import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { loadConfig } from "../../src/config.js";

test("rejects empty/NUL paths and timer overflow at startup", () => {
  for (const value of ["", "  ", "bad\u0000path"]) {
    expect(() => loadConfig({ CCUSAGE_CONFIG: value })).toThrow(
      "CCUSAGE_CONFIG",
    );
    expect(() => loadConfig({ CCUSAGE_BIN: value })).toThrow("CCUSAGE_BIN");
  }
  expect(() => loadConfig({ CCUSAGE_TIMEOUT_MS: "2147483648" })).toThrow(
    "CCUSAGE_TIMEOUT_MS",
  );
});

describe("loadConfig", () => {
  test("uses documented safe defaults", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 8766,
      configPath: expect.any(String),
      offline: true,
      cacheTtlMs: 60_000,
      timeoutMs: 120_000,
      maxOutputBytes: 67_108_864,
    });
    expect(isAbsolute(config.configPath)).toBe(true);
  });

  test("accepts strict explicit values including ephemeral test ports", () => {
    expect(
      loadConfig({
        PORT: "0",
        CCUSAGE_OFFLINE: "false",
        CCUSAGE_CACHE_TTL_MS: "0",
      }),
    ).toMatchObject({
      port: 0,
      offline: false,
      cacheTtlMs: 0,
    });
  });

  test("rejects invalid boolean, numeric, and empty executable values", () => {
    expect(() => loadConfig({ CCUSAGE_OFFLINE: "1" })).toThrow(
      "CCUSAGE_OFFLINE",
    );
    expect(() => loadConfig({ PORT: "8766.1" })).toThrow("PORT");
    expect(() => loadConfig({ CCUSAGE_TIMEOUT_MS: "0" })).toThrow(
      "CCUSAGE_TIMEOUT_MS",
    );
    expect(() => loadConfig({ CCUSAGE_BIN: " " })).toThrow("CCUSAGE_BIN");
  });
});
