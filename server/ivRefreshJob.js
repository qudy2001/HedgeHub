import { logError, logInfo } from "./logger.js";
import {
  getIvRefreshRun,
  listAllMonitoredSymbols,
  saveIvRefreshRun,
  upsertIvRankDaily,
  upsertTigerIvHistory
} from "./db.js";
import { tigerRequest } from "./providers/tiger.js";
import { runIvRefresh } from "./ivHistory.js";

export const IV_REFRESH_TICK_MS = 5 * 60 * 1000;
const PERIOD = "3year"; // ~756 daily points; the first run doubles as the backfill

const deps = {
  listSymbols: listAllMonitoredSymbols,
  fetchAnalysis: async (symbols) =>
    (await tigerRequest("/options/analysis", { symbols: symbols.join(","), period: PERIOD }, 0)).data ?? [],
  saveHistory: upsertTigerIvHistory,
  saveSnapshot: upsertIvRankDaily,
  getRun: getIvRefreshRun,
  saveRun: saveIvRefreshRun,
  log: (message, meta) => logInfo(`IV refresh: ${message}`, { subsystem: "iv-refresh", ...meta })
};

let running = false;

export async function runIvRefreshTick(options = {}) {
  if (running) return null;
  running = true;
  try {
    const run = await runIvRefresh({ ...options, deps });
    if (run) {
      logInfo("IV refresh finished", { subsystem: "iv-refresh", ...run });
    }
    return run;
  } finally {
    running = false;
  }
}

/** Checks every 5 minutes; only does work after 18:00 ET (or on weekends) and once per trading date. */
export function startIvRefreshScheduler() {
  const tick = () => runIvRefreshTick().catch((error) => logError("IV refresh failed", { subsystem: "iv-refresh", error }));
  setInterval(tick, IV_REFRESH_TICK_MS);
  setTimeout(tick, 30_000); // catch up shortly after a restart
}
