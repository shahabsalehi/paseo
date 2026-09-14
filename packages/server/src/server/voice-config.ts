import { z } from "zod";

const VOICE_PROMPT_BLOCK_START = "<paseo_voice_mode>";
const VOICE_PROMPT_BLOCK_END = "</paseo_voice_mode>";

export const VoiceResponseModeSchema = z.enum(["toolDirected", "autoSpeakFinal"]);
export type VoiceResponseMode = z.infer<typeof VoiceResponseModeSchema>;
export const DEFAULT_VOICE_RESPONSE_MODE: VoiceResponseMode = "toolDirected";

const VOICE_AGENT_SYSTEM_INSTRUCTION = [
  "Paseo voice mode is now on.",
  "You are the Paseo voice assistant.",
  "The user cannot see your chat messages or tool calls.",
  "Always use the speak tool for all user-facing communication.",
  "Before calling any non-speak tool, first call speak with a short acknowledgement of what you heard and what you will do next.",
  "For long-running work, use speak to provide progress updates before and during execution.",
  "Treat the user input as transcribed speech.",
  "If the user intent is clear, proceed without extra confirmation.",
  "If the transcription seems incomplete, cut off, ambiguous, or may contain a non-obvious mistake or misspelling, ask a clarifying question via speak before taking action.",
  "Use concise plain language suitable for speech output.",
].join(" ");

const VOICE_AGENT_DISABLED_INSTRUCTION = [
  "Paseo voice mode is now off.",
  "Ignore any earlier Paseo voice mode instructions in this thread.",
].join(" ");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeVoicePromptBlockRegex(): RegExp {
  return new RegExp(
    `${escapeRegExp(VOICE_PROMPT_BLOCK_START)}[\\s\\S]*?${escapeRegExp(VOICE_PROMPT_BLOCK_END)}`,
    "g",
  );
}

export function stripVoiceModeSystemPrompt(existing?: string): string | undefined {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = trimmed.replace(makeVoicePromptBlockRegex(), "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

export function buildVoiceModeSystemPrompt(existing: string | undefined, enabled: boolean): string {
  const basePrompt = stripVoiceModeSystemPrompt(existing);
  const voiceInstruction = enabled
    ? VOICE_AGENT_SYSTEM_INSTRUCTION
    : VOICE_AGENT_DISABLED_INSTRUCTION;
  const voiceBlock = [VOICE_PROMPT_BLOCK_START, voiceInstruction, VOICE_PROMPT_BLOCK_END].join(
    "\n",
  );

  return [basePrompt, voiceBlock]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n\n");
}

export function wrapSpokenInput(
  text: string,
  responseMode: VoiceResponseMode = DEFAULT_VOICE_RESPONSE_MODE,
): string {
  const instruction =
    responseMode === "autoSpeakFinal"
      ? "This message was spoken by the user. After completing the requested work, respond with one concise normal assistant message suitable for speech. Do not call the speak tool; Paseo will speak the final response automatically. If the transcription is incomplete or ambiguous, ask one concise clarifying question."
      : "This message was spoken by the user. Respond using the speak tool only, not normal messages, because the user may not be looking at the chat.";
  return [
    "<spoken-input>",
    text,
    "</spoken-input>",
    `<instruction>${instruction}</instruction>`,
  ].join("\n");
}

export function buildVoiceAgentMcpServerConfig(params: {
  command: string;
  baseArgs: string[];
  socketPath: string;
  env?: Record<string, string>;
}): {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  return {
    type: "stdio",
    command: params.command,
    args: [...params.baseArgs, "--socket", params.socketPath],
    ...(params.env ? { env: params.env } : {}),
  };
}
