import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";
import {
  beginAutomaticFinalSpeechTurn,
  normalizeAssistantTextForSpeech,
  reduceAutomaticFinalSpeechEvent,
  type AutomaticFinalResponse,
  type AutomaticFinalSpeechState,
} from "./automatic-final-speech.js";

const CLIENT_MESSAGE_ID = "client-message-1";

function submittedUserMessage(
  provider: Extract<AgentStreamEvent, { type: "turn_started" }>["provider"],
  clientMessageId = CLIENT_MESSAGE_ID,
  turnId?: string,
): AgentStreamEvent {
  return {
    type: "timeline",
    provider,
    ...(turnId ? { turnId } : {}),
    item: { type: "user_message", text: "Submitted prompt", clientMessageId },
  };
}

function collectResponses(
  events: AgentStreamEvent[],
  clientMessageId = CLIENT_MESSAGE_ID,
): AutomaticFinalResponse[] {
  let state = beginAutomaticFinalSpeechTurn(clientMessageId);
  const responses: AutomaticFinalResponse[] = [];
  for (const event of events) {
    const transition = reduceAutomaticFinalSpeechEvent(state, event);
    state = transition.state;
    if (transition.response) {
      responses.push(transition.response);
    }
  }
  return responses;
}

function applyEvent(
  state: AutomaticFinalSpeechState,
  event: AgentStreamEvent,
): AutomaticFinalSpeechState {
  return reduceAutomaticFinalSpeechEvent(state, event).state;
}

