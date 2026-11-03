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
      bindAddress: "127.0.0.1",
      allowedHosts: undefined,
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

  test("requires explicit matching hosts and a fixed port for non-loopback", () => {
    const env = { CCUSAGE_BIND_ADDRESS: "192.168.1.52" };
    expect(() => loadConfig(env)).toThrow("CCUSAGE_ALLOWED_HOSTS");
    expect(() =>
      loadConfig({
        ...env,
        PORT: "0",
        CCUSAGE_ALLOWED_HOSTS: "example.test:8766",
      }),
    ).toThrow("PORT");
    expect(() =>
      loadConfig({ ...env, CCUSAGE_ALLOWED_HOSTS: "example.test:8765" }),
    ).toThrow("PORT");
    expect(
      loadConfig({
        ...env,
        CCUSAGE_ALLOWED_HOSTS: " 192.168.1.52:8766, example.test:8766 ",
      }),
    ).toMatchObject({
      bindAddress: "192.168.1.52",
      allowedHosts: ["192.168.1.52:8766", "example.test:8766"],
    });
    expect(
      loadConfig({ CCUSAGE_BIND_ADDRESS: "127.0.0.2", PORT: "0" }).port,
    ).toBe(0);
  });

  test("rejects invalid, wildcard, multicast and broadcast bind addresses", () => {
    for (const address of [
      "",
      "localhost",
      "::1",
      "0.0.0.0",
      "224.0.0.1",
      "239.255.255.255",
      "255.255.255.255",
      "1.2.3.999",
      " 127.0.0.1",
    ]) {
      expect(() => loadConfig({ CCUSAGE_BIND_ADDRESS: address })).toThrow(
        "CCUSAGE_BIND_ADDRESS",
      );
    }
  });

  test("strictly validates every explicit authority", () => {
    for (const value of [
      "",
      " ",
      "localhost:8766,",
      ",localhost:8766",
      "localhost:8766,,example.com:8766",
      "http://localhost:8766",
      "localhost:8766/path",
      "user@localhost:8766",
      "*.example.com:8766",
      "localhost",
      "localhost:0",
      "localhost:65536",
      "localhost:-1",
      "localhost:01",
      "localhost:abc",
      "bad host:80",
      "bad..host:80",
      "999.1.1.1:80",
      "[::1]:80/path",
    ]) {
      expect(() => loadConfig({ CCUSAGE_ALLOWED_HOSTS: value })).toThrow(
        "CCUSAGE_ALLOWED_HOSTS",
      );
    }
    expect(
      loadConfig({ CCUSAGE_ALLOWED_HOSTS: "localhost:8766,[::1]:8766" })
        .allowedHosts,
    ).toEqual(["localhost:8766", "[::1]:8766"]);
  });
});
