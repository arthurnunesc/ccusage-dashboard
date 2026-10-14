import { describe, expect, test } from "bun:test";
import {
  calculateReport,
  resetMonthSort,
  sortRows,
} from "../../shared/report.js";

/**
 * @param {Partial<import("../../shared/report.js").DayUsage>} overrides
 */
function day(overrides = {}) {
  /** @type {import("../../shared/report.js").DayUsage} */
  const base = {
    date: "2026-01-01",
    agent: "claude",
    inputTokens: 40,
    outputTokens: 20,
    cacheWriteTokens: 10,
    cacheReadTokens: 30,
    totalTokens: 100,
    costUsd: 1,
    models: [
      {
        model: "sonnet",
        inputTokens: 40,
        outputTokens: 20,
        cacheWriteTokens: 10,
        cacheReadTokens: 30,
        totalTokens: 100,
        costUsd: 1,
        missingPricing: false,
        attribution: "model",
      },
    ],
  };
  return { ...base, ...overrides };
}

describe("calculateReport", () => {
  test("keeps tool/model identities separate and day costs authoritative", () => {
    const report = calculateReport(
      [
        day({
          costUsd: 1.000000001,
          models: [{ ...day().models[0], costUsd: 1 }],
        }),
        day({
          date: "2026-02-01",
          agent: "codex",
          totalTokens: 200,
          costUsd: 2,
          models: [
            {
              ...day().models[0],
              model: "sonnet",
              inputTokens: 100,
              outputTokens: 40,
              cacheWriteTokens: 20,
              cacheReadTokens: 40,
              totalTokens: 200,
              costUsd: 2,
            },
          ],
        }),
      ],
      { now: new Date("2026-02-01T12:00:00Z") },
    );

    expect(report.tools).toEqual(["claude", "codex"]);
    expect(report.summary.allTime.costUsd).toBe(3.000000001);
    expect(report.allTimeRows).toHaveLength(2);
    expect(report.allTimeRows.map((row) => [row.agent, row.model])).toEqual([
      ["claude", "sonnet"],
      ["codex", "sonnet"],
    ]);
    expect(report.months.map((month) => month.month)).toEqual([
      "2026-01",
      "2026-02",
    ]);
    expect(report.months[0].costUsd).toBe(1.000000001);
    expect(report.months[0].segments[0].costUsd).toBe(1);
    expect(report.allTimeRows[0]).toMatchObject({
      calls: null,
      reasoningTokens: null,
      provider: null,
      recordedCost: null,
      attribution: "model",
    });
  });

  test("uses the UTC today/prior-29-day window and active-day denominator", () => {
    const report = calculateReport(
      [
        day({
          date: "2026-01-02",
          totalTokens: 999,
          costUsd: 9.99,
          models: [
            {
              ...day().models[0],
              totalTokens: 999,
              inputTokens: 899,
              costUsd: 9.99,
            },
          ],
        }),
        day({ date: "2026-01-03", totalTokens: 100, costUsd: 1 }),
        day({ date: "2026-02-01", totalTokens: 100, costUsd: 3 }),
        day({
          date: "2026-02-02",
          totalTokens: 900,
          costUsd: 9,
          models: [
            {
              ...day().models[0],
              totalTokens: 900,
              inputTokens: 840,
              costUsd: 9,
            },
          ],
        }),
      ],
      { now: new Date("2026-02-01T23:59:59Z") },
    );

    expect(report.rolling).toMatchObject({
      totalTokens: 200,
      costUsd: 4,
      activeDays: 2,
      averageTokensPerActiveDay: 100,
      averageCostPerActiveDay: 2,
      costPerMillion: 20_000,
      busiestDay: { date: "2026-01-03", totalTokens: 100, costUsd: 1 },
      startDate: "2026-01-03",
      endDate: "2026-02-01",
    });
  });

  test("projects lifetime totals by inclusive observed calendar days", () => {
    const report = calculateReport(
      [day({ date: "2026-01-01" }), day({ date: "2026-01-03" })],
      { now: new Date("2026-02-01T00:00:00Z") },
    );

    expect(report.observedCalendarDays).toBe(3);
    expect(report.summary.typical30d.totalTokens).toBeCloseTo(2000);
    expect(report.summary.typical30d.costUsd).toBeCloseTo(20);
    expect(report.context).toMatchObject({ monthCount: 1, modelEntryCount: 1 });
  });

  test("keeps unattributed tokens and partial pricing in model rows and warnings", () => {
    const report = calculateReport(
      [
        day({
          totalTokens: 130,
          costUsd: 1.2,
          models: [
            day().models[0],
            {
              model: "Unattributed usage",
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              otherTokens: 30,
              totalTokens: 30,
              costUsd: 0.2,
              missingPricing: true,
              attribution: "unattributed",
            },
          ],
        }),
      ],
      { now: new Date("2026-01-01T00:00:00Z") },
    );

    expect(report.partialPricing).toBe(true);
    expect(
      report.allTimeRows.find((row) => row.attribution === "unattributed"),
    ).toMatchObject({
      otherTokens: 30,
      totalTokens: 30,
      missingPricing: true,
    });
    expect(report.dailyBreakdown[0]).toMatchObject({
      otherTokens: 30,
      totalTokens: 130,
    });
    expect(report.topModels.map((row) => row.model)).toEqual([
      "sonnet",
      "Unattributed usage",
    ]);
    expect(
      report.cards
        .filter((card) => card.metric === "costUsd")
        .every((card) => card.partialPricing),
    ).toBe(true);
  });

  test("returns no-data cards for an unmatched tool and does not divide by zero", () => {
    const report = calculateReport([day()], {
      agent: "missing-tool",
      now: new Date("2026-02-01T00:00:00Z"),
    });

    expect(report.hasData).toBe(false);
    expect(
      report.cards.every((card) => card.value === null && card.noData),
    ).toBe(true);
    expect(report.rolling).toMatchObject({
      totalTokens: 0,
      activeDays: 0,
      costPerMillion: 0,
    });
    expect(report.observedCalendarDays).toBe(0);
  });

  test("makes stale history a zero recent average", () => {
    const report = calculateReport([day({ date: "2025-01-01" })], {
      now: new Date("2026-02-01T00:00:00Z"),
    });

    expect(report.hasData).toBe(true);
    expect(report.rolling).toMatchObject({
      totalTokens: 0,
      costUsd: 0,
      activeDays: 0,
      averageTokensPerActiveDay: 0,
      averageCostPerActiveDay: 0,
      busiestDay: null,
    });
  });

  test("rejects invalid dates and unsafe accumulated token totals", () => {
    expect(() => calculateReport([day({ date: "2026-02-30" })])).toThrow(
      "Invalid UTC date",
    );
    expect(() =>
      calculateReport([day({ totalTokens: Number.MAX_SAFE_INTEGER + 1 })]),
    ).toThrow("nonnegative safe integer");
    expect(() =>
      calculateReport([
        day({ totalTokens: Number.MAX_SAFE_INTEGER }),
        day({ totalTokens: 100 }),
      ]),
    ).toThrow("Accumulated totalTokens");
  });
});

