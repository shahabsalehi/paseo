import { expect, test } from "vitest";
import {
  RuntimeAdmission,
  DEFAULT_RUNTIME_LIMITS,
  UnconfirmedRuntimeCloseError,
} from "./admission.js";

test("simultaneous provider launches reserve slots before memory checks resolve", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let launches = 0;
  const gate = new RuntimeAdmission({ ...DEFAULT_RUNTIME_LIMITS, checkMemory: () => pending });
  const opens = Array.from({ length: 20 }, (_, id) =>
    gate.open(String(id), true, async () => {
      launches++;
    }),
  );
  const results = Promise.allSettled(opens);
  expect(launches).toBe(0);
  release();
  expect((await results).filter((result) => result.status === "fulfilled")).toHaveLength(6);
  expect(launches).toBe(6);
  await gate.open("root", false, async () => {});
  await gate.open("ea", false, async () => {});
  await expect(gate.open("extra", false, async () => {})).rejects.toThrow("resident runtime limit");
});

test("failed memory checks and provider launches release their reservation", async () => {
  let healthy = false;
  const gate = new RuntimeAdmission({
    ...DEFAULT_RUNTIME_LIMITS,
    checkMemory: async () => {
      if (!healthy) throw new Error("pressure");
    },
  });
  await expect(gate.open("one", true, async () => {})).rejects.toThrow("pressure");
  healthy = true;
  await expect(
    gate.open("one", true, async () => {
      throw new Error("launch failed");
    }),
  ).rejects.toThrow("launch failed");
  await gate.open("one", true, async () => {});
  gate.closed("one");
  await gate.open("one", true, async () => {});
});

test("four workers share a global turn cap and leave coordinator capacity", () => {
  const gate = new RuntimeAdmission({ ...DEFAULT_RUNTIME_LIMITS, checkMemory: async () => {} });
  for (const id of ["omp", "codex", "grok", "other"]) gate.beginTurn(id, true);
  expect(() => gate.beginTurn("fifth", true)).toThrow("executing worker limit");
  gate.beginTurn("root", false);
  gate.beginTurn("ea", false);
  expect(() => gate.beginTurn("extra", false)).toThrow("executing worker limit");
  gate.endTurn("omp");
  gate.beginTurn("fifth", true);
});

test("an unconfirmed provider shutdown does not free a resident slot", async () => {
  const gate = new RuntimeAdmission({
    ...DEFAULT_RUNTIME_LIMITS,
    maxResident: 1,
    coordinatorReserve: 0,
    checkMemory: async () => {},
  });
  await expect(
    gate.open("stuck", true, async () => {
      throw new UnconfirmedRuntimeCloseError({ cause: new Error("close failed") });
    }),
  ).rejects.toThrow("termination could not be confirmed");
  await expect(gate.open("replacement", true, async () => {})).rejects.toThrow(
    "resident runtime limit",
  );
});

test("a registration error cannot release a runtime already owned by the manager", async () => {
  const gate = new RuntimeAdmission(
    {
      ...DEFAULT_RUNTIME_LIMITS,
      maxResident: 1,
      coordinatorReserve: 0,
      checkMemory: async () => {},
    },
    () => true,
  );
  await expect(
    gate.open("registered", true, async () => {
      throw new Error("snapshot persistence failed");
    }),
  ).rejects.toThrow("snapshot persistence failed");
  await expect(gate.open("extra", true, async () => {})).rejects.toThrow("resident runtime limit");
});
