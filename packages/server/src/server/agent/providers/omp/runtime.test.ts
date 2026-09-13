import { expect, test } from "vitest";

import { buildOmpLaunch } from "./runtime.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("falls back to progress when the event subscription is unavailable", async () => {
  const omp = new OmpHarness();
  omp.failEventSubscription(new Error("events unsupported"));
  await omp.start();

  await expect(omp.waitForSubscriptionFallback()).resolves.toEqual(["events", "progress"]);
});

test("managed dispatch disables native task recursion on create and resume", () => {
  for (const session of [undefined, "/tmp/saved-session.jsonl"]) {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/tmp",
        session,
        env: { PASEO_MANAGED_DISPATCH: "1", PASEO_OMP_DISPATCH_CONFIG: "/tmp/managed.yml" },
      },
    });
    expect(launch.argv.slice(-2)).toEqual(["--config", "/tmp/managed.yml"]);
  }
});
