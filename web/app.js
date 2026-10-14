import { preciseUsd, shortTokens, shortUsd } from "../shared/format.js";
import { calculateReport, resetMonthSort } from "../shared/report.js";
import { createTooltip, renderChart } from "./chart.js";
import { renderTable } from "./table.js";

/** @param {string} id */
function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing application element: ${id}`);
  return node;
}
const tool = /** @type {HTMLSelectElement} */ (element("tool"));
const refresh = /** @type {HTMLButtonElement} */ (element("refresh"));
const tooltip = createTooltip(element("tooltip"));
/** @type {import('../shared/types.d.ts').Snapshot | null} */
let snapshot = null;
/** @type {"tokens"|"dollars"} */
let metric = "tokens";
/** @type {"all-time"|"per-month"} */
let mode = "all-time";
/** @type {{key:string,direction:"asc"|"desc"}} */
let sort = { key: "costUsd", direction: "desc" };
let busy = false;

function render() {
  if (!snapshot) return;
  tooltip.hide();
  const view = calculateReport(snapshot.days, { agent: tool.value });
  element("status").textContent =
    `${snapshot.stale ? "Stale · " : ""}Generated ${new Date(snapshot.generatedAt).toLocaleString()}`;
  element("scope-note").textContent =
    `Local history · ccusage ${snapshot.metadata.ccusageVersion} · UTC grouping · ${snapshot.metadata.offline ? "Offline pricing" : "Pricing refresh requested"} · Costs are not invoices or subscription charges.`;
  const warnings = [
    ...snapshot.warnings.filter((text) => !text.includes("missing pricing")),
  ];
  if (view.partialPricing)
    warnings.unshift(
      "Missing pricing: costs are known subtotals, not complete estimates. Unpriced-only amounts are unavailable.",
    );
  element("warnings").textContent = warnings.join(" ");
  element("warnings").hidden = warnings.length === 0;
  const cards = element("cards");
  cards.replaceChildren();
  for (const card of view.cards) {
    const article = document.createElement("article");
    article.className = "summary-card";
    article.id = `card-${card.id}`;
    const heading = document.createElement("h3");
    heading.textContent = card.label;
    const value = document.createElement("span");
    value.className = "card-value";
    const unavailable = card.partialPricing && card.value === 0;
    value.textContent = unavailable
      ? "Unavailable"
      : card.metric === "tokens"
        ? shortTokens(card.value)
        : shortUsd(card.value);
    const context = document.createElement("p");
    context.className = "card-context";
    context.textContent = card.noData
      ? "No data"
      : card.id.startsWith("allTime")
        ? `${view.context.monthCount} months · ${view.context.modelEntryCount} model entries`
        : card.id.startsWith("typical")
          ? `${view.observedCalendarDays} observed UTC calendar days`
          : `${view.rolling.activeDays} active dates in the past 30 days`;
    const full =
      card.value === null
        ? "No data"
        : card.metric === "costUsd"
          ? `${preciseUsd(card.value)} USD`
          : `${card.value.toLocaleString("en-US", { maximumSignificantDigits: 17 })} tokens`;
    value.dataset.tooltip = `${full}\n${context.textContent}${card.partialPricing ? "\nKnown cost subtotal: some usage has no price." : ""}${card.id.startsWith("typical") ? "\nApproximation: lifetime total / inclusive observed UTC calendar span × 30." : ""}`;
    value.tabIndex = 0;
    article.append(heading, value, context);
    if (card.partialPricing) {
      const partial = document.createElement("span");
      partial.className = "partial";
      partial.textContent = "Known cost subtotal";
      article.append(partial);
    }
    cards.append(article);
  }
  element("empty").hidden = view.hasData;
  renderChart(element("chart-region"), element("legend"), view.months, metric);
  renderTable(
    element("table-region"),
    mode === "all-time" ? view.allTimeRows : view.monthlyRows,
    mode,
    sort,
    (key) => {
      sort = {
        key,
        direction:
          sort.key === key && sort.direction === "desc" ? "asc" : "desc",
      };
      render();
      // Preserve keyboard focus on the corresponding replaced header.
      const column = [...element("table-region").querySelectorAll("th")].find(
        (th) => th.hasAttribute("aria-sort"),
      );
      /** @type {HTMLElement | null} */ (
        column?.querySelector("button") ?? null
      )?.focus();
    },
  );
  element("table-context").textContent =
    `${mode === "all-time" ? view.allTimeRows.length : view.monthlyRows.length} entries · ${mode === "all-time" ? "Tool and model totals" : "Tool, month, and model totals"}`;
  element("tokens").setAttribute("aria-pressed", String(metric === "tokens"));
  element("dollars").setAttribute("aria-pressed", String(metric === "dollars"));
  element("all-time").setAttribute("aria-pressed", String(mode === "all-time"));
  element("per-month").setAttribute(
    "aria-pressed",
    String(mode === "per-month"),
  );
}

/** @param {boolean} explicit */
async function load(explicit = false) {
  if (busy) return;
  busy = true;
  refresh.disabled = true;
  element("retry").setAttribute("disabled", "");
  element("content").setAttribute("aria-busy", "true");
  element("status").textContent = snapshot
    ? `${snapshot.stale ? "Stale · " : ""}Generated ${new Date(snapshot.generatedAt).toLocaleString()} · Refreshing…`
    : "Loading ccusage report…";
  element("error").hidden = true;
  try {
    const response = await fetch(
      explicit ? "/api/refresh" : "/api/usage",
      explicit ? { method: "POST", headers: { "X-ccusage-refresh": "1" } } : {},
    );
    const json = await response.json();
    if (!response.ok)
      throw new Error(
        typeof json.error?.message === "string"
          ? json.error.message
          : "The report could not be loaded. Retry the scan.",
      );
    snapshot = json;
    const selected = tool.value;
    tool.replaceChildren(new Option("All tools", "all"));
    for (const agent of calculateReport(snapshot?.days ?? []).tools)
      tool.append(new Option(agent, agent));
    tool.value = [...tool.options].some((option) => option.value === selected)
      ? selected
      : "all";
    tool.disabled = false;
    render();
  } catch (error) {
    tooltip.hide();
    element("error-message").textContent =
      error instanceof Error
        ? error.message
        : "The report could not be loaded. Retry the scan.";
    element("error").hidden = false;
    if (snapshot) {
      snapshot = { ...snapshot, stale: true };
      render();
    } else
      element("status").textContent = "Report unavailable · Retry the scan";
  } finally {
    busy = false;
    refresh.disabled = false;
    element("retry").removeAttribute("disabled");
    element("content").setAttribute("aria-busy", "false");
  }
}
tool.addEventListener("change", render);
refresh.addEventListener("click", () => load(true));
element("retry").addEventListener("click", () => load(true));
element("tokens").addEventListener("click", () => {
  metric = "tokens";
  render();
});
element("dollars").addEventListener("click", () => {
  metric = "dollars";
  render();
});
element("all-time").addEventListener("click", () => {
  mode = "all-time";
  sort = resetMonthSort(sort, mode);
  render();
});
element("per-month").addEventListener("click", () => {
  mode = "per-month";
  render();
});
await load();
