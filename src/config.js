// @ts-check
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ binary?: string, cacheTtlMs: number, configPath: string, maxOutputBytes: number, offline: boolean, port: number, timeoutMs: number }} Config */

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

/**
 * Parse the application environment without reading user configuration files.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const configuredBinary = env.CCUSAGE_BIN;
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
    port: integerValue(env, "PORT", 8766, { min: 0, max: 65535 }),
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
