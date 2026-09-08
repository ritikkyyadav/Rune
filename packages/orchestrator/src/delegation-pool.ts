import type { ToolHandler, ToolCallInput, ToolCallOutput } from "@rune/tool-registry";

/** One engine-wide pool, including tasks dispatched inside workflow nodes. */
export class DelegationPool {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  wrap(handler: ToolHandler): ToolHandler {
    return { ...handler, execute: (input) => this.execute(handler, input) };
  }

  private async execute(handler: ToolHandler, input: ToolCallInput): Promise<ToolCallOutput> {
    let admitted = false;
    await new Promise<void>((resolve) => {
      const enter = () => {
        if (input.signal?.aborted) {
          cleanup();
          resolve();
          return;
        }
        if (this.active >= this.limit()) return;
        cleanup();
        this.active++;
        admitted = true;
        resolve();
      };
      const cleanup = () => {
        input.signal?.removeEventListener("abort", enter);
        this.waiting = this.waiting.filter((wake) => wake !== enter);
      };
      this.waiting.push(enter);
      input.signal?.addEventListener("abort", enter, { once: true });
      enter();
    });
    if (!admitted)
      return {
        toolName: input.toolName,
        callId: input.callId,
        success: false,
        result: "",
        error: "Delegation cancelled before it started.",
        durationMs: 0,
      };
    try {
      return await handler.execute(input);
    } finally {
      this.active--;
      for (const wake of [...this.waiting]) wake();
    }
  }
}
