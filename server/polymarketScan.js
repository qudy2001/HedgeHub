import { buildStrategySummary } from "./strategyEngine.js";
import { buildEffectiveStrategyAssets } from "./strategyAssets.js";
import {
  describeAssetPolymarketStatus,
  refreshPolymarketResolutions,
  withResolvedPolymarketEvents
} from "./polymarketResolver.js";
import { fetchPolymarketMarketsFromEventPage, polymarketEventDay } from "./providers/polymarket.js";
import { fetchOptionChain, fetchQuotes } from "./providers/marketData.js";
import { parsePolymarketQuestionSignal } from "../shared/polymarketSignals.js";

// On-demand "Polymarket + options" scan for one ticker (e.g. NVDA), independent of the
// configured strategy assets: resolve the current monthly event, load its markets and the
// listed options around the thresholds, and build the Polymarket-leg + option-leg candidates.

const DAY_MS = 86_400_000;
const CACHE_MS = 60_000;
const MAX_ROWS = 40;
const cache = new Map();

export function normalizeScanSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : "";
}

function adHocAsset(symbol) {
  return buildEffectiveStrategyAssets([
    {
      id: symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: symbol,
      optionSymbol: symbol,
      underlyingSymbol: symbol,
      referenceSymbol: symbol,
      conversionFallback: 1,
      polymarketQueries: [`${symbol.toLowerCase()} hit`],
      isCustom: true,
      finderEnabled: true,
      screenerEnabled: false
    }
  ]).finderAssets.find((asset) => asset.optionSymbol === symbol);
}

function addDays(dateIso, days) {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value) => (Number.isFinite(Number(value)) && value != null ? Number(value) : null);

// Compact, display-ready row. Reward/risk and max profit are deliberately left out: the finder computes them
// on a price grid that starts at zero, which produces meaningless values until the scoring rebuild.
export function slimPolymarketHedgeRow(row, symbol) {
  const pm = (row.legs ?? []).find((leg) => leg.kind === "binary") ?? null;
  const options = (row.legs ?? []).filter((leg) => leg.kind === "option");
  const pmCost = pm ? (finite(pm.quantity) ?? 0) * (finite(pm.entryPrice) ?? 0) : 0;
  const optionDebit = options.reduce(
    (sum, leg) =>
      sum +
      (leg.action === "SHORT" ? -1 : 1) *
        (finite(leg.quantity) ?? 0) *
        (finite(leg.contractMultiplier) ?? 100) *
        (finite(leg.entryPrice) ?? 0),
    0
  );
  const signal = parsePolymarketQuestionSignal(row.polymarketQuestion);
  const spreads = options.map((leg) => finite(leg.spread)).filter((value) => value != null);
  const ivs = options.map((leg) => finite(leg.impliedVolatility)).filter((value) => value > 0);
  const openInterests = options.map((leg) => finite(leg.openInterest)).filter((value) => value != null);
  // Same 0-100 liquidity idea as the options table: tight spreads, open interest, quote quality; capped by the Polymarket book.
  const legScores = options.map((leg) => {
    const spread = finite(leg.spread) ?? 100;
    return (
      (clamp(100 - spread * 10, 0, 100) +
        clamp(((finite(leg.openInterest) ?? 0) / 500) * 100, 0, 100) +
        clamp(((finite(leg.volume) ?? 0) / 100) * 100, 0, 100) +
        (leg.hasRealBidAsk === true && leg.isLive === true ? 100 : 70)) /
      4
    );
  });
  const pmScore = clamp(((finite(row.polymarketLiquidity) ?? 0) / 5000) * 100, 0, 100);

  return {
    id: row.id,
    symbol,
    question: row.polymarketQuestion,
    marketUrl: row.polymarketUrl ?? null,
    pmSide: row.polymarketPriceSide ?? pm?.outcome ?? null,
    pmPrice: finite(row.polymarketPrice),
    pmYes: finite(row.polymarketPrice) == null ? null : (row.polymarketPriceSide ?? pm?.outcome) === "NO" ? 1 - finite(row.polymarketPrice) : finite(row.polymarketPrice),
    pmShares: finite(pm?.quantity),
    pmLiquidity: finite(row.polymarketLiquidity),
    pmVolume: finite(row.polymarketVolume),
    pmTrigger: row.polymarketTriggerType ?? signal?.triggerType ?? null,
    pmDirection: row.polymarketDirection ?? signal?.direction ?? null,
    pmResolves: row.polymarketResolutionDate ?? row.expiration ?? null,
    strategyType: row.strategyType,
    optionExpiry: row.optionExpiry ?? null,
    legs: options.map((leg) => ({
      action: leg.action === "SHORT" ? "Sell" : "Buy",
      quantity: finite(leg.quantity),
      optionType: leg.optionType ?? null,
      strike: finite(leg.strike),
      price: finite(leg.entryPrice),
      bid: finite(leg.bid),
      ask: finite(leg.ask),
      bidSize: finite(leg.bidSize),
      askSize: finite(leg.askSize),
      volume: finite(leg.volume),
      iv: finite(leg.impliedVolatility),
      spreadPct: finite(leg.spread),
      openInterest: finite(leg.openInterest),
      contract: leg.contractSymbol ?? null
    })),
    pmCost,
    optionDebit,
    maxLoss: row.maxLossUnbounded ? null : finite(row.maxLoss),
    breakevens: Array.isArray(row.breakevens) ? row.breakevens.map(Number).filter(Number.isFinite) : [],
    maxOptionSpreadPct: spreads.length ? Math.max(...spreads) : null,
    pmTarget: signal?.targetValue ?? null,
    avgIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
    minOpenInterest: openInterests.length ? Math.min(...openInterests) : null,
    quoted: options.length > 0 && options.every((leg) => leg.hasRealBidAsk === true && leg.isLive === true),
    liquidity: legScores.length ? Math.round(Math.min(...legScores, pmScore)) : null
  };
}