describe("table sorting", () => {
  test("unpriced zero cost is unavailable, not a sortable free amount", () => {
    const rows = [
      { costUsd: 0, missingPricing: true },
      { costUsd: 1, missingPricing: false },
    ];
    for (const direction of /** @type {const} */ (["asc", "desc"])) {
      expect(sortRows(rows, "costUsd", direction)[1]).toBe(rows[0]);
    }
  });
  test("sorts text and numeric values with stable ties and nulls last in both directions", () => {
    const rows = [
      { model: "z", costUsd: 2 },
      { model: "a", costUsd: null },
      { model: "b", costUsd: 2 },
      { model: "c", costUsd: 1 },
    ];

    expect(sortRows(rows).map((row) => row.model)).toEqual([
      "z",
      "b",
      "c",
      "a",
    ]);
    expect(sortRows(rows, "costUsd", "asc").map((row) => row.model)).toEqual([
      "c",
      "z",
      "b",
      "a",
    ]);
    expect(sortRows(rows, "model", "asc").map((row) => row.model)).toEqual([
      "a",
      "b",
      "c",
      "z",
    ]);
    expect(rows[0].model).toBe("z");
  });

  test("resets a month sort only in all-time mode", () => {
    expect(
      resetMonthSort({ key: "month", direction: "asc" }, "all-time"),
    ).toEqual({
      key: "costUsd",
      direction: "desc",
    });
    expect(
      resetMonthSort({ key: "month", direction: "asc" }, "per-month"),
    ).toEqual({
      key: "month",
      direction: "asc",
    });
  });
});

test("early UTC years, cost-only active dates, and recent pricing scope", () => {
  expect(
    calculateReport([day({ date: "0099-01-01" })], {
      now: new Date("0099-01-01T00:00:00Z"),
    }).rolling.activeDays,
  ).toBe(1);
  const costOnly = day({
    date: "2026-01-02",
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
  });
  const partial = day({
    date: "2025-01-01",
    models: [{ ...day().models[0], missingPricing: true }],
  });
  const view = calculateReport([costOnly, partial], {
    now: new Date("2026-01-02T00:00:00Z"),
  });
  expect(view.rolling.activeDays).toBe(1);
  expect(view.rolling.costPerMillion).toBe(0);
  expect(
    view.cards.find((card) => card.id === "rolling30dCostPerDay")
      ?.partialPricing,
  ).toBe(false);
  expect(
    view.cards.find((card) => card.id === "allTimeCost")?.partialPricing,
  ).toBe(true);
});

test("model identities including NUL and genuine residual labels stay separate", () => {
  const model = day().models[0];
  const view = calculateReport([
    day({ agent: "a", models: [{ ...model, model: "b\u0000c" }] }),
    day({ agent: "a\u0000b", models: [{ ...model, model: "c" }] }),
    day({
      models: [
        { ...model, model: "Unattributed usage" },
        { ...model, model: "Unattributed usage", attribution: "unattributed" },
      ],
    }),
  ]);
  expect(view.allTimeRows).toHaveLength(4);
});

test("ranking is top three with exact identity ties; one-day projection is 30x", () => {
  const view = calculateReport([
    day({ agent: "d" }),
    day({ agent: "b" }),
    day({ agent: "c" }),
    day({ agent: "a" }),
  ]);
  expect(view.topModels.map((row) => row.agent)).toEqual(["a", "b", "c"]);
  expect(view.summary.typical30d.totalTokens).toBe(12000);
  expect(view.summary.typical30d.costUsd).toBe(120);
});

test("UTC year rollover and finite derived results", () => {
  const view = calculateReport(
    [day({ date: "2025-12-31" }), day({ date: "2026-01-01" })],
    { now: new Date("2026-01-01T00:00:00Z") },
  );
  expect(view.rolling.activeDays).toBe(2);
  expect(() =>
    calculateReport([day({ costUsd: Number.MAX_VALUE, models: [] })]),
  ).toThrow("Projected cost");
});
