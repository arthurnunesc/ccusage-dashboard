import { calculateReport } from "../shared/report.js";
import { runReport } from "./ccusage.js";
import { loadConfig } from "./config.js";
import { normalizeReport } from "./normalize.js";
import { createSnapshotCache } from "./snapshot.js";

const root = new URL("../", import.meta.url);
const assets = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/web/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/web/chart.js", ["web/chart.js", "text/javascript; charset=utf-8"]],
  ["/web/table.js", ["web/table.js", "text/javascript; charset=utf-8"]],
  ["/web/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
  ["/shared/report.js", ["shared/report.js", "text/javascript; charset=utf-8"]],
  ["/shared/format.js", ["shared/format.js", "text/javascript; charset=utf-8"]],
]);
const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
};

/** Public errors are selected from a fixed map, never from subprocess text. */
const messages = {
  TIMEOUT: "The ccusage scan timed out. Increase CCUSAGE_TIMEOUT_MS and retry.",
  OUTPUT_LIMIT:
    "The report exceeded its memory limit. Increase CCUSAGE_MAX_OUTPUT_BYTES and retry.",
  BINARY_MISSING:
    "The pinned ccusage native executable is missing. Reinstall dependencies.",
  INVALID_JSON:
    "ccusage returned invalid JSON. Check the pinned release and configuration.",
  INCOMPATIBLE_REPORT:
    "The ccusage report is incompatible. Run the contract test.",
  PROCESS_FAILED:
    "ccusage could not read a report. Check your source configuration and retry.",
  CANCELLED: "The report scan was cancelled.",
};

/** @param {unknown} error */
function safeError(error) {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "PROCESS_FAILED";
  const code = Object.hasOwn(messages, candidate)
    ? candidate
    : "PROCESS_FAILED";
  return {
    code,
    message: messages[/** @type {keyof typeof messages} */ (code)],
  };
}

/**
 * Imports do not start listeners or scan logs. Tests inject synthetic runners.
 * @param {{config?: ReturnType<typeof loadConfig>, runner?: (signal: AbortSignal) => Promise<ReturnType<typeof normalizeReport>>, clock?: () => number}} options
 */
export function createApplication({
  config = loadConfig(),
  runner,
  clock = Date.now,
} = {}) {
  const cache = createSnapshotCache({
    ttlMs: config.cacheTtlMs,
    clock,
    runner:
      runner ??
      (async (signal) =>
        normalizeReport(await runReport(config, { signal }), {
          generatedAt: new Date(clock()).toISOString(),
          offline: config.offline,
        })),
  });
  const payload = (
    /** @type {ReturnType<typeof normalizeReport>} */ snapshot,
    stale = false,
  ) => ({
    ...snapshot,
    stale,
    warnings: [
      ...snapshot.warnings,
      ...(stale ? ["Refresh failed. Showing the last successful report."] : []),
    ],
    metrics: calculateReport(snapshot.days, { now: new Date(clock()) }),
  });
  /** @type {ReturnType<typeof Bun.serve> | null} */
  let server = null;
  const json = (/** @type {unknown} */ data, status = 200) =>
    Response.json(data, { status, headers: securityHeaders });
  /** @param {Request} request */
  async function fetchHandler(request) {
    const url = new URL(request.url);
    const port = server?.port ?? config.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.get("host") ?? ""))
      return json(
        { error: { code: "FORBIDDEN", message: "Invalid local Host." } },
        403,
      );
    const path = url.pathname;
    const isRefresh = path === "/api/refresh";
    if (
      !assets.has(path) &&
      !["/api/usage", "/api/refresh", "/api/health"].includes(path)
    )
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    const method = isRefresh ? "POST" : "GET";
    if (request.method !== method)
      return new Response(null, {
        status: 405,
        headers: { ...securityHeaders, Allow: method },
      });
    if (isRefresh) {
      const expectedOrigin = `http://${request.headers.get("host")}`;
      if (
        request.headers.get("origin") !== expectedOrigin ||
        request.headers.get("x-ccusage-refresh") !== "1"
      )
        return json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Refresh requires a same-origin request.",
            },
          },
          403,
        );
    }
    if (path === "/api/health")
      return json({
        status: "ok",
        schemaVersion: 1,
        ccusageVersion: "20.0.31",
      });
    if (assets.has(path)) {
      const [file, type] = /** @type {[string,string]} */ (assets.get(path));
      return new Response(Bun.file(new URL(file, root)), {
        headers: { ...securityHeaders, "Content-Type": type },
      });
    }
    try {
      if (isRefresh) return json(payload(await cache.refresh()));
      const result = await cache.load();
      return json(payload(result.snapshot, result.stale));
    } catch (error) {
      return json(
        { error: safeError(error), stale: cache.peek() !== null },
        503,
      );
    }
  }
  return {
    fetch: fetchHandler,
    start() {
      if (server) throw new Error("Application already started.");
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: config.port,
        fetch: fetchHandler,
      });
      return server;
    },
    async close() {
      await cache.close();
      await server?.stop(true);
      server = null;
    },
  };
}

if (import.meta.main) {
  const app = createApplication();
  const server = app.start();
  console.log(`Coding Agent Usage: http://127.0.0.1:${server.port}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
