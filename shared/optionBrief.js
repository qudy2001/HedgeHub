// Compact text brief of a cached option chain (open interest + volume) for the research agents.
// Pure: built from contracts HedgeHub has already stored, through the same optionSummary and distribution
// maths as the Builder panels, so the agents read the numbers the user sees. It describes positioning; it
// does not recommend trades.
import { optionSummary } from "./optionSummary.js";
import { distribution } from "./optionDistribution.js";

const DAY = 86400000;
export const OPTION_BRIEF_MAX_CHARS = 6000;
// Below this much open interest a single contract moves every ratio, wall and max-pain strike.
export const OPTION_BRIEF_MIN_OPEN_INTEREST = 1000;
const usd = (v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const compact = (v) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K` : String(Math.round(v));
const signed = (v, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const share = (part, total) => (total > 0 ? `${Math.round((part / total) * 100)}%` : "n/a");
const stamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

// Largest strikes or expiries for one side of one metric, biggest first.
const largest = (bars, side, count) =>
  bars
    .filter((b) => b[side] > 0)
    .sort((a, b) => b[side] - a[side])
    .slice(0, count);

export function optionBrief({
  symbol,
  contracts = [],
  spot,
  source = "option provider",
  capturedAt,
  complete = true,
  stats = {},
  now = Date.now(),
} = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (!(spot > 0) || !contracts.length) return null;
  const summary = optionSummary({ contracts, spot, asOf: today, stats });
  if (!summary.contracts) return null;
  const options = { asOf: today, maxBars: Infinity },
    oi = distribution(contracts, "openInterest", options),
    vol = distribution(contracts, "volume", options),
    oiByExpiry = distribution(contracts, "openInterest", { ...options, axis: "expiry", grouping: "day" });
  if (!(oi.total > 0) && !(vol.total > 0)) return null;
  const { positioning: pos, flow, expected, price } = summary;
  const captured = Number.isFinite(Date.parse(capturedAt)) ? new Date(capturedAt).toISOString() : null,
    ageDays = captured ? Math.max(0, Math.floor((now - Date.parse(captured)) / DAY)) : null;
  const away = (strike) => signed((strike / spot - 1) * 100);
  const strikes = (bars, side, count) =>
    largest(bars, side, count)
      .map((b) => `${usd(b.lowStrike)} (${compact(b[side])}, ${away(b.lowStrike)})`)
      .join(", ");
  const split = (d) => `${share(d.near, d.total)} within 30 days, ${share(d.mid, d.total)} in 31-90 days, ${share(d.far, d.total)} beyond 90 days`;

  const lines = [
    `### Options positioning: ${symbol}`,
    `Source: ${source} option chain cached by HedgeHub${captured ? `, captured ${stamp(captured)} (${ageDays === 0 ? "less than a day" : `${ageDays} day${ageDays === 1 ? "" : "s"}`} before this run)` : ""}; ${summary.contracts.toLocaleString("en-US")} contracts expiring ${oi.from ?? vol.from} to ${oi.to ?? vol.to}. Spot at capture ${usd(spot)}.${complete ? "" : " The provider did not return every expiry, so totals are a lower bound."}`,
    "",
  ];
  if (oi.total < OPTION_BRIEF_MIN_OPEN_INTEREST) {
    lines.push(
      `Listed options are too thin to read positioning from: ${compact(oi.total)} contracts of open interest and ${compact(vol.total)} traded this session across the whole chain. Do not derive walls, max pain or an implied move from this chain, and expect wide spreads on any option structure.`,
    );
    return {
      text: lines.join("\n"),
      meta: { source, capturedAt: captured, ageDays, contracts: summary.contracts, spot, complete, thin: true },
    };
  }
  if (oi.total > 0)
    lines.push(
      `- **Open interest** (resting positions, updated once a day): ${compact(pos.callOi)} calls / ${compact(pos.putOi)} puts${pos.putCallOi != null ? `, put/call ${pos.putCallOi.toFixed(2)}` : ""}. By expiry: ${split(oi)}.`,
    );
  if (vol.total > 0)
    lines.push(
      `- **Volume** (session total at capture): ${compact(flow.callVolume)} calls / ${compact(flow.putVolume)} puts${flow.putCallVolume != null ? `, put/call ${flow.putCallVolume.toFixed(2)}` : ""}. By expiry: ${split(vol)}.${flow.turnover != null ? ` Turnover ${flow.turnover.toFixed(2)}x of open interest.` : ""}`,
    );
  if (pos.keyExpiry && pos.keyExpiry.oi > 0)
    lines.push(
      `- **Key expiry**: ${pos.keyExpiry.expiration} (${pos.keyExpiry.dte} days), ${compact(pos.keyExpiry.oi)} open interest${pos.maxPain != null ? `; max pain ${usd(pos.maxPain)} (${away(pos.maxPain)} from spot)` : ""}.`,
    );
  if (expected)
    lines.push(
      `- **Implied move** by ${expected.expiration}: about ±${usd(expected.amount)} (±${expected.pct.toFixed(1)}%), range ${usd(expected.low)} to ${usd(expected.high)}, from ${expected.method === "straddle" ? "the at-the-money straddle" : "implied volatility"}.`,
    );
  if (price.iv != null || price.hv != null || price.ivRank != null)
    lines.push(
      `- **Volatility**: ${[
        price.iv != null ? `implied ${(price.iv * 100).toFixed(0)}%` : null,
        price.hv != null ? `21-session realized ${(price.hv * 100).toFixed(0)}%` : null,
        price.ivRank != null ? `IV rank ${price.ivRank.toFixed(0)}` : null,
      ]
        .filter(Boolean)
        .join(", ")}.`,
    );

  if (summary.levels.length > 1) {
    lines.push("", "| Level | Price | vs spot | Basis |", "|---|---|---|---|");
    for (const level of summary.levels)
      lines.push(
        `| ${level.label} | ${usd(level.value)} | ${level.distancePct == null ? "" : signed(level.distancePct)} | ${level.note} |`,
      );
  }

  const detail = [
    ["Largest call open interest, all expiries", strikes(oi.bars, "call", 5)],
    ["Largest put open interest, all expiries", strikes(oi.bars, "put", 5)],
    ["Busiest call strikes this session", strikes(vol.bars, "call", 3)],
    ["Busiest put strikes this session", strikes(vol.bars, "put", 3)],
    [
      "Largest expiries by open interest",
      [...oiByExpiry.bars]
        .sort((a, b) => b.call + b.put - (a.call + a.put))
        .slice(0, 4)
        .filter((b) => b.call + b.put > 0)
        .map((b) => `${b.key} (${compact(b.call)} calls / ${compact(b.put)} puts)`)
        .join(", "),
    ],
    [
      `Volume above open interest (new positions, ${flow.freshCount} contract${flow.freshCount === 1 ? "" : "s"})`,
      flow.fresh
        .map((c) => `${c.expiration} ${usd(c.strike)} ${c.type} ${compact(c.volume)} traded vs ${compact(c.openInterest)} open`)
        .join("; "),
    ],
  ].filter(([, value]) => value);
  if (detail.length) lines.push("", ...detail.map(([label, value]) => `- ${label}: ${value}.`));
  if (summary.takeaways.length) lines.push("", "Read:", ...summary.takeaways.map((t) => `- ${t}`));
  lines.push(
    "",
    "Limits: this shows where contracts sit, not whether holders are long or short, and one session's volume is not a trend. Walls, max pain and the implied move are reference levels, not forecasts.",
  );
  const text = lines.join("\n");
  return {
    text: text.length > OPTION_BRIEF_MAX_CHARS ? text.slice(0, OPTION_BRIEF_MAX_CHARS - 1).trimEnd() + "…" : text,
    meta: {
      source,
      capturedAt: captured,
      ageDays,
      contracts: summary.contracts,
      spot,
      complete,
      thin: false,
    },
  };
}
