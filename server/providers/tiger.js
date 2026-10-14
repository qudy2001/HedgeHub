import { AsyncLocalStorage } from 'node:async_hooks';
import { finiteNumber as num, timestampIso } from '../quoteQuality.js';
import { optionDelta, impliedVolatility } from '../../shared/optionMath.js';

export const tigerEnabled = () => process.env.MARKET_DATA_PROVIDER === 'tiger';
const pending = new Map();
const cache = new Map();
export const tigerDiagnostics = {};
let queue = Promise.resolve();

// The bridge allows a limited number of calls per minute per function (shared by every HedgeHub process).
// Background jobs (scans) opt in to waiting out a 429 and retrying; request handlers fail fast with the
// wait time instead, so an HTTP request is never held open for a minute and other Tiger calls never queue
// behind a sleeping one.
const rateLimit = { until: 0, waits: 0 };
const maxRateLimitWaitMs = () => Number(process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS) || 150_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitContext = new AsyncLocalStorage();

export const withRateLimitWaiting = (fn) => waitContext.run(true, fn);

export function getTigerRateLimitState() {
  return { waitingUntil: rateLimit.until > Date.now() ? rateLimit.until : null, waits: rateLimit.waits };
}

class TigerRateLimitError extends Error {
  constructor(retryAfterSec) {
    super(`Tiger rate limit: retry after ${Math.ceil(retryAfterSec)} seconds`);
    this.retryAfterSec = retryAfterSec;
    this.isRateLimit = true;
  }
}

// One serialized call to the bridge. Never sleeps, so the queue always keeps moving.
function bridgeAttempt(path, key) {
  const job = queue.catch(() => {}).then(async () => {
    const status = tigerDiagnostics[path] ??= {};
    status.lastAttempt = new Date().toISOString();
    try {
      if (!process.env.TIGER_BRIDGE_TOKEN) throw new Error('Tiger bridge token is not configured');
      const response = await fetch(`${process.env.TIGER_BRIDGE_URL || 'http://127.0.0.1:8788'}${key}`, {
        headers: { authorization: `Bearer ${process.env.TIGER_BRIDGE_TOKEN}` },
        signal: AbortSignal.timeout(20_000)
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 429) {
        const raw = Number(body.retryAfter ?? response.headers?.get?.('retry-after'));
        throw new TigerRateLimitError(Number.isFinite(raw) && raw >= 0 ? raw : 60);
      }
      if (!response.ok) throw new Error(body.error || `Tiger bridge HTTP ${response.status}`);
      const result = { data: body.data, fetchedAt: body.fetchedAt, source: 'tiger' };
      status.lastSuccess = body.fetchedAt;
      status.error = null;
      return result;
    } catch (error) {
      status.error = error.message;
      throw error; // Never silently turn failure into synthetic market data.
    }
  });
  queue = job;
  return job;
}

export async function tigerRequest(path, params = {}, ttl = 0) {
  const query = new URLSearchParams(params);
  const key = `${path}?${query}`;
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < ttl) return existing.value;
  const mayWait = waitContext.getStore() === true;
  const pendingKey = `${key}|${mayWait}`;
  if (pending.has(pendingKey)) return pending.get(pendingKey);

  const run = (async () => {
    let waitedMs = 0;
    let myWaitUntil = 0;
    try {
      for (;;) {
        try {
          const result = await bridgeAttempt(path, key);
          cache.set(key, { at: Date.now(), value: result });
          if (cache.size > 500) cache.delete(cache.keys().next().value);
          return result;
        } catch (error) {
          if (!error.isRateLimit || !mayWait) throw error;
          const waitMs = Math.min(error.retryAfterSec * 1000 + 300, 65_000);
          if (waitedMs + waitMs > maxRateLimitWaitMs()) throw error;
          myWaitUntil = Date.now() + waitMs;
          rateLimit.until = Math.max(rateLimit.until, myWaitUntil);
          rateLimit.waits += 1;
          await sleep(waitMs);
          waitedMs += waitMs;
        }
      }
    } finally {
      if (myWaitUntil && rateLimit.until === myWaitUntil) rateLimit.until = 0;
    }
  })();
  pending.set(pendingKey, run);
  try { return await run; } finally { pending.delete(pendingKey); }
}

