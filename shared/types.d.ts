export interface Config {
  port: number;
  configPath: string;
  offline: boolean;
  cacheTtlMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
  binary?: string;
}

export interface Model {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  otherTokens?: number;
  totalTokens: number;
  costUsd: number;
  missingPricing: boolean;
  attribution: "model" | "unattributed";
}

export interface Day {
  date: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  models: Model[];
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  stale: boolean;
  warnings: string[];
  metadata: {
    ccusageVersion: string;
    offline: boolean;
    pricingMode: "auto";
    limitations: string[];
  };
  days: Day[];
}
