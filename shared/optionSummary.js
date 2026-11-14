// Rule-based read of the option chain (open interest + volume) against the stock's price context.
// Pure: everything comes from the contracts already loaded for the distribution panels plus a few
// stock stats. It describes positioning; it does not recommend trades.
const DAY = 86400000;
const ratio = (a, b) => (a != null && b > 0 ? a / b : null);
const finite = (v) => (Number.isFinite(v) ? v : null);
// Volatility arrives as a fraction (0.54) from some sources and as percent points (54) from others.
export const volFraction = (v) => (v > 0 ? (v > 3 ? v / 100 : v) : null);

function sumByStrike(contracts, metric) {
  const map = new Map();
  for (const c of contracts) {
    if (!map.has(c.strike)) map.set(c.strike, { strike: c.strike, call: 0, put: 0 });
    map.get(c.strike)[c.optionType] += c[metric];
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}
const top = (rows, side) =>
  rows.reduce((best, r) => (r[side] > (best?.[side] ?? 0) ? r : best), null);

// Strike where option holders collect the least at expiry, for one expiry's open interest.
export function maxPain(strikes) {
  let best = null;
  for (const { strike: settle } of strikes) {
    let payout = 0;
    for (const s of strikes)
      payout += s.call * Math.max(0, settle - s.strike) + s.put * Math.max(0, s.strike - settle);
    if (!best || payout < best.payout) best = { strike: settle, payout };
  }
  return best?.strike ?? null;
}
const mid = (c) => (c && c.bid > 0 && c.ask >= c.bid ? (c.bid + c.ask) / 2 : null);

// `language` ("en" or "zh") only changes the takeaways, the sentences shown under "What stands out" and sent to the
// research agents. Signals and levels are interface labels and stay English.
export function optionSummary({ contracts = [], spot, asOf, stats = {}, language = "en" } = {}) {
  const today = asOf ?? new Date().toISOString().slice(0, 10),
    seen = new Set();
  const valid = [];
  for (const c of contracts) {
    if (!["call", "put"].includes(c.optionType) || !(c.strike > 0) || !(c.expiration >= today)) continue;
    const id = c.contractSymbol || `${c.expiration}:${c.strike}:${c.optionType}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const oi = Number(c.openInterest),
      volume = Number(c.volume);
    valid.push({
      ...c,
      openInterest: oi >= 0 ? oi : 0,
      volume: volume >= 0 ? volume : 0,
      dte: Math.round((Date.parse(c.expiration) - Date.parse(today)) / DAY),
    });
  }
  const total = (metric, type, list = valid) =>
    list.reduce((t, c) => t + (c.optionType === type ? c[metric] : 0), 0);
  const callOi = total("openInterest", "call"),
    putOi = total("openInterest", "put"),
    callVol = total("volume", "call"),
    putVol = total("volume", "put");
  const hasChain = valid.length > 0 && spot > 0;

  // Walls: the largest resting open interest within 90 days, where it actually pins price.
  const nearTerm = valid.filter((c) => c.dte <= 90),
    wallRows = sumByStrike(nearTerm.length ? nearTerm : valid, "openInterest");
  const callWall = hasChain ? top(wallRows.filter((r) => r.strike >= spot), "call") : null,
    putWall = hasChain ? top(wallRows.filter((r) => r.strike <= spot), "put") : null;

  // Key expiry: the heaviest open interest in the next 45 days (else the heaviest overall).
  const byExpiry = new Map();
  for (const c of valid) {
    if (!byExpiry.has(c.expiration)) byExpiry.set(c.expiration, { expiration: c.expiration, dte: c.dte, oi: 0, list: [] });
    const e = byExpiry.get(c.expiration);
    e.oi += c.openInterest;
    e.list.push(c);
  }
  const expiries = [...byExpiry.values()].sort((a, b) => a.dte - b.dte),
    soon = expiries.filter((e) => e.dte >= 1 && e.dte <= 45),
    key = (soon.length ? soon : expiries).reduce((best, e) => (e.oi > (best?.oi ?? -1) ? e : best), null);
  const pain = key && key.oi > 0 ? maxPain(sumByStrike(key.list, "openInterest")) : null;

  // Expected move to the key expiry: the at-the-money straddle when quoted, else implied volatility.
  // Underlying IV when supplied, else the key expiry's at-the-money contract IV.
  let expected = null,
    iv = volFraction(stats.iv);
  if (hasChain && key && key.dte >= 1) {
    const strikes = [...new Set(key.list.map((c) => c.strike))].sort(
        (a, b) => Math.abs(a - spot) - Math.abs(b - spot),
      ),
      at = (type) => key.list.find((c) => c.strike === strikes[0] && c.optionType === type),
      call = mid(at("call")),
      put = mid(at("put"));
    iv ??= volFraction(at("call")?.impliedVolatility) ?? volFraction(at("put")?.impliedVolatility);
    const move =
      call != null && put != null
        ? { amount: call + put, method: "straddle" }
        : iv
          ? { amount: spot * iv * Math.sqrt(key.dte / 365), method: "iv" }
          : null;
    if (move && move.amount > 0 && move.amount < spot)
      expected = {
        ...move,
        pct: (move.amount / spot) * 100,
        low: spot - move.amount,
        high: spot + move.amount,
        expiration: key.expiration,
        dte: key.dte,
      };
  }

  // Flow: where today's volume is going, and where it exceeds resting open interest (new positions).
  const volRows = sumByStrike(valid, "volume"),
    busiest = ["call", "put"]
      .map((type) => ({ type, row: top(volRows, type) }))
      .filter((b) => b.row)
      .sort((a, b) => b.row[b.type] - a.row[a.type])[0];
  const fresh = valid
    .filter((c) => c.volume >= 100 && c.volume > c.openInterest)
    .sort((a, b) => b.volume - a.volume);
  const totalVol = callVol + putVol,
    totalOi = callOi + putOi;

  const hv = volFraction(stats.hv),
    ema = finite(stats.emaAverage),
    rsi = finite(stats.rsi);
  const positioning = {
    callOi,
    putOi,
    putCallOi: ratio(putOi, callOi),
    callWall: callWall && callWall.call > 0 ? { strike: callWall.strike, oi: callWall.call } : null,
    putWall: putWall && putWall.put > 0 ? { strike: putWall.strike, oi: putWall.put } : null,
    maxPain: pain,
    keyExpiry: key ? { expiration: key.expiration, dte: key.dte, oi: key.oi } : null,
  };
  const flow = {
    callVolume: callVol,
    putVolume: putVol,
    putCallVolume: ratio(putVol, callVol),
    turnover: ratio(totalVol, totalOi),
    nearShare: ratio(
      valid.reduce((t, c) => t + (c.dte <= 30 ? c.volume : 0), 0),
      totalVol,
    ),
    busiest: busiest ? { type: busiest.type, strike: busiest.row.strike, volume: busiest.row[busiest.type] } : null,
    fresh: fresh.slice(0, 3).map((c) => ({
      expiration: c.expiration,
      strike: c.strike,
      type: c.optionType,
      volume: c.volume,
      openInterest: c.openInterest,
    })),
    freshCount: fresh.length,
  };
  const price = {
    spot: finite(spot),
    trendPct: ema && spot > 0 ? (spot / ema - 1) * 100 : null,
    rsi,
    rangePct:
      stats.resistance > stats.support && spot > 0
        ? ((spot - stats.support) / (stats.resistance - stats.support)) * 100
        : null,
    iv,
    hv,
    ivHvRatio: ratio(iv, hv),
    ivRank: finite(stats.ivRank),
  };

  const signals = buildSignals(price, positioning, flow);
  const levels = hasChain || spot > 0 ? buildLevels({ spot, stats, positioning, expected }) : [];
  return {
    contracts: valid.length,
    price,
    positioning,
    flow,
    expected,
    signals,
    levels,
    takeaways: (language === "zh" ? buildTakeawaysZh : buildTakeaways)({ price, positioning, flow, expected, spot }),
  };
}

const lean = (r) => (r == null ? null : r > 1.1 ? "put" : r < 0.7 ? "call" : "balanced");
function buildSignals(price, positioning, flow) {
  const out = [];
  if (price.trendPct != null)
    out.push({
      key: "Trend",
      label: price.trendPct > 2 ? "Above trend" : price.trendPct < -2 ? "Below trend" : "At trend",
      detail: `${signed(price.trendPct)}% vs EMA average`,
      tone: price.trendPct > 2 ? "positive" : price.trendPct < -2 ? "negative" : "neutral",
    });
  if (price.rsi != null)
    out.push({
      key: "Momentum",
      label: price.rsi < 30 ? "Oversold" : price.rsi > 70 ? "Overbought" : "Neutral",
      detail: `RSI ${price.rsi.toFixed(1)}`,
      tone: price.rsi < 30 || price.rsi > 70 ? "warn" : "neutral",
    });
  if (price.ivHvRatio != null || price.ivRank != null) {
    const rich = price.ivHvRatio != null ? price.ivHvRatio >= 1.15 : price.ivRank >= 70,
      cheap = price.ivHvRatio != null ? price.ivHvRatio <= 0.9 : price.ivRank <= 30;
    out.push({
      key: "Volatility",
      label: rich ? "Options rich" : cheap ? "Options cheap" : "Fairly priced",
      detail: [
        price.ivHvRatio != null ? `IV ${(price.iv * 100).toFixed(0)}% vs HV ${(price.hv * 100).toFixed(0)}%` : null,
        price.ivRank != null ? `rank ${price.ivRank.toFixed(0)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      tone: rich || cheap ? "warn" : "neutral",
    });
  }
  const side = (key, r, noun) => {
    const l = lean(r);
    if (!l) return;
    out.push({
      key,
      label: l === "put" ? "Put-heavy" : l === "call" ? "Call-heavy" : "Balanced",
      detail: `Put/call ${noun} ${r.toFixed(2)}`,
      tone: l === "put" ? "negative" : l === "call" ? "positive" : "neutral",
    });
  };
  side("Positioning", positioning.putCallOi, "OI");
  side("Flow today", flow.putCallVolume, "volume");
  return out;
}

