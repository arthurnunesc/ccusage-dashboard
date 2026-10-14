import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReport } from "../../src/ccusage.js";
import { loadConfig } from "../../src/config.js";
import { normalizeReport } from "../../src/normalize.js";
import { createApplication } from "../../src/server.js";

// This managed server only spawns our synthetic executable; no native log scan.
const directory = await mkdtemp(join(tmpdir(), "ccusage-browser-"));
let closed = false;
/** @type {ReturnType<typeof createApplication> | undefined} */
let app;
async function close() {
  if (closed) return;
  closed = true;
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
process.once("SIGINT", async () => {
  await close();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await close();
  process.exit(0);
});
try {
  await mkdir(join(directory, "home"));
  const config = loadConfig({
    PORT: "18766",
    CCUSAGE_BIN: new URL("./browser-ccusage.js", import.meta.url).pathname,
  });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
  };
  app = createApplication({
    config,
    runner: async (signal) =>
      normalizeReport(await runReport(config, { signal, env }), {
        offline: true,
      }),
  });
  app.start();
} catch (error) {
  await close();
  throw error;
}