export async function tigerQuotes(requests) {
  const results = [];
  for (const request of requests) {
    const symbol = typeof request === 'string' ? request : request.symbol;
    const r = await tigerRequest('/quotes', { symbol }, 10_000);
    const q = r.data?.[0];
    if (!q) throw new Error(`Tiger has no quote for ${symbol}`);
    results.push({ symbol, regularMarketPrice: num(q.latest_price ?? q.close), previousClose: num(q.pre_close), change: num(q.change), changeRate: num(q.change_rate), regularMarketTime: timestampIso(q.latest_time ?? q.time),
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
  const bid = num(c.bid_price), ask = num(c.ask_price);
  const strike = num(c.strike);
  const expiration = expiry || timestampIso(c.expiry)?.slice(0, 10);
  const timeYears = (Date.parse(`${expiration}T20:00:00Z`) - Date.now()) / (365 * 86400_000);
  // Tiger often returns implied_vol = 0 for US options; derive it from the bid/ask mid instead.
  let iv = num(c.implied_vol), ivSource = 'tiger';
  if (!(iv > 0)) {
    iv = bid > 0 && ask >= bid ? impliedVolatility({ type, spot: currentSpot, strike, timeYears, price: (bid + ask) / 2 }) ?? 0 : 0;
    ivSource = iv > 0 ? 'derived-from-mid' : 'unavailable';
  }
  return { contractSymbol: c.identifier, symbol, expiration, optionType: type, strike, bid, ask,
    bidSize: num(c.bid_size), askSize: num(c.ask_size), mark: bid > 0 && ask >= bid ? (bid + ask) / 2 : null,
    lastPrice: num(c.latest_price), volume: num(c.volume), openInterest: num(c.open_interest), impliedVolatility: iv, impliedVolatilitySource: ivSource,
    multiplier: num(c.multiplier, 100), exerciseStyle: 'american', source: 'tiger', sourceLabel: 'Tiger OpenAPI',
    hasRealBidAsk: bid > 0 && ask >= bid, isLive: bid > 0 && ask >= bid,
    // A trade timestamp is NOT a quote timestamp. Filled from depth below.
    quoteTimestamp: null, tradeTimestamp: timestampIso(c.last_timestamp), fetchedAt,
    delta: optionDelta({ type, spot: currentSpot, strike, timeYears, volatility: iv }),
    greeksSource: 'European reference model; excludes early exercise and discrete dividends' };
}

let depthDeniedUntil = 0;
// Option depth is optional: Tiger sells no US option depth product, so it is off unless TIGER_OPTION_DEPTH=true.
const depthEnabled = () => process.env.TIGER_OPTION_DEPTH === 'true';

// Tiger US Option L1 carries live best bid/ask but no quote-event timestamp, and depth
// (which has one) is not sold for US options. During the regular session only, a chain
// fetched just now is as old as its fetch time, so that stands in for the quote time.
async function usMarketTrading() {
  try {
    const r = await tigerRequest('/session', {}, 30_000);
    return (r.data ?? []).some(m => m.market === 'US' && m.trading_status === 'TRADING');
  } catch { return false; }
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
  let depthWarned = false;
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
      if (!depthEnabled()) {
        // Depth disabled: no request, no warning; fetch-time stamping below covers market hours.
      } else if (rows.length && Date.now() < depthDeniedUntil) {
        if (!depthWarned) warnings.push('Quote timestamps unavailable: Tiger option depth is not available for US options, so exchange quote times are unknown');
        depthWarned = true;
      } else if (rows.length) {
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
    } catch (e) {
      if (/permission denied/i.test(e.message)) depthDeniedUntil = Date.now() + 10 * 60_000;
      if (!depthWarned) warnings.push(`Quote timestamps unavailable: ${e.message}`);
      depthWarned = true;
    }
    if (rows.some(c => !c.quoteTimestamp && c.hasRealBidAsk) && await usMarketTrading()) {
      for (const c of rows) if (!c.quoteTimestamp && c.hasRealBidAsk && timestampIso(r.fetchedAt)) {
        c.quoteTimestamp = timestampIso(r.fetchedAt);
        c.quoteTimestampSource = 'fetch-time';
      }
      if (!warnings.some(w => w.startsWith('Tiger L1 quotes'))) warnings.push('Tiger L1 quotes are stamped with fetch time (no exchange quote timestamp is available for US options)');
    }
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
