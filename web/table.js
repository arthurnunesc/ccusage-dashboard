import { exactTokens, preciseUsd, usd } from "../shared/format.js";
import { sortRows } from "../shared/report.js";

/** @typedef {ReturnType<typeof import('../shared/report.js').calculateReport>["allTimeRows"]} Rows */
/** @param {HTMLElement} container @param {Rows} rows @param {"all-time"|"per-month"} mode @param {{key:string,direction:"asc"|"desc"}} sort @param {(key:string)=>void} onSort */
export function renderTable(container, rows, mode, sort, onSort) {
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent =
    "Calls and Reasoning: Not provided by ccusage. Prices are estimates, not bills.";
  table.append(caption);
  const columns = [
    ["agent", "Agent"],
    ...(mode === "per-month" ? [["month", "Month"]] : []),
    ["model", "Model"],
    ["calls", "Calls"],
    ["inputTokens", "Input"],
    ["outputTokens", "Output"],
    ["reasoningTokens", "Reasoning"],
    ["cacheReadTokens", "Cache Rd"],
    ["cacheWriteTokens", "Cache Wr"],
    ["totalTokens", "Total"],
    ["costUsd", "Price"],
  ];
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  for (const [key, label] of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    if (["agent", "month", "model"].includes(key)) th.className = "text";
    if (sort.key === key)
      th.setAttribute(
        "aria-sort",
        sort.direction === "desc" ? "descending" : "ascending",
      );
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `Sort by ${label}`);
    button.textContent = label;
    if (sort.key === key)
      button.append(
        document.createTextNode(sort.direction === "desc" ? " ↓" : " ↑"),
      );
    button.addEventListener("click", () => onSort(key));
    th.append(button);
    header.append(th);
  }
  const sourceHeader = document.createElement("th");
  sourceHeader.scope = "col";
  sourceHeader.className = "text";
  sourceHeader.textContent = "Pricing source";
  header.append(sourceHeader);
  head.append(header);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of sortRows(rows, sort.key, sort.direction)) {
    const tr = document.createElement("tr");
    for (const [key] of columns) {
      const td = document.createElement("td");
      const value = row[key];
      const text = ["agent", "model", "month"].includes(key);
      td.className = text ? `text ${key === "model" ? "model" : ""}` : "";
      let explanation;
      if (text) {
        td.textContent = String(value);
        explanation = String(value);
      } else if (value === null) {
        td.textContent = "—";
        td.classList.add("unavailable");
        explanation = "Not provided by ccusage";
      } else if (key === "costUsd") {
        const unavailable = row.missingPricing && value === 0;
        td.textContent = unavailable
          ? "Unavailable"
          : `${usd(value)}${row.missingPricing ? " *" : ""}`;
        explanation = unavailable
          ? "Unavailable: ccusage flagged missing pricing, not free usage."
          : `${preciseUsd(value)} USD${row.missingPricing ? " · Known subtotal; some usage is unpriced." : " · ccusage auto: recorded or estimated"}`;
      } else {
        td.textContent = exactTokens(value);
        explanation = `${exactTokens(value)} tokens${key === "totalTokens" && row.otherTokens > 0 ? `; includes ${exactTokens(row.otherTokens)} unattributed other tokens (not reasoning)` : ""}`;
      }
      td.dataset.tooltip = explanation;
      td.tabIndex = 0;
      tr.append(td);
    }
    const source = document.createElement("td");
    source.className = "text pricing";
    source.textContent = `ccusage auto: recorded or estimated${row.missingPricing ? " · missing pricing" : ""}${row.attribution === "unattributed" ? " · unattributed" : ""}`;
    tr.append(source);
    body.append(tr);
  }
  table.append(body);
  container.replaceChildren(table);
}
