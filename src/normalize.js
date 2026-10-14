// @ts-check

/** @typedef {import("../shared/types.d.ts").Day} Day */
/** @typedef {import("../shared/types.d.ts").Model} Model */
/** @typedef {import("../shared/types.d.ts").Snapshot} Snapshot */

const MONEY_TOLERANCE = 1e-8;
const tokenKeys = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
];

export class ReportCompatibilityError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ReportCompatibilityError";
    this.code = "INCOMPATIBLE_REPORT";
  }
}

/** @param {unknown} value @param {string} path */
function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReportCompatibilityError(`${path} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} path */
function string(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReportCompatibilityError(`${path} must be a nonempty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function tokens(value, path) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ReportCompatibilityError(
      `${path} must be a nonnegative safe integer`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function cost(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ReportCompatibilityError(
      `${path} must be a finite nonnegative number`,
    );
  }
  return value;
}

/** @param {number} left @param {number} right */
function costsEqual(left, right) {
  return (
    Math.abs(left - right) <=
    MONEY_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

/** @param {number} left @param {number} right @param {string} path */
function equalTokens(left, right, path) {
  if (left !== right)
    throw new ReportCompatibilityError(`${path} does not reconcile exactly`);
}

/** @param {number} left @param {number} right @param {string} path */
function equalCosts(left, right, path) {
  if (!costsEqual(left, right))
    throw new ReportCompatibilityError(`${path} does not reconcile`);
}

/** @param {number} left @param {number} right @param {string} path */
function sumTokens(left, right, path) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum))
    throw new ReportCompatibilityError(`${path} exceeds safe integer range`);
  return sum;
}

/** @param {number} left @param {number} right @param {string} path */
function sumCosts(left, right, path) {
  const sum = left + right;
  if (!Number.isFinite(sum))
    throw new ReportCompatibilityError(`${path} exceeds finite money range`);
  return sum;
}

/** @param {Record<string, unknown>} row @param {string} path */
function totals(row, path) {
  /** @type {Record<string, number>} */
  const result = {};
  for (const key of tokenKeys) result[key] = tokens(row[key], `${path}.${key}`);
  result.totalTokens = tokens(row.totalTokens, `${path}.totalTokens`);
  result.totalCost = cost(row.totalCost, `${path}.totalCost`);
  const categoryTotal = tokenKeys.reduce(
    (sum, key) => sumTokens(sum, result[key], path),
    0,
  );
  if (categoryTotal > result.totalTokens) {
    throw new ReportCompatibilityError(
      `${path}.totalTokens is smaller than its token categories`,
    );
  }
  return result;
}

/** @param {string} date @param {string} path */
function validDate(date, path) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))
  ) {
    throw new ReportCompatibilityError(
      `${path} must be a real YYYY-MM-DD UTC date`,
    );
  }
  const parsed = new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10);
  if (parsed !== date)
    throw new ReportCompatibilityError(
      `${path} must be a real YYYY-MM-DD UTC date`,
    );
}

