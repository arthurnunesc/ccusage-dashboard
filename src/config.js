// @ts-check
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {import("../shared/types.d.ts").Config & { bindAddress: string }} Config */

/** @param {Record<string, string | undefined>} env @param {string} name @param {boolean} fallback */
function booleanValue(env, name, fallback) {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

/** @param {Record<string, string | undefined>} env @param {string} name @param {number} fallback @param {{ min: number, max: number }} range */
function integerValue(env, name, fallback, { min, max }) {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

/** @param {string} address */
function validateBindAddress(address) {
  if (isIP(address) !== 4)
    throw new Error("CCUSAGE_BIND_ADDRESS must be an IPv4 address");
  const octets = address.split(".").map(Number);
  if (
    address === "0.0.0.0" ||
    address === "255.255.255.255" ||
    (octets[0] >= 224 && octets[0] <= 239)
  )
    throw new Error("CCUSAGE_BIND_ADDRESS must be a unicast address");
  return octets[0] === 127;
}

/** @param {string} value */
function parseAllowedHosts(value) {
  return value.split(",").map((entry) => {
    const authority = entry.trim();
    const match = /^(\[[^\]]+\]|[^:]+):(0|[1-9]\d*)$/.exec(authority);
    if (!match)
      throw new Error(
        "CCUSAGE_ALLOWED_HOSTS must contain exact host:port entries",
      );
    const host = match[1];
    const port = Number(match[2]);
    const ipv6 =
      host.startsWith("[") &&
      host.endsWith("]") &&
      isIP(host.slice(1, -1)) === 6;
    const dns =
      host.length <= 253 &&
      host
        .split(".")
        .every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label)) &&
      (!/^[\d.]+$/.test(host) || isIP(host) === 4);
    if (
      (!ipv6 && !dns) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error(
        "CCUSAGE_ALLOWED_HOSTS must contain valid host:port entries",
      );
    return authority;
  });
}

/**
 * Parse the application environment without reading user configuration files.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const configuredBinary = env.CCUSAGE_BIN;
  const port = integerValue(env, "PORT", 8766, { min: 0, max: 65535 });
  const bindAddress = env.CCUSAGE_BIND_ADDRESS ?? "127.0.0.1";
  const loopback = validateBindAddress(bindAddress);
  const allowedHosts =
    env.CCUSAGE_ALLOWED_HOSTS === undefined
      ? undefined
      : parseAllowedHosts(env.CCUSAGE_ALLOWED_HOSTS);
  if (!loopback && (!allowedHosts || port === 0))
    throw new Error(
      "Non-loopback CCUSAGE_BIND_ADDRESS requires CCUSAGE_ALLOWED_HOSTS and a fixed nonzero PORT",
    );
  if (
    !loopback &&
    allowedHosts?.some(
      (host) => Number(host.slice(host.lastIndexOf(":") + 1)) !== port,
    )
  )
    throw new Error(
      "CCUSAGE_ALLOWED_HOSTS ports must match PORT for a non-loopback bind",
    );
  if (
    env.CCUSAGE_CONFIG !== undefined &&
    (env.CCUSAGE_CONFIG.trim() === "" || env.CCUSAGE_CONFIG.includes("\u0000"))
  ) {
    throw new Error("CCUSAGE_CONFIG must be one config file path");
  }
  if (
    configuredBinary !== undefined &&
    (configuredBinary.trim() === "" || configuredBinary.includes("\u0000"))
  ) {
    throw new Error("CCUSAGE_BIN must be one executable path");
  }

  return {
    port,
    bindAddress,
    allowedHosts,
    configPath: resolve(
      projectRoot,
      env.CCUSAGE_CONFIG ?? "ccusage.config.json",
    ),
    offline: booleanValue(env, "CCUSAGE_OFFLINE", true),
    cacheTtlMs: integerValue(env, "CCUSAGE_CACHE_TTL_MS", 60_000, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    timeoutMs: integerValue(env, "CCUSAGE_TIMEOUT_MS", 120_000, {
      min: 1,
      max: 2_147_483_647,
    }),
    maxOutputBytes: integerValue(env, "CCUSAGE_MAX_OUTPUT_BYTES", 67_108_864, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    }),
    ...(configuredBinary === undefined
      ? {}
      : { binary: resolve(configuredBinary) }),
  };
}
