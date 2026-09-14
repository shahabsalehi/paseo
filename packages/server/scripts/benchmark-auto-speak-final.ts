import path from "node:path";
import pino from "pino";

import { wordSimilarity } from "../src/server/test-utils/dictation-e2e.js";
import { LocalSpeechWorkerClient } from "../src/server/speech/providers/local/worker-client.js";

const trials = Math.max(
  1,
  Number.parseInt(process.env.PASEO_AUTO_SPEAK_FINAL_TTS_TRIALS ?? "10", 10),
);
const modelsDir = path.resolve(
  process.env.PASEO_LOCAL_MODELS_DIR ?? ".dev/paseo-home/models/local-speech",
);

const cases = [
  { name: "short", text: "How can I help?" },
  {
    name: "medium",
    text: "Your changes are ready. I checked the voice workflow, confirmed the tests pass, and found no remaining local errors.",
  },
  {
    name: "long",
    text: "The voice workflow is ready. I verified transcription, agent completion, automatic speech dispatch, playback acknowledgement, cancellation, and error isolation. The response stays readable, avoids technical markup in speech, and remains available as text if synthesis fails.",
  },
] as const;

interface SignalMetrics {
  durationMs: number;
  rms: number;
  peak: number;
  clippedPercent: number;
}

interface TrialResult extends SignalMetrics {
  elapsedMs: number;
  audioBytes: number;
}

async function streamToBuffer(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  return Buffer.concat(chunks);
}

function analyzePcm(audio: Buffer, sampleRate: number): SignalMetrics {
  const samples = Math.floor(audio.length / 2);
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = audio.readInt16LE(index * 2);
    const magnitude = Math.abs(value);
    sumSquares += value * value;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 32760) clipped += 1;
  }
  return {
    durationMs: (audio.length / (sampleRate * 2)) * 1000,
    rms: Math.sqrt(sumSquares / samples) / 32768,
    peak: peak / 32768,
    clippedPercent: (clipped / samples) * 100,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function summarize(values: readonly number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

async function main(): Promise<void> {
  const client = new LocalSpeechWorkerClient({
    config: {
      modelsDir,
      voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
      dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
      voiceTtsModel: "kokoro-en-v0_19",
      voiceTtsSpeakerId: 0,
    },
    logger: pino({ level: "silent" }),
    requestTimeoutMs: 120_000,
    idleTtlMs: 300_000,
  });

  try {
    const warmup = await client.synthesizeSpeech(cases[0].text);
    await streamToBuffer(warmup.stream as AsyncIterable<unknown>);

    const output = [];
    for (const benchmarkCase of cases) {
      const results: TrialResult[] = [];
      let lastAudio = Buffer.alloc(0);
      let lastFormat = "";
      for (let trial = 0; trial < trials; trial += 1) {
        const startedAt = performance.now();
        const speech = await client.synthesizeSpeech(benchmarkCase.text);
        const audio = await streamToBuffer(speech.stream as AsyncIterable<unknown>);
        const elapsedMs = performance.now() - startedAt;
        const sampleRate = Number(/rate=(\d+)/.exec(speech.format)?.[1] ?? 24000);
        results.push({
          elapsedMs,
          audioBytes: audio.length,
          ...analyzePcm(audio, sampleRate),
        });
        lastAudio = audio;
        lastFormat = speech.format;
      }

      const sttFormat = lastFormat.startsWith("audio/") ? lastFormat : "audio/" + lastFormat;
      const transcription = await client.transcribeVoice(lastAudio, sttFormat);
      output.push({
        name: benchmarkCase.name,
        textChars: benchmarkCase.text.length,
        synthesisMs: summarize(results.map((result) => result.elapsedMs)),
        audioDurationMs: summarize(results.map((result) => result.durationMs)),
        rms: summarize(results.map((result) => result.rms)),
        peak: summarize(results.map((result) => result.peak)),
        maxClippedPercent: Math.max(...results.map((result) => result.clippedPercent)),
        roundTripTranscript: transcription.text,
        roundTripWordSimilarity: wordSimilarity(transcription.text, benchmarkCase.text),
      });
    }

    console.log(JSON.stringify({ modelsDir, trials, cases: output }, null, 2));
  } finally {
    client.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
