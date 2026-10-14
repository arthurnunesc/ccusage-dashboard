import { colorFor } from "./format.js";

/**
 * @typedef {Object} ModelUsage
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheWriteTokens
 * @property {number} cacheReadTokens
 * @property {number} totalTokens
 * @property {number} costUsd
 * @property {boolean} missingPricing
 * @property {"model" | "unattributed"} attribution
 * @property {number} [otherTokens]
 */

/**
 * @typedef {Object} DayUsage
 * @property {string} date UTC calendar date in YYYY-MM-DD form.
 * @property {string} agent
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheWriteTokens
 * @property {number} cacheReadTokens
 * @property {number} totalTokens
 * @property {number} costUsd
 * @property {ModelUsage[]} models
 */

/** @typedef {{ inputTokens: number, outputTokens: number, cacheWriteTokens: number, cacheReadTokens: number, otherTokens: number, totalTokens: number, costUsd: number }} Totals */

const EMPTY_TOTALS = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  otherTokens: 0,
  totalTokens: 0,
  costUsd: 0,
});

const DAY_MS = 86_400_000;
const DEFAULT_SORT = Object.freeze({ key: "costUsd", direction: "desc" });

/** @param {string} left @param {string} right */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {unknown} value @param {string} name @returns {number} */
function nonNegativeSafeInteger(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

/** @param {unknown} value @param {string} name @returns {number} */
function nonNegativeFinite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite nonnegative number`);
  }
  return value;
}

/** @param {string} date */
function utcTimestamp(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError(`Invalid UTC date: ${date}`);
  }
  const [year, month, day] = date.split("-").map(Number);
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError(`Invalid UTC date: ${date}`);
  }
  return timestamp;
}

/** @param {Totals} current @param {Totals} addition */
function addTotals(current, addition) {
  /** @type {Totals} */
  const result = { ...EMPTY_TOTALS };
  /** @type {(keyof Omit<Totals, "costUsd">)[]} */
  const tokenKeys = [
    "inputTokens",
    "outputTokens",
    "cacheWriteTokens",
    "cacheReadTokens",
    "otherTokens",
    "totalTokens",
  ];
  for (const key of tokenKeys) {
    const value = current[key] + addition[key];
    result[key] = nonNegativeSafeInteger(value, `Accumulated ${key}`);
  }
  result.costUsd = nonNegativeFinite(
    current.costUsd + addition.costUsd,
    "Accumulated costUsd",
  );
  return result;
}

/** @param {ModelUsage} model @param {string} context */
function modelTotals(model, context) {
  if (
    !model ||
    typeof model !== "object" ||
    typeof model.model !== "string" ||
    !model.model
  ) {
    throw new TypeError(`${context}.model must be a nonempty string`);
  }
  if (model.attribution !== "model" && model.attribution !== "unattributed") {
    throw new TypeError(`${context}.attribution is invalid`);
  }
  const inputTokens = nonNegativeSafeInteger(
    model.inputTokens,
    `${context}.inputTokens`,
  );
  const outputTokens = nonNegativeSafeInteger(
    model.outputTokens,
    `${context}.outputTokens`,
  );
  const cacheWriteTokens = nonNegativeSafeInteger(
    model.cacheWriteTokens,
    `${context}.cacheWriteTokens`,
  );
  const cacheReadTokens = nonNegativeSafeInteger(
    model.cacheReadTokens,
    `${context}.cacheReadTokens`,
  );
  const totalTokens = nonNegativeSafeInteger(
    model.totalTokens,
    `${context}.totalTokens`,
  );
  const knownCategories = nonNegativeSafeInteger(
    inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
    `${context} category total`,
  );
  if (typeof model.missingPricing !== "boolean") {
    throw new TypeError(`${context}.missingPricing must be a boolean`);
  }
  const otherTokens = nonNegativeSafeInteger(
    model.otherTokens ?? Math.max(0, totalTokens - knownCategories),
    `${context}.otherTokens`,
  );
  if (
    nonNegativeSafeInteger(
      knownCategories + otherTokens,
      `${context} category total`,
    ) !== totalTokens
  ) {
    throw new TypeError(`${context} token categories must equal totalTokens`);
  }
  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    otherTokens,
    totalTokens,
    costUsd: nonNegativeFinite(model.costUsd, `${context}.costUsd`),
  };
}

/** @param {DayUsage} day @param {number} index */
function checkedDay(day, index) {
  const context = `days[${index}]`;
  if (
    !day ||
    typeof day !== "object" ||
    typeof day.agent !== "string" ||
    !day.agent
  ) {
    throw new TypeError(`${context}.agent must be a nonempty string`);
  }
  const timestamp = utcTimestamp(day.date);
  if (!Array.isArray(day.models))
    throw new TypeError(`${context}.models must be an array`);
  const models = day.models.map((model, modelIndex) =>
    modelTotals(model, `${context}.models[${modelIndex}]`),
  );
  let otherTokens = 0;
  for (const model of models) {
    otherTokens = nonNegativeSafeInteger(
      otherTokens + model.otherTokens,
      `${context}.otherTokens`,
    );
  }
  const totals = {
    inputTokens: nonNegativeSafeInteger(
      day.inputTokens,
      `${context}.inputTokens`,
    ),
    outputTokens: nonNegativeSafeInteger(
      day.outputTokens,
      `${context}.outputTokens`,
    ),
    cacheWriteTokens: nonNegativeSafeInteger(
      day.cacheWriteTokens,
      `${context}.cacheWriteTokens`,
    ),
    cacheReadTokens: nonNegativeSafeInteger(
      day.cacheReadTokens,
      `${context}.cacheReadTokens`,
    ),
    otherTokens,
    totalTokens: nonNegativeSafeInteger(
      day.totalTokens,
      `${context}.totalTokens`,
    ),
    costUsd: nonNegativeFinite(day.costUsd, `${context}.costUsd`),
  };
  return {
    day,
    timestamp,
    totals,
    models,
  };
}

/** @param {Totals} totals */
function copyTotals(totals) {
  return { ...totals };
}

/** @param {string} agent @param {string} model @param {string} [month] @param {string} [attribution] */
function identity(agent, model, month, attribution = "model") {
  return JSON.stringify([month ?? "", agent, model, attribution]);
}

/** @param {Map<string, any>} entries @param {string} key @param {string} agent @param {ModelUsage} model @param {ReturnType<typeof modelTotals>} totals @param {string} [month] */
function addModelEntry(entries, key, agent, model, totals, month) {
  const current = entries.get(key);
  if (current) {
    current.totals = addTotals(current.totals, totals);
    current.missingPricing ||= model.missingPricing;
    if (current.attribution !== model.attribution)
      current.attribution = "model";
    return;
  }
  entries.set(key, {
    agent,
    model: model.model,
    month,
    totals: copyTotals(totals),
    missingPricing: model.missingPricing,
    attribution: model.attribution,
  });
}

/** @param {any} entry */
function tableRow(entry) {
  return {
    agent: entry.agent,
    tool: entry.agent,
    model: entry.model,
    ...(entry.month === undefined ? {} : { month: entry.month }),
    ...copyTotals(entry.totals),
    missingPricing: entry.missingPricing,
    attribution: entry.attribution,
    provider: null,
    calls: null,
    reasoningTokens: null,
    recordedCost: null,
  };
}

/** @param {any[]} rows */
function identityOrder(rows) {
  return rows.sort((left, right) =>
    compareText(
      identity(left.agent, left.model, left.month, left.attribution),
      identity(right.agent, right.model, right.month, right.attribution),
    ),
  );
}

/**
 * Create all display calculations from normalized ccusage daily records. It
 * deliberately uses authoritative agent/day totals for cards and daily totals,
 * while tool/model rows retain their authoritative normalized model categories.
 *
 * @param {DayUsage[]} days
 * @param {{ agent?: string, allTools?: boolean, now?: Date }} [options]
 */
export function calculateReport(
  days,
  { agent = "all", allTools = agent === "all", now = new Date() } = {},
) {
  if (!Array.isArray(days)) throw new TypeError("days must be an array");
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new TypeError("now must be a valid Date");

  const checkedDays = days.map(checkedDay);
  const tools = [...new Set(checkedDays.map(({ day }) => day.agent))].sort(
    compareText,
  );
  const selected = checkedDays.filter(
    ({ day }) => allTools || day.agent === agent,
  );
  const selectedWithUsage = selected.filter(
    ({ totals }) => totals.totalTokens > 0 || totals.costUsd > 0,
  );
  const hasData = selectedWithUsage.length > 0;
  const monthEntries = new Map();
  const allTimeEntries = new Map();
  const daily = new Map();
  let allTime = copyTotals(EMPTY_TOTALS);
  let partialPricing = false;

  for (const item of selected) {
    const { day, totals, models } = item;
    allTime = addTotals(allTime, totals);
    const month = day.date.slice(0, 7);
    const dailyCurrent = daily.get(day.date) ?? {
      date: day.date,
      timestamp: item.timestamp,
      totals: copyTotals(EMPTY_TOTALS),
      partialPricing: false,
    };
    dailyCurrent.totals = addTotals(dailyCurrent.totals, totals);
    for (let index = 0; index < day.models.length; index += 1) {
      const model = day.models[index];
      const modelTotal = models[index];
      partialPricing ||= model.missingPricing;
      dailyCurrent.partialPricing ||= model.missingPricing;
      addModelEntry(
        allTimeEntries,
        identity(day.agent, model.model, undefined, model.attribution),
        day.agent,
        model,
        modelTotal,
      );
      addModelEntry(
        monthEntries,
        identity(day.agent, model.model, month, model.attribution),
        day.agent,
        model,
        modelTotal,
        month,
      );
    }
    daily.set(day.date, dailyCurrent);
  }

  const dailyBreakdown = [...daily.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map(({ date, totals, partialPricing: missingPricing }) => ({
      date,
      ...copyTotals(totals),
      missingPricing,
    }));
  const allTimeRows = identityOrder([...allTimeEntries.values()].map(tableRow));
  const monthlyRows = identityOrder([...monthEntries.values()].map(tableRow));

  const monthMap = new Map();
  for (const item of selected) {
    const month = item.day.date.slice(0, 7);
    const current = monthMap.get(month) ?? {
      month,
      totals: copyTotals(EMPTY_TOTALS),
      partialPricing: false,
    };
    current.totals = addTotals(current.totals, item.totals);
    current.partialPricing ||= item.day.models.some(
      (model) => model.missingPricing,
    );
    monthMap.set(month, current);
  }
  for (const row of monthlyRows) {
    const month = monthMap.get(row.month);
    if (!month) continue;
    const segments = month.segments ?? [];
    month.segments = segments;
    segments.push({
      agent: row.agent,
      tool: row.agent,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      cacheReadTokens: row.cacheReadTokens,
      otherTokens: row.otherTokens,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd,
      missingPricing: row.missingPricing,
      attribution: row.attribution,
      color: colorFor(row.agent, row.model),
    });
  }
  const months = [...monthMap.values()]
    .sort((left, right) => compareText(left.month, right.month))
    .map(
      ({
        month,
        totals,
        partialPricing: monthPartialPricing,
        segments = [],
      }) => ({
        month,
        totalTokens: totals.totalTokens,
        costUsd: totals.costUsd,
        partialPricing: monthPartialPricing,
        segments: identityOrder(segments),
      }),
    );

  const today = utcTimestamp(now.toISOString().slice(0, 10));
  const rollingStart = today - 29 * DAY_MS;
  let rollingTotals = copyTotals(EMPTY_TOTALS);
  let activeDays = 0;
  let busiestDay = null;
  let rollingPartialPricing = false;
  for (const entry of daily.values()) {
    if (entry.timestamp < rollingStart || entry.timestamp > today) continue;
    rollingTotals = addTotals(rollingTotals, entry.totals);
    rollingPartialPricing ||= entry.partialPricing;
    if (entry.totals.totalTokens <= 0 && entry.totals.costUsd <= 0) continue;
    activeDays += 1;
    if (
      busiestDay === null ||
      entry.totals.totalTokens > busiestDay.totalTokens ||
      (entry.totals.totalTokens === busiestDay.totalTokens &&
        entry.date < busiestDay.date)
    ) {
      busiestDay = {
        date: entry.date,
        totalTokens: entry.totals.totalTokens,
        costUsd: entry.totals.costUsd,
      };
    }
  }
  const earliest = dailyBreakdown[0];
  const latest = dailyBreakdown.at(-1);
  const observedCalendarDays =
    selected.length > 0 && earliest && latest
      ? Math.max(
          1,
          Math.round(
            (utcTimestamp(latest.date) - utcTimestamp(earliest.date)) / DAY_MS,
          ) + 1,
        )
      : 0;
  const typical30d = hasData
    ? {
        totalTokens: (allTime.totalTokens / observedCalendarDays) * 30,
        costUsd: (allTime.costUsd / observedCalendarDays) * 30,
      }
    : { totalTokens: 0, costUsd: 0 };
  nonNegativeFinite(typical30d.totalTokens, "Projected tokens");
  nonNegativeFinite(typical30d.costUsd, "Projected cost");
  const activeDayDivisor = Math.max(1, activeDays);
  const rolling = {
    ...rollingTotals,
    activeDays,
    averageTokensPerActiveDay: rollingTotals.totalTokens / activeDayDivisor,
    averageCostPerActiveDay: rollingTotals.costUsd / activeDayDivisor,
    busiestDay,
    costPerMillion:
      rollingTotals.totalTokens === 0
        ? 0
        : (rollingTotals.costUsd / rollingTotals.totalTokens) * 1_000_000,
    partialPricing: rollingPartialPricing,
    startDate: new Date(rollingStart).toISOString().slice(0, 10),
    endDate: new Date(today).toISOString().slice(0, 10),
  };
  const topModels = [...allTimeRows]
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        compareText(left.agent, right.agent) ||
        compareText(left.model, right.model),
    )
    .slice(0, 3);
  nonNegativeFinite(rolling.costPerMillion, "Cost per million");
  const summary = {
    allTime,
    typical30d,
    rolling30d: {
      totalTokens: rolling.totalTokens,
      costUsd: rolling.costUsd,
      averageTokensPerActiveDay: rolling.averageTokensPerActiveDay,
      averageCostPerActiveDay: rolling.averageCostPerActiveDay,
    },
  };
  const cards = [
    {
      id: "allTimeCost",
      label: "All-Time Cost",
      metric: "costUsd",
      value: hasData ? allTime.costUsd : null,
    },
    {
      id: "typical30dCost",
      label: "Typical 30d Cost",
      metric: "costUsd",
      value: hasData ? typical30d.costUsd : null,
    },
    {
      id: "rolling30dCostPerDay",
      label: "30d Avg Cost/Day",
      metric: "costUsd",
      value: hasData ? rolling.averageCostPerActiveDay : null,
    },
    {
      id: "allTimeTokens",
      label: "All-Time Tokens",
      metric: "tokens",
      value: hasData ? allTime.totalTokens : null,
    },
    {
      id: "typical30dTokens",
      label: "Typical 30d Tokens",
      metric: "tokens",
      value: hasData ? typical30d.totalTokens : null,
    },
    {
      id: "rolling30dTokensPerDay",
      label: "30d Avg Tokens/Day",
      metric: "tokens",
      value: hasData ? rolling.averageTokensPerActiveDay : null,
    },
  ].map((card) => ({
    ...card,
    noData: !hasData,
    partialPricing:
      card.metric === "costUsd" &&
      (card.id === "rolling30dCostPerDay"
        ? rollingPartialPricing
        : partialPricing),
  }));

  return {
    tools,
    hasData,
    partialPricing,
    cards,
    summary,
    months,
    allTimeRows,
    monthlyRows,
    dailyBreakdown,
    rolling,
    topModels,
    observedCalendarDays,
    context: {
      selectedAgent: agent,
      allTools,
      selectedDayEntries: selected.length,
      activeDayEntries: selectedWithUsage.length,
      monthCount: months.length,
      modelEntryCount: allTimeRows.length,
      earliestDate: earliest?.date ?? null,
      latestDate: latest?.date ?? null,
      observedCalendarDays,
    },
  };
}

/**
 * Sort table rows without mutating their source. Missing/non-finite numeric
 * values always sort last. Equal values retain their input order.
 *
 * @template T
 * @param {T[]} rows
 * @param {string} [key]
 * @param {"asc" | "desc"} [direction]
 * @returns {T[]}
 */
export function sortRows(rows, key = "costUsd", direction = "desc") {
  const factor = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftValue = /** @type {Record<string, unknown>} */ (left.row)[key];
      const rightValue = /** @type {Record<string, unknown>} */ (right.row)[
        key
      ];
      const leftMissing =
        (key === "costUsd" &&
          leftValue === 0 &&
          Boolean(
            /** @type {Record<string, unknown>} */ (left.row).missingPricing,
          )) ||
        leftValue === null ||
        leftValue === undefined ||
        (typeof leftValue === "number" && !Number.isFinite(leftValue));
      const rightMissing =
        (key === "costUsd" &&
          rightValue === 0 &&
          Boolean(
            /** @type {Record<string, unknown>} */ (right.row).missingPricing,
          )) ||
        rightValue === null ||
        rightValue === undefined ||
        (typeof rightValue === "number" && !Number.isFinite(rightValue));
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return left.index - right.index;
        return leftMissing ? 1 : -1;
      }
      let comparison;
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        comparison = leftValue - rightValue;
      } else {
        comparison = compareText(String(leftValue), String(rightValue));
      }
      return comparison === 0 ? left.index - right.index : comparison * factor;
    })
    .map(({ row }) => row);
}

/**
 * Reset a now-invalid month sort when the UI switches to all-time mode.
 *
 * @param {{ key?: string, direction?: "asc" | "desc" } | undefined} sort
 * @param {"all-time" | "per-month"} mode
 */
export function resetMonthSort(sort, mode) {
  if (!sort || (mode === "all-time" && sort.key === "month"))
    return { ...DEFAULT_SORT };
  return {
    key: sort.key ?? DEFAULT_SORT.key,
    direction: sort.direction ?? DEFAULT_SORT.direction,
  };
}

export { colorFor };
