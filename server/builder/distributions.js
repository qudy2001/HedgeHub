import {
  tigerEnabled,
  tigerRequest,
  normalizeTigerContract,
} from "../providers/tiger.js";
import { fetchOptionChain } from "../providers/yahooFinance.js";
import { addDays, dateOnly } from "../../shared/builderEngine.js";
export function createDistributionLoader({
  enabled = tigerEnabled,
  readTiger = tigerRequest,
  readChain = fetchOptionChain,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const cache = new Map();
  return async function load(symbol, days = 365) {
    const key = `${enabled()}:${symbol}:${days}`,
      old = cache.get(key);
    if (old && Date.now() - old.at < 600000) return old.promise;
    const promise = (async () => {
      const from = dateOnly(Date.now()),
        to = addDays(from, days),
        contracts = [],
        warnings = [];
      let source,
        complete = true;
      if (enabled()) {
        source = "Tiger";
        const response = await readTiger(
          "/options/expirations",
          { symbol },
          6 * 3600000,
        );
        const expiries = [
          ...new Set(
            (response.data ?? [])
              .map((e) => e.date)
              .filter((d) => d >= from && d <= to),
          ),
        ].sort();
        // Distribution needs every strike and expiry, not the scanner's near-spot/depth subset.
        for (const expiry of expiries) {
          try {
            let r;
            try {
              r = await readTiger("/options/chain", { symbol, expiry }, 600000);
            } catch (error) {
              if (!/rate limit|frequency|too many|429/i.test(error.message))
                throw error;
              // The bridge shares its rolling quota with the rest of HedgeHub.
              // Retry this expiry after the quota window instead of dropping far dates.
              await wait(61000);
              r = await readTiger("/options/chain", { symbol, expiry }, 600000);
            }
            contracts.push(
              ...(r.data ?? []).map((c) =>
                normalizeTigerContract(c, {
                  symbol,
                  expiry,
                  currentSpot: 0,
                  fetchedAt: r.fetchedAt,
                }),
              ),
            );
          } catch (e) {
            complete = false;
            warnings.push(`${expiry}: ${e.message}`);
          }
        }
      } else {
        source = "Yahoo";
        const results = await Promise.allSettled(
          ["call", "put"].map((optionType) =>
            readChain({
              symbol,
              expirationFrom: from,
              expirationTo: to,
              optionType,
              limit: 0,
            }),
          ),
        );
        for (const r of results) {
          if (r.status === "rejected") {
            complete = false;
            warnings.push(r.reason.message);
            continue;
          }
          const data = r.value;
          if (data.source === "modeled") {
            complete = false;
            warnings.push(
              data.warning ||
                "Option provider unavailable. No synthetic OI or volume used.",
            );
            continue;
          }
          contracts.push(
            ...(data.contracts ?? []).filter((c) => c.source !== "modeled"),
          );
          if (data.truncated) {
            complete = false;
            warnings.push("Provider response was truncated.");
          }
          if (data.warning) warnings.push(data.warning);
        }
      }
      return {
        symbol,
        contracts,
        source,
        asOf: new Date().toISOString(),
        from,
        to,
        complete,
        warnings,
      };
    })();
    cache.set(key, { at: Date.now(), promise });
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    try {
      return await promise;
    } catch (e) {
      cache.delete(key);
      throw e;
    }
  };
}
