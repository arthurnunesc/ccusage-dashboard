import { describe, expect, test } from "bun:test";
import {
  normalizeReport,
  ReportCompatibilityError,
} from "../../src/normalize.js";
import fixture from "../fixtures/unified-daily.json";

/** @returns {any} */
function report() {
  return structuredClone(fixture);
}

describe("normalizeReport", () => {
  test("normalizes nested agents without double counting top-level rows", () => {
    const snapshot = normalizeReport(report(), {
      generatedAt: "2026-01-10T00:00:00.000Z",
      offline: true,
    });
    expect(snapshot.days).toHaveLength(1);
    expect(snapshot.days[0]).toMatchObject({
      date: "2026-01-09",
      agent: "claude",
      totalTokens: 185,
      costUsd: 0.12,
    });
    expect(snapshot.days[0].models[0]).toMatchObject({
      model: "claude-sonnet-4-20250514",
      totalTokens: 185,
      attribution: "model",
    });
    expect(snapshot.generatedAt).toBe("2026-01-10T00:00:00.000Z");
  });

  test("keeps extra tokens as unattributed other tokens", () => {
    const value = report();
    value.daily[0].agents[0].totalTokens = 190;
    value.daily[0].totalTokens = 190;
    value.totals.totalTokens = 190;
    const snapshot = normalizeReport(value);
    expect(snapshot.days[0].models.at(-1)).toMatchObject({
      model: "Unattributed usage",
      totalTokens: 5,
      otherTokens: 5,
      attribution: "unattributed",
    });
  });

  test("aggregates repeated models and makes category/cost residuals visible", () => {
    const value = report();
    const agent = value.daily[0].agents[0];
    agent.modelBreakdowns.push({
      modelName: "claude-sonnet-4-20250514",
      inputTokens: 10,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cost: 0.01,
    });
    agent.inputTokens = 110;
    agent.totalTokens = 195;
    agent.totalCost = 0.13;
    value.daily[0].inputTokens = 110;
    value.daily[0].totalTokens = 195;
    value.daily[0].totalCost = 0.13;
    value.totals.inputTokens = 110;
    value.totals.totalTokens = 195;
    value.totals.totalCost = 0.13;
    const models = normalizeReport(value).days[0].models;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      inputTokens: 110,
      totalTokens: 195,
      costUsd: 0.13,
    });
  });

  test("preserves missing pricing independently from positive partial cost", () => {
    const value = report();
    value.daily[0].agents[0].modelBreakdowns[0].missingPricing = true;
    const snapshot = normalizeReport(value);
    expect(snapshot.days[0].models[0].missingPricing).toBe(true);
    expect(snapshot.days[0].models[0].costUsd).toBe(0.12);
    expect(snapshot.warnings.join(" ")).toContain("known subtotals");
  });

  test("accepts empty reports and rejects incompatible totals, dates, and duplicates", () => {
    expect(
      normalizeReport({
        daily: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          totalCost: 0,
        },
      }).days,
    ).toEqual([]);
    const invalidDate = report();
    invalidDate.daily[0].period = "2026-02-31";
    expect(() => normalizeReport(invalidDate)).toThrow(
      ReportCompatibilityError,
    );
    const mismatch = report();
    mismatch.totals.totalTokens = 184;
    expect(() => normalizeReport(mismatch)).toThrow(ReportCompatibilityError);
    const duplicate = report();
    duplicate.daily[0].agents.push(
      structuredClone(duplicate.daily[0].agents[0]),
    );
    duplicate.daily[0].inputTokens *= 2;
    duplicate.daily[0].outputTokens *= 2;
    duplicate.daily[0].cacheCreationTokens *= 2;
    duplicate.daily[0].cacheReadTokens *= 2;
    duplicate.daily[0].totalTokens *= 2;
    duplicate.daily[0].totalCost *= 2;
    duplicate.totals = structuredClone(duplicate.daily[0]);
    expect(() => normalizeReport(duplicate)).toThrow("duplicate date/agent");
  });

  test("rejects unsafe, negative, and model-overflow values", () => {
    const unsafe = report();
    unsafe.daily[0].agents[0].inputTokens = Number.MAX_SAFE_INTEGER + 1;
    expect(() => normalizeReport(unsafe)).toThrow("safe integer");
    const negative = report();
    negative.daily[0].agents[0].totalCost = -1;
    expect(() => normalizeReport(negative)).toThrow("finite nonnegative");
    const over = report();
    over.daily[0].agents[0].modelBreakdowns[0].inputTokens = 101;
    expect(() => normalizeReport(over)).toThrow("modelBreakdowns exceed");
  });
});

