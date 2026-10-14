import { buildIvRankDailySnapshot } from "./scannerIntelligence.js";

// Never call Tiger for this job while the US market is open or about to be.
export const IV_REFRESH_BLACKOUT_START_HOUR_ET = 9;
export const IV_REFRESH_START_HOUR_ET = 18;
export const IV_REFRESH_BATCH_SIZE = 10;
export const IV_REFRESH_MAX_ATTEMPTS = 3;
export const IV_REFRESH_RETRY_DELAY_MS = 30 * 60 * 1000;

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  weekday: "short"
});

export function etClock(now = new Date()) {
  const parts = Object.fromEntries(etFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: parts.weekday // Mon..Sun
  };
}

export function isWeekend(weekday) {
  return weekday === "Sat" || weekday === "Sun";
}

/** True during Mon-Fri 09:00-18:00 ET, when the job must not touch Tiger. */
export function isRefreshBlackout(now = new Date()) {
  const { hour, weekday } = etClock(now);
  return !isWeekend(weekday) && hour >= IV_REFRESH_BLACKOUT_START_HOUR_ET && hour < IV_REFRESH_START_HOUR_ET;
}

/**
 * The trading date whose end-of-day data this run should capture: today (ET) once
 * 18:00 ET has passed, otherwise the previous day. Weekends roll back to Friday.
 */
export function targetRunDate(now = new Date()) {
  const clock = etClock(now);
  let day = new Date(`${clock.date}T12:00:00Z`);
  if (clock.hour < IV_REFRESH_START_HOUR_ET) {
    day = new Date(day.getTime() - 86_400_000);
  }
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
    day = new Date(day.getTime() - 86_400_000);
  }
  return day.toISOString().slice(0, 10);
}

/** Tiger stamps daily points ~00:00 ET (04:00/05:00 UTC); +12h lands on the intended calendar date. */
export function tigerPointDate(timestampMs) {
  const ms = Number(timestampMs);
  return Number.isFinite(ms) ? new Date(ms + 12 * 3_600_000).toISOString().slice(0, 10) : null;
}

const finite = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (v) => (finite(v) == null ? null : Number(v) * 100); // Tiger rank/percentile are 0-1

export function normalizeTigerAnalysis(analysis = {}) {
  const byDate = new Map();
  for (const p of analysis.volatility_list ?? []) {
    const date = tigerPointDate(p.timestamp);
    const impliedVol = finite(p.implied_vol);
    if (!date || !(impliedVol > 0)) continue;
    byDate.set(date, {
      date,
      impliedVol,
      hisVolatility: finite(p.his_volatility),
      providerRank: pct(p.rank),
      providerPercentile: pct(p.percentile)
    });
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { symbol: String(analysis.symbol ?? "").toUpperCase(), rows, currentIv30: finite(analysis.implied_vol_30_days) };
}

export function buildDailySnapshot(normalized) {
  const last = normalized.rows.at(-1);
  if (!last) return null;
  return buildIvRankDailySnapshot({
    symbol: normalized.symbol,
    date: last.date,
    currentIv30: normalized.currentIv30 ?? last.impliedVol,
    ivHistory: normalized.rows.map((r) => ({ date: r.date, iv30: r.impliedVol }))
  });
}

/**
 * One nightly refresh. Dependencies are injected so the schedule/retry logic is testable.
 * Returns null when nothing was due.
 */
export async function runIvRefresh({ now = new Date(), force = false, deps }) {
  const { listSymbols, fetchAnalysis, saveHistory, saveSnapshot, getRun, saveRun, log = () => {} } = deps;
  if (!force && isRefreshBlackout(now)) return null;

  const runDate = targetRunDate(now);
  const existing = getRun(runDate);
  if (!force && existing) {
    if (existing.status === "ok") return null;
    if (existing.attempts >= IV_REFRESH_MAX_ATTEMPTS) return null;
    if (now.getTime() - Date.parse(existing.finishedAt) < IV_REFRESH_RETRY_DELAY_MS) return null;
  }

  const symbols = [...new Set(listSymbols().map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const attempts = (existing?.attempts ?? 0) + 1;
  const failed = [];
  let ok = 0;
  let runError = null;

  for (let i = 0; i < symbols.length; i += IV_REFRESH_BATCH_SIZE) {
    const batch = symbols.slice(i, i + IV_REFRESH_BATCH_SIZE);
    let results;
    try {
      results = await fetchAnalysis(batch);
    } catch (error) {
      runError = error.message;
      failed.push(...batch);
      log("batch failed", { batch, error: error.message });
      continue;
    }
    const bySymbol = new Map(results.map((r) => [String(r.symbol).toUpperCase(), r]));
    for (const symbol of batch) {
      try {
        const normalized = normalizeTigerAnalysis(bySymbol.get(symbol));
        const snapshot = bySymbol.has(symbol) ? buildDailySnapshot({ ...normalized, symbol }) : null;
        if (!snapshot) throw new Error("no IV history returned");
        saveHistory(symbol, normalized.rows);
        saveSnapshot(snapshot);
        ok += 1;
      } catch (error) {
        failed.push(symbol);
        log("symbol failed", { symbol, error: error.message });
      }
    }
  }

  const run = {
    runDate,
    status: failed.length === 0 ? "ok" : "partial",
    symbolsTotal: symbols.length,
    symbolsOk: ok,
    failedSymbols: failed.length ? failed.join(",") : null,
    attempts,
    error: runError
  };
  saveRun(run);
  return run;
}
