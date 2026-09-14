import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";

interface IdleAutomaticFinalSpeechState {
  status: "idle";
}

interface ArmedAutomaticFinalSpeechState {
  status: "armed";
  clientMessageId: string;
  candidateTurnId: string | undefined;
}

interface TrackingAutomaticFinalSpeechState {
  status: "tracking";
  turnId: string | undefined;
  lastAssistantText: string;
  lastAssistantMessageId: string | null;
  isAssistantRunOpen: boolean;
}

export type AutomaticFinalSpeechState =
  | IdleAutomaticFinalSpeechState
  | ArmedAutomaticFinalSpeechState
  | TrackingAutomaticFinalSpeechState;

export interface AutomaticFinalResponse {
  turnId: string | undefined;
  text: string;
}

export interface AutomaticFinalSpeechTransition {
  state: AutomaticFinalSpeechState;
  response: AutomaticFinalResponse | null;
}

export function clearAutomaticFinalSpeechTurn(): AutomaticFinalSpeechState {
  return { status: "idle" };
}

export function beginAutomaticFinalSpeechTurn(clientMessageId: string): AutomaticFinalSpeechState {
  return { status: "armed", clientMessageId, candidateTurnId: undefined };
}

export function reduceAutomaticFinalSpeechEvent(
  state: AutomaticFinalSpeechState,
  event: AgentStreamEvent,
): AutomaticFinalSpeechTransition {
  if (state.status === "idle") {
    return unchanged(state);
  }

  if (state.status === "armed") {
    return observeArmedEvent(state, event);
  }

  const correlation = correlateEvent(state, event);
  if (!correlation.matches) {
    return unchanged(state);
  }
  const tracked = correlation.state;

  switch (event.type) {
    case "timeline":
      return observeTimelineItem(tracked, event.item);
    case "turn_failed":
    case "turn_canceled":
      return { state: clearAutomaticFinalSpeechTurn(), response: null };
    case "turn_completed":
      return completeTurn(tracked);
    default:
      return unchanged(tracked);
  }
}

function observeArmedEvent(
  state: ArmedAutomaticFinalSpeechState,
  event: AgentStreamEvent,
): AutomaticFinalSpeechTransition {
  if (event.type === "turn_started") {
    return unchanged({ ...state, candidateTurnId: event.turnId });
  }

  if (
    event.type !== "timeline" ||
    event.item.type !== "user_message" ||
    event.item.clientMessageId !== state.clientMessageId
  ) {
    return unchanged(state);
  }

  return startTracking(event.turnId ?? state.candidateTurnId);
}

export function normalizeAssistantTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/[~*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unchanged(state: AutomaticFinalSpeechState): AutomaticFinalSpeechTransition {
  return { state, response: null };
}

function startTracking(turnId: string | undefined): AutomaticFinalSpeechTransition {
  return unchanged({
    status: "tracking",
    turnId,
    lastAssistantText: "",
    lastAssistantMessageId: null,
    isAssistantRunOpen: false,
  });
}

function correlateEvent(
  state: TrackingAutomaticFinalSpeechState,
  event: AgentStreamEvent,
): { matches: true; state: TrackingAutomaticFinalSpeechState } | { matches: false } {
  const eventTurnId = "turnId" in event ? event.turnId : undefined;
  if (state.turnId !== undefined && eventTurnId !== undefined && eventTurnId !== state.turnId) {
    return { matches: false };
  }
  if (state.turnId === undefined && eventTurnId !== undefined) {
    return { matches: true, state: { ...state, turnId: eventTurnId } };
  }
  return { matches: true, state };
}

function observeTimelineItem(
  state: TrackingAutomaticFinalSpeechState,
  item: Extract<AgentStreamEvent, { type: "timeline" }>["item"],
): AutomaticFinalSpeechTransition {
  if (item.type !== "assistant_message") {
    return unchanged({ ...state, isAssistantRunOpen: false });
  }
  if (!item.text.trim()) {
    return unchanged(state);
  }

  const continuesAssistantRun =
    state.isAssistantRunOpen &&
    (item.messageId === undefined || item.messageId === state.lastAssistantMessageId);
  const lastAssistantText = continuesAssistantRun
    ? `${state.lastAssistantText}${item.text}`
    : item.text;
  const lastAssistantMessageId =
    item.messageId ?? (continuesAssistantRun ? state.lastAssistantMessageId : null);

  return unchanged({
    ...state,
    lastAssistantText,
    lastAssistantMessageId,
    isAssistantRunOpen: true,
  });
}

function completeTurn(state: TrackingAutomaticFinalSpeechState): AutomaticFinalSpeechTransition {
  const text = normalizeAssistantTextForSpeech(state.lastAssistantText);
  return {
    state: clearAutomaticFinalSpeechTurn(),
    response: text ? { turnId: state.turnId, text } : null,
  };
}