function buildLevels({ spot, stats, positioning, expected }) {
  const rows = [
    ["Resistance", stats.resistance, "60-session high"],
    ["Call wall", positioning.callWall?.strike, "largest call OI above price"],
    ["Expected high", expected?.high, expected ? `by ${expected.expiration}` : ""],
    ["EMA average", stats.emaAverage, "trend reference"],
    ["Max pain", positioning.maxPain, positioning.keyExpiry ? `${positioning.keyExpiry.expiration} expiry` : ""],
    ["Spot", spot, "current price"],
    ["Expected low", expected?.low, expected ? `by ${expected.expiration}` : ""],
    ["Put wall", positioning.putWall?.strike, "largest put OI below price"],
    ["Support", stats.support, "60-session low"],
  ];
  return rows
    .filter(([, value]) => value > 0)
    .map(([label, value, note]) => ({
      label,
      value,
      note,
      distancePct: spot > 0 && label !== "Spot" ? (value / spot - 1) * 100 : null,
      spot: label === "Spot",
    }))
    .sort((a, b) => b.value - a.value || (a.spot ? 1 : -1));
}

const signed = (v, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const usd = (v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const compact = (v) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K` : String(Math.round(v));

function buildTakeaways({ price, positioning, flow, expected, spot }) {
  const out = [];
  const { rsi, trendPct } = price;
  if (rsi != null && trendPct != null) {
    if (rsi < 30 && trendPct < -2)
      out.push(`Price is stretched to the downside: RSI ${rsi.toFixed(1)} and ${Math.abs(trendPct).toFixed(1)}% below the EMA average.`);
    else if (rsi > 70 && trendPct > 2)
      out.push(`Price is stretched to the upside: RSI ${rsi.toFixed(1)} and ${trendPct.toFixed(1)}% above the EMA average.`);
    else
      out.push(
        `Price is ${Math.abs(trendPct) <= 2 ? "at" : `${Math.abs(trendPct).toFixed(1)}% ${trendPct > 0 ? "above" : "below"}`} the EMA average with RSI ${rsi.toFixed(1)}.`,
      );
  }
  if (price.ivHvRatio != null) {
    const gap = (price.iv - price.hv) * 100;
    out.push(
      `Options price in ${Math.abs(gap) < 3 ? "about the same movement as" : gap > 0 ? `${gap.toFixed(0)} points more movement than` : `${Math.abs(gap).toFixed(0)} points less movement than`} the stock has realized (IV ${(price.iv * 100).toFixed(0)}% vs HV ${(price.hv * 100).toFixed(0)}%)${price.ivRank != null ? `, with IV rank at ${price.ivRank.toFixed(0)}` : ""}.`,
    );
  }
  if (expected)
    out.push(
      `The market implies a move of about ±${usd(expected.amount)} (±${expected.pct.toFixed(1)}%) by ${expected.expiration}, a ${usd(expected.low)}–${usd(expected.high)} range${expected.method === "straddle" ? " from the at-the-money straddle" : " from implied volatility"}.`,
    );
  const { callWall, putWall, maxPain: pain, keyExpiry } = positioning;
  if (callWall && putWall)
    out.push(
      `Open interest brackets price between the ${usd(putWall.strike)} put wall (${compact(putWall.oi)}) and the ${usd(callWall.strike)} call wall (${compact(callWall.oi)})${pain != null && keyExpiry ? `; max pain for ${keyExpiry.expiration} is ${usd(pain)}, ${signed((pain / spot - 1) * 100)}% from spot` : ""}.`,
    );
  else if (pain != null && keyExpiry)
    out.push(`Max pain for ${keyExpiry.expiration} is ${usd(pain)}, ${signed((pain / spot - 1) * 100)}% from spot.`);
  const oiLean = lean(positioning.putCallOi),
    volLean = lean(flow.putCallVolume);
  if (oiLean && volLean) {
    const shift =
      flow.putCallVolume > positioning.putCallOi * 1.25
        ? "puts are trading above their share of open interest, so downside demand is building today"
        : flow.putCallVolume < positioning.putCallOi * 0.8
          ? "calls are trading above their share of open interest, so upside demand is building today"
          : "today's flow matches existing positioning";
    out.push(
      `Put/call is ${positioning.putCallOi.toFixed(2)} by open interest and ${flow.putCallVolume.toFixed(2)} by volume: ${shift}.`,
    );
  }
  if (flow.busiest && flow.nearShare != null)
    out.push(
      `${Math.round(flow.nearShare * 100)}% of volume expires within 30 days; the busiest strike is the ${usd(flow.busiest.strike)} ${flow.busiest.type}s (${compact(flow.busiest.volume)})${flow.freshCount ? `, and ${flow.freshCount} contract${flow.freshCount === 1 ? "" : "s"} traded more than their open interest` : ""}.`,
    );
  return out;
}

// The same read, written in Chinese rather than translated sentence by sentence. Keep the two in step: every English
// takeaway has its counterpart here, built from the same numbers under the same conditions.
function buildTakeawaysZh({ price, positioning, flow, expected, spot }) {
  const out = [];
  const { rsi, trendPct } = price;
  if (rsi != null && trendPct != null) {
    if (rsi < 30 && trendPct < -2)
      out.push(`价格已明显超跌：RSI ${rsi.toFixed(1)}，低于 EMA 均线 ${Math.abs(trendPct).toFixed(1)}%。`);
    else if (rsi > 70 && trendPct > 2)
      out.push(`价格已明显超涨：RSI ${rsi.toFixed(1)}，高于 EMA 均线 ${trendPct.toFixed(1)}%。`);
    else
      out.push(
        `价格${Math.abs(trendPct) <= 2 ? "贴近 EMA 均线" : `${trendPct > 0 ? "高于" : "低于"} EMA 均线 ${Math.abs(trendPct).toFixed(1)}%`}，RSI ${rsi.toFixed(1)}。`,
      );
  }
  if (price.ivHvRatio != null) {
    const gap = (price.iv - price.hv) * 100;
    out.push(
      `期权定价隐含的波动${Math.abs(gap) < 3 ? "与股价实际波动大致相当" : gap > 0 ? `比股价实际波动高 ${gap.toFixed(0)} 个百分点` : `比股价实际波动低 ${Math.abs(gap).toFixed(0)} 个百分点`}（IV ${(price.iv * 100).toFixed(0)}%，HV ${(price.hv * 100).toFixed(0)}%）${price.ivRank != null ? `，IV 分位 ${price.ivRank.toFixed(0)}` : ""}。`,
    );
  }
  if (expected)
    out.push(
      `市场隐含到 ${expected.expiration} 的波动约为 ±${usd(expected.amount)}（±${expected.pct.toFixed(1)}%），对应区间 ${usd(expected.low)}–${usd(expected.high)}，${expected.method === "straddle" ? "由平值跨式期权推算" : "由隐含波动率推算"}。`,
    );
  const { callWall, putWall, maxPain: pain, keyExpiry } = positioning;
  const painText = () => `${keyExpiry.expiration} 到期的最大痛点为 ${usd(pain)}，较现价 ${signed((pain / spot - 1) * 100)}%`;
  if (callWall && putWall)
    out.push(
      `未平仓合约把价格夹在 ${usd(putWall.strike)} 的看跌期权墙（${compact(putWall.oi)}）和 ${usd(callWall.strike)} 的看涨期权墙（${compact(callWall.oi)}）之间${pain != null && keyExpiry ? `；${painText()}` : ""}。`,
    );
  else if (pain != null && keyExpiry) out.push(`${painText()}。`);
  const oiLean = lean(positioning.putCallOi),
    volLean = lean(flow.putCallVolume);
  if (oiLean && volLean) {
    const shift =
      flow.putCallVolume > positioning.putCallOi * 1.25
        ? "看跌期权的成交占比高于其未平仓占比，今日下行需求在增加"
        : flow.putCallVolume < positioning.putCallOi * 0.8
          ? "看涨期权的成交占比高于其未平仓占比，今日上行需求在增加"
          : "今日成交与现有持仓结构一致";
    out.push(`看跌/看涨比按未平仓量为 ${positioning.putCallOi.toFixed(2)}，按成交量为 ${flow.putCallVolume.toFixed(2)}：${shift}。`);
  }
  if (flow.busiest && flow.nearShare != null)
    out.push(
      `${Math.round(flow.nearShare * 100)}% 的成交量集中在 30 天内到期的合约；成交最活跃的是 ${usd(flow.busiest.strike)} ${OPTION_TYPE_ZH[flow.busiest.type] ?? flow.busiest.type}期权（${compact(flow.busiest.volume)}）${flow.freshCount ? `，另有 ${flow.freshCount} 个合约的成交量超过其未平仓量` : ""}。`,
    );
  return out;
}

export const OPTION_TYPE_ZH = { call: "看涨", put: "看跌" };
// A key level's label and basis in Chinese, for text that is written in Chinese (the brief sent to the research agents).
const LEVEL_ZH = {
  Resistance: ["阻力位", () => "60 个交易日高点"],
  "Call wall": ["看涨期权墙", () => "现价上方最大的看涨未平仓量"],
  "Expected high": ["预期上沿", (date) => (date ? `截至 ${date}` : "")],
  "EMA average": ["EMA 均线", () => "趋势参考"],
  "Max pain": ["最大痛点", (date) => (date ? `${date} 到期` : "")],
  Spot: ["现价", () => "当前价格"],
  "Expected low": ["预期下沿", (date) => (date ? `截至 ${date}` : "")],
  "Put wall": ["看跌期权墙", () => "现价下方最大的看跌未平仓量"],
  Support: ["支撑位", () => "60 个交易日低点"],
};
export function levelTextZh(level) {
  const [label, note] = LEVEL_ZH[level.label] ?? [level.label, () => level.note];
  return { label, note: note(/\d{4}-\d{2}-\d{2}/.exec(level.note ?? "")?.[0]) };
}