// Interim order until the score exists: tightest option spread first, then deepest Polymarket book.
function tradabilityOrder(left, right) {
  const leftSpread = left.maxOptionSpreadPct ?? Infinity;
  const rightSpread = right.maxOptionSpreadPct ?? Infinity;
  if (leftSpread !== rightSpread) {
    return leftSpread - rightSpread;
  }

  return (right.pmLiquidity ?? 0) - (left.pmLiquidity ?? 0);
}

export async function scanPolymarketHedgeForSymbol(rawSymbol, deps = {}) {
  const symbol = normalizeScanSymbol(rawSymbol);
  if (!symbol) {
    return { symbol: String(rawSymbol ?? ""), rows: [], notes: ["Enter a valid ticker symbol."] };
  }

  const cached = cache.get(symbol);
  if (!deps.force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }

  const {
    quotesFn = fetchQuotes,
    chainFn = fetchOptionChain,
    marketsFn = (url) => fetchPolymarketMarketsFromEventPage(url, { tradableOnly: true }),
    refreshFn = refreshPolymarketResolutions,
    summaryFn = buildStrategySummary,
    now = new Date()
  } = deps;
  const notes = [];

  const baseAsset = adHocAsset(symbol);
  await refreshFn([baseAsset]);
  const asset = withResolvedPolymarketEvents(baseAsset);
  const status = describeAssetPolymarketStatus(baseAsset);

  if (!asset.polymarketEventUrls?.length) {
    const value = {
      symbol,
      rows: [],
      notes: [status.reason ?? `No Polymarket monthly event found for ${symbol}.`]
    };
    cache.set(symbol, { at: Date.now(), value });
    return value;
  }

  const marketResults = await Promise.allSettled(asset.polymarketEventUrls.map((url) => marketsFn(url)));
  marketResults.forEach((result, index) => {
    if (result.status === "rejected") {
      notes.push(`Polymarket event ${asset.polymarketEventUrls[index]}: ${result.reason?.message ?? result.reason}`);
    }
  });
  const markets = marketResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (!markets.length) {
    const value = { symbol, rows: [], notes: [...notes, `No tradable Polymarket markets are open for ${symbol} right now.`] };
    cache.set(symbol, { at: Date.now(), value });
    return value;
  }

  const quotes = await quotesFn([{ symbol, sourceSymbol: `${symbol.toLowerCase()}.us`, provider: "stooq" }]);
  const spot = Number(quotes?.find((quote) => quote.symbol === symbol)?.regularMarketPrice ?? quotes?.[0]?.regularMarketPrice);
  if (!(spot > 0)) {
    throw new Error(`No stock price available for ${symbol}`);
  }

  const targets = markets
    .map((market) => parsePolymarketQuestionSignal(market.question)?.targetValue)
    .filter((value) => Number.isFinite(value) && value > 0);
  const days = markets.map((market) => polymarketEventDay(market.endDate)).filter(Boolean).sort();
  const today = now.toISOString().slice(0, 10);
  const from = (days[0] ?? today).slice(0, 8) + "01";
  const to = addDays(days.at(-1) ?? addDays(today, 30), 5);
  const strikeMin = Math.max(Math.min(...targets, spot) * 0.85, 1);
  const strikeMax = Math.max(...targets, spot) * 1.15;

  const chains = await Promise.all(
    ["call", "put"].map((optionType) =>
      chainFn({
        symbol,
        expirationFrom: from < today ? today : from,
        expirationTo: to,
        optionType,
        currentSpot: spot,
        strikeHint: Math.round(spot),
        strikeMin,
        strikeMax,
        limit: 150
      })
    )
  );
  const optionMatches = chains.flatMap((payload) => payload.contracts ?? []).map((contract) => ({
    contractSymbol: contract.contractSymbol,
    strike: contract.strike,
    expiration: contract.expiration,
    mark: contract.mark ?? null,
    lastPrice: contract.lastPrice ?? contract.mark ?? null,
    impliedVolatility: Number(contract.impliedVolatility ?? 0) || null,
    optionType: contract.optionType,
    bid: contract.bid,
    ask: contract.ask,
    bidSize: contract.bidSize ?? null,
    askSize: contract.askSize ?? null,
    volume: contract.volume ?? null,
    openInterest: contract.openInterest ?? null,
    exerciseStyle: contract.exerciseStyle ?? null,
    source: contract.source,
    sourceLabel: contract.sourceLabel,
    isLive: contract.isLive === true,
    hasRealBidAsk: contract.hasRealBidAsk === true,
    rootSymbol: symbol,
    assetId: asset.id,
    assetLabel: asset.label,
    underlyingSymbol: symbol,
    referenceSymbol: symbol
  }));
  if (!optionMatches.length) {
    notes.push(`No listed ${symbol} options were returned for the event window.`);
  }

  const summary = await summaryFn({ quotes, polymarketMarkets: markets, optionMatches, assetUniverse: [asset] });
  const all = (summary.finder?.rows ?? []).map((row) => ({ ...slimPolymarketHedgeRow(row, symbol), spot }));
  const rows = all.sort(tradabilityOrder).slice(0, MAX_ROWS);
  if (all.length > rows.length) {
    notes.push(`Showing ${rows.length} of ${all.length} candidates, tightest option spreads first.`);
  }
  if (!rows.length && optionMatches.length) {
    notes.push("Options and markets loaded, but no pairing matched the Polymarket thresholds.");
  }

  const value = {
    symbol,
    rows,
    total: all.length,
    spot,
    events: status.events.map((event) => ({ title: event.title, url: event.url, endDate: event.endDate })),
    notes
  };
  cache.set(symbol, { at: Date.now(), value });
  return value;
}

export function resetPolymarketScanCache() {
  cache.clear();
}
