import { pickOptionReferencePrice } from "./optionPricing.js";
import { buildPayoffSummary } from "./strategyEngine.js";

const DEFAULT_RISK_FREE_RATE = 0.0425;
const DEFAULT_EVENT_LIMIT = 12;
const DEFAULT_EVENT_WINDOW_DAYS = 14;
const MAX_DAYS_AFTER_EVENT = 14;

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const normalizedValue =
    typeof value === "number" ? new Date(value).toISOString() : String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)
    ? new Date(`${normalizedValue}T00:00:00.000Z`)
    : new Date(normalizedValue);

  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDate(value) {
  const date = parseIsoDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
}

function addDays(dateIso, days) {
  const date = parseIsoDate(dateIso);
  if (!date) {
    return "";
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function differenceInDays(leftValue, rightValue) {
  const left = parseIsoDate(leftValue);
  const right = parseIsoDate(rightValue);

  if (!left || !right) {
    return 0;
  }

  return Math.round((right.getTime() - left.getTime()) / (24 * 60 * 60 * 1000));
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function formatCurrencyCompact(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(numericValue) >= 1_000_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2
  }).format(numericValue);
}

function formatPercent(value, digits = 2) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? `${numericValue.toFixed(digits)}%` : "n/a";
}

function normalizeStooqStockSymbol(symbol) {
  return `${String(symbol ?? "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "-")}.us`;
}

function quoteLookup(quotes) {
  return new Map((quotes ?? []).map((quote) => [String(quote.symbol ?? "").trim().toUpperCase(), quote]));
}

function getQuotePrice(quote) {
  return Number(quote?.regularMarketPrice ?? 0);
}

function groupOptionsByExpiration(contracts) {
  return (contracts ?? []).reduce((groups, contract) => {
    const key = String(contract?.expiration ?? "").trim();
    if (!key) {
      return groups;
    }

    const current = groups.get(key) ?? [];
    current.push(contract);
    groups.set(key, current);
    return groups;
  }, new Map());
}

function pickNearestOption(options, targetStrike) {
  const candidates = [...(options ?? [])].filter((option) => Number(option?.strike) > 0);
  if (!candidates.length) {
    return null;
  }

  return candidates.sort((left, right) => {
    const leftDistance = Math.abs(Number(left.strike) - targetStrike);
    const rightDistance = Math.abs(Number(right.strike) - targetStrike);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }

    return Number(left.strike) - Number(right.strike);
  })[0];
}

function getLowerOption(options, anchorStrike) {
  return [...(options ?? [])].reverse().find((option) => Number(option?.strike) < anchorStrike) ?? null;
}

function getHigherOption(options, anchorStrike) {
  return [...(options ?? [])].find((option) => Number(option?.strike) > anchorStrike) ?? null;
}

function getOptionMidPrice(contract) {
  return Math.max(pickOptionReferencePrice(contract, 0), 0);
}

function getOptionBid(contract) {
  const bid = toNumber(contract?.bid, null);
  return bid != null && bid >= 0 ? bid : getOptionMidPrice(contract);
}

function getOptionAsk(contract) {
  const ask = toNumber(contract?.ask, null);
  return ask != null && ask >= 0 ? ask : getOptionMidPrice(contract);
}

function calculateSpreadPct(netBid, netAsk, referencePrice) {
  if (!(netAsk >= netBid) || !(referencePrice > 0)) {
    return null;
  }

  return ((netAsk - netBid) / Math.max(Math.abs(referencePrice), 0.01)) * 100;
}

function buildEventUniverse(events, {
  limit = DEFAULT_EVENT_LIMIT,
  maxDaysToEvent = DEFAULT_EVENT_WINDOW_DAYS,
  today = new Date()
} = {}) {
  const baseDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  return (events ?? [])
    .map((event) => {
      const eventDate = toIsoDate(event.timestamp);
      const daysToEvent = eventDate ? Math.max(differenceInDays(baseDate, eventDate), 0) : null;

      return {
        ...event,
        eventDate,
        daysToEvent
      };
    })
    .filter((event) => {
      return (
        event.shortSymbol &&
        event.eventDate &&
        event.isRecentRelease !== true &&
        Number.isFinite(event.daysToEvent) &&
        event.daysToEvent >= 0 &&
        event.daysToEvent <= maxDaysToEvent
      );
    })
    .sort((left, right) => {
      return (
        left.daysToEvent - right.daysToEvent ||
        Number(right.marketCapUsd ?? 0) - Number(left.marketCapUsd ?? 0) ||
        String(left.shortSymbol).localeCompare(String(right.shortSymbol))
      );
    })
    .slice(0, Math.max(limit, 1));
}

