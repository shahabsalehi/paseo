import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type { AgentTimelineFetchResult } from "./agent-timeline-store-types.js";

// A disposable projection of provider history, never the provider session itself.
// Keep each read local to the request so browsing many old chats does not pin RAM.
export class HistorySnapshots {
  constructor(private readonly directory: string) {}
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid history agent ID");
    return join(this.directory, `${id}.json`);
  }
  async save(id: string, timeline: AgentTimelineFetchResult): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, timeline }), { mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async read(id: string): Promise<InMemoryAgentTimelineStore | null> {
    let text: string;
    try {
      text = await readFile(this.path(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(text);
    if (
      value.version !== 1 ||
      !Array.isArray(value.timeline?.rows) ||
      typeof value.timeline.epoch !== "string"
    )
      throw new Error("Invalid history snapshot");
    const store = new InMemoryAgentTimelineStore();
    store.initialize(id, {
      rows: value.timeline.rows,
      epoch: value.timeline.epoch,
      nextSeq: value.timeline.window.nextSeq,
    });
    return store;
  }
}
