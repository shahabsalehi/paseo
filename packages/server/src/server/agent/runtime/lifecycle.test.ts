import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { DEFAULT_RUNTIME_LIMITS } from "./admission.js";
import { CodexProviderOptionsSchema } from "../providers/codex/options.js";

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
    await manager.closeIdleRuntimes(Date.now() + 901_000);
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

test.each(
  ["omp", "codex", "grok"].flatMap((provider) =>
    ["root", "executive-assistant"].map((role) => ({ provider, role })),
  ),
)(
  "idle $provider $role releases runtime and keeps readable history",
  async ({ provider, role }) => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-idle-role-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(join(dir, "agents"), logger);
    await storage.initialize();
    const client = createTestAgentClient(provider);
    const createSession = vi.spyOn(client, "createSession");
    const resumeSession = vi.spyOn(client, "resumeSession");
    const manager = new AgentManager({
      logger,
      registry: storage,
      historyDirectory: join(dir, "history"),
      clients: { [provider]: client },
      runtimeLimits: { ...DEFAULT_RUNTIME_LIMITS, checkMemory: async () => {} },
    });
    try {
      const agent = await manager.createAgent({ provider, cwd: dir }, undefined, {
        labels: { role },
      });
      if (provider === "codex") {
        // Use the real provider schema; fake sessions otherwise accept invalid options.
        expect(() =>
          CodexProviderOptionsSchema.parse(createSession.mock.calls[0][0].providerOptions),
        ).not.toThrow();
      }
      await manager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "Keep this history",
      });
      await manager.closeIdleRuntimes(Date.now() + 901_000);
      expect(manager.getAgent(agent.id)).toBeNull();
      expect((await storage.get(agent.id))?.archivedAt).toBeFalsy();
      const history = await manager.readHistorySnapshot(agent.id);
      expect(
        history
          ?.fetch(agent.id)
          .rows.some(
            (row) => row.item.type === "assistant_message" && row.item.text === "Keep this history",
          ),
      ).toBe(true);
      expect(manager.getAgent(agent.id)).toBeNull();
      const resumed = await ensureAgentLoaded(agent.id, {
        agentManager: manager,
        agentStorage: storage,
        logger,
      });
      expect(resumed.persistence?.sessionId).toBe(agent.persistence?.sessionId);
      if (provider === "codex") {
        expect(() =>
          CodexProviderOptionsSchema.parse(resumeSession.mock.calls[0][1]?.providerOptions),
        ).not.toThrow();
      }
      await manager.closeAgent(agent.id);
    } finally {
      manager.prepareForShutdown();
      await manager.flush();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
