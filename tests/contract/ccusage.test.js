import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, runReport } from "../../src/ccusage.js";
import { normalizeReport } from "../../src/normalize.js";

/** @type {string[]} */
const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** @param {boolean} populated */
async function isolatedSource(populated) {
  const root = await mkdtemp(join(tmpdir(), "ccusage-dashboard-contract-"));
  directories.push(root);
  const home = join(root, "home");
  const empty = join(root, "empty");
  const claude = join(home, "claude");
  await mkdir(join(claude, "projects", "synthetic", "session"), {
    recursive: true,
  });
  await mkdir(empty, { recursive: true });
  if (populated) {
    await cp(
      new URL("../fixtures/claude-chat.jsonl", import.meta.url),
      join(claude, "projects", "synthetic", "session", "chat.jsonl"),
    );
  }
  const configPath = join(root, "ccusage.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      $schema: "https://ccusage.com/config-schema.json",
      defaults: {
        timezone: "UTC",
        mode: "auto",
        offline: true,
        noCost: false,
        order: "asc",
      },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    TMPDIR: join(root, "tmp"),
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: empty,
    OPENCODE_DATA_DIR: empty,
    AMP_DATA_DIR: empty,
    DROID_SESSIONS_DIR: empty,
    CODEBUFF_DATA_DIR: empty,
    HERMES_HOME: empty,
    PI_AGENT_DIR: empty,
    GOOSE_PATH_ROOT: empty,
    OPENCLAW_DIR: empty,
    KILO_DATA_DIR: empty,
    KIMI_DATA_DIR: empty,
    QWEN_DATA_DIR: empty,
    COPILOT_HOME: empty,
    COPILOT_OTEL_FILE_EXPORTER_PATH: join(empty, "missing.jsonl"),
    GEMINI_DATA_DIR: empty,
    ANTIGRAVITY_DATA_DIR: empty,
    GROK_HOME: empty,
    ZCODE_HOME: empty,
    LOG_LEVEL: "0",
    NO_COLOR: "1",
  };
  return {
    config: {
      binary: resolveBinary(),
      configPath,
      offline: true,
      cacheTtlMs: 1,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
      port: 0,
    },
    env,
  };
}

describe("installed ccusage 20.0.31 native contract", () => {
  test("the installed wrapper and native executable have the exact pinned version", async () => {
    const { config, env } = await isolatedSource(false);
    const pkg = await Bun.file(
      new URL("../../node_modules/ccusage/package.json", import.meta.url),
    ).json();
    expect(pkg.version).toBe("20.0.31");
    const child = Bun.spawn([config.binary, "--version"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      const [stdout, , code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain("20.0.31");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  });
  test("reports a synthetic Claude source through the unified daily by-agent shape", async () => {
    const { config, env } = await isolatedSource(true);
    const report = await runReport(config, { env });
    expect(report).toMatchObject({
      daily: [
        {
          period: "2026-01-09",
          agent: "all",
          totalTokens: 185,
          totalCost: 0.12,
          agents: [
            {
              agent: "claude",
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationTokens: 25,
              cacheReadTokens: 10,
              totalTokens: 185,
              totalCost: 0.12,
              modelBreakdowns: [
                {
                  modelName: "claude-sonnet-4-20250514",
                  cost: 0.12,
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheCreationTokens: 25,
                  cacheReadTokens: 10,
                },
              ],
            },
          ],
        },
      ],
      totals: { totalTokens: 185, totalCost: 0.12 },
    });
    expect(
      normalizeReport(report, { generatedAt: "2026-01-10T00:00:00.000Z" }).days,
    ).toHaveLength(1);
  });

  test("reports isolated empty source roots without reading a real home", async () => {
    const { config, env } = await isolatedSource(false);
    const report = await runReport(config, { env });
    expect(report).toEqual({
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
  });
});
