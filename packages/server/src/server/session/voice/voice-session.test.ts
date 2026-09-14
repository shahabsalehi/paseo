import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { VoiceSession, type VoiceSessionHost } from "./voice-session.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";

const VOICE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeVoiceTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;

  async connect(): Promise<void> {}

  appendPcm16(_chunk: Buffer): void {}

  flush(): void {}
  reset(): void {}
  close(): void {}
}

class FakeVoiceSttSession extends EventEmitter implements StreamingTranscriptionSession {
  public readonly requiredSampleRate = 16000;
  public commitCount = 0;

  async connect(): Promise<void> {}

  appendPcm16(_pcm16le: Buffer): void {}

  commit(): void {
    this.commitCount += 1;
  }

  clear(): void {}
  close(): void {}

  emitCommitted(event: StreamingTranscriptionCommittedEvent): void {
    this.emit("committed", event);
  }

  emitTranscript(event: StreamingTranscriptionEvent): void {
    this.emit("transcript", event);
  }
}

interface FakeVoiceHost extends VoiceSessionHost {
  readonly emitted: SessionOutboundMessage[];
  readonly spokenInput: Array<{ agentId: string; text: string; clientMessageId?: string }>;
  onEmit?: (message: SessionOutboundMessage) => void;
}

function createFakeHost(): FakeVoiceHost {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: Array<{ agentId: string; text: string; clientMessageId?: string }> = [];
  const host: FakeVoiceHost = {
    emitted,
    spokenInput,
    emit: (msg) => {
      emitted.push(msg);
      host.onEmit?.(msg);
    },
    loadAgent: async (agentId) =>
      ({ id: agentId, config: { systemPrompt: undefined } }) as unknown as ManagedAgent,
    reloadAgentSession: vi.fn(async (agentId) => ({ id: agentId }) as unknown as ManagedAgent),
    sendSpokenInput: async (agentId, text, _responseMode, clientMessageId) => {
      spokenInput.push({
        agentId,
        text,
        ...(clientMessageId ? { clientMessageId } : {}),
      });
      return true;
    },
    interruptAgentIfRunning: async () => {},
    hasActiveAgentRun: () => false,
  };
  return host;
}

function createVoiceSession(options?: {
  responseMode?: "toolDirected" | "autoSpeakFinal";
  tts?: TextToSpeechProvider | null;
  voiceBridge?: {
    registerVoiceSpeakHandler?: ReturnType<typeof vi.fn>;
    unregisterVoiceSpeakHandler?: ReturnType<typeof vi.fn>;
    registerVoiceCallerContext?: ReturnType<typeof vi.fn>;
    unregisterVoiceCallerContext?: ReturnType<typeof vi.fn>;
  };
}) {
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const host = createFakeHost();
  const voiceSession = new VoiceSession({
    host,
    logger: pino({ level: "silent" }),
    sessionId: "voice-session-test",
    sttLanguage: "en",
    tts: options?.tts ?? null,
    stt,
    voice: { turnDetection, responseMode: options?.responseMode },
    voiceBridge: options?.voiceBridge,
  });
  return { voiceSession, detector, sttSession, host };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function getAudioOutputMessages(messages: SessionOutboundMessage[]): SessionOutboundMessage[] {
  return messages.filter((message) => message.type === "audio_output");
}

async function submitSpokenInput(params: {
  voiceSession: VoiceSession;
  detector: FakeVoiceTurnDetectionSession;
  sttSession: FakeVoiceSttSession;
  text: string;
  segmentId?: string;
}): Promise<void> {
  const segmentId = params.segmentId ?? "segment-1";
  params.detector.emit("speech_started");
  await settle();
  params.detector.emit("speech_stopped");
  await settle();
  params.sttSession.emitCommitted({ segmentId, previousSegmentId: null });
  params.sttSession.emitTranscript({
    segmentId,
    transcript: params.text,
    isFinal: true,
    language: "en",
    avgLogprob: -0.1,
    isLowConfidence: false,
  });
  await settle();
}

function getLastClientMessageId(host: FakeVoiceHost): string {
  const clientMessageId = host.spokenInput.at(-1)?.clientMessageId;
  if (!clientMessageId) {
    throw new Error("automatic spoken input did not forward a client message ID");
  }
  return clientMessageId;
}

function startSubmittedTurn(params: {
  voiceSession: VoiceSession;
  host: FakeVoiceHost;
  turnId: string;
}): string {
  const clientMessageId = getLastClientMessageId(params.host);

  params.voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
    type: "turn_started",
    provider: "codex",
    turnId: params.turnId,
  });
  params.voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
    type: "timeline",
    provider: "codex",
    turnId: params.turnId,
    item: {
      type: "user_message",
      text: "Submitted spoken input",
      clientMessageId,
    },
  });
  return clientMessageId;
}

