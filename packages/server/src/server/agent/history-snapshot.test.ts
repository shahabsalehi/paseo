import { expect, test, vi } from "vitest";
import { Session } from "../session.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

test("stored history remains accessible without a provider or runtime admission", async () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("old-chat", {
    epoch: "saved",
    items: [
      { type: "user_message", text: "Previous work" },
      { type: "assistant_message", text: "Saved answer" },
    ],
  });
  const createAgent = vi.fn(() => {
    throw new Error("capacity full");
  });
  const receiver = Object.create(Session.prototype);
  receiver.agentManager = {
    getAgent: () => null,
    readHistorySnapshot: async () => store,
    createAgent,
  };
  receiver.agentStorage = {
    get: async () => ({ id: "old-chat", provider: "unavailable-provider" }),
  };
  receiver.buildStoredAgentPayload = (record: unknown) => record;
  const history = await receiver.readAgentHistory("old-chat");
  expect(history.fetch({ limit: 1 }).rows[0].item.text).toBe("Saved answer");
  expect(
    history.fetch({ direction: "before", cursor: { epoch: "saved", seq: 2 }, limit: 1 }).rows[0]
      .item.text,
  ).toBe("Previous work");
  expect(createAgent).not.toHaveBeenCalled();
});