function computeLiquidityScore({ minOpenInterest, minVolume, netSpreadPct, hasRealBidAsk, isLive }) {
  const oiScore = clamp((Math.max(minOpenInterest, 0) / 1000) * 30, 0, 30);
  const volumeScore = clamp((Math.max(minVolume, 0) / 300) * 25, 0, 25);
  const spreadScore = netSpreadPct == null ? 10 : clamp(25 - netSpreadPct, 0, 25);
  const qualityScore = hasRealBidAsk ? 20 : isLive ? 12 : 6;

  return formatNumber(oiScore + volumeScore + spreadScore + qualityScore, 2);
}

function computeCompositeScore({
  creditToRiskPct,
  averageIvPct,
  liquidityScore,
  daysToEvent,
  marketCapUsd,
  netSpreadPct
}) {
  const premiumScore = clamp(creditToRiskPct * 1.1, 0, 45);
  const volatilityScore = clamp(averageIvPct * 0.25, 0, 25);
  const timingScore = clamp(14 - daysToEvent, 0, 14);
  const marketCapScore = clamp((Math.log10(Math.max(marketCapUsd, 1)) - 9) * 8, 0, 14);
  const spreadPenalty = netSpreadPct == null ? 0 : clamp(netSpreadPct * 0.6, 0, 18);

  return formatNumber(premiumScore + volatilityScore + Number(liquidityScore ?? 0) + timingScore + marketCapScore - spreadPenalty, 2);
}

function buildOptionLeg(contract, action, rootSymbol, riskFreeRate) {
  const referencePrice = getOptionMidPrice(contract);
  const bid = toNumber(contract?.bid, null);
  const ask = toNumber(contract?.ask, null);
  const spreadPct =
    bid != null && ask != null && referencePrice > 0
      ? ((ask - bid) / Math.max(referencePrice, 0.01)) * 100
      : null;

  return {
    contractSymbol: contract?.contractSymbol ?? "",
    rootSymbol,
    action,
    optionType: String(contract?.optionType ?? "call").toLowerCase() === "put" ? "put" : "call",
    strike: formatNumber(Number(contract?.strike), 2),
    expiration: String(contract?.expiration ?? ""),
    entryPrice: formatNumber(referencePrice, 4),
    bid: formatNumber(bid, 4),
    ask: formatNumber(ask, 4),
    spread: formatNumber(spreadPct, 2),
    bidSize: toNumber(contract?.bidSize, null),
    askSize: toNumber(contract?.askSize, null),
    volume: toNumber(contract?.volume, null),
    openInterest: toNumber(contract?.openInterest, null),
    impliedVolatility: formatNumber(Number(contract?.impliedVolatility ?? 0) || null, 4),
    contractMultiplier: 100,
    quantity: 1,
    quoteSource: contract?.sourceLabel ?? contract?.source ?? "Option chain",
    isLive: contract?.isLive === true,
    hasRealBidAsk: contract?.hasRealBidAsk === true
  };
}

