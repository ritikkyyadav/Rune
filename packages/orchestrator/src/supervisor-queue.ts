/** Background review has its own bounded admission and batching policy. */
export class ReviewSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit = 2) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const enter = () => {
        this.active++;
        resolve();
      };
      if (this.active < this.limit) enter();
      else this.waiting.push(enter);
    });
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface SupervisedItem {
  /** Exact action, never a broad permission pattern. */
  key: string;
  /** Authorization / workspace-mutation epoch: batches never cross it. */
  epoch: number;
  chars: number;
  /**
   * Stamped by the queue on admission and again when the item leaves for a
   * batch — never set by the caller. Until these existed, how long an
   * observation sat behind a slow reviewer was the one reviewer number nothing
   * recorded: the audit row showed a `supervisor_skipped` with a count of
   * waiting observations and no way to say whether they had been waiting a
   * hundred milliseconds or a minute.
   */
  enqueuedAt?: number;
  dequeuedAt?: number;
}

/**
 * Every admitted action remains in a batch. Identical actions share a review
 * only inside that batch; there is no cached approval for later execution.
 * A full queue refuses admission of a NEW shape instead of dropping an
 * admitted observation or growing without bound; a repeat of a shape that is
 * already waiting rides along, because it costs the batch nothing. What a
 * refusal means is the caller's decision — Auto lets the action run under
 * the mechanical breakers and records that nobody watched it. Batching runs
 * off the ordinary tool's critical path.
 */
export class SupervisorQueue<T extends SupervisedItem> {
  private readonly pending: T[] = [];
  private running: Promise<void> | undefined;

  private lastWait = 0;

  constructor(
    private readonly review: (batch: T[]) => Promise<void>,
    private readonly maxPending = 64,
    private readonly now: () => number = () => performance.now(),
  ) {}

  enqueue(item: T): boolean {
    if (this.pending.length >= this.maxPending) {
      const repeat = this.pending.some((waiting) => waiting.key === item.key);
      if (!repeat || this.pending.length >= this.maxPending * 4) return false;
    }
    item.enqueuedAt = this.now();
    this.pending.push(item);
    if (!this.running) this.start();
    return true;
  }

  /**
   * How long the oldest observation still waiting has been in the queue, in
   * ms. This is the number a refusal is explained WITH — `size` says how many
   * are ahead, this says what that has cost so far.
   */
  oldestWaitMs(): number {
    const head = this.pending[0];
    if (head?.enqueuedAt === undefined) return 0;
    return Math.max(0, Math.round(this.now() - head.enqueuedAt));
  }

  /** The queue wait of the last observation to leave for a batch, in ms. */
  get lastWaitMs(): number {
    return this.lastWait;
  }

  /** Observations waiting for a batch — the number a refusal is explained with. */
  get size(): number {
    return this.pending.length;
  }

  private start(): void {
    this.running = this.flush().finally(() => {
      this.running = undefined;
      if (this.pending.length) this.start();
    });
  }

  private async flush(): Promise<void> {
    // Collect a short burst of parallel tool proposals, not a turn of model work.
    await new Promise((resolve) => setTimeout(resolve, 10));
    while (this.pending.length) {
      const batch: T[] = [];
      const keys = new Set<string>();
      const epoch = this.pending[0]!.epoch;
      let chars = 0;
      while (this.pending.length) {
        const next = this.pending[0]!;
        const additional = keys.has(next.key) ? 0 : next.chars;
        if (
          batch.length &&
          (next.epoch !== epoch ||
            (!keys.has(next.key) && keys.size >= 8) ||
            chars + additional > 24_000)
        )
          break;
        const leaving = this.pending.shift()!;
        leaving.dequeuedAt = this.now();
        if (leaving.enqueuedAt !== undefined)
          this.lastWait = Math.max(0, Math.round(leaving.dequeuedAt - leaving.enqueuedAt));
        batch.push(leaving);
        keys.add(next.key);
        chars += additional;
      }
      // The caller records classifier outages; one failed review must not strand
      // later admitted observations or create an unhandled rejected promise.
      try {
        await this.review(batch);
      } catch {
        /* recorded by the reviewer */
      }
    }
  }

  async drain(): Promise<void> {
    while (this.running) await this.running;
  }
}