test("all motivating, named, and unknown tools; prefixes and unknown fields", () => {
  const value = report();
  const day = value.daily[0];
  day.agents = [
    "claude",
    "codex",
    "opencode",
    "pi",
    "pi:lab",
    "future-tool",
  ].map((agent) => ({
    ...structuredClone(day.agents[0]),
    agent,
    modelBreakdowns: [
      {
        ...day.agents[0].modelBreakdowns[0],
        modelName: "[pi] exact/prefix",
        futureField: 42,
      },
    ],
  }));
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "totalTokens",
    "totalCost",
  ]) {
    day[key] *= 6;
    value.totals[key] *= 6;
  }
  value.future = { ignored: true };
  const normalized = normalizeReport(value);
  expect(normalized.days).toHaveLength(6);
  expect(
    normalized.days.every((day) => day.models[0].model === "[pi] exact/prefix"),
  ).toBe(true);
});

test("category/cost residuals, omitted exported fields, and float-only residuals", () => {
  const value = report();
  delete value.daily[0].agents[0].modelBreakdowns[0].inputTokens;
  delete value.daily[0].agents[0].modelBreakdowns[0].cost;
  const residual = normalizeReport(value).days[0].models.at(-1);
  expect(residual).toMatchObject({
    attribution: "unattributed",
    inputTokens: 100,
    totalTokens: 100,
    costUsd: 0.12,
  });
  const rounding = report();
  rounding.daily[0].agents[0].modelBreakdowns[0].cost -= 1e-10;
  expect(normalizeReport(rounding).days[0].models).toHaveLength(1);
});

test("unpriced totals labels and positive/zero missing costs remain separate", () => {
  const value = report();
  value.totals.unpricedModels = [
    value.daily[0].agents[0].modelBreakdowns[0].modelName,
  ];
  expect(normalizeReport(value).days[0].models[0].missingPricing).toBe(true);
  for (const row of [value.daily[0], value.daily[0].agents[0], value.totals])
    row.totalCost = 0;
  value.daily[0].agents[0].modelBreakdowns[0].cost = 0;
  expect(normalizeReport(value).days[0].models[0]).toMatchObject({
    costUsd: 0,
    missingPricing: true,
  });
});

test("required arrays, valid calendars, numeric types and material cost conflicts", () => {
  /** @type {((value:any)=>void)[]} */
  const mutations = [
    (value) => delete value.daily[0].agents,
    (value) => (value.daily[0].agents[0].agent = ""),
    (value) => (value.daily[0].period = "2025-02-29"),
    (value) => (value.daily[0].period = "not-a-date"),
    (value) => (value.daily[0].agents[0].modelsUsed = {}),
    (value) => (value.daily[0].agents[0].modelBreakdowns = null),
    (value) => (value.daily[0].agents[0].outputTokens = 0.5),
    (value) => (value.daily[0].agents[0].totalCost = Infinity),
    (value) => (value.daily[0].agents[0].totalCost = NaN),
    (value) => (value.daily[0].agents[0].modelBreakdowns[0].cost = 0.5),
    (value) =>
      (value.daily[0].agents[0].modelBreakdowns[0].missingPricing = "yes"),
    (value) => (value.totals.unpricedModels = [null]),
  ];
  for (const mutate of mutations) {
    const value = report();
    mutate(value);
    expect(() => normalizeReport(value)).toThrow(ReportCompatibilityError);
  }
  const leap = report();
  leap.daily[0].period = "2024-02-29";
  expect(normalizeReport(leap).days[0].date).toBe("2024-02-29");
});

test("accumulated unsafe totals are rejected", () => {
  const value = report();
  const day = value.daily[0];
  day.inputTokens = Number.MAX_SAFE_INTEGER;
  day.totalTokens = Number.MAX_SAFE_INTEGER;
  day.outputTokens = day.cacheCreationTokens = day.cacheReadTokens = 0;
  day.agents = [
    { ...day, agent: "one", modelBreakdowns: [] },
    { ...day, agent: "two", modelBreakdowns: [] },
  ];
  expect(() => normalizeReport(value)).toThrow("safe integer range");
});