describe("automatic final speech", () => {
  test("selects the last complete assistant run after a successful turn", () => {
    const responses = collectResponses([
      { type: "turn_started", provider: "codex", turnId: "turn-1" },
      submittedUserMessage("codex", CLIENT_MESSAGE_ID, "turn-1"),
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "Earlier update." },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "reasoning", text: "private reasoning" },
      },
      {
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
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: {
          type: "assistant_message",
          messageId: "final-message",
          text: "Final **answer** with ",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: {
          type: "assistant_message",
          messageId: "final-message",
          text: "[the docs](https://example.com).",
        },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-1" },
    ]);

    expect(responses).toEqual([{ turnId: "turn-1", text: "Final answer with the docs." }]);
  });

  test("emits one response for duplicate completion events", () => {
    const responses = collectResponses([
      { type: "turn_started", provider: "codex", turnId: "turn-2" },
      submittedUserMessage("codex", CLIENT_MESSAGE_ID, "turn-2"),
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-2",
        item: { type: "assistant_message", text: "Speak once." },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-2" },
      { type: "turn_completed", provider: "codex", turnId: "turn-2" },
    ]);

    expect(responses).toEqual([{ turnId: "turn-2", text: "Speak once." }]);
  });

  test("tracks a provider turn whose events omit turn ids", () => {
    const responses = collectResponses([
      { type: "turn_started", provider: "pi" },
      submittedUserMessage("pi"),
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "Identifier-free response." },
      },
      { type: "turn_completed", provider: "pi" },
    ]);

    expect(responses).toEqual([{ turnId: undefined, text: "Identifier-free response." }]);
  });

  test("learns a turn id from a later event", () => {
    const responses = collectResponses([
      { type: "turn_started", provider: "pi" },
      submittedUserMessage("pi", CLIENT_MESSAGE_ID, "learned-turn"),
      {
        type: "timeline",
        provider: "pi",
        turnId: "learned-turn",
        item: { type: "assistant_message", text: "Learned identity." },
      },
      { type: "turn_completed", provider: "pi", turnId: "learned-turn" },
    ]);

    expect(responses).toEqual([{ turnId: "learned-turn", text: "Learned identity." }]);
  });

  test.each(["turn_failed", "turn_canceled"] as const)(
    "does not select speech for a typed %s turn",
    (terminalType) => {
      const terminalEvent: AgentStreamEvent =
        terminalType === "turn_failed"
          ? {
              type: "turn_failed",
              provider: "claude",
              turnId: "turn-error",
              error: "OAuth session expired",
            }
          : {
              type: "turn_canceled",
              provider: "claude",
              turnId: "turn-error",
              reason: "interrupted",
            };
      const responses = collectResponses([
        { type: "turn_started", provider: "claude", turnId: "turn-error" },
        submittedUserMessage("claude", CLIENT_MESSAGE_ID, "turn-error"),
        {
          type: "timeline",
          provider: "claude",
          turnId: "turn-error",
          item: {
            type: "assistant_message",
            text: "Failed to authenticate: OAuth session expired",
          },
        },
        terminalEvent,
      ]);

      expect(responses).toEqual([]);
    },
  );

  test("preserves error-looking text from a successfully completed turn", () => {
    const responses = collectResponses([
      { type: "turn_started", provider: "claude", turnId: "turn-quoted-error" },
      submittedUserMessage("claude", CLIENT_MESSAGE_ID, "turn-quoted-error"),
      {
        type: "timeline",
        provider: "claude",
        turnId: "turn-quoted-error",
        item: {
          type: "assistant_message",
          text: "Authentication failed is the heading shown in the guide.",
        },
      },
      { type: "turn_completed", provider: "claude", turnId: "turn-quoted-error" },
    ]);

    expect(responses).toEqual([
      {
        turnId: "turn-quoted-error",
        text: "Authentication failed is the heading shown in the guide.",
      },
    ]);
  });

  test("ignores unrelated ownership and still tracks a later matching turn", () => {
    const responses = collectResponses([
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-old",
        item: { type: "assistant_message", text: "Old response." },
      },
      { type: "turn_started", provider: "codex", turnId: "turn-other" },
      submittedUserMessage("codex", "another-client", "turn-other"),
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-other",
        item: { type: "assistant_message", text: "Other response." },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-other" },
      { type: "turn_started", provider: "codex", turnId: "turn-current" },
      submittedUserMessage("codex", CLIENT_MESSAGE_ID, "turn-current"),
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-current",
        item: { type: "assistant_message", text: "Current response." },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-current" },
    ]);

    expect(responses).toEqual([{ turnId: "turn-current", text: "Current response." }]);
  });

  test("beginning a new spoken turn replaces unfinished tracking state", () => {
    let state = beginAutomaticFinalSpeechTurn("client-old");
    state = applyEvent(state, {
      type: "turn_started",
      provider: "codex",
      turnId: "turn-old",
    });
    state = applyEvent(state, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-old",
      item: { type: "user_message", text: "Old prompt", clientMessageId: "client-old" },
    });
    state = applyEvent(state, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-old",
      item: { type: "assistant_message", text: "Old unfinished response." },
    });

    state = beginAutomaticFinalSpeechTurn("client-new");
    state = applyEvent(state, {
      type: "turn_started",
      provider: "codex",
      turnId: "turn-new",
    });
    state = applyEvent(state, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-new",
      item: { type: "user_message", text: "New prompt", clientMessageId: "client-new" },
    });
    state = applyEvent(state, {
      type: "timeline",
      provider: "codex",
      turnId: "turn-new",
      item: { type: "assistant_message", text: "New response." },
    });
    const transition = reduceAutomaticFinalSpeechEvent(state, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-new",
    });

    expect(transition.response).toEqual({ turnId: "turn-new", text: "New response." });
  });

  test("allows a later spoken turn to reuse the same provider turn id", () => {
    const responses: AutomaticFinalResponse[] = [];
    let state = beginAutomaticFinalSpeechTurn("client-1");
    for (const [index, text] of ["First response.", "Second response."].entries()) {
      const clientMessageId = `client-${index + 1}`;
      state = applyEvent(state, {
        type: "turn_started",
        provider: "codex",
        turnId: "reused-turn",
      });
      state = applyEvent(state, submittedUserMessage("codex", clientMessageId, "reused-turn"));
      state = applyEvent(state, {
        type: "timeline",
        provider: "codex",
        turnId: "reused-turn",
        item: { type: "assistant_message", text },
      });
      const transition = reduceAutomaticFinalSpeechEvent(state, {
        type: "turn_completed",
        provider: "codex",
        turnId: "reused-turn",
      });
      if (transition.response) {
        responses.push(transition.response);
      }
      state = beginAutomaticFinalSpeechTurn(`client-${index + 2}`);
    }

    expect(responses).toEqual([
      { turnId: "reused-turn", text: "First response." },
      { turnId: "reused-turn", text: "Second response." },
    ]);
  });

  test("does not select an empty final response", () => {
    const responses = collectResponses([
      { type: "turn_started", provider: "codex", turnId: "turn-empty" },
      submittedUserMessage("codex", CLIENT_MESSAGE_ID, "turn-empty"),
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-empty",
        item: { type: "assistant_message", text: "   " },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-empty" },
    ]);

    expect(responses).toEqual([]);
  });

  test("only the matching owner responds to identical broadcast events", () => {
    const ownerEvents: AgentStreamEvent[] = [
      { type: "turn_started", provider: "codex", turnId: "turn-owner" },
      submittedUserMessage("codex", "client-owner", "turn-owner"),
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-owner",
        item: { type: "assistant_message", text: "Owner response." },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-owner" },
    ];
    const observerEvents: AgentStreamEvent[] = [
      ...ownerEvents,
      { type: "turn_started", provider: "codex", turnId: "turn-observer" },
      submittedUserMessage("codex", "client-observer", "turn-observer"),
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-observer",
        item: { type: "assistant_message", text: "Observer response." },
      },
      { type: "turn_completed", provider: "codex", turnId: "turn-observer" },
    ];

    expect(collectResponses(ownerEvents, "client-owner")).toEqual([
      { turnId: "turn-owner", text: "Owner response." },
    ]);
    expect(collectResponses(observerEvents, "client-observer")).toEqual([
      { turnId: "turn-observer", text: "Observer response." },
    ]);
  });
});

describe("assistant text normalization for speech", () => {
  test("removes common Markdown markup while retaining readable content", () => {
    expect(
      normalizeAssistantTextForSpeech(
        "## Result\n\n- Use **Paseo** with [the guide](https://example.com).\n- Run `npm test`.",
      ),
    ).toBe("Result Use Paseo with the guide. Run npm test.");
  });

  test("omits fenced code bodies from speech", () => {
    expect(
      normalizeAssistantTextForSpeech("Done.\n\n```ts\nconst secret = 1;\n```\n\nReady."),
    ).toBe("Done. Code block omitted. Ready.");
  });
});