/** @param {Record<string, unknown>} row @param {string} path */
function models(row, path) {
  if (!Array.isArray(row.modelBreakdowns)) {
    throw new ReportCompatibilityError(
      `${path}.modelBreakdowns must be an array`,
    );
  }
  /** @type {Map<string, Model>} */
  const result = new Map();
  for (const [index, value] of row.modelBreakdowns.entries()) {
    const breakdown = object(value, `${path}.modelBreakdowns[${index}]`);
    const model = string(
      breakdown.modelName,
      `${path}.modelBreakdowns[${index}].modelName`,
    );
    const previous = result.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      missingPricing: false,
      attribution: "model",
    };
    const inputTokens =
      breakdown.inputTokens === undefined
        ? 0
        : tokens(
            breakdown.inputTokens,
            `${path}.modelBreakdowns[${index}].inputTokens`,
          );
    const outputTokens =
      breakdown.outputTokens === undefined
        ? 0
        : tokens(
            breakdown.outputTokens,
            `${path}.modelBreakdowns[${index}].outputTokens`,
          );
    const cacheWriteTokens =
      breakdown.cacheCreationTokens === undefined
        ? 0
        : tokens(
            breakdown.cacheCreationTokens,
            `${path}.modelBreakdowns[${index}].cacheCreationTokens`,
          );
    const cacheReadTokens =
      breakdown.cacheReadTokens === undefined
        ? 0
        : tokens(
            breakdown.cacheReadTokens,
            `${path}.modelBreakdowns[${index}].cacheReadTokens`,
          );
    const costUsd =
      breakdown.cost === undefined
        ? 0
        : cost(breakdown.cost, `${path}.modelBreakdowns[${index}].cost`);
    if (
      breakdown.missingPricing !== undefined &&
      typeof breakdown.missingPricing !== "boolean"
    ) {
      throw new ReportCompatibilityError(
        `${path}.modelBreakdowns[${index}].missingPricing must be a boolean`,
      );
    }
    previous.inputTokens = sumTokens(previous.inputTokens, inputTokens, path);
    previous.outputTokens = sumTokens(
      previous.outputTokens,
      outputTokens,
      path,
    );
    previous.cacheWriteTokens = sumTokens(
      previous.cacheWriteTokens,
      cacheWriteTokens,
      path,
    );
    previous.cacheReadTokens = sumTokens(
      previous.cacheReadTokens,
      cacheReadTokens,
      path,
    );
    const breakdownTokens = [
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
    ].reduce((sum, value) => sumTokens(sum, value, path), 0);
    previous.totalTokens = sumTokens(
      previous.totalTokens,
      breakdownTokens,
      path,
    );
    previous.costUsd = sumCosts(previous.costUsd, costUsd, path);
    previous.missingPricing ||= breakdown.missingPricing === true;
    result.set(model, previous);
  }
  return [...result.values()];
}

/** @param {unknown} report */
export function validateReport(report) {
  const root = object(report, "report");
  if (!Array.isArray(root.daily))
    throw new ReportCompatibilityError("report.daily must be an array");
  const grand = object(root.totals, "report.totals");
  if (
    grand.unpricedModels !== undefined &&
    (!Array.isArray(grand.unpricedModels) ||
      grand.unpricedModels.some(
        (value) => typeof value !== "string" || value.length === 0,
      ))
  ) {
    throw new ReportCompatibilityError(
      "report.totals.unpricedModels must be an array of nonempty model labels",
    );
  }
  const grandTotals = totals(grand, "report.totals");
  /** @type {Record<string, number>} */
  const cumulative = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
  const dates = new Set();
  const pairs = new Set();

  for (const [dayIndex, dayValue] of root.daily.entries()) {
    const day = object(dayValue, `report.daily[${dayIndex}]`);
    const date = string(day.period, `report.daily[${dayIndex}].period`);
    validDate(date, `report.daily[${dayIndex}].period`);
    if (dates.has(date))
      throw new ReportCompatibilityError(
        `report.daily contains duplicate date ${date}`,
      );
    dates.add(date);
    string(day.agent, `report.daily[${dayIndex}].agent`);
    if (!Array.isArray(day.modelsUsed))
      throw new ReportCompatibilityError(
        `report.daily[${dayIndex}].modelsUsed must be an array`,
      );
    if (!Array.isArray(day.modelBreakdowns))
      throw new ReportCompatibilityError(
        `report.daily[${dayIndex}].modelBreakdowns must be an array`,
      );
    const dayTotals = totals(day, `report.daily[${dayIndex}]`);
    if (!Array.isArray(day.agents) || day.agents.length === 0) {
      throw new ReportCompatibilityError(
        `report.daily[${dayIndex}].agents must contain the --by-agent breakdown`,
      );
    }
    /** @type {Record<string, number>} */
    const agentsTotal = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    };
    for (const [agentIndex, agentValue] of day.agents.entries()) {
      const agent = object(
        agentValue,
        `report.daily[${dayIndex}].agents[${agentIndex}]`,
      );
      const agentName = string(
        agent.agent,
        `report.daily[${dayIndex}].agents[${agentIndex}].agent`,
      );
      const pair = `${date}\u0000${agentName}`;
      if (pairs.has(pair))
        throw new ReportCompatibilityError(
          `report.daily contains duplicate date/agent ${date}/${agentName}`,
        );
      pairs.add(pair);
      if (!Array.isArray(agent.modelsUsed))
        throw new ReportCompatibilityError(
          `report.daily[${dayIndex}].agents[${agentIndex}].modelsUsed must be an array`,
        );
      const agentTotals = totals(
        agent,
        `report.daily[${dayIndex}].agents[${agentIndex}]`,
      );
      models(agent, `report.daily[${dayIndex}].agents[${agentIndex}]`);
      for (const key of tokenKeys.concat("totalTokens"))
        agentsTotal[key] = sumTokens(
          agentsTotal[key],
          agentTotals[key],
          "report daily totals",
        );
      agentsTotal.totalCost = sumCosts(
        agentsTotal.totalCost,
        agentTotals.totalCost,
        "report daily totals",
      );
    }
    for (const key of tokenKeys.concat("totalTokens"))
      equalTokens(
        agentsTotal[key],
        dayTotals[key],
        `report.daily[${dayIndex}].${key}`,
      );
    equalCosts(
      agentsTotal.totalCost,
      dayTotals.totalCost,
      `report.daily[${dayIndex}].totalCost`,
    );
    for (const key of tokenKeys.concat("totalTokens"))
      cumulative[key] = sumTokens(
        cumulative[key],
        dayTotals[key],
        "report totals",
      );
    cumulative.totalCost = sumCosts(
      cumulative.totalCost,
      dayTotals.totalCost,
      "report totals",
    );
  }
  for (const key of tokenKeys.concat("totalTokens"))
    equalTokens(cumulative[key], grandTotals[key], `report.totals.${key}`);
  equalCosts(
    cumulative.totalCost,
    grandTotals.totalCost,
    "report.totals.totalCost",
  );
  return root;
}

