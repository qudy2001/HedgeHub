import { finiteNumber as num, timestampIso } from '../quoteQuality.js';
import { optionDelta } from '../../shared/optionMath.js';

export const tigerEnabled = () => process.env.MARKET_DATA_PROVIDER === 'tiger';
const pending = new Map();
const cache = new Map();
export const tigerDiagnostics = {};
let queue = Promise.resolve();

export async function tigerRequest(path, params = {}, ttl = 0) {
  const query = new URLSearchParams(params);
  const key = `${path}?${query}`;
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < ttl) return existing.value;
  if (pending.has(key)) return pending.get(key);
  const job = queue.catch(() => {}).then(async () => {
    const status = tigerDiagnostics[path] ??= {};
    status.lastAttempt = new Date().toISOString();
    try {
      if (!process.env.TIGER_BRIDGE_TOKEN) throw new Error('Tiger bridge token is not configured');
      const response = await fetch(`${process.env.TIGER_BRIDGE_URL || 'http://127.0.0.1:8788'}${key}`, {
        headers: { authorization: `Bearer ${process.env.TIGER_BRIDGE_TOKEN}` },
        signal: AbortSignal.timeout(20_000)
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Tiger bridge HTTP ${response.status}`);
      const result = { data: body.data, fetchedAt: body.fetchedAt, source: 'tiger' };
      status.lastSuccess = body.fetchedAt;
      status.error = null;
      cache.set(key, { at: Date.now(), value: result });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return result;
    } catch (error) {
      status.error = error.message;
      throw error; // Never silently turn failure into synthetic market data.
    }
  });
  queue = job;
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}

export async function tigerQuotes(requests) {
  const results = [];
  for (const request of requests) {
    const symbol = typeof request === 'string' ? request : request.symbol;
    const r = await tigerRequest('/quotes', { symbol }, 10_000);
    const q = r.data?.[0];
    if (!q) throw new Error(`Tiger has no quote for ${symbol}`);
    results.push({ symbol, regularMarketPrice: num(q.latest_price ?? q.close), regularMarketTime: timestampIso(q.latest_time ?? q.time),
      shortName: q.name ?? symbol, source: 'tiger', fetchedAt: r.fetchedAt, quoteCoverage: 'Nasdaq Basic; not consolidated NBBO' });
  }
  return results;
}

export async function tigerHistory({ symbol, lookbackPoints = 320 }) {
  const r = await tigerRequest('/bars', { symbol }, 6 * 3600_000);
  const points = (r.data ?? []).map(p => ({ date: timestampIso(p.time)?.slice(0, 10), open: num(p.open), high: num(p.high),
    low: num(p.low), close: num(p.close), volume: num(p.volume) }))
    .filter(p => p.date && p.close > 0 && p.high >= p.low && p.low > 0)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-lookbackPoints);
  return { symbol, points, source: 'tiger', sourceLabel: 'Tiger OpenAPI', fetchedAt: r.fetchedAt, adjustment: 'forward-adjusted (Tiger BR)' };
}

export async function tigerFundamentals({ symbol }) {
  const r = await tigerRequest('/fundamentals', { symbol }, 24 * 3600_000);
  const f = r.data?.[0];
  if (!f) throw new Error('No Tiger fundamentals returned');
  return { ...f, symbol, source: 'tiger', generatedAt: r.fetchedAt, marketCapUsd: num(f.market_cap), peTtm: num(f.ttm_pe_rate),
    dividendYield: num(f.divide_rate) == null ? null : num(f.divide_rate) * 100, high52w: num(f.week52_high), low52w: num(f.week52_low),
    description: f.name ?? symbol, sector: f.sector ?? null, industry: f.industry ?? null };
}

export function normalizeTigerContract(c, { symbol, expiry, currentSpot, fetchedAt }) {
  const type = String(c.put_call).toLowerCase();
  const bid = num(c.bid_price), ask = num(c.ask_price), iv = num(c.implied_vol);
  const strike = num(c.strike);
  const expiration = expiry || timestampIso(c.expiry)?.slice(0, 10);
  const timeYears = (Date.parse(`${expiration}T20:00:00Z`) - Date.now()) / (365 * 86400_000);
  return { contractSymbol: c.identifier, symbol, expiration, optionType: type, strike, bid, ask,
    bidSize: num(c.bid_size), askSize: num(c.ask_size), mark: bid > 0 && ask >= bid ? (bid + ask) / 2 : null,
    lastPrice: num(c.latest_price), volume: num(c.volume), openInterest: num(c.open_interest), impliedVolatility: iv,
    multiplier: num(c.multiplier, 100), exerciseStyle: 'american', source: 'tiger', sourceLabel: 'Tiger OpenAPI',
    hasRealBidAsk: bid > 0 && ask >= bid, isLive: bid > 0 && ask >= bid,
    // A trade timestamp is NOT a quote timestamp. Filled from depth below.
    quoteTimestamp: null, tradeTimestamp: timestampIso(c.last_timestamp), fetchedAt,
    delta: optionDelta({ type, spot: currentSpot, strike, timeYears, volatility: iv }),
    greeksSource: 'European reference model; excludes early exercise and discrete dividends' };
}

export async function tigerOptionChain({ symbol, expiration, expirationFrom, expirationTo, optionType = 'call', currentSpot = 0, limit = 60, strikeMin, strikeMax }) {
  if (!(currentSpot > 0)) currentSpot = (await tigerQuotes([{ symbol }]))[0].regularMarketPrice;
  let expiries = [expiration];
  if (!expiration) {
    const r = await tigerRequest('/options/expirations', { symbol }, 6 * 3600_000);
    expiries = [...new Set((r.data ?? []).map(e => e.date).filter(d => d >= expirationFrom && d <= expirationTo))].sort();
  }
  const contracts = [];
  const warnings = [];
  for (const expiry of expiries.slice(0, 8)) {
    const r = await tigerRequest('/options/chain', { symbol, expiry }, 30_000);
    let rows = (r.data ?? []).filter(c => String(c.put_call).toLowerCase() === optionType)
      .map(c => normalizeTigerContract(c, { symbol, expiry, currentSpot, fetchedAt: r.fetchedAt }))
      .filter(c => c.strike > 0 && c.multiplier === 100 && (!strikeMin || c.strike >= strikeMin) && (!strikeMax || c.strike <= strikeMax));
    // Depth supplies actual bid/ask event timestamps; only hydrate near-spot contracts.
    rows = rows.sort((a, b) => Math.abs(a.strike - currentSpot) - Math.abs(b.strike - currentSpot)).slice(0, 30);
    try {
      const params = new URLSearchParams({ symbol });
      rows.forEach(c => params.append('contract', c.contractSymbol));
      if (rows.length) {
        const depth = (await tigerRequest('/options/depth', params, 10_000)).data;
        for (const c of rows) {
          const d = depth?.[c.contractSymbol] ?? (depth?.identifier === c.contractSymbol ? depth : null);
          const bids = (d?.bids ?? []).filter(x => x[0] > 0 && x[1] > 0).sort((a, b) => b[0] - a[0]);
          const asks = (d?.asks ?? []).filter(x => x[0] > 0 && x[1] > 0).sort((a, b) => a[0] - b[0]);
          if (bids.length && asks.length) {
            c.bid = bids[0][0]; c.ask = asks[0][0]; c.bidSize = bids[0][1]; c.askSize = asks[0][1];
            c.quoteTimestamp = timestampIso(Math.min(bids[0][2], asks[0][2]));
            c.mark = (c.bid + c.ask) / 2;
            c.hasRealBidAsk = c.ask >= c.bid;
          }
        }
      }
    } catch (e) { warnings.push(`Quote timestamps unavailable: ${e.message}`); }
    contracts.push(...rows);
  }
  return { symbol, optionType, contracts: limit > 0 ? contracts.slice(0, limit) : contracts, source: 'tiger', warnings,
    generatedAt: new Date().toISOString() };
}

export async function tigerEarnings(symbol, window = null) {
  const r = await tigerRequest('/events', { symbol, ...(window ? { from: window.from, to: window.to } : {}) }, 3600_000);
  const events = (r.data?.earnings ?? []).filter(e => String(e.symbol).toUpperCase() === symbol).map(e => ({
    ...e, date: timestampIso(e.report_date ?? e.earnings_date ?? e.earnings_timestamp ?? e.date)?.slice(0, 10)
  })).filter(e => e.date && e.date >= r.data.from).sort((a, b) => a.date.localeCompare(b.date));
  // A known next event establishes a window; an empty calendar does not.
  const next = events.find(e => e.date >= new Date().toISOString().slice(0, 10));
  return { source: 'tiger', fetchedAt: r.fetchedAt, events, complete: Boolean(next), from: r.data.from,
    to: next?.date ?? r.data.to, status: events.length ? 'event-found' : 'unknown' };
}
