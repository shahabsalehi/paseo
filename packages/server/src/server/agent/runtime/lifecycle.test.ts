import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { DEFAULT_RUNTIME_LIMITS } from "./admission.js";

test("idle worker closes without archiving and resumes the same durable session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-idle-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(dir, "agents"), logger);
  await storage.initialize();
  let closed = 0;
  const manager = new AgentManager({
    logger,
    registry: storage,
    clients: {
      omp: createTestAgentClient("omp", {
        closeSession: async () => {
          closed++;
        },
      }),
    },
    runtimeLimits: { ...DEFAULT_RUNTIME_LIMITS, checkMemory: async () => {} },
  });
  try {
    const worker = await manager.createAgent(
      { provider: "omp", cwd: dir, title: "Retain me" },
      undefined,
      { workspaceId: undefined, labels: { "paseo.parent-agent-id": "root" } },
    );
    const persistence = worker.persistence;
    await manager.appendTimelineItem(worker.id, {
      type: "assistant_message",
      text: "Completed evidence",
    });
    await manager.closeIdleWorkers(Date.now() + 121_000);
    expect(closed).toBe(1);
    expect(manager.getAgent(worker.id)).toBeNull();
    const stored = await storage.get(worker.id);
    expect(stored?.archivedAt).toBeFalsy();
    expect(stored?.persistence?.sessionId).toBe(persistence?.sessionId);
    const resumed = await ensureAgentLoaded(worker.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    expect(resumed.id).toBe(worker.id);
    expect(resumed.persistence?.sessionId).toBe(persistence?.sessionId);
    expect(resumed.labels["paseo.parent-agent-id"]).toBe("root");
    await manager.closeAgent(resumed.id);
  } finally {
    manager.prepareForShutdown();
    await manager.flush();
    await rm(dir, { recursive: true, force: true });
  }
});