function buildIronCondorForExpiry({
  event,
  quote,
  calls,
  puts,
  expiration,
  riskFreeRate = DEFAULT_RISK_FREE_RATE
}) {
  const spot = getQuotePrice(quote);
  if (!(spot > 0)) {
    return null;
  }

  const sortedCalls = [...(calls ?? [])].sort((left, right) => Number(left.strike) - Number(right.strike));
  const sortedPuts = [...(puts ?? [])].sort((left, right) => Number(left.strike) - Number(right.strike));
  if (sortedCalls.length < 3 || sortedPuts.length < 3) {
    return null;
  }

  const atmCall = pickNearestOption(sortedCalls, spot);
  const atmPut = pickNearestOption(sortedPuts, spot);
  if (!atmCall || !atmPut) {
    return null;
  }

  const atmStraddlePrice = getOptionMidPrice(atmCall) + getOptionMidPrice(atmPut);
  if (!(atmStraddlePrice > 0)) {
    return null;
  }

  const shortCallTarget = spot + atmStraddlePrice;
  const shortPutTarget = Math.max(spot - atmStraddlePrice, 0.01);
  const shortCall =
    sortedCalls.find((option) => Number(option.strike) >= shortCallTarget) ??
    pickNearestOption(sortedCalls, shortCallTarget);
  const shortPut =
    [...sortedPuts].reverse().find((option) => Number(option.strike) <= shortPutTarget) ??
    pickNearestOption(sortedPuts, shortPutTarget);

  if (!shortCall || !shortPut) {
    return null;
  }

  const longCall = getHigherOption(sortedCalls, Number(shortCall.strike));
  const longPut = getLowerOption(sortedPuts, Number(shortPut.strike));
  if (!longCall || !longPut) {
    return null;
  }

  const shortCallPrice = getOptionMidPrice(shortCall);
  const shortPutPrice = getOptionMidPrice(shortPut);
  const longCallPrice = getOptionMidPrice(longCall);
  const longPutPrice = getOptionMidPrice(longPut);
  const netCredit = shortCallPrice + shortPutPrice - longCallPrice - longPutPrice;
  if (!(netCredit > 0)) {
    return null;
  }

  const callWidth = Number(longCall.strike) - Number(shortCall.strike);
  const putWidth = Number(shortPut.strike) - Number(longPut.strike);
  const widestWing = Math.max(callWidth, putWidth);
  if (!(callWidth > 0) || !(putWidth > 0) || !(widestWing > netCredit)) {
    return null;
  }

  const maxProfitValue = netCredit * 100;
  const maxLossValue = (widestWing - netCredit) * 100;
  const averageIv =
    [shortCall, shortPut]
      .map((contract) => Number(contract?.impliedVolatility ?? 0))
      .filter((value) => value > 0)
      .reduce((sum, value, _index, array) => sum + value / array.length, 0) || 0.24;
  const netBid =
    getOptionBid(shortCall) +
    getOptionBid(shortPut) -
    getOptionAsk(longCall) -
    getOptionAsk(longPut);
  const netAsk =
    getOptionAsk(shortCall) +
    getOptionAsk(shortPut) -
    getOptionBid(longCall) -
    getOptionBid(longPut);
  const netSpreadPct = calculateSpreadPct(netBid, netAsk, netCredit);
  const hasRealBidAsk = [shortCall, shortPut, longCall, longPut].every((contract) => contract?.hasRealBidAsk === true);
  const isLive = [shortCall, shortPut, longCall, longPut].every((contract) => contract?.isLive === true);
  const minOpenInterest = Math.min(
    ...[shortCall, shortPut, longCall, longPut].map((contract) => Number(contract?.openInterest ?? 0) || 0)
  );
  const minVolume = Math.min(
    ...[shortCall, shortPut, longCall, longPut].map((contract) => Number(contract?.volume ?? 0) || 0)
  );
  const liquidityScore = computeLiquidityScore({
    minOpenInterest,
    minVolume,
    netSpreadPct,
    hasRealBidAsk,
    isLive
  });
  const breakevenLow = Number(shortPut.strike) - netCredit;
  const breakevenHigh = Number(shortCall.strike) + netCredit;
  const creditToRiskPct = (netCredit / Math.max(widestWing - netCredit, 0.01)) * 100;
  const daysAfterEvent = differenceInDays(event.eventDate, expiration);
  const compositeScore = computeCompositeScore({
    creditToRiskPct,
    averageIvPct: averageIv * 100,
    liquidityScore,
    daysToEvent: event.daysToEvent,
    marketCapUsd: Number(event.marketCapUsd ?? 0),
    netSpreadPct
  });
  const strategyCloseDate = expiration;
  const optionLegs = [
    buildOptionLeg(longPut, "LONG", event.shortSymbol, riskFreeRate),
    buildOptionLeg(shortPut, "SHORT", event.shortSymbol, riskFreeRate),
    buildOptionLeg(shortCall, "SHORT", event.shortSymbol, riskFreeRate),
    buildOptionLeg(longCall, "LONG", event.shortSymbol, riskFreeRate)
  ];
  const payoffLegs = optionLegs.map((leg) => ({
    kind: "option",
    action: leg.action,
    quantity: 1,
    entryPrice: Number(leg.entryPrice),
    optionType: leg.optionType,
    strike: Number(leg.strike),
    expiration: leg.expiration,
    contractMultiplier: 100,
    impliedVolatility: Number(leg.impliedVolatility ?? averageIv) || averageIv,
    riskFreeRate
  }));
  const payoffSummary = buildPayoffSummary({
    currentSpot: spot,
    targetSpot: spot,
    targetThreshold: spot,
    currentUnderlyingSpot: spot,
    conversionRatio: 1,
    strategyCloseDate,
    polymarketResolutionDate: strategyCloseDate,
    volatility: averageIv,
    riskFreeRate,
    legs: payoffLegs
  });
  const releaseSession = String(event.releaseSession ?? "Time TBA");
  const plannedExitDate = releaseSession.toLowerCase().includes("before") ? event.eventDate : addDays(event.eventDate, 1);

  return {
    id: `vol-crush-${event.shortSymbol.toLowerCase()}-${expiration.replace(/-/g, "")}`,
    symbol: event.shortSymbol,
    companyName: event.description ?? event.name ?? event.shortSymbol,
    assetLabel: event.shortSymbol,
    strategyType: "Iron Condor",
    eventDate: event.eventDate,
    releaseSession,
    plannedExitDate,
    expiration,
    daysToEvent: event.daysToEvent,
    daysToExpiry: Math.max(differenceInDays(new Date().toISOString().slice(0, 10), expiration), 0),
    daysAfterEvent,
    underlyingPrice: formatNumber(spot, 2),
    expectedMoveDollar: formatNumber(atmStraddlePrice, 2),
    expectedMovePct: formatNumber((atmStraddlePrice / spot) * 100, 2),
    breakevenLow: formatNumber(breakevenLow, 2),
    breakevenHigh: formatNumber(breakevenHigh, 2),
    netCredit: formatNumber(netCredit, 4),
    netBid: formatNumber(netBid, 4),
    netAsk: formatNumber(netAsk, 4),
    netSpreadPct: formatNumber(netSpreadPct, 2),
    maxProfit: formatNumber(payoffSummary.maxProfit ?? maxProfitValue, 2),
    maxLoss: formatNumber(payoffSummary.maxLoss ?? -maxLossValue, 2),
    maxProfitUnbounded: payoffSummary.maxProfitUnbounded === true,
    maxLossUnbounded: payoffSummary.maxLossUnbounded === true,
    rewardRisk: formatNumber(maxProfitValue / Math.max(maxLossValue, 0.01), 2),
    creditToRiskPct: formatNumber(creditToRiskPct, 2),
    liquidityScore,
    compositeScore,
    averageIv: formatNumber(averageIv, 4),
    averageIvPct: formatNumber(averageIv * 100, 2),
    marketCapUsd: formatNumber(Number(event.marketCapUsd ?? 0), 0),
    marketCapLabel: formatCurrencyCompact(event.marketCapUsd),
    earningsEstimate: toNumber(event.earningsEstimate, null),
    revenueEstimate: toNumber(event.revenueEstimate, null),
    quoteQuality: hasRealBidAsk ? "Live NBBO" : isLive ? "Live snapshot" : "Modeled",
    managementPlan:
      "Defined-risk earnings premium sale. Enter before the report, then plan to exit on the first session after earnings instead of waiting for expiry.",
    marketBias: "Range-bound",
    marketBiasTone: "range",
    payoffCurve: payoffSummary.payoffCurve,
    breakevens: payoffSummary.breakevens,
    marketContext: {
      proxySymbol: event.shortSymbol,
      underlyingSymbol: event.shortSymbol,
      currentProxySpot: formatNumber(spot, 2),
      currentUnderlyingSpot: formatNumber(spot, 2),
      conversionRatio: 1,
      targetUnderlyingValue: formatNumber(spot, 2),
      impliedVolatility: formatNumber(averageIv, 4),
      riskFreeRate: formatNumber(riskFreeRate, 4)
    },
    optionLegs,
    legs: optionLegs
  };
}

