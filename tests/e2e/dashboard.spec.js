import { expect, test } from "@playwright/test";

test("complete dashboard, filtering, independent toggles, sorts and inert labels", async ({
  page,
}) => {
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(page.locator(".summary-card")).toHaveCount(6);
  await expect(page.locator("#status")).toContainText("Generated");
  await expect(page.locator("#warnings")).toContainText("pricing");
  await expect(
    page.getByRole("button", { name: "Token count", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#table-region")).toContainText(
    "Not provided by ccusage",
  );
  await expect(page.locator("#table-region img")).toHaveCount(0);
  await expect(page.locator("#table-region")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  await page.getByRole("button", { name: "Per month", exact: true }).click();
  const monthSort = page.getByRole("button", {
    name: "Sort by Month",
    exact: true,
  });
  await expect(monthSort).toBeVisible();
  await monthSort.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("th[aria-sort='descending']")).toContainText(
    "Month",
  );
  await page
    .getByRole("button", { name: "Dollar amount", exact: true })
    .click();
  await expect(page.locator("th[aria-sort='descending']")).toContainText(
    "Month",
  );
  await expect(
    page.getByRole("button", { name: "Per month", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "All time", exact: true }).click();
  await expect(page.locator("th[aria-sort='descending']")).toContainText(
    "Price",
  );
  const allTokens = await page
    .locator("#card-allTimeTokens .card-value")
    .textContent();
  await page.getByLabel("Tool", { exact: true }).selectOption("codex");
  await expect(page.locator("#table-region tbody tr")).toHaveCount(1);
  expect(
    await page.locator("#card-allTimeTokens .card-value").textContent(),
  ).not.toBe(allTokens);
  await expect(page.locator("#legend")).not.toContainText("claude");
  await page.getByRole("button", { name: "Token count", exact: true }).click();
  await expect(page.locator("#chart-region svg")).toBeVisible();
  expect(errors).toEqual([]);
});

test("chart keyboard/pointer tooltips reset and stable colors", async ({
  page,
}) => {
  await page.goto("/");
  const segment = page
    .locator(".chart-segment[aria-label*='claude-sonnet-synthetic']")
    .first();
  await expect(segment).toBeVisible();
  const color = await segment.getAttribute("fill");
  await segment.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(page.getByRole("tooltip")).toContainText("tokens");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await segment.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toBeHidden();
  await segment.focus();
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.getByRole("tooltip")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Dollar amount", exact: true })
    .click();
  expect(
    await page
      .locator(".chart-segment[aria-label*='claude-sonnet-synthetic']")
      .first()
      .getAttribute("fill"),
  ).toBe(color);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  expect(
    await page
      .locator(".chart-segment[aria-label*='claude-sonnet-synthetic']")
      .first()
      .getAttribute("fill"),
  ).toBe(color);
});

test("refresh failure preserves old snapshot then recovers", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Generated");
  const value = await page
    .locator("#card-allTimeTokens .card-value")
    .textContent();
  const generated = await page.locator("#status").textContent();
  await page.route("**/api/refresh", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          message: "<img src=x onerror=alert(1)> synthetic refresh failure",
        },
        stale: true,
      },
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Stale");
  expect(
    await page.locator("#card-allTimeTokens .card-value").textContent(),
  ).toBe(value);
  expect(await page.locator("#status").textContent()).toContain(generated);
  await expect(page.locator("#error img")).toHaveCount(0);
  await page.unroute("**/api/refresh");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#status")).not.toContainText("Stale");
});

test("loading, initial failure and retry", async ({ page }) => {
  await page.route("**/api/usage", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 503,
      json: { error: { message: "Synthetic unavailable report" } },
    });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Loading");
  await expect(page.locator("#error")).toContainText(
    "Synthetic unavailable report",
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Generated");
  await expect(page.locator(".summary-card")).toHaveCount(6);
});

test("genuine empty data", async ({ page, request }) => {
  const populated = await (await request.get("/api/usage")).json();
  await page.route("**/api/usage", (route) =>
    route.fulfill({ json: { ...populated, days: [], warnings: [] } }),
  );
  await page.goto("/");
  await expect(page.locator("#empty")).toContainText("No usage");
  await expect(page.locator(".card-value")).toHaveText([
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
  ]);
  await expect(page.locator("#chart-region")).not.toContainText("NaN");
  await expect(page.locator("#chart-region")).not.toContainText("Infinity");
});

test("fractional dollar scale, zero costs, and bounded long-label tooltips", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Dollar amount", exact: true })
    .click();
  await expect(page.locator("#chart-region")).toContainText("$0.26");
  const data = await (await request.get("/api/usage")).json();
  const longLabel = "long-model-".repeat(500);
  for (const day of data.days) {
    day.costUsd = 0;
    for (const model of day.models) model.costUsd = 0;
    if (day.agent === "codex") day.models[0].model = longLabel;
  }
  await page.route("**/api/usage", (route) => route.fulfill({ json: data }));
  await page.setViewportSize({ width: 375, height: 900 });
  await page.reload();
  await page
    .getByRole("button", { name: "Dollar amount", exact: true })
    .click();
  await expect(page.locator(".chart-segment")).toHaveCount(0);
  const cell = page.getByRole("cell", { name: longLabel, exact: true }).first();
  await cell.focus();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  const box = await tip.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900);
  await page.getByRole("button", { name: "Refresh", exact: true }).focus();
  await expect(tip).toBeHidden();
});

test("future all tool and hostile tool labels are distinct inert filters", async ({
  page,
  request,
}) => {
  const data = await (await request.get("/api/usage")).json();
  const hostile = "<img src=x onerror=alert(1)> tool";
  for (const day of data.days) {
    if (day.agent === "claude") day.agent = "all";
    if (day.agent === "pi:lab") day.agent = hostile;
  }
  await page.route("**/api/usage", (route) => route.fulfill({ json: data }));
  await page.goto("/");
  await page.getByLabel("Tool", { exact: true }).selectOption("all");
  await expect(page.locator("#table-region tbody tr")).toHaveCount(2);
  await expect(page.locator("#legend")).not.toContainText("codex");
  await page.getByLabel("Tool", { exact: true }).selectOption(hostile);
  await expect(page.locator("#table-region tbody tr")).toHaveCount(1);
  await expect(page.locator("#table-region")).toContainText(hostile);
  await expect(page.locator("#tool img, #table-region img")).toHaveCount(0);
  await page.getByLabel("Tool", { exact: true }).selectOption("");
  await expect(page.locator("#table-region tbody tr")).toHaveCount(5);
});

test("desktop/mobile screenshot batch and 200% zoom have no page overflow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Generated");
  await page.screenshot({
    path: ".impeccable/review/desktop.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.screenshot({
    path: ".impeccable/review/mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