describe("VoiceSession streaming transcription", () => {
  test("surfaces a refused voice-mode agent interruption", async () => {
    const { voiceSession, host } = createVoiceSession();
    host.interruptAgentIfRunning = vi.fn(async () => {
      throw new Error("active run cancellation was not acknowledged");
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await expect(voiceSession.handleAbort()).rejects.toThrow(
      "active run cancellation was not acknowledged",
    );
    expect(host.interruptAgentIfRunning).toHaveBeenCalledWith(VOICE_AGENT_ID);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "activity_log",
        payload: expect.objectContaining({
          type: "error",
          content: "Voice interruption failed: active run cancellation was not acknowledged",
          metadata: { voiceAbortFailed: true },
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("delivers the streaming final transcript to the agent exactly once", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "ship the streaming final",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();

    expect(sttSession.commitCount).toBe(1);
    expect(host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "ship the streaming final" },
    ]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "ship the streaming final",
          language: "en",
          avgLogprob: -0.1,
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("emits an empty transcript on finalization timeout without submitting to the agent", async () => {
    vi.useFakeTimers();
    try {
      const { voiceSession, detector, sttSession, host } = createVoiceSession();

      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });

      await vi.advanceTimersByTimeAsync(10_000);
      await settle();

      expect(host.spokenInput).toEqual([]);
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "transcription_result",
          payload: expect.objectContaining({ text: "" }),
        }),
      );

      await voiceSession.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters a low-confidence streaming final without submitting to the agent", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "background noise",
      isFinal: true,
      avgLogprob: -2.5,
      isLowConfidence: true,
    });
    await settle();

    expect(host.spokenInput).toEqual([]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "",
          avgLogprob: -2.5,
          isLowConfidence: true,
        }),
      }),
    );

    await voiceSession.cleanup();
  });
});

