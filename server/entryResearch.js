import { finiteNumber as num, timestampIso, assessQuote } from './quoteQuality.js';
import { buildPriceZones } from './coveredIncomeScanner.js';

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const positive = a => a.map(v => num(v)).filter(v => v > 0);
const change = (a, b) => a != null && b > 0 ? (a / b - 1) * 100 : null;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};
export const RESEARCH_VERSION = 'entry-research-v1';

export function weeklyBars(bars) {
  const weeks = new Map();
  for (const bar of bars) {
    const d = new Date(`${bar.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    const key = d.toISOString().slice(0, 10), prior = weeks.get(key);
    weeks.set(key, prior ? { ...prior, high: Math.max(prior.high, bar.high), low: Math.min(prior.low, bar.low), close: bar.close, volume: (prior.volume ?? 0) + (bar.volume ?? 0) } : { ...bar, date: key });
  }
  return [...weeks.values()];
}

export function historicalPosition(current, values, minimum = 60) {
  const sample = positive(values);
  if (!(current > 0) || sample.length < minimum) return { percentile: null, rank: null, sampleCount: sample.length };
  const low = Math.min(...sample), high = Math.max(...sample);
  return { percentile: sample.filter(v => v < current).length / sample.length * 100,
    rank: high > low ? (current - low) / (high - low) * 100 : null, sampleCount: sample.length };
}

export function financialTrends(rows, asOf = new Date().toISOString()) {
  // Publication time, not period-end, determines whether a result was knowable.
  const known = rows.filter(r => timestampIso(r.filing_date) && timestampIso(r.filing_date) <= asOf);
  const fields = {};
  for (const r of known) {
    const key = String(r.field);
    (fields[key] ??= []).push({ date: timestampIso(r.period_end_date)?.slice(0, 10), filed: timestampIso(r.filing_date), value: num(r.value), currency: r.currency });
  }
  for (const series of Object.values(fields)) series.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { fields, unpublishedOrUndatedCount: rows.length - known.length };
}

export function buildEntryResearch({ symbol, datasets, peers = [], feePerContract = 0, assetType = 'stock', now = new Date().toISOString() }) {
  const get = k => datasets[k]?.data;
  const bars = [...new Map((get('bars')?.points ?? []).filter(p => p.date && p.date < now.slice(0, 10) && p.close > 0 && p.high >= p.low && p.low > 0).map(p => [p.date, p])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const quote = get('quote')?.[0];
  const spot = num(quote?.regularMarketPrice) ?? bars.at(-1)?.close ?? null;
  const zones = bars.length >= 60 && spot > 0 ? buildPriceZones(bars, spot) : null;
  const weeks = weeklyBars(bars);
  const weeklyZones = weeks.length >= 60 && spot > 0 ? buildPriceZones(weeks, spot) : null;
  const closes = bars.map(p => p.close);
  const changes = closes.slice(1).map((c, i) => Math.log(c / closes[i])).filter(Number.isFinite).slice(-20);
  const avg = mean(changes);
  const rv = changes.length === 20 ? Math.sqrt(changes.reduce((s, v) => s + (v - avg) ** 2, 0) / 19) * Math.sqrt(252) : null;
  const analysis = get('iv')?.[0] ?? {};
  const ivHistory = (analysis.volatility_list ?? []).map(p => ({ date: timestampIso(p.timestamp)?.slice(0, 10), iv: num(p.implied_vol), hv: num(p.his_volatility) }))
    .filter(p => p.date && p.iv > 0 && p.date <= now.slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date));
  const uniqueIv = [...new Map(ivHistory.map(p => [p.date, p])).values()];
  const iv = num(analysis.implied_vol_30_days) ?? uniqueIv.at(-1)?.iv ?? null;
  const completedIv = uniqueIv.filter(p => p.date < now.slice(0, 10));
  const ivChange = n => iv != null && completedIv.length >= n ? (iv - completedIv.at(-n).iv) * 100 : null;
  const f = get('fundamentals') ?? {};
  const financials = financialTrends(get('financials') ?? [], now);
  const valueHistory = (get('valuation') ?? []).filter(r => timestampIso(r.date) && timestampIso(r.date) <= now);
  const peHistory = valueHistory.filter(r => r.field === 'p_to_ltm_diluted_eps_before_extra').map(r => num(r.value));
  const peerRows = peers.map(p => ({ symbol: p.symbol, pe: p.stale ? null : num(p.data?.peTtm), pfcf: p.stale ? null : num(p.pfcf), fetchedAt: p.updatedAt, error: p.error }));
  const peerPe = positive(peerRows.map(p => p.pe));
  const peerMedian = peerPe.length >= 3 ? median(peerPe) : null;
  const pe = num(f.peTtm);
  const valuePosition = historicalPosition(pe, peHistory);
  const fcfHistory = valueHistory.filter(r => r.field === 'market_cap_to_ltm_levered_fcf').sort((a, b) => Date.parse(timestampIso(a.date)) - Date.parse(timestampIso(b.date))).map(r => num(r.value));
  const pfcf = fcfHistory.at(-1);
  const peerFcf = positive(peerRows.map(p => p.pfcf)).sort((a, b) => a - b);
  const peerFcfMedian = peerFcf.length >= 3 ? median(peerFcf) : null;
  const contracts = get('options')?.contracts ?? [];
  const byExpiry = new Map();
  for (const c of contracts) {
    if (!(c.impliedVolatility > 0)) continue;
    const bucket = byExpiry.get(c.expiration) ?? [];
    bucket.push(c); byExpiry.set(c.expiration, bucket);
  }
  const termStructure = [...byExpiry].sort(([a], [b]) => a.localeCompare(b)).map(([expiry, rows]) => {
    const nearest = [...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 2);
    const deltaLeg = type => rows.filter(c => c.optionType === type && Number.isFinite(c.delta)).sort((a, b) => Math.abs(Math.abs(a.delta) - .25) - Math.abs(Math.abs(b.delta) - .25))[0];
    const p = deltaLeg('put'), c = deltaLeg('call');
    return { expiry, atmIv: mean(nearest.map(c => c.impliedVolatility)), skew25: p && c ? (p.impliedVolatility - c.impliedVolatility) * 100 : null };
  });
  const event = get('events') ?? { complete: false, events: [] };
  const quoteTime = timestampIso(quote?.regularMarketTime);
  const spotFresh = quoteTime && Date.parse(now) - Date.parse(quoteTime) >= -5000 && Date.parse(now) - Date.parse(quoteTime) <= 90_000;
  const entries = contracts.filter(c => c.optionType === 'put' && c.multiplier !== 0 && c.strike > 0 && Math.abs(c.delta) >= .15 && Math.abs(c.delta) <= .30).map(c => {
    const quality = assessQuote(c, Date.parse(now));
    const spread = c.bid > 0 && c.ask >= c.bid ? (c.ask - c.bid) / ((c.ask + c.bid) / 2) * 100 : null;
    const earnings = (event.events ?? []).some(e => e.date >= now.slice(0, 10) && e.date <= c.expiration);
    const earningsKnown = event.complete === true && event.from <= now.slice(0, 10) && event.to >= c.expiration;
    const reasons = [...quality.reasons];
    if ((c.multiplier ?? 100) !== 100) reasons.push('nonstandard-contract');
    if (!(c.expiration > now.slice(0, 10))) reasons.push('expired-or-expiring-today');
    if (!spotFresh) reasons.push('underlying-stale-or-undated');
    if (datasets.options?.stale) reasons.push('options-collection-stale');
    if (earnings) reasons.push('earnings-before-expiry');
    else if (!earningsKnown || datasets.events?.stale) reasons.push('earnings-coverage-unknown');
    if (!(spread <= 10) || !(c.volume >= 50) || !(c.openInterest >= 100)) reasons.push('liquidity-filter');
    const multiplier = c.multiplier ?? 100;
    const credit = num(c.bid) == null ? null : c.bid * multiplier - feePerContract;
    const dte = Math.ceil((Date.parse(c.expiration) - Date.parse(now.slice(0, 10))) / 86400_000);
    return { contract: c.contractSymbol, expiry: c.expiration, strike: c.strike, dte, bid: c.bid, spread, credit,
      delta: c.delta, source: c.source, quoteTimestamp: c.quoteTimestamp, status: reasons.length ? 'needs-review' : 'ready-for-review', reasons,
      entryPrice: credit != null ? c.strike - credit / multiplier : null, capital: c.strike * multiplier,
      premiumReturnPct: credit != null ? credit / (c.strike * multiplier) * 100 : null,
      supportBufferAtr: zones?.atr14 > 0 ? (zones.supportPrice - c.strike) / zones.atr14 : null,
      stress: [-.1, -.2, -.3].map(move => ({ move, pnl: credit != null && spot > 0 ? credit - Math.max(c.strike - spot * (1 + move), 0) * multiplier : null })) };
  }).sort((a, b) => a.dte - b.dte || a.strike - b.strike);
  const benchmark = (get('benchmark')?.points ?? []).filter(p => p.date < now.slice(0, 10));
  const return20 = a => a.length >= 21 ? change(a.at(-1).close, a.at(-21).close) : null;
  const alignedReturn = other => {
    const byDate = new Map(other.filter(p => p.close > 0).map(p => [p.date, p]));
    const common = bars.filter(p => byDate.has(p.date)).slice(-21);
    return { own: return20(common), other: return20(common.map(p => byDate.get(p.date))) };
  };
  const marketAligned = alignedReturn(benchmark);
  const sectorAligned = alignedReturn(get('sector')?.points ?? []);
  const ownReturn = return20(bars), marketReturn = marketAligned.other;
  const sectorReturn = sectorAligned.other;
  const flow = get('flow') ?? {};
  const recentFlow = (flow.history ?? []).slice(-20);
  const meanVol = mean(bars.slice(-21, -1).map(p => p.volume).filter(Number.isFinite));
  return { version: RESEARCH_VERSION, symbol, assetType, generatedAt: now, stockPrice: spot, quoteTimestamp: quoteTime,
    statuses: Object.fromEntries(Object.entries(datasets).map(([k, v]) => [k, { source: v.source, updatedAt: v.updatedAt, stale: v.stale, error: v.error }])),
    structure: { ...zones, technicalRange: zones?.fairValueZone, weekly: weeklyZones, invalidation: zones?.supportPrice ?? null, bars: bars.slice(-260) },
    fundamentals: assetType === 'etf' ? { applicable: false } : { applicable: true, current: f, ...financials },
    valuation: { applicable: assetType !== 'etf', pe: pe > 0 ? pe : null, historical: valuePosition, peerMedian, peers: peerRows,
      pfcf: pfcf > 0 ? pfcf : null, fcfHistorical: historicalPosition(pfcf, fcfHistory), peerFcfMedian,
      relativeToPeersPct: pe > 0 ? change(pe, peerMedian) : null, note: 'Relative multiples, not intrinsic value. Peers are user-selected; negative multiples excluded.' },
    volatility: { iv, rv20: rv, ivRvRatio: iv != null && rv > 0 ? iv / rv : null, history: uniqueIv, change5Points: ivChange(5), change20Points: ivChange(20),
      historical: historicalPosition(iv, completedIv.map(p => p.iv)), providerPercentile: num(analysis.iv_metric?.percentile), providerRank: num(analysis.iv_metric?.rank), termStructure },
    demand: { return20Pct: ownReturn, spyReturn20Pct: marketReturn, relativeStrength20Points: marketAligned.own != null && marketReturn != null ? marketAligned.own - marketReturn : null,
      sectorSymbol: get('sector')?.symbol ?? null, sectorReturn20Pct: sectorReturn, relativeStrengthSectorPoints: sectorAligned.own != null && sectorReturn != null ? sectorAligned.own - sectorReturn : null,
      relativeVolume: meanVol > 0 ? bars.at(-1)?.volume / meanVol : null, flowHistory: recentFlow, distribution: flow.distribution ?? null,
      flowLabel: 'Tiger classified flow; not verified institutional buying', breadth: null },
    events: event, dividends: (get('dividends') ?? []).map(d => ({ amount: num(d.amount), currency: d.currency,
      exDate: timestampIso(d.execute_date)?.slice(0, 10), payDate: timestampIso(d.pay_date)?.slice(0, 10) })), entries, feePerContract,
    assumptions: ['Reference delta uses a 4.25% annual rate and zero dividend yield; excludes early exercise/discrete dividends.', 'Relative strength compares 21 shared completed-session closes.', 'Current source coverage is shown per dataset.',
      'Support is a historical price zone, not a guaranteed floor.', feePerContract === 0 ? 'Fees default to zero; set your per-contract fee for net comparisons.' : 'Entry fees only; exercise/assignment/exit charges excluded.'] };
}
