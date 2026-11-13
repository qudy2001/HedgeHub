import {
  DEFAULT_STRATEGY,
  buildCandidates,
  applyCatalysts,
  addDays,
  dateOnly,
  DAY,
} from "../../shared/builderEngine.js";
import { optionPrice } from "../../shared/optionMath.js";
export function demoWorkspace(settings = {}) {
  const today = dateOnly(Date.now()),
    definition = { ...DEFAULT_STRATEGY, ...settings, pricingMode: "modeled" },
    datasets = {};
  for (const [symbol, spot] of [
    ["AAPL", 220],
    ["MSFT", 420],
    ["SPY", 590],
  ]) {
    const bars = [];
    for (let i = 560; i >= 0; i--) {
      const date = addDays(today, -i);
      if ([0, 6].includes(new Date(date).getUTCDay())) continue;
      const close =
        spot *
        (1 -
          0.00025 * i +
          0.028 * Math.sin(i * 0.19) +
          0.008 * Math.cos(i * 0.47));
      // Open at the previous close so sample candles alternate between up and down days.
      const open = bars.length ? bars[bars.length - 1].close : close * 0.997;
      bars.push({
        date,
        open,
        high: Math.max(open, close) * 1.006,
        low: Math.min(open, close) * 0.994,
        close,
        volume: 20000000 + Math.round(5000000 * Math.sin(i)),
      });
    }
    const expiries = [
      ...new Set(
        [
          ...Array.from({ length: 22 }, (_, i) => 7 + i * 7),
          ...Array.from({ length: 18 }, (_, i) => 180 + i * 30),
        ].map((offset) => {
          const date = addDays(today, offset);
          return addDays(date, (5 - new Date(date).getUTCDay() + 7) % 7);
        }),
      ),
    ];
    const distributionContracts = expiries.flatMap((expiration, e) =>
      Array.from({ length: 37 }, (_, i) => {
        const strike = Math.round(spot * 0.55 + i * spot * 0.025),
          distance = (strike - spot) / spot;
        return ["call", "put"].map((optionType, t) => {
          // Illustrative quotes so the sample option chain is populated: a volatility smile with put skew
          // priced by the European model, with a ~2% spread. Not market data.
          const iv = 0.28 + 0.4 * Math.abs(distance) + (t ? 0.03 : 0),
            mid = optionPrice({
              type: optionType,
              spot,
              strike,
              timeYears: (Date.parse(expiration) - Date.parse(today)) / DAY / 365,
              volatility: iv,
            }),
            half = Math.max(0.005, mid * 0.01),
            bid = Math.max(0, Math.round((mid - half) * 100) / 100);
          return {
            contractSymbol: `SAMPLE:${symbol}:${expiration}:${strike}:${optionType}`,
            symbol,
            expiration,
            strike,
            optionType,
            bid,
            ask: Math.round((mid + half) * 100) / 100,
            bidSize: 5 + Math.round(40 * (0.5 + 0.5 * Math.sin(i * 3 + e + t))),
            askSize: 5 + Math.round(40 * (0.5 + 0.5 * Math.cos(i * 2 + e + t))),
            impliedVolatility: iv,
            hasRealBidAsk: bid > 0,
            isLive: false,
            openInterest: Math.round(
              (500 +
                8500 *
                  Math.exp(-(((distance - (t ? -0.08 : 0.08)) / 0.15) ** 2))) *
                (0.3 + Math.exp(-e / 7) + 0.6 * (e % 5 === 0)) *
                (0.75 + 0.25 * Math.sin(i + e + t)),
            ),
            volume: Math.round(
              (60 + 2400 * Math.exp(-((distance / 0.08) ** 2))) *
                Math.exp(-e / 5) *
                (0.7 + 0.3 * Math.cos(i * 2 + e + t)),
            ),
          };
        });
      }).flat(),
    );
    datasets[symbol] = {
      symbol,
      spot,
      asOf: new Date().toISOString(),
      source: "Illustrative sample",
      hv: 0.28,
      bars,
      chain: [],
      distribution: {
        sample: true,
        complete: true,
        source: "Illustrative sample",
        asOf: new Date().toISOString(),
        contracts: distributionContracts,
        warnings: [],
      },
      warnings: [],
      quoteTimestamp: new Date().toISOString(),
    };
  }
  const items = [
    ["Shipping disruption eases", 2, "Bullish", "resolved"],
    ["El Niño outlook", 0, "Neutral", "monitoring"],
    ["Russia-related biological outbreak", 0, "Neutral", "monitoring"],
    ["US 10Y yield above 6%", -5, "Strong bearish", "monitoring"],
    ["Shipping disruption worsens", -3, "Bearish", "monitoring"],
    ["Oil price pressure", -2, "Bearish", "monitoring"],
  ].map(([title, points, sentiment, status], i) => ({
    id: "demo-" + i,
    title,
    eventKey: title,
    points,
    sentiment,
    status,
    verified: i !== 2,
    symbol: "AAPL",
    template: "collar",
    sources: i === 2 ? [] : ["https://example.com/illustrative-evidence"],
    condition:
      i === 3
        ? "Official daily US 10Y yield closes above 6%."
        : "Review a documented change in this topic.",
    resolution: "A source confirms the tracking condition has ended.",
    rationale: "Illustrative impact, not a current market assessment.",
    checkedAt: new Date().toISOString(),
    impactUntil: addDays(today, 30),
    history: [
      { at: new Date().toISOString(), note: "Illustrative item added" },
    ],
  }));
  const rows = definition.symbols
    .filter((s) => datasets[s])
    .flatMap((s) => buildCandidates(datasets[s], definition))
    .map((r) => applyCatalysts(r, items));
  return {
    definition,
    datasets,
    rows,
    items,
    agent: {
      status: "completed",
      suggestions: [],
      valuations: [
        {
          symbol: "AAPL",
          priceTarget: 235,
          rating: "Bullish",
          report:
            "Illustrative research only. No current AI recommendation has been generated.",
          asOf: new Date().toISOString(),
        },
      ],
    },
  };
}
