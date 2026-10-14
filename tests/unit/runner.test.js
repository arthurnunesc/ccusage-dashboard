import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReportRunnerError,
  resolveBinary,
  runReport,
} from "../../src/ccusage.js";
import { createFakeCcusage } from "../helpers/fake-ccusage.js";

/** @type {string[]} */
const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("real child PIDs are gone after timeout, overflow, and cancellation", async () => {
  const { binary, config, directory, env } = await setup();
  for (const mode of ["ignore-term", "overflow", "hang"]) {
    const pidFile = join(directory, `${mode}.pid`);
    const controller = new AbortController();
    const pending = runReport(
      { ...config, binary, timeoutMs: 2000 },
      {
        env: { ...env, FAKE_MODE: mode, FAKE_PID_FILE: pidFile },
        signal: controller.signal,
      },
    ).catch((error) => error);
    if (mode === "hang") {
      for (let i = 0; i < 100; i++) {
        if (await Bun.file(pidFile).exists()) break;
        await Bun.sleep(5);
      }
      controller.abort();
    }
    const error = await pending;
    expect(error).toBeInstanceOf(ReportRunnerError);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

test("large stderr is drained concurrently and malformed schemas are distinct", async () => {
  const { binary, config, env } = await setup();
  expect(
    await runReport(
      { ...config, binary },
      { env: { ...env, FAKE_MODE: "noisy" } },
    ),
  ).toMatchObject({ daily: [] });
  await expect(
    runReport(
      { ...config, binary },
      { env: { ...env, FAKE_OUTPUT: '{"daily":[],"totals":{}}' } },
    ),
  ).rejects.toMatchObject({ code: "INCOMPATIBLE_REPORT" });
  await expect(
    runReport({ ...config, binary: join("/missing", "ccusage") }),
  ).rejects.toMatchObject({ code: "BINARY_MISSING" });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "ccusage-dashboard-runner-"));
  directories.push(directory);
  return {
    directory,
    env: {
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: directory,
      XDG_CACHE_HOME: directory,
    },
    binary: await createFakeCcusage(directory),
    config: {
      binary: "",
      configPath: join(directory, "config.json"),
      offline: true,
      cacheTtlMs: 1,
      timeoutMs: 1_000,
      maxOutputBytes: 1024,
      port: 0,
    },
  };
}

describe("runReport", () => {
  test("native resolution failures use a distinct safe error", () => {
    for (const resolver of [
      () => undefined,
      () => {
        throw new Error("private resolver path");
      },
    ]) {
      try {
        resolveBinary(resolver);
        throw new Error("Expected resolution failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ReportRunnerError);
        expect(/** @type {ReportRunnerError} */ (error).code).toBe(
          "BINARY_MISSING",
        );
        expect(/** @type {Error} */ (error).message).not.toContain("private");
      }
    }
  });
  test("required argument array and offline opt-in are explicit", async () => {
    const { binary, config, directory, env } = await setup();
    const file = join(directory, "arguments.json");
    for (const offline of [true, false]) {
      await runReport(
        { ...config, binary, offline },
        { env: { ...env, FAKE_ARGS_FILE: file } },
      );
      const args = JSON.parse(await readFile(file, "utf8"));
      expect(args.slice(0, 10)).toEqual([
        "daily",
        "--by-agent",
        "--json",
        "--timezone",
        "UTC",
        "--order",
        "asc",
        "--mode",
        "auto",
        "--config",
      ]);
      expect(args.includes("--offline")).toBe(offline);
      expect(args.includes("--no-cost")).toBe(false);
    }
    const shipped = await Bun.file(
      new URL("../../ccusage.config.json", import.meta.url),
    ).json();
    expect(shipped.defaults.offline).toBeUndefined();
    expect(shipped.defaults.noCost).toBe(false);
  });
  test("accepts valid stdout while discarding stderr", async () => {
    const { binary, config, env } = await setup();
    const report = await runReport(
      { ...config, binary },
      { env: { ...env, FAKE_MODE: "stderr" } },
    );
    expect(report).toMatchObject({ daily: [], totals: { totalTokens: 0 } });
  });

  test("uses distinct safe errors for failed child and bad JSON", async () => {
    const { binary, config, env } = await setup();
    await expect(
      runReport(
        { ...config, binary },
        { env: { ...env, FAKE_MODE: "nonzero" } },
      ),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    await expect(
      runReport(
        { ...config, binary },
        { env: { ...env, FAKE_MODE: "invalid" } },
      ),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
  });

  test("terminates over-limit, timed out, and aborted children", async () => {
    const { binary, config, env } = await setup();
    await expect(
      runReport(
        { ...config, binary },
        { env: { ...env, FAKE_MODE: "overflow" } },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    await expect(
      runReport(
        { ...config, binary, timeoutMs: 50 },
        { env: { ...env, FAKE_MODE: "hang" } },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    const controller = new AbortController();
    const promise = runReport(
      { ...config, binary },
      { env: { ...env, FAKE_MODE: "hang" }, signal: controller.signal },
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ReportRunnerError);
    await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
