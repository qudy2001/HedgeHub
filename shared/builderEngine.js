import { optionPrice, optionDelta } from "./optionMath.js";

export const ENGINE_VERSION = "studio-v1";
export const DAY = 86400000;
export const TEMPLATES = {
  collar: "Collar",
  protective_put: "Protective put",
  covered_call: "Covered call",
  cash_put: "Cash-secured put",
  put_credit: "Put credit spread",
  put_debit: "Put debit spread",
  stock: "Stock only",
};
export const SENTIMENTS = [
  "Strong bullish",
  "Bullish",
  "Neutral",
  "Bearish",
  "Strong bearish",
];
export const DEFAULT_STRATEGY = {
  name: "My protected portfolio",
  symbols: ["AAPL", "MSFT", "SPY"],
  template: "collar",
  shares: 100,
  putPct: 95,
  callPct: 105,
  dte: 35,
  fee: 0.65,
  minPrice: 0,
  minVolume: 0,
  trend: "any",
  pricingMode: "market",
  dailyResearch: true,
};
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);
export const addDays = (d, n) => dateOnly(Date.parse(d) + n * DAY);
export const number = (v) =>
  v == null || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v))
    ? null
    : Number(v);
export function validateStrategy(input = {}) {
  const s = { ...DEFAULT_STRATEGY, ...input };
  s.name = String(s.name).trim().slice(0, 100);
  s.symbols = [
    ...new Set(
      (Array.isArray(s.symbols) ? s.symbols : String(s.symbols).split(/[\s,]+/))
        .map((v) => String(v).trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (
    !s.name ||
    !s.symbols.length ||
    s.symbols.length > 50 ||
    s.symbols.some((v) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(v))
  )
    throw new Error("Enter a name and 1–50 valid US stock/ETF symbols.");
  if (!TEMPLATES[s.template]) throw new Error("Unknown strategy template");
  for (const [key, min, max] of [
    ["shares", 100, 10000],
    ["putPct", 50, 100],
    ["callPct", 100, 150],
    ["dte", 7, 365],
    ["fee", 0, 100],
    ["minPrice", 0, 100000],
    ["minVolume", 0, 1e12],
  ]) {
    const n = number(s[key]);
    if (n == null || n < min || n > max)
      throw new Error(`${key} must be between ${min} and ${max}`);
    s[key] = n;
  }
  if (s.shares % 100 || !Number.isInteger(s.dte))
    throw new Error("Use multiples of 100 shares and whole days.");
  if (
    !["market", "modeled"].includes(s.pricingMode) ||
    !["any", "above50", "below50"].includes(s.trend)
  )
    throw new Error("Invalid pricing or trend setting");
  return Object.fromEntries(
    Object.keys(DEFAULT_STRATEGY).map((k) => [
      k,
      k === "dailyResearch" ? s[k] === true : s[k],
    ]),
  );
}
export function realizedVol(bars) {
  const p = bars.slice(-21).map((b) => b.close);
  if (p.length < 21 || p.some((v) => !(v > 0))) return null;
  const r = p.slice(1).map((v, i) => Math.log(v / p[i])),
    avg = r.reduce((a, b) => a + b, 0) / 20;
  return Math.sqrt((r.reduce((a, b) => a + (b - avg) ** 2, 0) / 19) * 252);
}
export function technicals(bars) {
  const closes = bars.map((b) => b.close),
    sma = (n) =>
      closes.length >= n
        ? closes.slice(-n).reduce((a, b) => a + b, 0) / n
        : null;
  const d = closes
    .slice(-15)
    .slice(1)
    .map((v, i) => v - closes.slice(-15)[i]);
  const gain = d.reduce((a, v) => a + Math.max(0, v), 0),
    loss = d.reduce((a, v) => a + Math.max(0, -v), 0);
  return {
    sma50: sma(50),
    sma200: sma(200),
    rsi:
      d.length < 14
        ? null
        : gain + loss === 0
          ? 50
          : (100 * gain) / (gain + loss),
    hv: realizedVol(bars),
    support: bars.length
      ? Math.min(...bars.slice(-60).map((b) => b.low))
      : null,
    resistance: bars.length
      ? Math.max(...bars.slice(-60).map((b) => b.high))
      : null,
  };
}
export function payoff(
  row,
  spot,
  date = row.expiry,
  volOverride = null,
  rate = 0.0425,
) {
  const stock = row.shares * (spot - row.spot);
  const timeYears = Math.max(
    0,
    (Date.parse(row.expiry) - Date.parse(date)) / DAY / 365,
  );
  return (
    stock +
    row.legs.reduce((p, l) => {
      // The shared quote model rejects spot=0; the payoff engine must honor its limiting value.
      const value =
        spot === 0
          ? l.type === "put"
            ? l.strike * Math.exp(-rate * timeYears)
            : 0
          : optionPrice({
              type: l.type,
              spot,
              strike: l.strike,
              timeYears,
              volatility: volOverride ?? l.iv,
              riskFreeRate: rate,
            });
      return p + l.quantity * 100 * (value - l.price);
    }, 0) -
    row.fees
  );
}
export function summarizePosition(row) {
  const strikes = [
    ...new Set([0, row.spot, ...row.legs.map((l) => l.strike)]),
  ].sort((a, b) => a - b);
  const values = strikes.map((s) => payoff(row, s));
  const slope =
    row.shares +
    row.legs
      .filter((l) => l.type === "call")
      .reduce((a, l) => a + l.quantity * 100, 0);
  const high = Math.max(...strikes) * 3,
    highPnl = payoff(row, high);
  const maxProfit = slope > 0 ? null : Math.max(...values, highPnl);
  const maxLoss = slope < 0 ? null : Math.min(...values, highPnl);
  const points = [...strikes, high],
    breakevens = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      pa = payoff(row, a),
      pb = payoff(row, b);
    if (Math.abs(pa) < 1e-8) breakevens.push(a);
    if (pa * pb < 0) breakevens.push(a + ((b - a) * -pa) / (pb - pa));
  }
  return {
    maxProfit,
    maxLoss,
    breakevens: [...new Set(breakevens)],
    capital: Math.max(
      row.shares * row.spot + row.netDebit,
      -(maxLoss ?? 0),
      row.template === "cash_put"
        ? row.legs[0].strike * 100 * Math.abs(row.legs[0].quantity)
        : 0,
      1,
    ),
  };
}
export function baseRating(row) {
  const notional = row.spot * row.lots * 100;
  const worst = Math.min(
    ...[-0.1, -0.2, -0.3].map((m) => payoff(row, row.spot * (1 + m))),
  );
  const parts = {
    protection: 35 * clamp(1 + worst / (0.3 * notional), 0, 1),
    cost:
      25 *
      clamp(1 - Math.max(0, row.netDebit + row.fees) / (0.05 * notional), 0, 1),
    upside: 20 * clamp(payoff(row, row.spot * 1.1) / (0.1 * notional), 0, 1),
    liquidity: null,
  };
  const liquid = row.legs.every(
    (l) => l.verifiedQuote && l.bid >= 0 && l.ask > 0 && l.ask >= l.bid,
  );
  if (!row.legs.length) parts.liquidity = 20;
  else if (liquid)
    parts.liquidity =
      20 *
      clamp(
        1 -
          Math.max(
            ...row.legs.map((l) => (l.ask - l.bid) / ((l.ask + l.bid) / 2)),
          ) /
            0.2,
        0,
        1,
      );
  const lower = Object.values(parts).reduce((a, v) => a + (v ?? 0), 0);
  return {
    parts,
    baseScore: parts.liquidity == null ? null : Math.round(lower),
    scoreRange: [
      Math.round(lower),
      Math.round(lower + (parts.liquidity == null ? 20 : 0)),
    ],
    version: ENGINE_VERSION,
  };
}
export function applyCatalysts(
  row,
  items = [],
  enabled = true,
  asOf = new Date().toISOString(),
) {
  const seen = new Set();
  const contributions = items
    .filter(
      (i) =>
        !i.removed &&
        (!i.symbol || i.symbol === row.symbol) &&
        (!i.template || i.template === row.template),
    )
    .map((i) => {
      const key = i.eventKey || i.id,
        duplicate = seen.has(key);
      seen.add(key);
      const fresh =
        i.checkedAt &&
        Date.parse(asOf) - Date.parse(i.checkedAt) >= -5000 &&
        Date.parse(asOf) - Date.parse(i.checkedAt) < 7 * DAY;
      const eligible =
        enabled &&
        !duplicate &&
        i.verified &&
        i.sources?.length &&
        fresh &&
        (!i.impactUntil || i.impactUntil >= asOf.slice(0, 10));
      return {
        id: i.id,
        title: i.title,
        points: eligible ? clamp(Number(i.points) || 0, -5, 5) : 0,
        excluded: !eligible,
        reason: !enabled
          ? "Excluded by toggle"
          : duplicate
            ? "Related event already counted"
            : !i.verified
              ? "Unverified"
              : !i.sources?.length
                ? "Source required"
                : !fresh
                  ? "Evidence needs refresh"
                  : i.impactUntil && i.impactUntil < asOf.slice(0, 10)
                    ? "Impact horizon ended"
                    : i.rationale,
      };
    });
  const catalystImpact = clamp(
    contributions.reduce((a, i) => a + i.points, 0),
    -15,
    15,
  );
  return {
    ...row,
    contributions,
    catalystImpact,
    overall:
      row.baseScore == null
        ? null
        : clamp(row.baseScore + catalystImpact, 0, 100),
    adjustedRange: row.scoreRange.map((n) => clamp(n + catalystImpact, 0, 100)),
  };
}
export function buildCandidates(
  snapshot,
  input,
  templates = Object.keys(TEMPLATES),
) {
  const s = validateStrategy(input),
    spot = snapshot.spot,
    asOf = snapshot.asOf || new Date().toISOString(),
    today = asOf.slice(0, 10);
  if (!(spot > 0)) return [];
  const tech = technicals(snapshot.bars ?? []);
  if (
    spot < s.minPrice ||
    (s.minVolume > 0 && (snapshot.bars?.at(-1)?.volume ?? 0) < s.minVolume) ||
    (s.trend === "above50" && !(spot > tech.sma50 && tech.sma50 > 0)) ||
    (s.trend === "below50" && !(spot < tech.sma50))
  )
    return [];
  const modeled = s.pricingMode === "modeled";
  const target = addDays(today, s.dte),
    expiries = modeled
      ? [target]
      : [
          ...new Set(
            (snapshot.chain ?? [])
              .map((c) => c.expiration)
              .filter(
                (d) =>
                  d > today &&
                  Math.abs((Date.parse(d) - Date.parse(target)) / DAY) <= 21,
              ),
          ),
        ]
          .sort(
            (a, b) =>
              Math.abs(Date.parse(a) - Date.parse(target)) -
              Math.abs(Date.parse(b) - Date.parse(target)),
          )
          .slice(0, 3);
  const lots = s.shares / 100,
    rows = [];
  if (templates.includes("stock") && !expiries.length) expiries.push(target);
  for (const expiry of expiries)
    for (const template of templates) {
      if (!TEMPLATES[template]) continue;
      if (modeled && template !== "stock" && !(snapshot.hv > 0 || tech.hv > 0))
        continue;
      const select = (type, pct, quantity) => {
        let c;
        if (modeled) {
          const strike = Math.max(1, Math.round((spot * pct) / 100)),
            iv = snapshot.hv || tech.hv;
          c = {
            strike,
            impliedVolatility: iv,
            mark: optionPrice({
              type,
              spot,
              strike,
              volatility: iv,
              timeYears: (Date.parse(expiry) - Date.parse(today)) / DAY / 365,
            }),
            source: "European model",
            contractSymbol: `MODEL:${snapshot.symbol}:${expiry}:${type}:${strike}`,
          };
        } else {
          c = (snapshot.chain ?? [])
            .filter(
              (c) =>
                c.expiration === expiry &&
                c.optionType === type &&
                (c.multiplier ?? 100) === 100 &&
                c.strike > 0 &&
                c.impliedVolatility > 0 &&
                number(c.bid) != null &&
                c.bid >= 0 &&
                c.ask > 0 &&
                c.ask >= c.bid &&
                c.hasRealBidAsk === true,
            )
            .sort(
              (a, b) =>
                Math.abs(a.strike - (spot * pct) / 100) -
                Math.abs(b.strike - (spot * pct) / 100),
            )[0];
        }
        if (!c) return null;
        const age = c.quoteTimestamp
          ? Date.parse(asOf) - Date.parse(c.quoteTimestamp)
          : Infinity;
        return {
          type,
          quantity: quantity * lots,
          strike: c.strike,
          price: modeled ? c.mark : quantity > 0 ? c.ask : c.bid,
          iv: c.impliedVolatility,
          contract: c.contractSymbol,
          bid: number(c.bid),
          ask: number(c.ask),
          oi: number(c.openInterest),
          volume: number(c.volume),
          source: c.source,
          quoteTimestamp: c.quoteTimestamp ?? null,
          verifiedQuote:
            !modeled && c.isLive === true && age >= -5000 && age <= 90000,
        };
      };
      let shares = 0,
        legs = [];
      if (
        ["stock", "collar", "protective_put", "covered_call"].includes(template)
      )
        shares = s.shares;
      if (["collar", "protective_put"].includes(template))
        legs.push(select("put", s.putPct, 1));
      if (["collar", "covered_call"].includes(template))
        legs.push(select("call", s.callPct, -1));
      if (template === "cash_put") legs.push(select("put", s.putPct, -1));
      if (template === "put_credit")
        legs.push(select("put", s.putPct, -1), select("put", s.putPct - 5, 1));
      if (template === "put_debit")
        legs.push(select("put", 100, 1), select("put", s.putPct, -1));
      if (
        legs.some((l) => !l) ||
        new Set(legs.map((l) => l.type + ":" + l.strike)).size !== legs.length
      )
        continue;
      if (template === "collar" && !(legs[0].strike < legs[1].strike)) continue;
      const netDebit = legs.reduce((v, l) => v + l.price * l.quantity * 100, 0),
        fees = legs.reduce((v, l) => v + Math.abs(l.quantity) * s.fee, 0);
      const row = {
        id: `${snapshot.symbol}:${template}:${expiry}:${legs.map((l) => l.strike).join("-")}`,
        symbol: snapshot.symbol,
        template,
        name: TEMPLATES[template],
        asOf,
        expiry,
        spot,
        shares,
        lots,
        legs,
        netDebit,
        fees,
        iv: legs.length
          ? legs.reduce((a, l) => a + l.iv, 0) / legs.length
          : null,
        hv: tech.hv,
        minOi:
          legs.length && legs.every((l) => l.oi != null)
            ? Math.min(...legs.map((l) => l.oi))
            : null,
        modeled,
        source: snapshot.source,
        quoteTimestamp: snapshot.quoteTimestamp,
      };
      row.delta =
        shares +
        legs.reduce(
          (a, l) =>
            a +
            (optionDelta({
              type: l.type,
              spot,
              strike: l.strike,
              timeYears: (Date.parse(expiry) - Date.parse(today)) / DAY / 365,
              volatility: l.iv,
            }) ?? 0) *
              l.quantity *
              100,
          0,
        );
      Object.assign(row, summarizePosition(row), baseRating(row));
      rows.push(row);
    }
  return rows;
}

// Daily-close decisions, next-session-open fills. Synthetic contracts, no current IV or news.
export function backtest(bars, input, settings = {}) {
  const s = validateStrategy({ ...input, pricingMode: "modeled" }),
    { start, end } = settings;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "") ||
    dateOnly(start) !== start ||
    dateOnly(end) !== end ||
    start >= end ||
    end > dateOnly(Date.now())
  )
    throw new Error("Choose valid past start/end dates.");
  const numeric = (key, def, min, max) => {
    const n = number(settings[key] ?? def);
    if (n == null || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const initial = numeric("capital", 100000, 100, 1e9),
    slip = numeric("optionSlippage", 2, 0, 20) / 100,
    stockSlip = numeric("stockSlippage", 5, 0, 100) / 10000,
    roll = numeric("rollDays", 5, 0, 30),
    stop = numeric("stopLoss", 20, 0, 100) / 100,
    profit = numeric("takeProfit", 25, 0, 1000) / 100,
    rate = numeric("rate", 4.25, 0, 30) / 100;
  const history = [...bars]
    .filter((b) => b.close > 0 && b.open > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const first = history.findIndex((b) => b.date >= start),
    last = history.findLastIndex((b) => b.date <= end);
  if (
    first < 60 ||
    last <= first ||
    (Date.parse(history[first].date) - Date.parse(start)) / DAY > 5 ||
    (Date.parse(end) - Date.parse(history[last].date)) / DAY > 5
  )
    throw new Error(
      "History does not cover these dates with 60 warm-up sessions. Choose a covered range.",
    );
  let cash = initial,
    position = null,
    pending = "entry",
    peak = initial,
    maxDrawdown = 0;
  const equity = [],
    trades = [];
  const friction = (p, spot, date, vol) =>
    Math.abs(p.shares) * spot * stockSlip +
    p.legs.reduce(
      (a, l) =>
        a +
        Math.abs(l.quantity) *
          (100 *
            optionPrice({
              type: l.type,
              spot,
              strike: l.strike,
              timeYears: Math.max(
                0,
                (Date.parse(p.expiry) - Date.parse(date)) / DAY / 365,
              ),
              volatility: vol,
              riskFreeRate: rate,
            }) *
            slip +
            s.fee),
      0,
    );
  const close = (bar, price, vol, reason) => {
    const pnl =
      payoff(position, price, bar.date, vol, rate) -
      friction(position, price, bar.date, vol) -
      position.entrySlippage;
    cash += pnl;
    trades.push({
      entryDate: position.entryDate,
      exitDate: bar.date,
      pnl,
      reason,
      entrySpot: position.spot,
      exitSpot: price,
      expiry: position.expiry,
    });
    position = null;
  };
  for (let i = first; i <= last; i++) {
    const b = history[i],
      known = history.slice(0, i),
      vol = realizedVol(known),
      prev = history[i - 1];
    if (!(vol > 0)) throw new Error(`Volatility unavailable before ${b.date}`);
    if (position && (pending === "exit" || pending === "roll")) {
      close(b, b.open, vol, pending);
      pending = pending === "roll" ? "entry" : null;
    }
    if (!position && pending === "entry") {
      const candidates = buildCandidates(
        {
          symbol: s.symbols[0],
          spot: prev.close,
          asOf: `${prev.date}T21:00:00Z`,
          bars: known,
          hv: vol,
        },
        s,
        [s.template],
      );
      const p = candidates[0];
      if (p) {
        p.spot = b.open;
        p.entryDate = b.date;
        for (const l of p.legs)
          l.price = optionPrice({
            type: l.type,
            spot: b.open,
            strike: l.strike,
            timeYears: Math.max(
              0,
              (Date.parse(p.expiry) - Date.parse(b.date)) / DAY / 365,
            ),
            volatility: vol,
            riskFreeRate: rate,
          });
        p.netDebit = p.legs.reduce((a, l) => a + l.price * l.quantity * 100, 0);
        Object.assign(p, summarizePosition(p));
        p.entrySlippage = friction(p, b.open, b.date, vol) - p.fees;
        if (p.capital + p.fees + p.entrySlippage <= cash) position = p;
      }
    }
    pending = null;
    if (position && (b.date >= position.expiry || i === last))
      close(
        b,
        b.close,
        realizedVol(history.slice(0, i + 1)) || vol,
        i === last ? "end of test" : "expiry",
      );
    const value =
      cash +
      (position
        ? payoff(
            position,
            b.close,
            b.date,
            realizedVol(history.slice(0, i + 1)) || vol,
            rate,
          ) - position.entrySlippage
        : 0);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - value) / peak : 0);
    equity.push({
      date: b.date,
      value,
      benchmark: initial * (b.close / history[first].open),
    });
    if (position) {
      const pnl = value - cash;
      pending =
        (stop > 0 && pnl <= -position.capital * stop) ||
        (profit > 0 && pnl >= position.capital * profit)
          ? "exit"
          : Date.parse(position.expiry) - Date.parse(b.date) <= roll * DAY
            ? "roll"
            : null;
    } else pending = "entry";
  }
  const returns = equity.slice(1).map((e, i) => e.value / equity[i].value - 1),
    avg = returns.reduce((a, b) => a + b, 0) / (returns.length || 1),
    sd = Math.sqrt(
      returns.reduce((a, b) => a + (b - avg) ** 2, 0) / (returns.length || 1),
    );
  return {
    version: ENGINE_VERSION,
    symbol: s.symbols[0],
    equity,
    trades,
    initial,
    final: cash,
    returnPct: (cash / initial - 1) * 100,
    maxDrawdown: maxDrawdown * 100,
    winRate: trades.length
      ? (trades.filter((t) => t.pnl > 0).length / trades.length) * 100
      : null,
    sharpe: sd > 0 ? ((avg - rate / 252) / sd) * Math.sqrt(252) : null,
    assumptions: {
      ...settings,
      pricing:
        "European synthetic options; trailing 20-session volatility; no dividends or early assignment; provider-adjusted stock series",
      execution:
        "Close signals / next session open; cash settlement at expiry; expiry is synthetic target DTE",
      optionSlippage: slip,
      stockSlippage: stockSlip,
      rate,
    },
    dataRange: [history[0].date, history.at(-1).date],
  };
}
