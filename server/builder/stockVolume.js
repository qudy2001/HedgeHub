import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";
import { tigerEnabled, tigerRequest } from "../providers/tiger.js";
import { createStockVolumeStore } from "./stockVolumeStore.js";
import {
  validateStockProfile,
  profileWindows,
  shiftDate,
} from "../../shared/stockVolumeProfile.js";
const nyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function normalizeStockBars(rows, window) {
  if (!Array.isArray(rows)) throw new Error("Tiger did not return a bar list");
  if (rows.length >= 1200)
    throw new Error("Provider bar limit reached; window is incomplete");
  const map = new Map();
  let missing = 0;
  for (const b of rows) {
    const time = Number(b.time),
      close = b.close == null ? NaN : Number(b.close),
      volume = b.volume == null ? NaN : Number(b.volume);
    if (
      !Number.isFinite(time) ||
      time <= 0 ||
      !Number.isFinite(close) ||
      close <= 0 ||
      !Number.isFinite(volume) ||
      volume < 0
    ) {
      missing++;
      continue;
    }
    const date = nyDate.format(time);
    if (date < window.from || date > window.to) continue;
    map.set(time, { time, date, close, volume });
  }
  if (missing)
    throw new Error(
      `${missing} bars had missing prices or volumes; this window needs a retry`,
    );
  return [...map.values()].sort((a, b) => a.time - b.time);
}
export function createStockVolumeService({
  store = createStockVolumeStore(),
  enabled = tigerEnabled,
  read = tigerRequest,
  now = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
} = {}) {
  const jobs = new Map();
  let running = 0,
    closed = false;
  const snapshot = (j) => ({
    id: j.id,
    status: j.status,
    progress: j.progress,
    processed: j.processed,
    total: j.total,
    cacheHits: j.cacheHits,
    error: j.error,
    result: j.result,
  });
  async function run(job) {
    running++;
    const keys = [],
      warnings = [];
    let emptyWindows = 0,
      failures = 0;
    try {
      job.status = "running";
      const settings = job.settings,
        windows = profileWindows(settings);
      job.total = windows.length;
      for (const w of windows) {
        if (job.abort.signal.aborted) break;
        const cached = store.find(settings.symbol, settings.interval, w),
          recent = w.to >= shiftDate(settings.to, -3);
        if (cached && (!recent || now() - cached.fetched_at < 60000)) {
          keys.push(cached.cache_key);
          job.cacheHits++;
          if (!cached.bar_count) emptyWindows++;
        } else
          try {
            const params = {
              symbol: settings.symbol,
              period: settings.interval,
              from: w.from,
              to: w.to,
            };
            let response;
            try {
              response = await read("/stock-volume/bars", params, 0);
            } catch (e) {
              if (!/rate limit|frequency|too many|429/i.test(e.message))
                throw e;
              job.waiting = true;
              await wait(61000, job.abort.signal);
              job.waiting = false;
              response = await read("/stock-volume/bars", params, 0);
            }
            if (job.abort.signal.aborted) break;
            const bars = normalizeStockBars(response.data, w);
            keys.push(store.put(settings.symbol, settings.interval, w, bars));
            if (!bars.length) emptyWindows++;
            failures = 0;
          } catch (e) {
            if (job.abort.signal.aborted) break;
            warnings.push(`${w.from}–${w.to}: ${e.message}`);
            failures++;
          }
        job.processed++;
        job.progress = Math.round((job.processed / windows.length) * 90);
        if (failures >= 3) {
          warnings.push(
            "Stopped after three consecutive provider failures. Remaining history was not fetched.",
          );
          break;
        }
      }
      if (job.abort.signal.aborted || closed) return;
      job.status = "processing";
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(
          new URL("./stockVolumeWorker.js", import.meta.url),
          { workerData: { filename: store.filename, keys, settings } },
        );
        job.worker = worker;
        worker.once("message", (r) =>
          r.error ? reject(new Error(r.error)) : resolve(r),
        );
        worker.once("error", reject);
        worker.once("exit", () =>
          reject(new Error("Stock volume processing interrupted")),
        );
      });
      if (job.abort.signal.aborted || closed) return;
      if (emptyWindows)
        warnings.push(
          `${emptyWindows} requested windows returned no bars (for example holidays or unavailable history).`,
        );
      job.result = {
        ...result,
        source: "Tiger · regular session · unadjusted prices",
        interval: settings.interval,
        from: settings.from,
        to: settings.to,
        cacheHits: job.cacheHits,
        requestedWindows: windows.length,
        emptyWindows,
        warnings,
        complete: job.processed === windows.length && warnings.length === 0,
        asOf: new Date(now()).toISOString(),
      };
      job.status = "completed";
      job.progress = 100;
    } catch (e) {
      if (!job.abort.signal.aborted) {
        job.status = "failed";
        job.error = e.message;
      }
    } finally {
      running--;
      job.worker = null;
    }
  }
  return {
    start(owner, input) {
      if (closed) throw new Error("Stock volume service is closed");
      if (!enabled())
        throw new Error(
          "Stock volume history requires the configured Tiger provider.",
        );
      if (running >= 2)
        throw new Error(
          "Two history requests are running. Cancel one or wait.",
        );
      const settings = validateStockProfile(input, now()),
        job = {
          id: crypto.randomUUID(),
          owner,
          settings,
          status: "queued",
          progress: 0,
          processed: 0,
          total: 0,
          cacheHits: 0,
          abort: new AbortController(),
        };
      jobs.set(job.id, job);
      for (const [id, j] of jobs) {
        if (jobs.size <= 40) break;
        if (["completed", "failed", "cancelled"].includes(j.status))
          jobs.delete(id);
      }
      void run(job);
      return snapshot(job);
    },
    get(owner, id) {
      const j = jobs.get(id);
      return j?.owner === owner
        ? { ...snapshot(j), waiting: j.waiting ?? false }
        : null;
    },
    cancel(owner, id) {
      const j = jobs.get(id);
      if (j?.owner !== owner) return null;
      if (!["completed", "failed", "cancelled"].includes(j.status)) {
        j.status = "cancelled";
        j.abort.abort();
        j.worker?.terminate();
      }
      return snapshot(j);
    },
    close() {
      closed = true;
      for (const j of jobs.values()) {
        j.abort.abort();
        j.worker?.terminate();
      }
      store.close();
    },
  };
}
