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
  // Attach a rejection handler before cancellation; assert after owned cleanup.
  const result = pending.catch((error) => error);
  await Bun.sleep(1);
  await cache.close();
  expect(await result).toEqual(new Error("cancelled"));
  await expect(cache.refresh()).rejects.toThrow("closed");
});

test("failed first scan leaves no cache and a later load can recover", async () => {
  let calls = 0;
  const cache = createSnapshotCache({
    ttlMs: 100,
    runner: async () => {
      calls++;
      if (calls === 1) throw new Error("unavailable");
      return { generatedAt: "synthetic" };
    },
  });
  try {
    await expect(cache.load()).rejects.toThrow("unavailable");
    expect(cache.peek()).toBeNull();
    const loaded = await cache.load();
    expect(loaded.stale).toBe(false);
    expect(loaded.snapshot.generatedAt).toBe("synthetic");
  } finally {
    await cache.close();
  }
});
