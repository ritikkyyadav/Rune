export interface AlanConfig {
  engine: {
    socketPath: string;
    logDir: string;
    dbPath: string;
    maxSessions: number;
  };
  llm: {
    defaultProvider: "anthropic" | "openai" | "ollama";
    anthropic?: {
      apiKey: string;
      model: string;
      maxTokens: number;
    };
    openai?: {
      apiKey: string;
      model: string;
      maxTokens: number;
    };
    ollama?: {
      baseUrl: string;
      model: string;
    };
    planner?: {
      provider: string;
      model: string;
    };
    executor?: {
      provider: string;
      model: string;
    };
  };
  permissions: {
    defaultLevel: "auto" | "confirm" | "sandbox";
    rules: PermissionRule[];
  };
  sandbox: {
    enabled: boolean;
    networkDeny: boolean;
    fsAllowlist: string[];
  };
}

export interface PermissionRule {
  tool: string;
  level: "auto" | "confirm" | "sandbox";
  pattern?: string;
  scope: "session" | "project" | "global";
}
