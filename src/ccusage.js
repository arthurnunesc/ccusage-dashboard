// @ts-check
// ccusage publishes this function but does not ship declaration files.
// @ts-expect-error -- ccusage's JavaScript wrapper has no .d.ts file.
import { resolveNativeBinary as resolveInstalledNativeBinary } from "ccusage/src/cli.js";
import { ReportCompatibilityError, validateReport } from "./normalize.js";

/** @typedef {import("../shared/types.d.ts").Config} Config */

export class ReportRunnerError extends Error {
  /** @param {"BINARY_MISSING" | "CANCELLED" | "INCOMPATIBLE_REPORT" | "INVALID_JSON" | "OUTPUT_LIMIT" | "PROCESS_FAILED" | "TIMEOUT"} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ReportRunnerError";
    this.code = code;
  }
}

/** Resolve only the native executable paired with the installed ccusage package. */
export function resolveBinary() {
  const binary = resolveInstalledNativeBinary();
  if (binary === undefined) {
    throw new ReportRunnerError(
      "BINARY_MISSING",
      "The installed ccusage native executable is unavailable. Reinstall ccusage with its optional native package.",
    );
  }
  return binary;
}

/** @param {ReadableStream<Uint8Array>} stream @param {(chunk: Uint8Array) => void} onChunk */
async function consume(stream, onChunk) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      onChunk(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run one native ccusage unified daily report. The child receives no shell command.
 * @param {Config} config
 * @param {{ signal?: AbortSignal, env?: Record<string, string | undefined> }} [options]
 */
export async function runReport(config, { signal, env = process.env } = {}) {
  if (signal?.aborted)
    throw new ReportRunnerError(
      "CANCELLED",
      "The ccusage report was cancelled.",
    );
  const command = config.binary ?? resolveBinary();
  const args = [
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
    config.configPath,
  ];
  if (config.offline) args.push("--offline");

  /** @type {Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined} */
  let child;
  try {
    child = Bun.spawn([command, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch {
    throw new ReportRunnerError(
      "BINARY_MISSING",
      "The configured ccusage executable could not be started.",
    );
  }
  if (child === undefined) {
    throw new ReportRunnerError(
      "BINARY_MISSING",
      "The configured ccusage executable could not be started.",
    );
  }
  let reason =
    /** @type {"CANCELLED" | "OUTPUT_LIMIT" | "TIMEOUT" | undefined} */ (
      undefined
    );
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    try {
      child?.kill("SIGKILL");
    } catch {
      // The child already exited. Its `exited` promise remains the cleanup boundary.
    }
  };
  const onAbort = () => {
    reason = "CANCELLED";
    terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    reason = "TIMEOUT";
    terminate();
  }, config.timeoutMs);
  /** @type {Uint8Array[]} */
  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutTask = consume(child.stdout, (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > config.maxOutputBytes) {
      reason ??= "OUTPUT_LIMIT";
      terminate();
      return;
    }
    stdout.push(chunk);
  });
  const stderrTask = consume(child.stderr, (chunk) => {
    // Drain all stderr, but never retain potentially private diagnostic output.
    stderrBytes = Math.min(stderrBytes + chunk.byteLength, 65_536);
  });

  let exitCode;
  try {
    [exitCode] = await Promise.all([child.exited, stdoutTask, stderrTask]);
  } catch {
    terminate();
    await Promise.allSettled([child.exited, stdoutTask, stderrTask]);
    throw new ReportRunnerError(
      "PROCESS_FAILED",
      "The report streams could not be read.",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (reason === "TIMEOUT")
    throw new ReportRunnerError(
      "TIMEOUT",
      "ccusage did not finish before the configured timeout.",
    );
  if (reason === "OUTPUT_LIMIT")
    throw new ReportRunnerError(
      "OUTPUT_LIMIT",
      "ccusage output exceeded CCUSAGE_MAX_OUTPUT_BYTES. Increase that limit for this history.",
    );
  if (reason === "CANCELLED")
    throw new ReportRunnerError(
      "CANCELLED",
      "The ccusage report was cancelled.",
    );
  if (exitCode !== 0)
    throw new ReportRunnerError(
      "PROCESS_FAILED",
      "ccusage could not load the usage report.",
    );

  let report;
  try {
    report = JSON.parse(new TextDecoder().decode(concat(stdout, stdoutBytes)));
  } catch {
    throw new ReportRunnerError(
      "INVALID_JSON",
      "ccusage returned malformed JSON.",
    );
  }
  try {
    validateReport(report);
  } catch (error) {
    if (error instanceof ReportCompatibilityError) {
      throw new ReportRunnerError(
        "INCOMPATIBLE_REPORT",
        "ccusage returned an incompatible daily by-agent report.",
      );
    }
    throw error;
  }
  return report;
}

/** @param {Uint8Array[]} chunks @param {number} size */
function concat(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
