// One Builder scan at a time, server-wide. The hourly auto-scan adds every listed stock; a scan someone asks for
// goes ahead of the auto entries still waiting (behind earlier requests), so it runs right after the current stock.
export function createScanQueue({ onError = () => {}, now = Date.now } = {}) {
  const pending = [];
  let current = null,
    seq = 0;
  const finished = new Map(); // owner -> { symbol -> { at, source, ok } }
  const view = (e) => ({ id: e.id, symbol: e.symbol, source: e.source, jobId: e.jobId ?? null });
  async function drain() {
    if (current) return;
    while (pending.length) {
      current = pending.shift();
      current.startedAt = now();
      let ok = true;
      try {
        await current.run();
      } catch (e) {
        ok = false;
        onError(e, current);
      }
      const done = finished.get(current.owner) ?? new Map();
      done.set(current.symbol, { at: new Date(now()).toISOString(), source: current.source, ok });
      finished.set(current.owner, done);
      current = null;
    }
  }
  return {
    // entry: { owner, symbol, source: "manual" | "auto", jobId?, run: async () => {} }
    add(entry) {
      const e = { ...entry, id: ++seq, queuedAt: now() };
      if (e.source === "manual") {
        const firstAuto = pending.findIndex((p) => p.source !== "manual");
        pending.splice(firstAuto < 0 ? pending.length : firstAuto, 0, e);
      } else pending.push(e);
      const behind = current ? view(current) : null,
        ahead = pending.indexOf(e);
      void drain();
      return { ...view(e), behind, ahead };
    },
    // True when the owner's symbol is waiting or running (optionally only for one source).
    has(owner, symbol, source = null) {
      return [current, ...pending].some(
        (p) => p && p.owner === owner && p.symbol === symbol && (!source || p.source === source),
      );
    },
    remove(predicate) {
      for (let i = pending.length - 1; i >= 0; i--) if (predicate(pending[i])) pending.splice(i, 1);
    },
    busy: () => Boolean(current),
    state(owner) {
      return {
        current: current ? { ...view(current), startedAt: new Date(current.startedAt).toISOString(), mine: current.owner === owner } : null,
        queue: pending.filter((p) => p.owner === owner).map(view),
        waiting: pending.length,
        finished: Object.fromEntries(finished.get(owner) ?? []),
      };
    },
  };
}
