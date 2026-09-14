import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { withTimeout } from "../utils/promise-timeout.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { ensureSherpaOnnxModels } from "./speech/providers/local/sherpa/model-downloader.js";
import { createDaemonTestContext } from "./test-utils/index.js";
import { parsePcm16MonoWav } from "./test-utils/dictation-e2e.js";

const modelsDir = path.resolve(".dev/paseo-home/models/local-speech");
const fixturePath = path.resolve("packages/app/e2e/support/fixtures/recording.wav");

type AudioOutputMessage = Extract<SessionOutboundMessage, { type: "audio_output" }>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("automatically speaks a fake Codex final response with local speech providers", async () => {
  await ensureSherpaOnnxModels({
    modelsDir,
    modelIds: ["parakeet-tdt-0.6b-v2-int8", "kokoro-en-v0_19"],
    logger: pino({ level: "silent" }),
  });

  const ctx = await createDaemonTestContext({
    voiceResponseMode: "autoSpeakFinal",
    dictationFinalTimeoutMs: 8000,
    speech: {
      providers: {
        dictationStt: { provider: "local", explicit: true },
        voiceStt: { provider: "local", explicit: true },
        voiceTts: { provider: "local", explicit: true },
      },
      local: {
        modelsDir,
        models: {
          dictationStt: "parakeet-tdt-0.6b-v2-int8",
          voiceStt: "parakeet-tdt-0.6b-v2-int8",
          voiceTts: "kokoro-en-v0_19",
          voiceTtsSpeakerId: 0,
        },
      },
    },
  });
  const voiceCwd = mkdtempSync(path.join(tmpdir(), "auto-speak-final-agent-"));
  const cleanups: Array<() => void> = [];
  let voiceModeEnabled = false;

  try {
    const agent = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd: voiceCwd,
      },
    });
    expect(agent.status).toBe("idle");
    await ctx.client.setAgentTimelineSubscription([agent.id]);

    const voiceMode = await ctx.client.setVoiceMode(true, agent.id);
    voiceModeEnabled = voiceMode.enabled;
    expect(voiceMode).toMatchObject({
      enabled: true,
      accepted: true,
      agentId: agent.id,
    });

    const transcript = createDeferred<string>();
    const turnCompleted = createDeferred<void>();
    const outputAudio = createDeferred<AudioOutputMessage>();
    const assistantTexts: string[] = [];
    const toolCallIds = new Set<string>();
    const rejectOutcome = (error: Error): void => {
      transcript.reject(error);
      turnCompleted.reject(error);
      outputAudio.reject(error);
    };
    const outcomePromise = Promise.all([
      transcript.promise,
      turnCompleted.promise,
      outputAudio.promise,
    ]);

    cleanups.push(
      ctx.client.on("transcription_result", (message) => {
        if (message.type !== "transcription_result") return;
        transcript.resolve(message.payload.text.trim());
      }),
    );
    cleanups.push(
      ctx.client.on("agent_stream", (message) => {
        if (message.type !== "agent_stream" || message.payload.agentId !== agent.id) return;
        const event = message.payload.event;
        if (event.type === "turn_failed") {
          rejectOutcome(new Error(String(event.error)));
          return;
        }
        if (event.type === "turn_canceled") {
          rejectOutcome(new Error("Fake Codex voice turn was canceled"));
          return;
        }
        if (event.type === "turn_completed") {
          turnCompleted.resolve();
          return;
        }
        if (event.type !== "timeline") return;
        if (event.item.type === "assistant_message") {
          assistantTexts.push(event.item.text);
        } else if (event.item.type === "tool_call") {
          toolCallIds.add(event.item.callId);
        }
      }),
    );
    cleanups.push(
      ctx.client.on("audio_output", (message) => {
        if (message.type !== "audio_output") return;
        void ctx.client.audioPlayed(message.payload.id).then(
          () => outputAudio.resolve(message),
          (error: unknown) =>
            rejectOutcome(error instanceof Error ? error : new Error(String(error))),
        );
      }),
    );
    cleanups.push(
      ctx.client.on("activity_log", (message) => {
        if (message.type !== "activity_log" || message.payload.type !== "error") return;
        rejectOutcome(new Error(message.payload.content));
      }),
    );

    const fixture = parsePcm16MonoWav(readFileSync(fixturePath));
    expect(fixture.sampleRate).toBe(16000);
    const chunkBytes = 3200;
    for (let offset = 0; offset < fixture.pcm16.length; offset += chunkBytes) {
      const chunk = fixture.pcm16.subarray(
        offset,
        Math.min(fixture.pcm16.length, offset + chunkBytes),
      );
      await ctx.client.sendVoiceAudioChunk(
        chunk.toString("base64"),
        "audio/pcm;rate=16000;bits=16",
        offset + chunkBytes >= fixture.pcm16.length,
      );
    }

    const [transcribedText, , audioMessage] = await withTimeout(
      outcomePromise,
      90_000,
      "Timed out waiting for the automatic final speech round trip",
    );

    expect(transcribedText).toBe("This is a voice note.");
    expect(assistantTexts.join("").trim()).toBe("Hello world");
    expect(toolCallIds.size).toBe(0);
    expect(audioMessage.payload.isVoiceMode).toBe(true);
    expect(audioMessage.payload.format).toBe("pcm;rate=24000");
    expect(audioMessage.payload.isLastChunk).toBe(true);
    expect(Buffer.from(audioMessage.payload.audio, "base64").byteLength).toBeGreaterThan(2000);
  } finally {
    for (const cleanup of cleanups.toReversed()) cleanup();
    if (voiceModeEnabled) {
      await ctx.client.setVoiceMode(false).catch(() => undefined);
    }
    rmSync(voiceCwd, { recursive: true, force: true });
    await ctx.cleanup();
  }
}, 120_000);
