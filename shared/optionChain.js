// Option-chain view of the Builder results table: one row per strike, calls on the left, puts on the right.
// Each contract is evaluated as "buy 1 at the ask" through the scanner's own position maths
// (summarizePosition / incomeMetrics), so a chain cell means the same thing as the same results-table column.
import { impliedVolatility } from "./optionMath.js";
import { DAY, number, summarizePosition, incomeMetrics } from "./builderEngine.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const contractKey = (expiry, type, strike) => `${expiry}|${type}|${Number(strike)}`;

// Standard monthlies expire on the third Friday; every other listed date is shown as a weekly ("W").
export function isWeeklyExpiry(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return !(d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21);
}

// Same contract filter the scanner applies: standard 100x multiplier, real strike and a dated expiry.
const usable = (c) =>
  (c.optionType === "call" || c.optionType === "put") &&
  c.strike > 0 &&
  ISO_DATE.test(c.expiration ?? "") &&
  (c.multiplier ?? 100) === 100;

export function chainExpiries(contracts, today) {
  const dates = new Set();
  for (const c of contracts) if (usable(c) && c.expiration >= today) dates.add(c.expiration);
  return [...dates].sort().map((date) => ({
    date,
    dte: Math.round((Date.parse(date) - Date.parse(today)) / DAY),
    weekly: isWeeklyExpiry(date),
  }));
}

// The listed expiry closest to `date` (the first one when there is no date to anchor on).
export function nearestExpiry(expiries, date) {
  if (!date) return expiries[0];
  const gap = (e) => Math.abs(Date.parse(e.date) - Date.parse(date));
  return expiries.reduce((best, e) => (gap(e) < gap(best) ? e : best), expiries[0]);
}

// `asOf` is the chain snapshot time. Provider IV is used when present; otherwise it is implied from the
// bid/ask mid at `spot`, the same fallback the scanner's Tiger normalizer uses.
export function contractMetrics(c, { spot, asOf, fee = 0, hv = null }) {
  const bid = number(c.bid),
    ask = number(c.ask);
  const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
  let iv = c.impliedVolatility > 0 ? Number(c.impliedVolatility) : null,
    ivDerived = false;
  if (iv == null && mid != null && spot > 0) {
    iv = impliedVolatility({
      type: c.optionType,
      spot,
      strike: c.strike,
      timeYears: (Date.parse(`${c.expiration}T20:00:00Z`) - Date.parse(asOf)) / (365 * DAY),
      price: mid,
    });
    ivDerived = iv != null;
  }
  const quoted = c.hasRealBidAsk === true && c.isLive === true;
  const out = {
    contractSymbol: c.contractSymbol ?? null,
    type: c.optionType,
    strike: c.strike,
    expiry: c.expiration,
    bid,
    ask,
    bidSize: number(c.bidSize),
    askSize: number(c.askSize),
    volume: number(c.volume),
    openInterest: number(c.openInterest),
    iv,
    ivDerived,
    quoted,
    // Position metrics need a price to buy at; without a usable ask they stay absent rather than guessed.
    priced: false,
  };
  if (!(ask > 0) || (bid != null && ask < bid) || !(spot > 0)) return out;
  const row = {
    symbol: c.symbol,
    asOf,
    expiry: c.expiration,
    spot,
    shares: 0,
    lots: 1,
    legs: [
      {
        type: c.optionType,
        quantity: 1,
        strike: c.strike,
        price: ask,
        iv: iv ?? 0,
        bid,
        ask,
        oi: out.openInterest,
        volume: out.volume,
        verifiedQuote: quoted,
      },
    ],
    netDebit: ask * 100,
    fees: fee,
    iv,
    hv,
  };
  Object.assign(row, summarizePosition(row));
  const m = incomeMetrics(row);
  return {
    ...out,
    priced: true,
    netDebit: row.netDebit,
    // null means unlimited, as in the results table.
    maxProfit: row.maxProfit,
    maxLoss: row.maxLoss,
    downBreakeven: m.downBreakeven,
    evPerBp: m.evPerBp,
    liquidity: m.liquidity,
    // Annualised return is an income yield; a bought option is a debit, so there is none to report.
    annRetPct: null,
  };
}

const total = (values) => {
  const known = values.filter((v) => v != null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

export function buildChain(contracts, expiry, ctx) {
  const byStrike = new Map(),
    seen = new Set();
  for (const c of contracts) {
    if (!usable(c) || c.expiration !== expiry) continue;
    const id = c.contractSymbol || contractKey(c.expiration, c.optionType, c.strike);
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byStrike.get(c.strike) ?? { strike: c.strike, call: null, put: null };
    row[c.optionType] = contractMetrics(c, ctx);
    byStrike.set(c.strike, row);
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    found = strikes.findIndex((r) => r.strike >= ctx.spot);
  const side = (type, key) => total(strikes.map((r) => r[type]?.[key] ?? null));
  return {
    expiry,
    strikes,
    // The spot divider sits before this strike (== strikes.length when spot is above the whole chain).
    spotIndex: found < 0 ? strikes.length : found,
    totals: {
      callVolume: side("call", "volume"),
      putVolume: side("put", "volume"),
    },
  };
}

// Scanned results that use each contract, so the chain can point back at the candidates built from it.
export function indexCandidates(rows) {
  const index = new Map();
  for (const r of rows)
    for (const l of r.legs ?? []) {
      const key = contractKey(r.expiry, l.type, l.strike);
      if (index.has(key)) index.get(key).push(r);
      else index.set(key, [r]);
    }
  return index;
}

// The Score cell of the results table: the exact score, or the range while liquidity is unverified.
// Results with neither (Polymarket rows) are unscored.
export function scoreLabel(row) {
  if (row.overall != null) return String(row.overall);
  return row.adjustedRange ? `${row.adjustedRange[0]}–${row.adjustedRange[1]}` : null;
}
// Ranks by the guaranteed minimum, so a result with unverified liquidity never outranks a verified one
// (the table likewise sorts rows without an exact score last).
export const scoreRank = (row) => row.overall ?? row.adjustedRange?.[0] ?? -1;

// The scanner reports earnings per result expiry ("Before expiry" / "Clear"). Earnings before an expiry
// are also before every later one, and a clear expiry is clear for every earlier one, so other expiries
// can be derived; anything between the two known bounds stays unknown (null).
export function earningsForExpiry(rows, expiry) {
  let before = null,
    clear = null;
  for (const r of rows) {
    if (!r.expiry) continue;
    if (r.earnings === "Before expiry" && (before == null || r.expiry < before)) before = r.expiry;
    if (r.earnings === "Clear" && (clear == null || r.expiry > clear)) clear = r.expiry;
  }
  if (before != null && expiry >= before) return "Before expiry";
  if (clear != null && expiry <= clear) return "Clear";
  return null;
}
