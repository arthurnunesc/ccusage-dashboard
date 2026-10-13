/**
 * Single-flight successful-snapshot cache. Failed scans never replace history.
 * @template T
 * @param {{runner: (signal: AbortSignal) => Promise<T>, ttlMs: number, clock?: () => number}} options
 */
export function createSnapshotCache({ runner, ttlMs, clock = Date.now }) {
  /** @type {T | null} */
  let snapshot = null;
  let loadedAt = 0;
  /** @type {Promise<T> | null} */
  let inflight = null;
  const controller = new AbortController();
  let closed = false;
  const refresh = () => {
    if (closed) return Promise.reject(new Error("Application is closed."));
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => runner(controller.signal))
      .then((next) => {
        snapshot = next;
        loadedAt = clock();
        return next;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return {
    refresh,
    async load() {
      if (snapshot && clock() - loadedAt < ttlMs)
        return { snapshot, stale: false };
      try {
        return { snapshot: await refresh(), stale: false };
      } catch (error) {
        if (!snapshot) throw error;
        return { snapshot, stale: true };
      }
    },
    peek: () => snapshot,
    async close() {
      closed = true;
      controller.abort();
      await inflight?.catch(() => {});
    },
  };
}
