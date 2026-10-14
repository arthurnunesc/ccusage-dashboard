#!/usr/bin/env bun

// Synthetic report generator. It never reads HOME, agent files, or credentials.
const models = [
  {
    agent: "claude",
    model: "claude-sonnet-synthetic",
    input: 1200000,
    output: 220000,
    cost: 0.12,
  },
  {
    agent: "codex",
    model: "same-model",
    input: 850000,
    output: 110000,
    cost: 0.08,
  },
  {
    agent: "opencode",
    model: "same-model",
    input: 400000,
    output: 180000,
    cost: 0.06,
  },
  {
    agent: "pi:lab",
    model: "[pi] <img src=x onerror=alert(1)>",
    input: 12000,
    output: 800,
    cost: 0,
    missing: true,
  },
];
const metrics = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "totalTokens",
  "totalCost",
];
const daily = ["2026-08-12", "2026-09-10", "2026-10-14"].map(
  (period, index) => {
    const agents = models.map((item) => {
      const model = {
        modelName: item.model,
        inputTokens: item.input * (index + 1),
        outputTokens: item.output * (index + 1),
        cacheCreationTokens: 1000,
        cacheReadTokens: 2000,
        cost: item.cost,
        missingPricing: !!item.missing,
      };
      return {
        agent: item.agent,
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        cacheCreationTokens: 1000,
        cacheReadTokens: 2000,
        totalTokens:
          model.inputTokens +
          model.outputTokens +
          3000 +
          (item.agent === "claude" ? 100 : 0),
        totalCost: model.cost,
        modelsUsed: [item.model],
        modelBreakdowns: [model],
      };
    });
    return {
      period,
      agent: "all",
      ...Object.fromEntries(
        metrics.map((key) => [
          key,
          agents.reduce(
            (sum, item) =>
              sum + Number(item[/** @type {keyof typeof item} */ (key)]),
            0,
          ),
        ]),
      ),
      modelsUsed: models.map((item) => item.model),
      modelBreakdowns: [],
      metadata: { agents: models.map((item) => item.agent) },
      agents,
    };
  },
);
const totals = Object.fromEntries(
  metrics.map((key) => [
    key,
    daily.reduce(
      (sum, item) => sum + Number(item[/** @type {keyof typeof item} */ (key)]),
      0,
    ),
  ]),
);
console.log(JSON.stringify({ daily, totals }));