describe("VoiceSession automatic final-response speech", () => {
  test("speaks only the complete last assistant message after successful completion", async () => {
    const synthesizeSpeech = vi.fn(async () => ({
      stream: Readable.from([Buffer.from("audio")]),
      format: "mp3",
    }));
    const { voiceSession, detector, sttSession, host } = createVoiceSession({
      responseMode: "autoSpeakFinal",
      tts: { synthesizeSpeech },
    });
    host.onEmit = (message) => {
      if (message.type === "audio_output") {
        voiceSession.handleAudioPlayed(message.payload.id);
      }
    };

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await submitSpokenInput({
      voiceSession,
      detector,
      sttSession,
      text: "test the final response",
    });

    startSubmittedTurn({ voiceSession, host, turnId: "turn-1" });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "reasoning", text: "private reasoning" },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "Earlier update." },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "true", exitCode: 0, output: "" },
      },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: {
        type: "assistant_message",
        messageId: "final-message",
        text: "Final **answer** with ",
      },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: {
        type: "assistant_message",
        messageId: "final-message",
        text: "[the docs](https://example.com).",
      },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-1",
    });

    await vi.waitFor(() => {
      expect(synthesizeSpeech).toHaveBeenCalledWith("Final answer with the docs.");
      expect(getAudioOutputMessages(host.emitted)).toHaveLength(1);
    });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);

    await voiceSession.cleanup();
  });

  test("dispatches a completed turn exactly once and ignores unrelated events", async () => {
    const synthesizeSpeech = vi.fn(async () => ({
      stream: Readable.from([Buffer.from("audio")]),
      format: "mp3",
    }));
    const { voiceSession, detector, sttSession, host } = createVoiceSession({
      responseMode: "autoSpeakFinal",
      tts: { synthesizeSpeech },
    });
    host.onEmit = (message) => {
      if (message.type === "audio_output") {
        voiceSession.handleAudioPlayed(message.payload.id);
      }
    };

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await submitSpokenInput({ voiceSession, detector, sttSession, text: "say it once" });

    voiceSession.handleAgentStreamEvent("22222222-2222-4222-8222-222222222222", {
      type: "timeline",
      provider: "codex",
      turnId: "turn-other",
      item: { type: "assistant_message", text: "Wrong agent." },
    });
    startSubmittedTurn({ voiceSession, host, turnId: "turn-2" });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-other",
      item: { type: "assistant_message", text: "Wrong turn." },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-2",
      item: { type: "assistant_message", text: "Speak once." },
    });
    const completion = {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-2",
    } as const;
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, completion);
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, completion);

    await vi.waitFor(() => {
      expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    });
    expect(synthesizeSpeech).toHaveBeenCalledWith("Speak once.");

    await voiceSession.cleanup();
  });

  test("speaks only to the client that submitted the spoken turn", async () => {
    const ownerSynthesis = vi.fn(async () => ({
      stream: Readable.from([Buffer.from("owner-audio")]),
      format: "mp3",
    }));
    const observerSynthesis = vi.fn();
    const owner = createVoiceSession({
      responseMode: "autoSpeakFinal",
      tts: { synthesizeSpeech: ownerSynthesis },
    });
    const observer = createVoiceSession({
      responseMode: "autoSpeakFinal",
      tts: { synthesizeSpeech: observerSynthesis },
    });
    owner.host.onEmit = (message) => {
      if (message.type === "audio_output") {
        owner.voiceSession.handleAudioPlayed(message.payload.id);
      }
    };

    await owner.voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await observer.voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await submitSpokenInput({
      voiceSession: owner.voiceSession,
      detector: owner.detector,
      sttSession: owner.sttSession,
      text: "speak to the owner",
    });
    await submitSpokenInput({
      voiceSession: observer.voiceSession,
      detector: observer.detector,
      sttSession: observer.sttSession,
      text: "arm the other client",
    });
    const ownerClientMessageId = getLastClientMessageId(owner.host);
    const observerClientMessageId = getLastClientMessageId(observer.host);
    expect(ownerClientMessageId).not.toBe(observerClientMessageId);

    const events = [
      { type: "turn_started", provider: "codex", turnId: "turn-owner" },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-owner",
        item: {
          type: "user_message",
          text: "speak to the owner",
          clientMessageId: ownerClientMessageId,
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-owner",
        item: { type: "assistant_message", text: "Owner only." },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-owner" },
    ] as const;
    for (const event of events) {
      owner.voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, event);
      observer.voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, event);
    }

    await vi.waitFor(() => expect(ownerSynthesis).toHaveBeenCalledWith("Owner only."));
    expect(observerSynthesis).not.toHaveBeenCalled();

    await owner.voiceSession.cleanup();
    await observer.voiceSession.cleanup();
  });

  test("clears ownership after an asynchronous pre-start send failure", async () => {
    const synthesizeSpeech = vi.fn();
    const { voiceSession, detector, sttSession, host } = createVoiceSession({
      responseMode: "autoSpeakFinal",
      tts: { synthesizeSpeech },
    });
    let resolveSend: ((accepted: boolean) => void) | undefined;
    const sendSpokenInput = vi.fn(
      (
        _agentId: string,
        _text: string,
        _responseMode: "toolDirected" | "autoSpeakFinal",
        _clientMessageId?: string,
      ) =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    host.sendSpokenInput = sendSpokenInput;

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await submitSpokenInput({
      voiceSession,
      detector,
      sttSession,
      text: "this send will fail",
    });
    await vi.waitFor(() => expect(sendSpokenInput).toHaveBeenCalledTimes(1));
    expect(sendSpokenInput.mock.calls[0]?.[3]).toEqual(expect.any(String));

    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "turn_failed",
      provider: "codex",
      turnId: "turn-before-start",
      error: "send failed before the turn started",
    });
    resolveSend?.(false);
    await settle();

    const unrelatedEvents = [
      { type: "turn_started", provider: "codex", turnId: "turn-unrelated" },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-unrelated",
        item: {
          type: "user_message",
          text: "Unrelated input",
          clientMessageId: "another-client-message",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-unrelated",
        item: { type: "assistant_message", text: "Do not speak this." },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-unrelated" },
    ] as const;
    for (const event of unrelatedEvents) {
      voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, event);
    }
    await settle();

    expect(synthesizeSpeech).not.toHaveBeenCalled();
    await voiceSession.cleanup();
  });

  test.each(["turn_failed", "turn_canceled"] as const)(
    "does not speak a %s turn",
    async (terminalType) => {
      const synthesizeSpeech = vi.fn();
      const { voiceSession, detector, sttSession, host } = createVoiceSession({
        responseMode: "autoSpeakFinal",
        tts: { synthesizeSpeech },
      });

      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      await submitSpokenInput({ voiceSession, detector, sttSession, text: "do not speak" });
      startSubmittedTurn({ voiceSession, host, turnId: "turn-terminal" });
      voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
        type: "timeline",
        provider: "codex",
        turnId: "turn-terminal",
        item: { type: "assistant_message", text: "Partial response." },
      });
      voiceSession.handleAgentStreamEvent(
        VOICE_AGENT_ID,
        terminalType === "turn_failed"
          ? {
              type: "turn_failed",
              provider: "codex",
              turnId: "turn-terminal",
              error: "failed",
            }
          : {
              type: "turn_canceled",
              provider: "codex",
              turnId: "turn-terminal",
              reason: "canceled",
            },
      );
      await settle();

      expect(synthesizeSpeech).not.toHaveBeenCalled();
      await voiceSession.cleanup();
    },
  );

  test("surfaces a TTS failure and speaks the next successful turn", async () => {
    const synthesizeSpeech = vi
      .fn()
      .mockRejectedValueOnce(new Error("TTS unavailable"))
      .mockResolvedValueOnce({
        stream: Readable.from([Buffer.from("recovered audio")]),
        format: "mp3",
      });
    const { voiceSession, detector, sttSession, host } = createVoiceSession({
      responseMode: "autoSpeakFinal",
      tts: { synthesizeSpeech },
    });
    host.onEmit = (message) => {
      if (message.type === "audio_output") {
        voiceSession.handleAudioPlayed(message.payload.id);
      }
    };

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await submitSpokenInput({ voiceSession, detector, sttSession, text: "survive TTS failure" });
    startSubmittedTurn({ voiceSession, host, turnId: "turn-failure" });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-failure",
      item: { type: "assistant_message", text: "The text response remains." },
    });
    expect(() => {
      voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
        type: "turn_completed",
        provider: "codex",
        turnId: "turn-failure",
      });
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
      expect(host.emitted).toContainEqual({
        type: "activity_log",
        payload: {
          id: expect.any(String),
          timestamp: expect.any(Date),
          type: "error",
          content: "Voice playback failed. Read the response above or try again.",
          metadata: { voiceTtsFailed: true, turnId: "turn-failure" },
        },
      });
    });
    expect(host.emitted.some((message) => message.type === "audio_output")).toBe(false);

    await submitSpokenInput({
      voiceSession,
      detector,
      sttSession,
      text: "recover speech",
      segmentId: "segment-2",
    });
    startSubmittedTurn({ voiceSession, host, turnId: "turn-recovery" });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-recovery",
      item: { type: "assistant_message", text: "Recovered spoken response." },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-recovery",
    });

    await vi.waitFor(() => {
      expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
      expect(getAudioOutputMessages(host.emitted)).toHaveLength(1);
    });
    expect(synthesizeSpeech).toHaveBeenNthCalledWith(2, "Recovered spoken response.");

    await voiceSession.cleanup();
  });

  test("aborts pending automatic synthesis before it emits audio", async () => {
    let resolveSynthesis: ((result: { stream: Readable; format: string }) => void) | undefined;
    const synthesizeSpeech = vi.fn(
      () =>
        new Promise<{ stream: Readable; format: string }>((resolve) => {
          resolveSynthesis = resolve;
        }),
    );
    const { voiceSession, detector, sttSession, host } = createVoiceSession({
      responseMode: "autoSpeakFinal",
      tts: { synthesizeSpeech },
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await submitSpokenInput({ voiceSession, detector, sttSession, text: "start speaking" });
    startSubmittedTurn({ voiceSession, host, turnId: "turn-abort" });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-abort",
      item: { type: "assistant_message", text: "This should be canceled." },
    });
    voiceSession.handleAgentStreamEvent(VOICE_AGENT_ID, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-abort",
    });

    await vi.waitFor(() => expect(synthesizeSpeech).toHaveBeenCalledTimes(1));
    await voiceSession.handleAbort();
    resolveSynthesis?.({
      stream: Readable.from([Buffer.from("late audio")]),
      format: "mp3",
    });
    await settle();

    expect(host.emitted.some((message) => message.type === "audio_output")).toBe(false);
    expect(
      host.emitted.some(
        (message) =>
          message.type === "activity_log" && message.payload.metadata?.voiceTtsFailed === true,
      ),
    ).toBe(false);
    await voiceSession.cleanup();
  });

  test("registers and cleans up the voice bridge in default tool-directed mode", async () => {
    const registerVoiceSpeakHandler = vi.fn();
    const unregisterVoiceSpeakHandler = vi.fn();
    const registerVoiceCallerContext = vi.fn();
    const unregisterVoiceCallerContext = vi.fn();
    const { voiceSession, host } = createVoiceSession({
      voiceBridge: {
        registerVoiceSpeakHandler,
        unregisterVoiceSpeakHandler,
        registerVoiceCallerContext,
        unregisterVoiceCallerContext,
      },
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    expect(host.reloadAgentSession).toHaveBeenCalledTimes(1);
    expect(registerVoiceSpeakHandler).toHaveBeenCalledWith(VOICE_AGENT_ID, expect.any(Function));
    expect(registerVoiceCallerContext).toHaveBeenCalledWith(VOICE_AGENT_ID, {
      childAgentDefaultLabels: {},
      allowCustomCwd: false,
      enableVoiceTools: true,
    });
    expect(unregisterVoiceSpeakHandler).not.toHaveBeenCalled();
    expect(unregisterVoiceCallerContext).not.toHaveBeenCalled();

    await voiceSession.cleanup();

    expect(unregisterVoiceSpeakHandler).toHaveBeenCalledWith(VOICE_AGENT_ID);
    expect(unregisterVoiceCallerContext).toHaveBeenCalledWith(VOICE_AGENT_ID);
  });

  test("does not touch the voice bridge in automatic-final mode", async () => {
    const registerVoiceSpeakHandler = vi.fn();
    const unregisterVoiceSpeakHandler = vi.fn();
    const registerVoiceCallerContext = vi.fn();
    const unregisterVoiceCallerContext = vi.fn();
    const { voiceSession, host } = createVoiceSession({
      responseMode: "autoSpeakFinal",
      voiceBridge: {
        registerVoiceSpeakHandler,
        unregisterVoiceSpeakHandler,
        registerVoiceCallerContext,
        unregisterVoiceCallerContext,
      },
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await voiceSession.cleanup();

    expect(host.reloadAgentSession).not.toHaveBeenCalled();
    expect(registerVoiceSpeakHandler).not.toHaveBeenCalled();
    expect(unregisterVoiceSpeakHandler).not.toHaveBeenCalled();
    expect(registerVoiceCallerContext).not.toHaveBeenCalled();
    expect(unregisterVoiceCallerContext).not.toHaveBeenCalled();
  });
});