/**
 * Validate ccusage unified daily JSON and create the app-owned snapshot contract.
 * @param {unknown} report
 * @param {{ generatedAt?: string, offline?: boolean }} [options]
 * @returns {Snapshot}
 */
export function normalizeReport(
  report,
  { generatedAt = new Date().toISOString(), offline = true } = {},
) {
  const root = validateReport(report);
  /** @type {Day[]} */
  const days = [];
  /** @type {string[]} */
  const warnings = [];
  let sawMissingPricing = false;
  let sawUnattributed = false;
  const grand = /** @type {Record<string, unknown>} */ (root.totals);
  const unpriced = new Set(
    /** @type {string[]} */ (grand.unpricedModels ?? []),
  );

  for (const [dayIndex, dayValue] of /** @type {unknown[]} */ (
    root.daily
  ).entries()) {
    const day = /** @type {Record<string, unknown>} */ (dayValue);
    const date = /** @type {string} */ (day.period);
    for (const [agentIndex, agentValue] of /** @type {unknown[]} */ (
      day.agents
    ).entries()) {
      const agent = /** @type {Record<string, unknown>} */ (agentValue);
      const sourceTotals = totals(
        agent,
        `report.daily[${dayIndex}].agents[${agentIndex}]`,
      );
      const modelRows = models(
        agent,
        `report.daily[${dayIndex}].agents[${agentIndex}]`,
      );
      const modelTotals = {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      for (const model of modelRows) {
        model.missingPricing ||= unpriced.has(model.model);
        modelTotals.inputTokens = sumTokens(
          modelTotals.inputTokens,
          model.inputTokens,
          "model totals",
        );
        modelTotals.outputTokens = sumTokens(
          modelTotals.outputTokens,
          model.outputTokens,
          "model totals",
        );
        modelTotals.cacheWriteTokens = sumTokens(
          modelTotals.cacheWriteTokens,
          model.cacheWriteTokens,
          "model totals",
        );
        modelTotals.cacheReadTokens = sumTokens(
          modelTotals.cacheReadTokens,
          model.cacheReadTokens,
          "model totals",
        );
        modelTotals.totalTokens = sumTokens(
          modelTotals.totalTokens,
          model.totalTokens,
          "model totals",
        );
        modelTotals.costUsd = sumCosts(
          modelTotals.costUsd,
          model.costUsd,
          "model totals",
        );
        sawMissingPricing ||= model.missingPricing;
      }
      const residual = {
        inputTokens: sourceTotals.inputTokens - modelTotals.inputTokens,
        outputTokens: sourceTotals.outputTokens - modelTotals.outputTokens,
        cacheWriteTokens:
          sourceTotals.cacheCreationTokens - modelTotals.cacheWriteTokens,
        cacheReadTokens:
          sourceTotals.cacheReadTokens - modelTotals.cacheReadTokens,
        otherTokens:
          sourceTotals.totalTokens -
          sourceTotals.inputTokens -
          sourceTotals.outputTokens -
          sourceTotals.cacheCreationTokens -
          sourceTotals.cacheReadTokens,
        costUsd: sourceTotals.totalCost - modelTotals.costUsd,
      };
      if (
        Object.entries(residual).some(
          ([key, value]) => key !== "costUsd" && value < 0,
        )
      ) {
        throw new ReportCompatibilityError(
          `report.daily[${dayIndex}].agents[${agentIndex}].modelBreakdowns exceed authoritative totals`,
        );
      }
      if (
        residual.costUsd < 0 &&
        !costsEqual(sourceTotals.totalCost, modelTotals.costUsd)
      ) {
        throw new ReportCompatibilityError(
          `report.daily[${dayIndex}].agents[${agentIndex}].modelBreakdowns cost exceeds authoritative total`,
        );
      }
      if (
        residual.inputTokens ||
        residual.outputTokens ||
        residual.cacheWriteTokens ||
        residual.cacheReadTokens ||
        residual.otherTokens ||
        (residual.costUsd > 0 &&
          !costsEqual(sourceTotals.totalCost, modelTotals.costUsd))
      ) {
        sawUnattributed = true;
        const totalTokens =
          residual.inputTokens +
          residual.outputTokens +
          residual.cacheWriteTokens +
          residual.cacheReadTokens +
          residual.otherTokens;
        modelRows.push({
          model: "Unattributed usage",
          inputTokens: residual.inputTokens,
          outputTokens: residual.outputTokens,
          cacheWriteTokens: residual.cacheWriteTokens,
          cacheReadTokens: residual.cacheReadTokens,
          ...(residual.otherTokens === 0
            ? {}
            : { otherTokens: residual.otherTokens }),
          totalTokens,
          costUsd: residual.costUsd > 0 ? residual.costUsd : 0,
          missingPricing: false,
          attribution: "unattributed",
        });
      }
      days.push({
        date,
        agent: string(
          agent.agent,
          `report.daily[${dayIndex}].agents[${agentIndex}].agent`,
        ),
        inputTokens: sourceTotals.inputTokens,
        outputTokens: sourceTotals.outputTokens,
        cacheWriteTokens: sourceTotals.cacheCreationTokens,
        cacheReadTokens: sourceTotals.cacheReadTokens,
        totalTokens: sourceTotals.totalTokens,
        costUsd: sourceTotals.totalCost,
        models: modelRows,
      });
    }
  }
  if (sawMissingPricing)
    warnings.push(
      "Some model usage has missing pricing; costs are known subtotals.",
    );
  if (sawUnattributed)
    warnings.push(
      "Some usage is unattributed because ccusage model breakdowns do not include every total.",
    );
  days.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.agent.localeCompare(right.agent),
  );
  return {
    schemaVersion: 1,
    generatedAt,
    stale: false,
    warnings,
    metadata: {
      ccusageVersion: "20.0.31",
      offline,
      pricingMode: "auto",
      limitations: [
        "Costs are estimates or recorded local calculations, not invoices.",
        "Provider, calls, reasoning, and pricing provenance are not exported by the unified daily report.",
      ],
    },
    days,
  };
}
