import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STRATEGY,
  validateStrategy,
  buildCandidates,
  payoff,
  summarizePosition,
  applyCatalysts,
  backtest,
  addDays,
} from "../shared/builderEngine.js";
import { extractAgent } from "../server/builder/agents.js";

const snapshot = {
  symbol: "AAPL",
  spot: 220,
  asOf: "2025-07-01T15:00:00Z",
  hv: 0.28,
  chain: [],
  bars: [],
  source: "fixture",
};
const strategy = {
  ...DEFAULT_STRATEGY,
  symbols: ["AAPL"],
  pricingMode: "modeled",
};
const collar = () => buildCandidates(snapshot, strategy, ["collar"])[0];
function history() {
  const bars = [];
  for (let n = 0; n < 500; n++) {
    const date = addDays("2024-01-01", n);
    if ([0, 6].includes(new Date(date).getUTCDay())) continue;
    const close = 100 + n * 0.05 + 2 * Math.sin(n * 0.7);
    bars.push({
      date,
      open: close * 0.998,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1e6,
    });
  }
  return bars;
}

test("stock/option payoffs agree with collar strike boundaries and fees; modeled liquidity is not fabricated", () => {
  const r = collar();
  r.legs[0].price = 4;
  r.legs[1].price = 2.15;
  r.netDebit = 185;
  r.fees = 1.3;
  Object.assign(r, summarizePosition(r));
  assert.equal(r.legs[0].strike, 209);
  assert.equal(r.legs[1].strike, 231);
  assert.ok(Math.abs(payoff(r, 0) + 1286.3) < 1e-8);
  assert.ok(Math.abs(payoff(r, 300) - 913.7) < 1e-8);
  assert.ok(Math.abs(r.breakevens[0] - 221.863) < 1e-8);
  assert.equal(r.baseScore, null);
  assert.equal(r.parts.liquidity, null);
  assert.equal(r.minOi, null);
});
test("market scan never silently synthesizes contracts or selects collapsed vertical spreads", () => {
  assert.equal(
    buildCandidates(snapshot, { ...strategy, pricingMode: "market" }, [
      "collar",
    ]).length,
    0,
  );
  const c = {
    expiration: "2025-08-01",
    optionType: "put",
    strike: 209,
    impliedVolatility: 0.28,
    bid: 3,
    ask: 4,
    hasRealBidAsk: true,
    multiplier: 100,
  };
  assert.equal(
    buildCandidates(
      { ...snapshot, chain: [c] },
      { ...strategy, pricingMode: "market" },
      ["put_credit"],
    ).length,
    0,
  );
});
test("credit spread maximum loss reserves its width; long puts have unlimited upside stock combination", () => {
  const spread = buildCandidates(snapshot, strategy, ["put_credit"])[0];
  assert.ok(spread.maxLoss < 0);
  assert.ok(spread.maxProfit > 0);
  assert.equal(spread.capital, -spread.maxLoss);
  const put = buildCandidates(snapshot, strategy, ["protective_put"])[0];
  assert.equal(put.maxProfit, null);
  assert.ok(put.maxLoss < 0);
});
test("catalysts are scoped, expire, deduplicate and do not repeatedly accumulate; completion alone is not bullish", () => {
  const r = { ...collar(), baseScore: 74, scoreRange: [74, 74] },
    now = "2025-07-01T16:00:00Z";
  const i = {
    id: "1",
    eventKey: "rates",
    title: "Rates",
    symbol: "AAPL",
    template: "collar",
    points: -5,
    verified: true,
    sources: ["https://example.com/source"],
    checkedAt: now,
    status: "resolved",
  };
  const items = [
    i,
    { ...i, id: "2" },
    { ...i, id: "3", eventKey: "war", verified: false },
    { ...i, id: "4", symbol: "MSFT" },
    { ...i, id: "5", eventKey: "old", checkedAt: "2025-06-01" },
    { ...i, id: "6", eventKey: "expired", impactUntil: "2025-06-30" },
  ];
  const a = applyCatalysts(r, items, true, now);
  assert.equal(a.overall, 69);
  assert.equal(a.catalystImpact, -5);
  assert.equal(applyCatalysts(a, items, true, now).overall, 69);
  assert.equal(applyCatalysts(r, items, false, now).overall, 74);
  assert.equal(
    applyCatalysts(
      r,
      [...Array(8)].map((_, n) => ({
        ...i,
        id: String(n),
        eventKey: String(n),
      })),
      true,
      now,
    ).catalystImpact,
    -15,
  );
});
test("strategy validation rejects invalid quantities, symbols, pricing and non-finite numbers", () => {
  for (const patch of [
    { shares: 50 },
    { symbols: ["../secret"] },
    { dte: NaN },
    { pricingMode: "fake" },
    { fee: -1 },
    { trend: "unknown" },
  ])
    assert.throws(() => validateStrategy({ ...strategy, ...patch }));
});
test("backtest trades use next-session opening prices; future data cannot alter earlier positions or equity", () => {
  const bars = history(),
    settings = { start: "2024-06-03", end: "2025-03-03", capital: 100000 };
  const result = backtest(bars, strategy, settings);
  assert.ok(result.trades.length > 1);
  assert.equal(
    result.trades[0].entrySpot,
    bars.find((b) => b.date === result.trades[0].entryDate).open,
  );
  const cutoff = "2024-11-01";
  const altered = bars.map((b) =>
    b.date >= cutoff
      ? {
          ...b,
          open: b.open * 1.3,
          close: b.close * 1.3,
          high: b.high * 1.3,
          low: b.low * 1.3,
        }
      : b,
  );
  const other = backtest(altered, strategy, settings);
  assert.deepEqual(
    result.equity.filter((e) => e.date < cutoff),
    other.equity.filter((e) => e.date < cutoff),
  );
  assert.deepEqual(
    result.trades.filter((e) => e.exitDate < cutoff),
    other.trades.filter((e) => e.exitDate < cutoff),
  );
});
test("backtest coverage, capital and friction boundaries are explicit", () => {
  const bars = history(),
    settings = { start: "2024-06-03", end: "2025-03-03" };
  assert.throws(
    () => backtest(bars, strategy, { ...settings, start: "2023-01-01" }),
    /cover/,
  );
  assert.throws(
    () => backtest(bars, strategy, { ...settings, rate: -1 }),
    /rate/,
  );
  const poor = backtest(bars, strategy, { ...settings, capital: 100 });
  assert.equal(poor.trades.length, 0);
  assert.equal(poor.final, 100);
  const free = backtest(
    bars,
    { ...strategy, fee: 0 },
    {
      ...settings,
      stockSlippage: 0,
      optionSlippage: 0,
      stopLoss: 0,
      takeProfit: 0,
    },
  );
  const fees = backtest(
    bars,
    { ...strategy, fee: 2 },
    {
      ...settings,
      stockSlippage: 0,
      optionSlippage: 0,
      stopLoss: 0,
      takeProfit: 0,
    },
  );
  assert.ok(fees.final < free.final);
});
test("TradingAgents extraction preserves missing targets and does not verify or resolve suggested claims", () => {
  const run = {
    id: "r1",
    requested_at: "2025-01-01",
    jobs: {
      AAPL: {
        decision: "Overweight",
        report_sections: {
          final_trade_decision: "**Price Target**: $235.50",
          news_report: "See https://example.com/report",
        },
        section_summaries: {
          news_report: {
            categories: {
              bearish: {
                items: [
                  {
                    label: "Rates above 6%",
                    status: "success",
                    completed: true,
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
  const r = extractAgent(run);
  assert.equal(r.valuations[0].priceTarget, 235.5);
  assert.equal(r.valuations[0].rating, "Bullish");
  assert.equal(r.suggestions[0].verified, false);
  assert.equal(r.suggestions[0].status, "monitoring");
  assert.equal(r.suggestions[0].agentResolved, true);
  delete run.jobs.AAPL.report_sections.final_trade_decision;
  assert.equal(extractAgent(run).valuations[0].priceTarget, null);
});
