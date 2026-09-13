import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { DEFAULT_RUNTIME_LIMITS, RuntimeCapacityError, type RuntimeLimits } from "./admission.js";

const execute = promisify(execFile);

export function runtimeLimitsFromEnvironment(env: NodeJS.ProcessEnv): RuntimeLimits | undefined {
  if (env.PASEO_RUNTIME_LIMITS !== "1") return undefined;
  const command = env.PASEO_CAPACITY_COMMAND;
  if (!command || !isAbsolute(command)) {
    throw new Error("PASEO_RUNTIME_LIMITS requires an absolute PASEO_CAPACITY_COMMAND");
  }
  const ompConfigPath = env.PASEO_OMP_DISPATCH_CONFIG;
  if (!ompConfigPath || !isAbsolute(ompConfigPath)) {
    throw new Error("PASEO_RUNTIME_LIMITS requires an absolute PASEO_OMP_DISPATCH_CONFIG");
  }
  return {
    ...DEFAULT_RUNTIME_LIMITS,
    ompConfigPath,
    async checkMemory(continuation = false) {
      try {
        await execute(command, continuation ? ["--continuation"] : [], {
          env: { ...env, PA_CAPACITY_MEMORY_ONLY: "1" },
          timeout: 12_000,
          maxBuffer: 16_384,
        });
      } catch {
        throw new RuntimeCapacityError("memory admission check deferred or unavailable");
      }
    },
  };
}
