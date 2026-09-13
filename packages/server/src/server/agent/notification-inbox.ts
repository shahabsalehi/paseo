import { mkdir, readdir, readFile, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface InboxMessage {
  id: string;
  agentId: string;
  prompt: string;
  delivered?: boolean;
  queuedAt?: number;
}

/** Native durable delivery spool. Busy parents are deferred, never interrupted. */
export class NotificationInbox {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private lastQueuedAt = 0;
  constructor(
    readonly directory: string,
    private readonly ready: (id: string) => Promise<boolean>,
    private readonly deliver: (message: InboxMessage) => Promise<void>,
  ) {}
  private path(id: string) {
    return join(this.directory, createHash("sha256").update(id).digest("hex") + ".json");
  }
  private async write(message: InboxMessage) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(message.id),
      temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(message));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result;
    return result;
  }
  enqueue(message: InboxMessage): Promise<void> {
    return this.serialize(async () => {
      try {
        await readFile(this.path(message.id));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.lastQueuedAt = Math.max(Date.now(), this.lastQueuedAt + 1);
      await this.write({ ...message, queuedAt: this.lastQueuedAt });
    });
  }
  drain(): Promise<void> {
    return this.serialize(async () => {
      if (this.stopped) return;
      let names: string[];
      try {
        names = await readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const messages: InboxMessage[] = [];
      for (const name of names.filter((entry) => entry.endsWith(".json")))
        messages.push(JSON.parse(await readFile(join(this.directory, name), "utf8")));
      messages.sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
      const deferred = new Set<string>();
      for (const message of messages) {
        if (this.stopped) break;
        if (deferred.has(message.agentId)) continue;
        if (message.delivered || !(await this.ready(message.agentId))) continue;
        try {
          await this.deliver(message);
          // Keep the small receipt for idempotence across queue sweeps/restarts.
          await this.write({ ...message, prompt: "", delivered: true });
        } catch {
          deferred.add(message.agentId); /* Retry at next idle/capacity event. */
        }
      }
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.tail;
  }
}
