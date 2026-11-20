import test from 'node:test';
import assert from 'node:assert/strict';
import { normalCdf, optionPrice, coveredCapital, coveredPayoff, coveredBreakeven } from '../shared/optionMath.js';
import { assessQuote, finiteNumber, timestampIso } from '../server/quoteQuality.js';
import { buildLiquidityAssessment, computeContractsForAllocation, buildCandidateResult } from '../server/coveredIncomeScanner.js';
import { findMatchingMarket } from '../server/paperTrading.js';
import { historicalPosition, financialTrends, buildEntryResearch } from '../server/entryResearch.js';
import { createResearchStore } from '../server/researchStore.js';
import { normalizeTigerContract } from '../server/providers/tiger.js';

const near = (a, b, tolerance = .0001) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('shared reference model: known normal probabilities, put-call parity and zero-volatility limit', () => {
  near(normalCdf(1), .841344746); near(normalCdf(-1), .158655254); assert.equal(normalCdf(0), .5);
  const args = { spot: 100, strike: 100, timeYears: 1, volatility: .2, riskFreeRate: 0 };
  near(optionPrice({ ...args, type: 'call' }), 7.965567, .0001);
  near(optionPrice({ ...args, type: 'put' }), 7.965567, .0001);
  near(optionPrice({ ...args, type: 'call', volatility: 0 }), 0);
});

test('cash-secured portfolio sizing and breakeven agree with exact payoff', () => {
  assert.equal(coveredCapital('covered_strangle', 100, 95), 19500);
  assert.equal(computeContractsForAllocation('covered_strangle', 95, 105, 10500, 100).contracts, 0);
  assert.equal(computeContractsForAllocation('covered_call', null, 105, 10000, 100).contracts, 1);
  for (const [type, putPremium, callPremium] of [['cash_secured_put', 2, 0], ['covered_call', 0, 1], ['covered_strangle', 2, 1], ['covered_strangle', 6, 1]]) {
    const terminal = coveredBreakeven(type, 100, 95, putPremium, callPremium);
    near(coveredPayoff({ type, spot: 100, terminal, putStrike: 95, callStrike: 105, putPremium, callPremium }), 0);
  }
  assert.equal(coveredBreakeven('covered_strangle', 100, 95, 2, 1), 97);
});

test('scanner returns bid-based yield and preserves unknown earnings and quote provenance', () => {
  const c = { bid: 2, ask: 2.1, strike: 95, mid: 2.05, delta: -.2, isLiquid: true, impliedVolatility: .2, source: 'tiger', quoteTimestamp: new Date().toISOString(), isLive: true, hasRealBidAsk: true };
  const row = buildCandidateResult({ symbol: 'TEST', companyName: 'Test', currentPrice: 100, expiryDate: '2030-01-01', dte: 30,
    strategyType: 'cash_secured_put', priceZones: { supportPrice: 96, resistancePrice: 105, atr14: 3, fairValueZone: { lower: 95, upper: 105 } },
    putContract: c, callContract: null, maxAllocatedCash: 9500, historicalVolatility: .2, earningsBeforeExpiry: null });
  assert.equal(row.premium.totalPremium, 200);
  assert.equal(row.risk.earningsBeforeExpiry, null);
  assert.equal(row.put.source, 'tiger');
});

test('unverified, stale, crossed and future quotes cannot pass eligibility', () => {
  const fresh = { bid: 2, ask: 2.1, hasRealBidAsk: true, isLive: true, quoteTimestamp: new Date().toISOString(), volume: 100, openInterest: 200 };
  const config = { minOptionVolume: 50, minOpenInterest: 100, maxBidAskSpreadPct: 10 };
  assert.equal(buildLiquidityAssessment(fresh, config).isLiquid, true);
  for (const patch of [{ bid: 3, ask: 2 }, { quoteTimestamp: null }, { isLive: false }, { hasRealBidAsk: false }, { quoteTimestamp: new Date(Date.now() - 100000).toISOString() }, { quoteTimestamp: new Date(Date.now() + 60000).toISOString() }, { volume: 1 }]) {
    assert.equal(buildLiquidityAssessment({ ...fresh, ...patch }, config).isLiquid, false);
  }
  assert.equal(finiteNumber(null), null); assert.equal(finiteNumber(''), null);
  assert.equal(timestampIso(1700000000000000000), '2023-11-14T22:13:20.000Z');
});

