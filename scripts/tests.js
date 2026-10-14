import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const scope = process.argv[2];
if (!["unit", "contract", "e2e"].includes(scope)) {
  throw new Error("Expected test scope: unit, contract, or e2e.");
}
const root = await mkdtemp(join(tmpdir(), "ccusage-tests-"));
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
let interrupted = false;
let cleaned = false;
function stopOwnedGroup() {
  if (!child?.pid) return;
  // Chromium can create its own process group. Record only descendants or
  // processes carrying this run's unique temporary profile path.
  const listing = spawnSync("ps", ["-eo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  if (listing.status !== 0)
    throw new Error("Cannot inspect owned test processes for cleanup.");
  const canonical = (/** @type {string} */ path) =>
    path.replaceAll("/private/var/", "/var/");
  const entries = listing.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match
      ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }]
      : [];
  });
  const owned = new Set([child.pid]);
  for (const entry of entries)
    if (canonical(entry.command).includes(canonical(root)))
      owned.add(entry.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries)
      if (owned.has(entry.parent) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        changed = true;
      }
  }
  for (const pid of [...owned].reverse()) {
    if (pid === process.pid || pid === child.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ESRCH"
        )
      )
        throw error;
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      )
    )
      throw error;
  }
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  stopOwnedGroup();
  await rm(root, { recursive: true, force: true });
}
const interrupt = () => {
  interrupted = true;
  stopOwnedGroup();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  for (const name of ["home", "tmp", "config", "data", "cache"])
    await mkdir(join(root, name));
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(homedir(), ".cache", "ms-playwright"));
  const args =
    scope === "e2e"
      ? ["node_modules/@playwright/test/cli.js", "test"]
      : ["test", `tests/${scope}`];
  if (interrupted) throw new Error("Test run interrupted before startup.");
  child = spawn(process.execPath, ["--no-env-file", ...args], {
    detached: true,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      CI: process.env.CI ? "1" : "",
      TZ: "UTC",
    },
  });
  const code = await new Promise((resolve, reject) => {
    child?.once("error", reject);
    child?.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = interrupted ? 130 : Number(code);
} finally {
  await cleanup();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
