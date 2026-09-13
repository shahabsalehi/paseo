import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

export interface DispatchAgent {
  id: string;
  labels: Record<string, string>;
}

export class DispatchOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchOwnershipError";
  }
}

const automation = new Set([
  "create_schedule",
  "update_schedule",
  "resume_schedule",
  "run_schedule_once",
  "create_heartbeat",
  "pause_schedule",
  "delete_schedule",
]);
const control = new Set([
  "send_agent_prompt",
  "update_agent",
  "set_agent_mode",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
]);

export function assertDispatchOwnership(input: {
  caller: DispatchAgent;
  tool: string;
  target: DispatchAgent | null;
  labels: Record<string, string>;
  hasExecutiveAssistant: boolean;
  workerCount: number;
}): void {
  const { caller, tool, target, labels, hasExecutiveAssistant, workerCount } = input;
  const parent = caller.labels[PARENT_AGENT_ID_LABEL];
  const executive = caller.labels.role === "executive-assistant";
  const worker = Boolean(parent) && !executive;
  if (
    tool === "update_agent" &&
    Object.keys(labels).some((key) => key === "role" || key === PARENT_AGENT_ID_LABEL)
  ) {
    throw new DispatchOwnershipError(
      "Dispatch roles and parentage cannot be changed by an agent tool.",
    );
  }
  if (tool === "create_agent") {
    assertCreateOwnership({ worker, executive, hasExecutiveAssistant, workerCount, labels });
  }
  if (worker && automation.has(tool)) {
    throw new DispatchOwnershipError("Workers cannot schedule or dispatch further work.");
  }
  if (!control.has(tool)) return;
  if (!target) throw new DispatchOwnershipError("Dispatch target could not be resolved.");
  if (tool === "send_agent_prompt" && target.id === parent) return;
  if (worker) {
    throw new DispatchOwnershipError(
      "Workers may report to their dispatcher but cannot control agents.",
    );
  }
  if (target.labels[PARENT_AGENT_ID_LABEL] !== caller.id) {
    throw new DispatchOwnershipError("An agent may only control its own direct children.");
  }
  if (!executive && hasExecutiveAssistant && target.labels.role !== "executive-assistant") {
    throw new DispatchOwnershipError("Worker control belongs to your executive assistant.");
  }
}

function assertCreateOwnership(input: {
  worker: boolean;
  executive: boolean;
  hasExecutiveAssistant: boolean;
  workerCount: number;
  labels: Record<string, string>;
}): void {
  const { worker, executive, hasExecutiveAssistant, workerCount, labels } = input;
  if (worker)
    throw new DispatchOwnershipError(
      "Workers cannot create agents; return the task to your dispatcher.",
    );
  if (labels.role === "executive-assistant") {
    if (executive || hasExecutiveAssistant)
      throw new DispatchOwnershipError(
        "Only a root without an executive assistant may create one.",
      );
    return;
  }
  if (!executive && (hasExecutiveAssistant || workerCount >= 1)) {
    throw new DispatchOwnershipError(
      "Send the approved work plan to your executive assistant for dispatch.",
    );
  }
}

export function isDispatchControlTool(tool: string): boolean {
  return tool === "create_agent" || control.has(tool) || automation.has(tool);
}
