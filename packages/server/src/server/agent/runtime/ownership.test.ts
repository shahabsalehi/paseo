import { expect, test } from "vitest";
import { assertDispatchOwnership, type DispatchAgent } from "./ownership.js";
const root = { id: "root", labels: {} };
const ea = { id: "ea", labels: { role: "executive-assistant", "paseo.parent-agent-id": "root" } };
const worker = { id: "worker", labels: { "paseo.parent-agent-id": "ea" } };
function check(
  caller: DispatchAgent,
  tool: string,
  target: DispatchAgent | null = null,
  labels = {},
) {
  assertDispatchOwnership({
    caller,
    tool,
    target,
    labels,
    hasExecutiveAssistant: caller.id === "root",
    workerCount: 0,
  });
}
test("EA retains dispatch ownership across subsequent root and worker calls", () => {
  check(ea, "create_agent");
  check(ea, "send_agent_prompt", worker);
  check(root, "send_agent_prompt", ea);
  check(ea, "send_agent_prompt", root);
  check(worker, "send_agent_prompt", ea);
  expect(() => check(root, "create_agent")).toThrow("executive assistant");
  expect(() => check(root, "send_agent_prompt", worker)).toThrow();
  expect(() => check(worker, "create_agent")).toThrow();
  expect(() => check(worker, "create_schedule")).toThrow();
  expect(() => check(worker, "update_agent", worker, { role: "executive-assistant" })).toThrow();
  expect(() => check(ea, "create_agent", null, { role: "executive-assistant" })).toThrow();
});
