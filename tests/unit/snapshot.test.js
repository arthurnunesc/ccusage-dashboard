import { expect, test } from "bun:test";
import { createSnapshotCache } from "../../src/snapshot.js";

test("single-flight, TTL, stale recovery, and unchanged successful timestamp", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const cache = createSnapshotCache({
    ttlMs: 10,
    clock: () => now,
    runner: async () => {
      calls++;
      await Bun.sleep(5);
      if (fail) throw new Error("safe failure");
      return { generatedAt: now };
    },
  });
  try {
    const [a, b] = await Promise.all([cache.load(), cache.refresh()]);
    expect(a.snapshot).toBe(b);
    expect(calls).toBe(1);
    now = 9;
    await cache.load();
    expect(calls).toBe(1);
    now = 10;
    await cache.load();
    expect(calls).toBe(2);
    fail = true;
    now = 20;
    const stale = await cache.load();
    expect(stale.stale).toBe(true);
    expect(stale.snapshot.generatedAt).toBe(10);
    await expect(cache.refresh()).rejects.toThrow("safe failure");
    expect(cache.peek()?.generatedAt).toBe(10);
    fail = false;
    expect((await cache.load()).stale).toBe(false);
  } finally {
    await cache.close();
  }
});

test("close aborts owned operation and prohibits new refreshes", async () => {
  const cache = createSnapshotCache({
    ttlMs: 0,
    runner: (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }),
  });
  const pending = cache.load();
  const assertion = expect(pending).rejects.toThrow("cancelled");
  await Bun.sleep(1);
  await cache.close();
  await assertion;
  await expect(cache.refresh()).rejects.toThrow("closed");
});