function buildBestCandidateForEvent({
  event,
  quote,
  callContracts,
  putContracts,
  riskFreeRate = DEFAULT_RISK_FREE_RATE
}) {
  const callByExpiration = groupOptionsByExpiration(callContracts);
  const putByExpiration = groupOptionsByExpiration(putContracts);
  const expiries = [...new Set([...callByExpiration.keys(), ...putByExpiration.keys()])]
    .filter((expiration) => {
      const daysAfterEvent = differenceInDays(event.eventDate, expiration);
      return daysAfterEvent >= 0 && daysAfterEvent <= MAX_DAYS_AFTER_EVENT;
    })
    .sort();

  const candidates = expiries
    .map((expiration) =>
      buildIronCondorForExpiry({
        event,
        quote,
        calls: callByExpiration.get(expiration) ?? [],
        puts: putByExpiration.get(expiration) ?? [],
        expiration,
        riskFreeRate
      })
    )
    .filter(Boolean);

  if (!candidates.length) {
    return null;
  }

  return candidates.sort((left, right) => {
    return (
      Number(right.compositeScore ?? 0) - Number(left.compositeScore ?? 0) ||
      Number(left.daysAfterEvent ?? 99) - Number(right.daysAfterEvent ?? 99) ||
      Number(right.creditToRiskPct ?? 0) - Number(left.creditToRiskPct ?? 0)
    );
  })[0];
}

