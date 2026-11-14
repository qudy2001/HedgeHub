import { optionBrief } from "../../shared/optionBrief.js";
import { technicals } from "../../shared/builderEngine.js";

// Option positioning for the research agents, read only from what the Builder has already cached: the
// newest snapshot of the symbol that holds a full option chain. Nothing is fetched here, so starting a
// research run never spends provider quota; a symbol with no recent chain simply runs without the brief.
export const OPTION_CONTEXT_MAX_AGE_DAYS = 4; // a Friday chain still serves a Monday or Tuesday run
const DAY = 86400000;

export function createOptionContext(
  snapshots,
  { maxAgeDays = OPTION_CONTEXT_MAX_AGE_DAYS, now = Date.now } = {},
) {
  return function optionContext(owner, symbol) {
    const at = now(),
      hit = snapshots
        .list(owner, symbol)
        .find(
          (s) => s.parts.includes("distribution") && at - Date.parse(s.capturedAt) <= maxAgeDays * DAY,
        );
    if (!hit) return null;
    const snapshot = snapshots.get(owner, hit.id),
      chain = snapshot?.parts.distribution?.data;
    if (!chain?.contracts?.length) return null;
    const scan = snapshot.parts.scan?.data,
      volatility = snapshot.parts.research?.data?.volatility,
      tech = technicals(scan?.dataset?.bars ?? []);
    return optionBrief({
      symbol,
      contracts: chain.contracts,
      spot: scan?.dataset?.spot ?? snapshot.summary?.spot,
      source: chain.source,
      capturedAt: chain.asOf ?? snapshot.parts.distribution.capturedAt,
      complete: chain.complete !== false,
      stats: {
        rsi: tech.rsi,
        support: tech.support,
        resistance: tech.resistance,
        hv: tech.hv,
        iv: volatility?.history?.at(-1)?.iv ?? volatility?.iv,
        ivRank: volatility?.historical?.rank,
      },
      now: at,
    });
  };
}
