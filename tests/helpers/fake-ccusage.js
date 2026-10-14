// @ts-check
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** @param {string} directory */
export async function createFakeCcusage(directory) {
  const path = join(directory, "fake-ccusage.js");
  const source = `#!${process.execPath}
import {writeFileSync} from "node:fs";
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_MODE || "success";
if (mode === "stderr") process.stderr.write("private diagnostic\\n");
if (mode === "noisy") process.stderr.write("private".repeat(200000));
if (mode === "nonzero") { process.stderr.write("private failure\\n"); process.exit(7); }
if (mode === "invalid") { process.stdout.write("not json"); process.exit(0); }
if (mode === "overflow") { process.stdout.write("x".repeat(65536)); process.exit(0); }
if (mode === "hang" || mode === "ignore-term") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
process.stdout.write(process.env.FAKE_OUTPUT || '{"daily":[],"totals":{"inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"totalTokens":0,"totalCost":0}}');
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}
