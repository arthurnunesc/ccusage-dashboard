import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReport } from "../../src/ccusage.js";
import { loadConfig } from "../../src/config.js";
import { normalizeReport } from "../../src/normalize.js";
import { createFakeCcusage } from "../helpers/fake-ccusage.js";

test("application shutdown terminates an actual in-flight child and listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ccusage-shutdown-"));
  /** @type {ReturnType<typeof createApplication> | undefined} */
  let app;
  try {
    const binary = await createFakeCcusage(directory);
    const pidFile = join(directory, "pid");
    const config = { ...loadConfig({}), binary, port: 0 };
    app = createApplication({
      config,
      runner: async (signal) =>
        normalizeReport(
          await runReport(config, {
            signal,
            env: {
              HOME: directory,
              FAKE_MODE: "ignore-term",
              FAKE_PID_FILE: pidFile,
            },
          }),
        ),
    });
    const server = app.start();
    const url = `http://127.0.0.1:${server.port}/api/usage`;
    const pending = fetch(url).catch(() => null);
    for (let i = 0; i < 400; i++) {
      if (await Bun.file(pidFile).exists()) break;
      await Bun.sleep(5);
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    await app.close();
    await pending;
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import { createApplication } from "../../src/server.js";

test("HTTP routes, isolated single flight, and rebinding/CSRF protection", async () => {
  let calls = 0;
  let fail = false;
  const snapshot = normalizeReport({
    daily: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  });
  const app = createApplication({
    config: { ...loadConfig({}), port: 0 },
    runner: async () => {
      calls++;
      await Bun.sleep(5);
      if (fail) throw new Error("PRIVATE /secret/home/transcript");
      return snapshot;
    },
  });
  try {
    const server = app.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const get = (
      path = "/api/usage",
      /** @type {RequestInit} */ options = {},
    ) => fetch(origin + path, options);
    expect((await get("/api/health")).status).toBe(200);
    expect(calls).toBe(0);
    const responses = await Promise.all([get(), get()]);
    expect(calls).toBe(1);
    expect((await responses[0].json()).stale).toBe(false);
    expect(responses[0].headers.get("cache-control")).toBe("no-store");
    expect(responses[0].headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(
      (await get("/shared/report.js")).headers.get("content-type"),
    ).toContain("javascript");
    expect((await get("/src/config.js")).status).toBe(404);
    expect((await get("/missing")).status).toBe(404);
    expect((await get("/api/usage", { method: "POST" })).status).toBe(405);
    expect((await get("/api/refresh")).status).toBe(405);
    expect(
      (await get("/api/health", { headers: { Host: "evil.example" } })).status,
    ).toBe(403);
    for (const foreign of [
      "http://evil.example",
      "null",
      "http://localhost:1",
      "",
    ]) {
      expect(
        (
          await get("/api/refresh", {
            method: "POST",
            headers: { Origin: foreign, "X-ccusage-refresh": "1" },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await get("/api/refresh", {
          method: "POST",
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(403);
    const refresh = {
      method: "POST",
      headers: { Origin: origin, "X-ccusage-refresh": "1" },
    };
    expect((await get("/api/refresh", refresh)).status).toBe(200);
    expect(calls).toBe(2);
    fail = true;
    const error = await get("/api/refresh", refresh);
    expect(error.status).toBe(503);
    const body = await error.text();
    expect(body).not.toContain("PRIVATE");
    expect(body).not.toContain("/secret");
    expect(JSON.parse(body).stale).toBe(true);
    expect((await get()).status).toBe(200);
  } finally {
    await app.close();
  }
});

test("initial runner failure returns safe error without an empty snapshot", async () => {
  const app = createApplication({
    config: { ...loadConfig({}), port: 0 },
    runner: async () => {
      throw Object.assign(new Error("private"), { code: "TIMEOUT" });
    },
  });
  try {
    const server = app.start();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/usage`);
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.error.code).toBe("TIMEOUT");
    expect(json.stale).toBe(false);
  } finally {
    await app.close();
  }
});
