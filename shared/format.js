/** @typedef {number | null | undefined} MaybeNumber */

const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const MONEY_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * @param {MaybeNumber} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Truncate a positive number instead of rounding it for compact displays.
 *
 * @param {number} value
 * @param {number} places
 */
function truncate(value, places) {
  /** @type {Intl.NumberFormatOptions & {roundingMode: "trunc"}} */
  const options = {
    useGrouping: false,
    minimumFractionDigits: places,
    maximumFractionDigits: places,
    roundingMode: "trunc",
  };
  return Number(value.toLocaleString("en-US", options));
}

/**
 * Format a token count in full, with grouping.
 *
 * @param {MaybeNumber} value
 * @returns {string}
 */
export function exactTokens(value) {
  return isFiniteNumber(value) ? TOKEN_FORMATTER.format(value) : "—";
}

/**
 * Format token counts compactly. Millions and billions are truncated, never
 * rounded up, so the compact value cannot overstate usage.
 *
 * @param {MaybeNumber} value
 * @returns {string}
 */
export function shortTokens(value) {
  if (!isFiniteNumber(value)) return "—";
  if (Math.abs(value) >= 1_000_000_000) {
    return `${truncate(value / 1_000_000_000, 2).toFixed(2)}B`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${truncate(value / 1_000_000, 2).toFixed(2)}M`;
  }
  return exactTokens(value);
}

/**
 * Format a summary USD value with two truncated decimal places.
 *
 * @param {MaybeNumber} value
 * @returns {string}
 */
export function shortUsd(value) {
  return isFiniteNumber(value)
    ? `$${MONEY_FORMATTER.format(truncate(value, 2))}`
    : "—";
}

/**
 * Format normal table USD with conventional two-decimal rounding.
 *
 * @param {MaybeNumber} value
 * @returns {string}
 */
export function usd(value) {
  return isFiniteNumber(value) ? `$${MONEY_FORMATTER.format(value)}` : "—";
}

/**
 * Format a USD value for an exact-value tooltip without forcing cents.
 *
 * @param {MaybeNumber} value
 * @returns {string}
 */
export function preciseUsd(value) {
  return isFiniteNumber(value)
    ? `$${value.toLocaleString("en-US", { maximumSignificantDigits: 17 })}`
    : "—";
}

/**
 * Produce a deterministic, readable color from the complete tool/model
 * identity. It is independent of display order, filters, and report refreshes.
 *
 * @param {string} agent
 * @param {string} model
 * @returns {string}
 */
export function colorFor(agent, model) {
  const identity = JSON.stringify([agent, model]);
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue} 62% 56%)`;
}
