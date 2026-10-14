import {
  colorFor,
  exactTokens,
  preciseUsd,
  shortTokens,
} from "../shared/format.js";

const SVG = "http://www.w3.org/2000/svg";
/** @param {string} tag @param {Record<string,string|number>} attributes */
function svg(tag, attributes) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  return element;
}

/** Delegation is installed once, including for future card/table/chart nodes.
 * @param {HTMLElement} element
 */
export function createTooltip(element) {
  /** @type {Element | null} */
  let active = null;
  const hide = () => {
    active?.removeAttribute("aria-describedby");
    active = null;
    element.hidden = true;
    element.textContent = "";
    element.style.removeProperty("left");
    element.style.removeProperty("top");
  };
  /** @param {Element} target @param {number} [x] @param {number} [y] */
  const show = (target, x, y) => {
    hide();
    const text = target.getAttribute("data-tooltip");
    if (!text) return;
    active = target;
    element.textContent = text;
    element.hidden = false;
    target.setAttribute("aria-describedby", element.id);
    const rect = target.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(12, Math.min(x ?? rect.left, innerWidth - box.width - 12))}px`;
    element.style.top = `${Math.max(12, Math.min((y ?? rect.bottom) + 12, innerHeight - box.height - 12))}px`;
  };
  document.addEventListener("pointerover", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest("[data-tooltip]")
        : null;
    if (target) show(target, event.clientX, event.clientY);
  });
  document.addEventListener("focusin", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest("[data-tooltip]")
        : null;
    if (target) show(target);
  });
  document.addEventListener("pointerout", (event) => {
    if (
      active &&
      event.target instanceof Node &&
      active.contains(event.target) &&
      !(
        event.relatedTarget instanceof Node &&
        active.contains(event.relatedTarget)
      )
    )
      hide();
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  window.addEventListener("resize", hide);
  document.addEventListener(
    "scroll",
    () => {
      if (active && document.activeElement === active) show(active);
      else hide();
    },
    true,
  );
  return { hide };
}

/** @typedef {ReturnType<typeof import('../shared/report.js').calculateReport>["months"]} Months */
/** @param {HTMLElement} container @param {HTMLElement} legend @param {Months} months @param {"tokens"|"dollars"} metric */
export function renderChart(container, legend, months, metric) {
  container.replaceChildren();
  legend.replaceChildren();
  const key = metric === "tokens" ? "totalTokens" : "costUsd";
  const maximum = months.reduce((max, month) => Math.max(max, month[key]), 0);
  const width = Math.max(720, container.clientWidth, months.length * 96 + 110);
  const plotHeight = 200;
  const left = 80;
  const top = 20;
  const bottom = top + plotHeight;
  const chart = svg("svg", {
    viewBox: `0 0 ${width} 280`,
    width,
    height: 280,
    role: "group",
    "aria-label": `Monthly ${metric === "tokens" ? "tokens" : "USD"}`,
  });
  const title = svg("title", {});
  title.textContent =
    "Monthly usage. Focus a colored segment for its exact tool and model values.";
  chart.append(title);
  for (const fraction of [1, 0.75, 0.5, 0.25, 0]) {
    const y = top + (1 - fraction) * plotHeight;
    chart.append(
      svg("line", {
        x1: left,
        x2: width - 20,
        y1: y,
        y2: y,
        class: "chart-grid",
      }),
    );
    const tick = svg("text", {
      x: left - 10,
      y: y + 4,
      "text-anchor": "end",
      class: "chart-label",
    });
    tick.textContent =
      metric === "tokens"
        ? shortTokens(maximum * fraction)
        : preciseUsd(maximum * fraction);
    chart.append(tick);
  }
  const step = (width - left - 20) / Math.max(1, months.length);
  const identities = new Map();
  months.forEach((month, index) => {
    let accumulated = 0;
    for (const segment of month.segments) {
      const color = colorFor(segment.agent, segment.model);
      identities.set(
        JSON.stringify([segment.agent, segment.model, segment.attribution]),
        { ...segment, color },
      );
      const amount = segment[key];
      if (amount <= 0 || maximum <= 0) continue;
      const height = (amount / maximum) * plotHeight;
      const text = `${month.month} · ${segment.agent}\n${segment.model}${segment.attribution === "unattributed" ? " (unattributed)" : ""}\n${metric === "tokens" ? `${exactTokens(amount)} tokens` : `${preciseUsd(amount)} USD`}${segment.missingPricing ? "\nPartial estimate: some usage has no price." : ""}`;
      const rect = svg("rect", {
        x: left + step * index + step * 0.2,
        y: bottom - accumulated - height,
        width: step * 0.6,
        height,
        fill: color,
        class: "chart-segment",
        tabindex: 0,
        role: "img",
        "aria-label": text,
        "data-tooltip": text,
      });
      chart.append(rect);
      accumulated += height;
    }
    const label = svg("text", {
      x: left + step * (index + 0.5),
      y: bottom + 25,
      "text-anchor": "middle",
      class: "chart-label",
    });
    label.textContent = month.month;
    chart.append(label);
  });
  if (maximum === 0) {
    const label = svg("text", {
      x: width / 2,
      y: 120,
      "text-anchor": "middle",
      class: "chart-label",
    });
    label.textContent = months.length
      ? "No positive known cost or token total for this metric"
      : "No monthly usage";
    chart.append(label);
  }
  container.append(chart);
  for (const item of identities.values()) {
    const li = document.createElement("li");
    const swatch = svg("svg", { width: 12, height: 12, "aria-hidden": "true" });
    swatch.append(
      svg("rect", {
        x: 0,
        y: 0,
        width: 12,
        height: 12,
        fill: item.color,
        rx: 2,
      }),
    );
    const label = document.createElement("span");
    label.textContent = `${item.agent} / ${item.model}${item.attribution === "unattributed" ? " (unattributed)" : ""}`;
    li.append(swatch, label);
    legend.append(li);
  }
}
