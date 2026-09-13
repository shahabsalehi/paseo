export class UnconfirmedRuntimeCloseError extends Error {
  constructor(options: ErrorOptions) {
    super(
      "Provider runtime termination could not be confirmed; capacity remains reserved",
      options,
    );
    this.name = "UnconfirmedRuntimeCloseError";
  }
}

export class RuntimeCapacityError extends Error {
  constructor(public readonly reason: string) {
    super(
      `Dispatch deferred: ${reason}. No new provider work was started; retry through the dispatch queue.`,
    );
    this.name = "RuntimeCapacityError";
  }
}

export interface RuntimeLimits {
  maxResident: number;
  coordinatorReserve: number;
  maxExecuting: number;
  maxWorkers: number;
  idleMs: number;
  maxWarmWorkers: number;
  checkMemory: () => Promise<void>;
  ompConfigPath?: string;
}

export const DEFAULT_RUNTIME_LIMITS = {
  maxResident: 8,
  coordinatorReserve: 2,
  maxExecuting: 6,
  maxWorkers: 4,
  idleMs: 120_000,
  maxWarmWorkers: 2,
};

// Reservations are made before yielding. Opening providers is serialized so
// the next memory sample observes the previous launch's actual allocation.
export class RuntimeAdmission {
  private readonly resident = new Map<string, boolean>();
  private readonly executing = new Map<string, boolean>();
  private opening: Promise<unknown> = Promise.resolve();

  constructor(readonly limits: RuntimeLimits) {}

  async open<T>(id: string, worker: boolean, operation: () => Promise<T>): Promise<T> {
    if (this.resident.has(id))
      throw new RuntimeCapacityError("runtime already opening or resident");
    const workers = [...this.resident.values()].filter(Boolean).length;
    if (
      this.resident.size >= this.limits.maxResident ||
      (worker && workers >= this.limits.maxResident - this.limits.coordinatorReserve)
    ) {
      throw new RuntimeCapacityError("resident runtime limit reached");
    }
    this.resident.set(id, worker);
    const opening = this.opening
      .catch(() => undefined)
      .then(async () => {
        await this.limits.checkMemory();
        return operation();
      });
    this.opening = opening;
    try {
      return await opening;
    } catch (error) {
      if (!(error instanceof UnconfirmedRuntimeCloseError)) this.resident.delete(id);
      throw error;
    }
  }

  beginTurn(id: string, worker: boolean): void {
    if (this.executing.has(id)) return;
    const workers = [...this.executing.values()].filter(Boolean).length;
    if (
      this.executing.size >= this.limits.maxExecuting ||
      (worker && workers >= this.limits.maxWorkers)
    ) {
      throw new RuntimeCapacityError("executing worker limit reached");
    }
    this.executing.set(id, worker);
  }

  endTurn(id: string): void {
    this.executing.delete(id);
  }

  closed(id: string): void {
    this.resident.delete(id);
    this.executing.delete(id);
  }
}
