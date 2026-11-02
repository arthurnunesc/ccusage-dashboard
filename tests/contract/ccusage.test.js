import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    codex: empty,
  };
}

/** @param {string} codex @param {string} path @param {boolean} compressed @param {boolean} [later] */
async function writeRollout(codex, path, compressed, later = false) {
  const contents = await readFile(
    new URL("../fixtures/codex-rollout.jsonl", import.meta.url),
  );
  const data = later
    ? contents.toString().replaceAll("T00:00:", "T00:01:")
    : contents;
  const destination = join(codex, `${path}.jsonl${compressed ? ".zst" : ""}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, compressed ? Bun.zstdCompressSync(data) : data);
}

describe("installed ccusage 20.0.33 native contract", () => {
  test("the installed wrapper and native executable have the exact pinned version", async () => {
    const { config, env } = await isolatedSource(false);
    const pkg = await Bun.file(
      new URL("../../node_modules/ccusage/package.json", import.meta.url),
    ).json();
    expect(pkg.version).toBe("20.0.33");
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
      expect(stdout).toContain("20.0.33");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("compressed Codex rollouts match plain reports and normalized snapshots", async () => {
    const plain = await isolatedSource(false);
    const compressed = await isolatedSource(false);
    await writeRollout(plain.codex, "sessions/2026/01/09/rollout", false);
    await writeRollout(compressed.codex, "sessions/2026/01/09/rollout", true);
    const [plainReport, compressedReport] = await Promise.all([
      runReport(plain.config, { env: plain.env }),
      runReport(compressed.config, { env: compressed.env }),
    ]);
    expect(compressedReport).toEqual(plainReport);
    expect(plainReport).toMatchObject({
      daily: [{ period: "2026-01-09", agents: [{ agent: "codex" }] }],
      totals: { totalTokens: 120 },
    });
    const options = { generatedAt: "2026-01-10T00:00:00.000Z" };
    const plainSnapshot = normalizeReport(plainReport, options);
    expect(normalizeReport(compressedReport, options)).toEqual(plainSnapshot);
    expect(plainSnapshot.days).toMatchObject([
      { date: "2026-01-09", agent: "codex", totalTokens: 120 },
    ]);
  });

  test("counts a rollout with both encodings once", async () => {
    const source = await isolatedSource(false);
    await writeRollout(source.codex, "sessions/2026/01/09/rollout", false);
    await writeRollout(source.codex, "sessions/2026/01/09/rollout", true);
    const report = await runReport(source.config, { env: source.env });
    expect(report.totals.totalTokens).toBe(120);
    expect(normalizeReport(report).days[0].totalTokens).toBe(120);
  });

  test("includes compressed active and archived rollouts and deduplicates across encodings", async () => {
    const source = await isolatedSource(false);
    await writeRollout(source.codex, "sessions/active", true);
    await writeRollout(source.codex, "archived_sessions/archived", true, true);
    const baseline = await runReport(source.config, { env: source.env });
    expect(baseline.totals.totalTokens).toBe(240);
    expect(normalizeReport(baseline).days[0].totalTokens).toBe(240);
    await writeRollout(source.codex, "archived_sessions/active", false);
    const withDuplicate = await runReport(source.config, { env: source.env });
    expect(withDuplicate).toEqual(baseline);
    expect(normalizeReport(withDuplicate).days[0].totalTokens).toBe(240);

    const reverse = await isolatedSource(false);
    await writeRollout(reverse.codex, "sessions/active", false);
    await writeRollout(reverse.codex, "archived_sessions/archived", true, true);
    await writeRollout(reverse.codex, "archived_sessions/active", true);
    expect(await runReport(reverse.config, { env: reverse.env })).toEqual(
      baseline,
    );
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
