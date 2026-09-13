import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationInbox } from "./notification-inbox.js";

test("busy parent delivery survives restart, retries failure, and deduplicates receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-inbox-"));
  const delivered: string[] = [];
  let ready = false,
    fail = true;
  const deliver = async (message: { id: string }) => {
    if (fail) throw new Error("capacity");
    delivered.push(message.id);
  };
  const message = { id: "child:finished", agentId: "parent", prompt: "result" };
  let inbox = new NotificationInbox(dir, async () => ready, deliver);
  try {
    await inbox.enqueue(message);
    await inbox.enqueue(message);
    await inbox.drain();
    expect(delivered).toEqual([]);
    await inbox.stop();
    inbox = new NotificationInbox(dir, async () => ready, deliver);
    ready = true;
    await inbox.drain();
    expect(delivered).toEqual([]);
    fail = false;
    await inbox.drain();
    await inbox.enqueue(message);
    await inbox.drain();
    expect(delivered).toEqual([message.id]);
  } finally {
    await inbox.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