test('missing exact prediction market does not fall through to unrelated or similar markets', () => {
  const market = { id: 'oil', slug: 'oil', question: 'Will oil exceed $80?', endDate: '2030-01-01', yesPrice: .8 };
  const order = { polymarketMarketId: 'btc', polymarketQuestion: 'Will BTC exceed $80000?', polymarketResolutionDate: '2030-01-01' };
  assert.equal(findMatchingMarket(order, [market]), null);
  assert.equal(findMatchingMarket({ polymarketMarketSlug: 'missing', polymarketQuestion: market.question }, [market]), null);
  assert.equal(findMatchingMarket({ polymarketQuestion: market.question, polymarketResolutionDate: '2030-01-01' }, [market]), market);
});

test('Tiger trade time cannot masquerade as quote time; model deltas are separate from vendor daily Greeks', () => {
  const c = normalizeTigerContract({ identifier: 'test', put_call: 'PUT', strike: 100, bid_price: 2, ask_price: 2.1, implied_vol: .3, last_timestamp: Date.now(), delta: -.9 }, { symbol: 'TEST', expiry: '2030-01-01', currentSpot: 100, fetchedAt: new Date().toISOString() });
  assert.equal(c.quoteTimestamp, null);
  assert.equal(assessQuote(c).eligible, false);
  assert.notEqual(c.delta, -.9);
  assert.match(c.greeksSource, /reference/);
});

test('insufficient IV history and future financial filings remain unavailable', () => {
  assert.equal(historicalPosition(.3, [.2, .3]).percentile, null);
  assert.equal(historicalPosition(.3, Array(60).fill(.3)).rank, null);
  const rows = [{ field: 'revenue', value: 100, period_end_date: '2025-12-31', filing_date: '2026-02-01' }, { field: 'revenue', value: 200, period_end_date: '2026-03-31', filing_date: '2026-05-01' }];
  const result = financialTrends(rows, '2026-04-01T00:00:00Z');
  assert.equal(result.fields.revenue.length, 1);
  assert.equal(result.unpublishedOrUndatedCount, 1);
});

test('research earnings gaps block entry without hiding analysis; fees reduce credit', () => {
  const now = '2026-10-02T15:00:00.000Z';
  const datasets = { quote: { data: [{ regularMarketPrice: 100, regularMarketTime: now }] }, options: { data: { contracts: [{ contractSymbol: 'p95', strike: 95, multiplier: 100, optionType: 'put', expiration: '2026-10-16', bid: 2, ask: 2.1, delta: -.2, volume: 100, openInterest: 200, hasRealBidAsk: true, isLive: true, quoteTimestamp: now }] } } };
  const p = buildEntryResearch({ symbol: 'TEST', datasets, feePerContract: 1, now });
  assert.equal(p.entries[0].credit, 199);
  assert.equal(p.entries[0].entryPrice, 93.01);
  assert.ok(p.entries[0].reasons.includes('earnings-coverage-unknown'));
  assert.equal(p.volatility.iv, null);
  datasets.events = { data: { complete: true, from: '2026-10-02', to: '2026-10-30', events: [] } };
  assert.equal(buildEntryResearch({ symbol: 'TEST', datasets, now }).entries[0].status, 'ready-for-review');
});

test('research store preserves immutable snapshots, isolates owners and deduplicates observations', () => {
  const store = createResearchStore(':memory:');
  try {
    store.put('TEST', 'iv', 'tiger', [1], '2026-10-02T15:00:00Z');
    store.put('TEST', 'iv', 'tiger', [2], '2026-10-02T15:00:00Z');
    assert.deepEqual(store.get('TEST', 'iv', 'tiger').data, [2]);
    const source = { symbol: 'TEST', value: 1 };
    const saved = store.save('a', source); source.value = 2;
    assert.equal(store.snapshot('a', saved.id).research.value, 1);
    assert.equal(store.snapshot('b', saved.id), null);
    store.watch('a', 'TEST', { peers: [] });
    assert.equal(store.watches('b').length, 0);
  } finally { store.close(); }
});

test('peer median averages even samples and relative strength aligns trading dates', () => {
  const points = Array.from({ length: 23 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, close: 100 + i, high: 130, low: 90 }));
  const benchmark = points.slice(0, -1).map(p => ({ ...p, close: p.close * 2 }));
  const p = buildEntryResearch({ symbol: 'TEST', now: '2026-10-02T15:00:00Z', datasets: { bars: { data: { points } }, benchmark: { data: { points: benchmark } } },
    peers: [10, 20, 30, 100].map((pe, i) => ({ symbol: `P${i}`, data: { peTtm: pe }, pfcf: pe })) });
  assert.equal(p.valuation.peerMedian, 25);
  assert.equal(p.valuation.peerFcfMedian, 25);
  near(p.demand.relativeStrength20Points, 0);
});