export async function buildVolCrushEarningsScan({
  companyEvents = [],
  fetchQuotes,
  fetchOptionChain,
  limit = DEFAULT_EVENT_LIMIT,
  maxDaysToEvent = DEFAULT_EVENT_WINDOW_DAYS
}) {
  const warnings = [];
  const selectedEvents = buildEventUniverse(companyEvents, {
    limit,
    maxDaysToEvent
  });

  if (!selectedEvents.length) {
    return {
      generatedAt: new Date().toISOString(),
      warnings: ["No upcoming large-cap earnings events were available in the scan window."],
      summary: {
        eventsConsidered: 0,
        candidatesRanked: 0,
        liveQuoteCandidates: 0,
        modeledCandidates: 0
      },
      rows: [],
      selectedRowId: null
    };
  }

  const quoteItems = selectedEvents.map((event) => ({
    symbol: event.shortSymbol,
    label: event.shortSymbol,
    provider: "stooq",
    sourceSymbol: normalizeStooqStockSymbol(event.shortSymbol)
  }));
  const quotes = await fetchQuotes(quoteItems);
  const quotesBySymbol = quoteLookup(quotes);

  const candidateResults = await Promise.allSettled(
    selectedEvents.map(async (event) => {
      const quote = quotesBySymbol.get(String(event.shortSymbol).toUpperCase());
      const spot = getQuotePrice(quote);

      if (!(spot > 0)) {
        throw new Error(`No stock quote was returned for ${event.shortSymbol}`);
      }

      const [callChain, putChain] = await Promise.all([
        fetchOptionChain({
          symbol: event.shortSymbol,
          expirationFrom: event.eventDate,
          expirationTo: addDays(event.eventDate, MAX_DAYS_AFTER_EVENT),
          optionType: "call",
          currentSpot: spot,
          strikeHint: spot,
          limit: 120
        }),
        fetchOptionChain({
          symbol: event.shortSymbol,
          expirationFrom: event.eventDate,
          expirationTo: addDays(event.eventDate, MAX_DAYS_AFTER_EVENT),
          optionType: "put",
          currentSpot: spot,
          strikeHint: spot,
          limit: 120
        })
      ]);

      return buildBestCandidateForEvent({
        event,
        quote,
        callContracts: callChain?.contracts ?? [],
        putContracts: putChain?.contracts ?? []
      });
    })
  );

  const rows = candidateResults
    .flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return result.value ? [result.value] : [];
      }

      warnings.push(`${selectedEvents[index]?.shortSymbol ?? "Event"} scan skipped: ${result.reason.message}`);
      return [];
    })
    .sort((left, right) => {
      return (
        Number(right.compositeScore ?? 0) - Number(left.compositeScore ?? 0) ||
        Number(left.daysToEvent ?? 99) - Number(right.daysToEvent ?? 99) ||
        Number(right.liquidityScore ?? 0) - Number(left.liquidityScore ?? 0)
      );
    });

  const liveQuoteCandidates = rows.filter((row) => row.quoteQuality !== "Modeled").length;
  const modeledCandidates = rows.length - liveQuoteCandidates;

  if (rows.length && liveQuoteCandidates === 0) {
    warnings.push("Live option quotes were unavailable, so this scan is using modeled option chains.");
  }

  return {
    generatedAt: new Date().toISOString(),
    warnings,
    summary: {
      eventsConsidered: selectedEvents.length,
      candidatesRanked: rows.length,
      liveQuoteCandidates,
      modeledCandidates
    },
    filters: {
      sessions: [...new Set(rows.map((row) => row.releaseSession))],
      quoteQualities: [...new Set(rows.map((row) => row.quoteQuality))]
    },
    rows,
    selectedRowId: rows[0]?.id ?? null
  };
}
