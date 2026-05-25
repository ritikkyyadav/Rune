import { Engine } from "./engine";
import type { EngineConfig } from "./engine";

export interface ProductionEngineConfig extends Partial<EngineConfig> {
  healthCheckIntervalMs?: number;
  onHealthChange?: (healthy: boolean) => void;
}

export class ProductionEngine {
  private engine: Engine;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private onHealthChange?: (healthy: boolean) => void;

  constructor(config: ProductionEngineConfig = {}) {
    const { healthCheckIntervalMs, onHealthChange, ...engineConfig } = config;

    // Production defaults: all subsystems enabled, security on
    this.engine = new Engine({
      enableSecurity: true,
      enableRateLimiting: true,
      enableCheckpoints: true,
      redactOutputs: true,
      ...engineConfig,
    });
    this.onHealthChange = onHealthChange;

    if (healthCheckIntervalMs && healthCheckIntervalMs > 0) {
      this.healthTimer = setInterval(() => {
        void this.healthCheck().then((healthy) => {
          this.onHealthChange?.(healthy);
        });
      }, healthCheckIntervalMs);
    }
  }

  get inner(): Engine {
    return this.engine;
  }

  async healthCheck(): Promise<boolean> {
    const providers = this.engine.getRegisteredProviders();
    return providers.length > 0;
  }

  getContextUsage() {
    return this.engine.getContextUsage();
  }

  getSecurityPosture() {
    return this.engine.getSecurityPosture();
  }

  getAuditStats() {
    return this.engine.getAuditStats();
  }

  getCostBreakdown() {
    return this.engine.getCostBreakdown();
  }

  close(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.engine.close();
  }
}
