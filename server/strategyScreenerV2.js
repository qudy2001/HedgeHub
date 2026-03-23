import {
  defaultStrategyConfig,
  strategyScreenerV2AssetUniverse
} from "./marketCatalog.js";
import { pickOptionReferencePrice } from "./optionPricing.js";
import { hasPublicPolymarketEvent, isTradablePolymarketMarket } from "./providers/polymarket.js";
import { parseTargetFromQuestion } from "./strategyEngine.js";

const MIN_POLYMARKET_PRICE = 0.1;
const MAX_POLYMARKET_PRICE = 0.9;
const MIN_DAYS_TO_EVENT = 3;
const MIN_POLYMARKET_VOLUME = 1000;
const MIN_OPTION_DAYS_REMAINING = 2;
const MAX_DAYS_AFTER_EVENT = 3;
const MAX_OPTION_SPREAD_PCT = 8;
const MIN_OPTION_VOLUME = 100;
const MIN_OPEN_INTEREST = 500;
const MIN_DEPTH_LEVELS = 3;
const EXIT_TICK_LIMIT = 2;
const CAPITAL_MULTIPLIER = 2;
const RISK_FREE_RATE = 0.0425;
const DEBUG_PROBABILITY_MISMATCH_THRESHOLD = 3;
const DEFAULT_EXECUTION_RISK_MAX = 20;
const DEFAULT_EXIT_LIQUIDITY_MIN = 10;
const DEFAULT_TOP_RESULT_LIMIT = 15;
const DEFAULT_EXPECTED_PRICE_RANGE = {
  min: 5,
  max: 10
};
const FALLBACK_VOLATILITY = {
  "btc-v2": 0.44,
  "eth-v2": 0.56,
  "gold-v2": 0.18,
  "oil-v2": 0.3,
  "stocks-xsp-v2": 0.22,
  "stocks-spx-v2": 0.22
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalCdf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));

  return 0.5 * (1 + sign * y);
}

function differenceInDays(leftDate, rightDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((rightDate.getTime() - leftDate.getTime()) / millisecondsPerDay);
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function quoteLookup(quotes) {
  return new Map((quotes ?? []).map((quote) => [quote.symbol, quote]));
}

function getQuotePrice(quote) {
  return Number(quote?.regularMarketPrice ?? quote?.price ?? 0);
}

function toDate(dateIso) {
  return dateIso ? new Date(`${dateIso}T00:00:00.000Z`) : null;
}

function addDays(dateIso, days) {
  const value = toDate(dateIso);
  if (!value) {
    return "";
  }

  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysUntil(dateIso, now = new Date()) {
  const targetDate = toDate(dateIso);
  if (!targetDate) {
    return null;
  }

  const currentDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.max(differenceInDays(currentDate, targetDate), 0);
}

function getMidPrice(contract) {
  return pickOptionReferencePrice(contract, 0);
}

function getSpreadPct(contract) {
  const bid = Number(contract?.bid ?? 0);
  const ask = Number(contract?.ask ?? 0);
  const mid = getMidPrice(contract);
  if (!(bid > 0 && ask > 0 && mid > 0)) {
    return null;
  }

  return ((ask - bid) / mid) * 100;
}

function getTickSize(price) {
  if (price >= 10) {
    return 0.1;
  }

  if (price >= 3) {
    return 0.05;
  }

  return 0.01;
}

function estimateDepthLevels(contract) {
  const bidSize = Number(contract?.bidSize ?? 0);
  const askSize = Number(contract?.askSize ?? 0);
  const openInterest = Number(contract?.openInterest ?? 0);
  const volume = Number(contract?.volume ?? 0);
  const visibleSize = Math.min(bidSize, askSize);
  let levels = 0;

  if (visibleSize >= 10) {
    levels += 1;
  }
  if (visibleSize >= 25) {
    levels += 1;
  }
  if (visibleSize >= 50 || volume >= 250) {
    levels += 1;
  }
  if (visibleSize >= 100 || openInterest >= 2000) {
    levels += 1;
  }

  return levels;
}

function simulateExit(contract, quantity = 1) {
  const spreadPct = getSpreadPct(contract);
  const bid = Number(contract?.bid ?? 0);
  const ask = Number(contract?.ask ?? 0);
  const mid = getMidPrice(contract);
  const tickSize = getTickSize(mid);
  const spreadTicks = tickSize > 0 && ask > bid ? (ask - bid) / tickSize : Infinity;
  const visibleSize = Math.min(Number(contract?.bidSize ?? 0), Number(contract?.askSize ?? 0));
  const slippageTicks = Number.isFinite(spreadTicks) ? Math.max(Math.ceil(spreadTicks / 2) - 1, 0) : EXIT_TICK_LIMIT + 2;
  const canExit = visibleSize >= quantity && slippageTicks <= EXIT_TICK_LIMIT && (spreadPct ?? Infinity) <= MAX_OPTION_SPREAD_PCT;

  return {
    canExit,
    slippageTicks,
    spreadTicks: Number.isFinite(spreadTicks) ? formatNumber(spreadTicks, 2) : null
  };
}

function optionImpliedProbability({
  spot,
  strike,
  expiration,
  impliedVolatility,
  riskFreeRate = RISK_FREE_RATE
}) {
  const timeYears = Math.max(daysUntil(expiration) / 365, 1 / 365);
  const volatility = Number(impliedVolatility ?? 0);

  if (!(spot > 0) || !(strike > 0) || !(volatility > 0) || !(timeYears > 0)) {
    return null;
  }

  const sqrtT = Math.sqrt(timeYears);
  const d2 =
    (Math.log(spot / strike) + (riskFreeRate - 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);

  return clamp(normalCdf(d2), 0.001, 0.999);
}

function priceOptionAtScenario({
  spot,
  strike,
  optionType,
  evaluationDate,
  expiration,
  impliedVolatility,
  riskFreeRate = RISK_FREE_RATE
}) {
  const evaluation = toDate(evaluationDate);
  const expiry = toDate(expiration);
  if (!(spot > 0) || !(strike > 0) || !expiry || !evaluation) {
    return 0;
  }

  const remainingDays = Math.max(differenceInDays(evaluation, expiry), 0);
  if (remainingDays <= 0) {
    return optionType === "put" ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  }

  const volatility = Number(impliedVolatility ?? 0) || 0.24;
  const timeYears = Math.max(remainingDays / 365, 1 / 365);
  const sqrtT = Math.sqrt(timeYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeYears);

  if (optionType === "put") {
    return discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1);
  }

  return spot * normalCdf(d1) - discountedStrike * normalCdf(d2);
}

function buildEventSpots(currentSpot, targetSpot) {
  const normalizedCurrent = Math.max(currentSpot, 0.01);
  const normalizedTarget = Math.max(targetSpot, normalizedCurrent * 0.8, 0.01);
  const movePct = Math.max(Math.abs(normalizedTarget - normalizedCurrent) / normalizedCurrent, 0.03);

  return {
    happens: Math.max(normalizedTarget * 1.01, normalizedCurrent * (1 + movePct)),
    fails: Math.max(Math.min(normalizedTarget * 0.99, normalizedCurrent * (1 - movePct)), 0.01)
  };
}

function estimateScenarioPnl({
  polymarketLeg,
  optionLegs,
  eventOccurs,
  spot,
  eventDate,
  targetSpot
}) {
  const polymarketPnl = polymarketLeg
    ? polymarketLeg.quantity *
      ((polymarketLeg.side === "YES" ? (eventOccurs ? 1 : 0) : eventOccurs ? 0 : 1) - polymarketLeg.entryPrice)
    : 0;
  const optionPnl = optionLegs.reduce((sum, leg) => {
    const mark = priceOptionAtScenario({
      spot,
      strike: leg.strike,
      optionType: leg.optionType,
      evaluationDate: eventDate,
      expiration: leg.expiration,
      impliedVolatility: leg.impliedVolatility
    });
    const perContract = leg.action === "LONG" ? mark - leg.entryPrice : leg.entryPrice - mark;
    return sum + perContract * leg.quantity * 100;
  }, 0);

  return {
    total: polymarketPnl + optionPnl,
    polymarket: polymarketPnl,
    options: optionPnl,
    targetSpot
  };
}

function buildExpectedRangeProfile(position, currentSpot, targetSpot, eventDate) {
  const points = [];

  for (let pct = -20; pct <= 20; pct += 1) {
    const spot = Math.max(currentSpot * (1 + pct / 100), 0.01);
    points.push({
      pct,
      pnl: formatNumber(
        estimateScenarioPnl({
          polymarketLeg: position.polymarketLeg,
          optionLegs: position.optionLegs,
          eventOccurs: spot >= targetSpot,
          spot,
          eventDate,
          targetSpot
        }).total,
        2
      )
    });
  }

  return points;
}

function getRangePayoff(profile, minPct, maxPct) {
  const matching = profile.filter((point) => point.pct >= minPct && point.pct <= maxPct && point.pnl != null);
  if (!matching.length) {
    return null;
  }

  const values = matching.map((point) => Number(point.pnl));
  return {
    min: Math.min(...values),
    max: Math.max(...values)
  };
}

function getPolymarketMarketsForAsset(asset, polymarketMarkets) {
  return (polymarketMarkets ?? []).filter((market) => {
    if (!market?.question || !isTradablePolymarketMarket(market) || !hasPublicPolymarketEvent(market)) {
      return false;
    }

    const yesPrice = Number(market?.yesPrice ?? 0);
    const targetValue = parseTargetFromQuestion(market.question);
    const volume = Number(market?.volume ?? 0);
    const daysToResolution = daysUntil(String(market?.endDate ?? "").slice(0, 10));
    const question = market.question.toLowerCase();

    return (
      yesPrice > MIN_POLYMARKET_PRICE &&
      yesPrice < MAX_POLYMARKET_PRICE &&
      Number.isFinite(targetValue) &&
      targetValue > 0 &&
      Number.isFinite(volume) &&
      volume >= MIN_POLYMARKET_VOLUME &&
      Number.isFinite(daysToResolution) &&
      daysToResolution >= MIN_DAYS_TO_EVENT &&
      asset.polymarketQueries.some((query) => question.includes(query.split(" ")[0]))
    );
  });
}

function enrichContracts(contracts, currentSpot, fallbackVolatility) {
  return contracts.map((contract) => {
    const impliedVolatility = Number(contract.impliedVolatility ?? 0) || fallbackVolatility;
    const probability = optionImpliedProbability({
      spot: currentSpot,
      strike: contract.strike,
      expiration: contract.expiration,
      impliedVolatility
    });
    const spreadPct = getSpreadPct(contract);
    const depthLevels = estimateDepthLevels(contract);
    const exitSimulation = simulateExit(contract, 1);

    return {
      ...contract,
      impliedVolatility,
      optionProbability: probability,
      spreadPct,
      depthLevels,
      exitSimulation
    };
  });
}

function hasTradableOptionQuote(contract) {
  const bid = Number(contract?.bid ?? 0);
  const ask = Number(contract?.ask ?? 0);

  return contract?.isLive === true && contract?.hasRealBidAsk === true && bid > 0 && ask > 0;
}

function selectMatchedCall(calls, polymarketProbability) {
  return [...calls]
    .filter((contract) => Number.isFinite(contract.optionProbability))
    .sort((left, right) => {
      const leftDistance = Math.abs(left.optionProbability - polymarketProbability);
      const rightDistance = Math.abs(right.optionProbability - polymarketProbability);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      return Math.abs(left.strike - right.strike);
    })[0] ?? null;
}

function findNearestContract(contracts, predicate, sortFn) {
  return [...contracts].filter(predicate).sort(sortFn)[0] ?? null;
}

function buildOptionLeg(contract, action, quantity) {
  return {
    contractSymbol: contract.contractSymbol,
    action,
    quantity,
    contractMultiplier: 100,
    strike: Number(contract.strike),
    expiration: contract.expiration,
    optionType: contract.optionType,
    entryPrice: getMidPrice(contract),
    impliedVolatility: contract.impliedVolatility,
    riskFreeRate: RISK_FREE_RATE,
    bid: Number(contract.bid ?? 0),
    ask: Number(contract.ask ?? 0),
    bidSize: Number(contract.bidSize ?? 0),
    askSize: Number(contract.askSize ?? 0),
    spreadPct: contract.spreadPct,
    volume: Number(contract.volume ?? 0),
    openInterest: Number(contract.openInterest ?? 0),
    depthLevels: Number(contract.depthLevels ?? 0),
    rootSymbol: contract.rootSymbol,
    hasRealBidAsk: contract.hasRealBidAsk === true,
    isLive: contract.isLive === true,
    quoteSource: contract.isLive === true ? "live" : "modeled"
  };
}

function estimateOptionExposure(optionLegs, currentSpot) {
  const calls = optionLegs.filter((leg) => leg.optionType === "call");
  const puts = optionLegs.filter((leg) => leg.optionType === "put");
  const premiumExposure = optionLegs.reduce((sum, leg) => sum + Math.abs(leg.entryPrice * leg.quantity * 100), 0);
  const protectedCallWidth =
    calls.length >= 2
      ? (Math.max(...calls.map((leg) => leg.strike)) - Math.min(...calls.map((leg) => leg.strike))) *
        100 *
        Math.max(...calls.map((leg) => leg.quantity))
      : 0;
  const protectedPutWidth =
    puts.length >= 2
      ? (Math.max(...puts.map((leg) => leg.strike)) - Math.min(...puts.map((leg) => leg.strike))) *
        100 *
        Math.max(...puts.map((leg) => leg.quantity))
      : 0;
  const nakedShortExposure = optionLegs
    .filter((leg) => leg.action === "SHORT")
    .reduce((sum, leg) => {
      const hasProtection = optionLegs.some(
        (candidate) =>
          candidate.optionType === leg.optionType &&
          candidate.action === "LONG" &&
          candidate.quantity >= leg.quantity &&
          (leg.optionType === "call" ? candidate.strike >= leg.strike : candidate.strike <= leg.strike)
      );

      if (hasProtection) {
        return sum;
      }

      return sum + Math.max(currentSpot, leg.strike) * leg.quantity * 100 * 0.2;
    }, 0);

  return Math.max(premiumExposure, protectedCallWidth + protectedPutWidth, nakedShortExposure, 1);
}

function evaluatePosition({
  name,
  strategyClass,
  asset,
  market,
  currentSpot,
  currentUnderlyingSpot,
  conversionRatio,
  targetSpot,
  targetUnderlyingValue,
  polymarketProbability,
  optionProbability,
  polymarketLeg,
  optionLegs,
  executionRiskScore,
  exitLiquidityScore,
  settlementType,
  exerciseStyle
}) {
  const eventDate = String(market.endDate ?? "").slice(0, 10);
  const { happens, fails } = buildEventSpots(currentSpot, targetSpot);
  const eventScenario = estimateScenarioPnl({
    polymarketLeg,
    optionLegs,
    eventOccurs: true,
    spot: happens,
    eventDate,
    targetSpot
  });
  const failScenario = estimateScenarioPnl({
    polymarketLeg,
    optionLegs,
    eventOccurs: false,
    spot: fails,
    eventDate,
    targetSpot
  });
  const consensusProbability = clamp((polymarketProbability + optionProbability) / 2, 0.05, 0.95);
  const expectedValue = consensusProbability * eventScenario.total + (1 - consensusProbability) * failScenario.total;
  const worstScenarioLoss = Math.min(eventScenario.total, failScenario.total, 0);
  const tailRiskProbability = eventScenario.total < failScenario.total ? consensusProbability : 1 - consensusProbability;
  const pinRisk = hasPinRisk(optionLegs, currentSpot);
  const assignmentRisk = hasAssignmentRisk(optionLegs, currentSpot, settlementType, exerciseStyle);
  const capitalExposure = Math.max(
    Math.abs(polymarketLeg.quantity * polymarketLeg.entryPrice),
    estimateOptionExposure(optionLegs, currentSpot),
    1
  );
  const hedgeQualityScore = (() => {
    if (eventScenario.total >= 0 && failScenario.total >= 0) {
      return 100;
    }

    const positiveScenario = Math.max(eventScenario.total, failScenario.total, 0);
    const negativeScenario = Math.abs(Math.min(eventScenario.total, failScenario.total, 0));
    if (positiveScenario <= 0) {
      return 0;
    }

    return clamp((positiveScenario / Math.max(negativeScenario, 1)) * 50, 0, 100);
  })();
  const tailRiskScore = Math.abs(worstScenarioLoss) * tailRiskProbability;
  const expectedValuePct = (expectedValue / capitalExposure) * 100;
  const edgeMagnitudePct = Math.abs(polymarketProbability - optionProbability) * 100;
  const probabilityEdgeScore = clamp(edgeMagnitudePct * 10, 0, 100);
  const expectedValueScore = clamp(expectedValuePct * 2, -100, 100);
  const liquidityScore = clamp(exitLiquidityScore, 0, 100);
  const executionCostScore = clamp(executionRiskScore * 5 + (pinRisk ? 12 : 0) + (assignmentRisk ? 18 : 0), 0, 100);
  const hedgeQualityScoreNormalized = clamp(hedgeQualityScore, 0, 100);
  const compositeScore =
    probabilityEdgeScore * 0.4 +
    expectedValueScore * 0.25 +
    liquidityScore * 0.15 -
    executionCostScore * 0.1 +
    hedgeQualityScoreNormalized * 0.1 -
    tailRiskScore * 0.02 +
    (settlementType === "cash" ? 4 : 0) +
    (asset.preferenceRank === 1 ? 2 : 0);
  const expectedRangeProfile = buildExpectedRangeProfile(
    {
      polymarketLeg,
      optionLegs
    },
    currentSpot,
    targetSpot,
    eventDate
  );
  const defaultRangePayoff = getRangePayoff(
    expectedRangeProfile,
    DEFAULT_EXPECTED_PRICE_RANGE.min,
    DEFAULT_EXPECTED_PRICE_RANGE.max
  );
  const failureReason = (() => {
    const failureCandidates = [
      {
        label: "liquidity_fail",
        severity: Math.max(DEFAULT_EXIT_LIQUIDITY_MIN - liquidityScore, 0)
      },
      {
        label: "execution_fail",
        severity: Math.max(executionRiskScore - DEFAULT_EXECUTION_RISK_MAX, 0) + (pinRisk ? 2 : 0) + (assignmentRisk ? 3 : 0)
      },
      {
        label: "hedge_fail",
        severity: Math.max(45 - hedgeQualityScore, 0)
      },
      {
        label: "mismatch_fail",
        severity: Math.max(DEBUG_PROBABILITY_MISMATCH_THRESHOLD - edgeMagnitudePct, 0)
      }
    ].sort((left, right) => right.severity - left.severity);

    return failureCandidates[0]?.severity > 0 ? failureCandidates[0].label : null;
  })();

  return {
    id: [
      asset.id,
      market.id,
      strategyClass.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      optionLegs.map((leg) => `${leg.action}-${leg.optionType}-${leg.strike}-${leg.expiration}`).join("_")
    ].join(":"),
    assetId: asset.id,
    assetLabel: asset.label,
    optionRootSymbol: asset.optionSymbol,
    referenceSymbol: asset.referenceSymbol,
    marketQuestion: market.question,
    polymarketMarketId: market.id,
    polymarketUrl: market.url,
    strategyName: name,
    strategyClass,
    eventDate,
    optionExpiry: optionLegs[0]?.expiration ?? eventDate,
    strategyCloseDate: [eventDate, optionLegs[0]?.expiration ?? ""].filter(Boolean).sort()[0] ?? eventDate,
    daysToEvent: daysUntil(eventDate),
    daysToExpiry: daysUntil(optionLegs[0]?.expiration ?? eventDate),
    settlementType,
    exerciseStyle,
    polymarketProbability: formatNumber(polymarketProbability * 100, 2),
    optionImpliedProbability: formatNumber(optionProbability * 100, 2),
    probabilityMismatchPct: formatNumber((polymarketProbability - optionProbability) * 100, 2),
    probabilityEdgeScore: formatNumber(probabilityEdgeScore, 2),
    expectedValue: formatNumber(expectedValue, 2),
    expectedValueScore: formatNumber(expectedValueScore, 2),
    executionRiskScore: formatNumber(executionRiskScore, 2),
    executionCostScore: formatNumber(executionCostScore, 2),
    exitLiquidityScore: formatNumber(exitLiquidityScore, 2),
    liquidityScore: formatNumber(liquidityScore, 2),
    hedgeQualityScore: formatNumber(hedgeQualityScore, 2),
    tailRiskScore: formatNumber(tailRiskScore, 2),
    capitalExposure: formatNumber(capitalExposure, 2),
    maxLossValue: formatNumber(Math.abs(worstScenarioLoss), 2),
    pinRisk,
    assignmentRisk,
    failureReason,
    scenarioEventPnL: formatNumber(eventScenario.total, 2),
    scenarioFailPnL: formatNumber(failScenario.total, 2),
    defaultRangePayoffMin: defaultRangePayoff?.min != null ? formatNumber(defaultRangePayoff.min, 2) : null,
    defaultRangePayoffMax: defaultRangePayoff?.max != null ? formatNumber(defaultRangePayoff.max, 2) : null,
    compositeScore: formatNumber(compositeScore, 2),
    marketContext: {
      proxySymbol: asset.optionSymbol,
      underlyingSymbol: asset.underlyingSymbol,
      currentProxySpot: formatNumber(currentSpot, 4),
      currentUnderlyingSpot: formatNumber(currentUnderlyingSpot, 4),
      conversionRatio: formatNumber(conversionRatio, 8),
      targetProxySpot: formatNumber(targetSpot, 4),
      targetUnderlyingValue: formatNumber(targetUnderlyingValue, 4),
      marketReferenceYesPrice: formatNumber(polymarketProbability, 4),
      impliedVolatility: formatNumber(optionLegs[0]?.impliedVolatility ?? 0.24, 4),
      riskFreeRate: formatNumber(RISK_FREE_RATE, 4)
    },
    polymarketLeg,
    optionLegs,
    expectedRangeProfile
  };
}

function chooseBestQuantity(buildCandidate, maxQuantity = 12) {
  const candidates = [];

  for (let quantity = 1; quantity <= maxQuantity; quantity += 1) {
    const candidate = buildCandidate(quantity);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates.sort((left, right) => (right.compositeScore ?? -Infinity) - (left.compositeScore ?? -Infinity))[0] ?? null;
}

function calculateExecutionRisk(optionContracts) {
  const spreadCost = optionContracts.reduce((sum, contract) => sum + Number(contract.spreadPct ?? 0), 0);
  const slippageCost = optionContracts.reduce((sum, contract) => sum + Number(contract.exitSimulation?.slippageTicks ?? 0), 0);
  return spreadCost + slippageCost * 1.5;
}

function calculateExitLiquidityScore(optionContracts) {
  if (!optionContracts.length) {
    return 0;
  }

  const averageDepth = optionContracts.reduce((sum, contract) => sum + Number(contract.depthLevels ?? 0), 0) / optionContracts.length;
  const averageOpenInterest =
    optionContracts.reduce((sum, contract) => sum + Number(contract.openInterest ?? 0), 0) / optionContracts.length;
  const averageVolume = optionContracts.reduce((sum, contract) => sum + Number(contract.volume ?? 0), 0) / optionContracts.length;
  const averageSpread = optionContracts.reduce((sum, contract) => sum + Number(contract.spreadPct ?? 0), 0) / optionContracts.length;

  return clamp(averageDepth * 18 + averageVolume / 20 + averageOpenInterest / 40 - averageSpread * 4, 0, 100);
}

function hasPinRisk(contracts, currentSpot) {
  return contracts.some((contract) => Math.abs(Number(contract.strike) - currentSpot) / Math.max(currentSpot, 1) < 0.01);
}

function hasAssignmentRisk(contracts, currentSpot, settlementType, exerciseStyle) {
  if (settlementType === "cash" || exerciseStyle === "european") {
    return false;
  }

  return contracts.some((contract) => {
    if (contract.action !== "SHORT") {
      return false;
    }

    return contract.optionType === "put" ? currentSpot < contract.strike : currentSpot > contract.strike;
  });
}

function meetsCapitalLimit(position, capitalLimit) {
  const maxLossValue = Number(position?.maxLossValue ?? Infinity);
  return Number.isFinite(maxLossValue) && maxLossValue <= capitalLimit;
}

function buildStrategyA({
  asset,
  market,
  currentSpot,
  currentUnderlyingSpot,
  conversionRatio,
  targetSpot,
  targetUnderlyingValue,
  polymarketProbability,
  optionProbability,
  matchedCall,
  puts,
  capitalLimit
}) {
  const expiry = matchedCall.expiration;
  const expiryPuts = puts.filter((contract) => contract.expiration === expiry);
  const longPut = findNearestContract(
    expiryPuts,
    (contract) => Number(contract.strike) >= Math.max(matchedCall.strike, currentSpot * 0.99),
    (left, right) => left.strike - right.strike
  );
  if (!longPut) {
    return null;
  }

  const shortPut = findNearestContract(
    expiryPuts,
    (contract) => Number(contract.strike) < Number(longPut.strike),
    (left, right) => Math.abs(left.strike - matchedCall.strike) - Math.abs(right.strike - matchedCall.strike)
  );
  if (!shortPut) {
    return null;
  }

  const position = chooseBestQuantity((quantity) => {
    const polymarketLeg = {
      side: "YES",
      entryPrice: polymarketProbability,
      quantity: Math.max(1, Math.round((defaultStrategyConfig.yesLeg?.allocation ?? 1000) / polymarketProbability))
    };
    const optionLegs = [buildOptionLeg(longPut, "LONG", quantity), buildOptionLeg(shortPut, "SHORT", quantity)];
    const executionRiskScore = calculateExecutionRisk([longPut, shortPut]);
    const exitLiquidityScore = calculateExitLiquidityScore([longPut, shortPut]);

    return evaluatePosition({
      name: "Strategy A",
      strategyClass: "Directional Edge Capture",
      asset,
      market,
      currentSpot,
      currentUnderlyingSpot,
      conversionRatio,
      targetSpot,
      targetUnderlyingValue,
      polymarketProbability,
      optionProbability,
      polymarketLeg,
      optionLegs,
      executionRiskScore,
      exitLiquidityScore,
      settlementType: asset.settlementType,
      exerciseStyle: asset.exerciseStyle
    });
  });

  if (!position) {
    return null;
  }

  return meetsCapitalLimit(position, capitalLimit) ? position : null;
}

function buildStrategyB({
  asset,
  market,
  currentSpot,
  currentUnderlyingSpot,
  conversionRatio,
  targetSpot,
  targetUnderlyingValue,
  polymarketProbability,
  optionProbability,
  matchedCall,
  calls,
  capitalLimit
}) {
  const expiry = matchedCall.expiration;
  const expiryCalls = calls.filter((contract) => contract.expiration === expiry);
  const longCall = findNearestContract(
    expiryCalls,
    (contract) => Number(contract.strike) <= matchedCall.strike,
    (left, right) => Math.abs(left.strike - matchedCall.strike) - Math.abs(right.strike - matchedCall.strike)
  );
  if (!longCall) {
    return null;
  }

  const shortCall = findNearestContract(
    expiryCalls,
    (contract) => Number(contract.strike) > Number(longCall.strike),
    (left, right) => left.strike - right.strike
  );
  if (!shortCall) {
    return null;
  }

  const polymarketNoPrice = clamp(1 - polymarketProbability, 0.001, 0.999);
  const position = chooseBestQuantity((quantity) => {
    const polymarketLeg = {
      side: "NO",
      entryPrice: polymarketNoPrice,
      quantity: Math.max(1, Math.round((defaultStrategyConfig.yesLeg?.allocation ?? 1000) / polymarketNoPrice))
    };
    const optionLegs = [buildOptionLeg(longCall, "LONG", quantity), buildOptionLeg(shortCall, "SHORT", quantity)];
    const executionRiskScore = calculateExecutionRisk([longCall, shortCall]);
    const exitLiquidityScore = calculateExitLiquidityScore([longCall, shortCall]);

    return evaluatePosition({
      name: "Strategy B",
      strategyClass: "Reverse Edge",
      asset,
      market,
      currentSpot,
      currentUnderlyingSpot,
      conversionRatio,
      targetSpot,
      targetUnderlyingValue,
      polymarketProbability,
      optionProbability,
      polymarketLeg,
      optionLegs,
      executionRiskScore,
      exitLiquidityScore,
      settlementType: asset.settlementType,
      exerciseStyle: asset.exerciseStyle
    });
  });

  if (!position) {
    return null;
  }

  return meetsCapitalLimit(position, capitalLimit) ? position : null;
}

function buildStrategyC({
  asset,
  market,
  currentSpot,
  currentUnderlyingSpot,
  conversionRatio,
  targetSpot,
  targetUnderlyingValue,
  polymarketProbability,
  optionProbability,
  matchedCall,
  calls,
  puts,
  capitalLimit
}) {
  const expiry = matchedCall.expiration;
  const expiryCalls = calls.filter((contract) => contract.expiration === expiry);
  const expiryPuts = puts.filter((contract) => contract.expiration === expiry);
  const shortCall = findNearestContract(
    expiryCalls,
    (contract) => Number(contract.strike) >= Math.max(targetSpot, currentSpot * 1.02),
    (left, right) => left.strike - right.strike
  );
  const shortPut = findNearestContract(
    expiryPuts,
    (contract) => Number(contract.strike) <= currentSpot * 0.98,
    (left, right) => right.strike - left.strike
  );

  if (!shortCall || !shortPut) {
    return null;
  }

  const longCallWing = findNearestContract(
    expiryCalls,
    (contract) => Number(contract.strike) > Number(shortCall.strike),
    (left, right) => left.strike - right.strike
  );
  const longPutWing = findNearestContract(
    expiryPuts,
    (contract) => Number(contract.strike) < Number(shortPut.strike),
    (left, right) => right.strike - left.strike
  );
  const useIronCondor = Boolean(longCallWing && longPutWing);
  if (!useIronCondor && asset.settlementType !== "cash") {
    return null;
  }

  const polymarketLeg = {
    side: "YES",
    entryPrice: polymarketProbability,
    quantity: Math.max(1, Math.round((defaultStrategyConfig.yesLeg?.allocation ?? 500) / polymarketProbability))
  };
  const position = chooseBestQuantity((quantity) => {
    const optionLegs = [
      buildOptionLeg(shortPut, "SHORT", quantity),
      buildOptionLeg(shortCall, "SHORT", quantity),
      ...(useIronCondor
        ? [buildOptionLeg(longPutWing, "LONG", quantity), buildOptionLeg(longCallWing, "LONG", quantity)]
        : [])
    ];
    const contracts = [shortPut, shortCall, ...(useIronCondor ? [longPutWing, longCallWing] : [])];
    const executionRiskScore = calculateExecutionRisk(contracts);
    const exitLiquidityScore = calculateExitLiquidityScore(contracts);

    return evaluatePosition({
      name: "Strategy C",
      strategyClass: useIronCondor ? "Volatility Arbitrage (Iron Condor)" : "Volatility Arbitrage (Short Strangle)",
      asset,
      market,
      currentSpot,
      currentUnderlyingSpot,
      conversionRatio,
      targetSpot,
      targetUnderlyingValue,
      polymarketProbability,
      optionProbability,
      polymarketLeg,
      optionLegs,
      executionRiskScore,
      exitLiquidityScore,
      settlementType: asset.settlementType,
      exerciseStyle: asset.exerciseStyle
    });
  }, useIronCondor ? 8 : 4);

  if (!position) {
    return null;
  }

  return meetsCapitalLimit(position, capitalLimit) ? position : null;
}

export function buildStrategyScreenerV2({
  quotes,
  polymarketMarkets,
  optionMatches
}) {
  const quoteMap = quoteLookup(quotes);
  const rows = [];
  const assumptions = [
    "Polymarket event liquidity uses a minimum volume threshold of 1000.",
    "Depth is estimated conservatively from displayed quote size, volume, and open interest because full order-book levels are not available in the live snapshot.",
    "Assignment risk is treated as elevated for physical/American short legs that are already in the money at the current spot.",
    "Expected value is weighted by the midpoint of Polymarket and options-implied probabilities to avoid assuming either market is fully correct.",
    "V2 now scores imperfect candidates and returns the top-ranked set instead of hard-discarding them for weak mismatch, execution, or hedge metrics."
  ];
  const warnings = [];
  const capitalLimit = (defaultStrategyConfig.bankroll ?? 2000) * CAPITAL_MULTIPLIER;

  for (const asset of strategyScreenerV2AssetUniverse) {
    const currentOptionSpot = getQuotePrice(quoteMap.get(asset.optionSymbol));
    const currentUnderlyingSpot = getQuotePrice(quoteMap.get(asset.underlyingSymbol)) || currentOptionSpot;
    const conversionRatio =
      currentUnderlyingSpot > 0 && currentOptionSpot > 0
        ? currentOptionSpot / currentUnderlyingSpot
        : Number(asset.conversionFallback ?? 1) || 1;
    const assetMarkets = getPolymarketMarketsForAsset(asset, polymarketMarkets);
    const alignedContracts = (optionMatches ?? []).filter((contract) => contract.rootSymbol === asset.optionSymbol);
    const liveContractsAvailable = alignedContracts.some((contract) => contract.isLive === true);
    const fallbackVolatility = FALLBACK_VOLATILITY[asset.id] ?? 0.24;

    if (!liveContractsAvailable) {
      warnings.push(`No live option liquidity snapshot for ${asset.label}. Executable V2 results may be unavailable.`);
    }

    for (const market of assetMarkets) {
      const eventDate = String(market.endDate ?? "").slice(0, 10);
      const targetUnderlying = parseTargetFromQuestion(market.question);
      const targetSpot = Math.max(targetUnderlying * conversionRatio, currentOptionSpot || 1);
      const polymarketProbability = clamp(Number(market.yesPrice ?? 0), 0.001, 0.999);
      const alignedExpiries = alignedContracts.filter((contract) => {
        const expiration = String(contract.expiration ?? "");
        const daysToExpiry = daysUntil(expiration);
        return (
          expiration >= eventDate &&
          expiration <= addDays(eventDate, MAX_DAYS_AFTER_EVENT) &&
          Number.isFinite(daysToExpiry) &&
          daysToExpiry >= MIN_OPTION_DAYS_REMAINING
        );
      });
      const enrichedContracts = enrichContracts(
        alignedExpiries,
        Math.max(currentOptionSpot, 0.01),
        fallbackVolatility
      );
      const calls = enrichedContracts.filter(
        (contract) => contract.optionType === "call" && hasTradableOptionQuote(contract)
      );
      const puts = enrichedContracts.filter(
        (contract) => contract.optionType === "put" && hasTradableOptionQuote(contract)
      );

      if (!calls.length || !puts.length) {
        continue;
      }

      const matchedCall = selectMatchedCall(calls, polymarketProbability);
      if (!matchedCall) {
        continue;
      }

      const optionProbability = Number(matchedCall.optionProbability ?? 0);
      const probabilityEdge = polymarketProbability - optionProbability;
      const distanceToTargetPct = Math.abs(targetSpot - currentOptionSpot) / Math.max(currentOptionSpot, 1);
      const atmCall = findNearestContract(
        calls,
        () => true,
        (left, right) => Math.abs(left.strike - currentOptionSpot) - Math.abs(right.strike - currentOptionSpot)
      );
      const atmPut = findNearestContract(
        puts,
        () => true,
        (left, right) => Math.abs(left.strike - currentOptionSpot) - Math.abs(right.strike - currentOptionSpot)
      );
      const impliedMovePct =
        atmCall && atmPut
          ? (getMidPrice(atmCall) + getMidPrice(atmPut)) / Math.max(currentOptionSpot, 1)
          : 0;

      if (probabilityEdge >= 0) {
        const strategyA = buildStrategyA({
          asset,
          market,
          currentSpot: currentOptionSpot,
          currentUnderlyingSpot,
          conversionRatio,
          targetSpot,
          targetUnderlyingValue: targetUnderlying,
          polymarketProbability,
          optionProbability,
          matchedCall,
          puts,
          capitalLimit
        });
        if (strategyA) {
          rows.push(strategyA);
        }
      }

      if (probabilityEdge < 0) {
        const strategyB = buildStrategyB({
          asset,
          market,
          currentSpot: currentOptionSpot,
          currentUnderlyingSpot,
          conversionRatio,
          targetSpot,
          targetUnderlyingValue: targetUnderlying,
          polymarketProbability,
          optionProbability,
          matchedCall,
          calls,
          capitalLimit
        });
        if (strategyB) {
          rows.push(strategyB);
        }
      }

      const strategyC = buildStrategyC({
        asset,
        market,
        currentSpot: currentOptionSpot,
        currentUnderlyingSpot,
        conversionRatio,
        targetSpot,
        targetUnderlyingValue: targetUnderlying,
        polymarketProbability,
        optionProbability,
        matchedCall,
        calls,
        puts,
        capitalLimit
      });
      if (strategyC) {
        const volatilityEdgeBonus = formatNumber(Math.max((impliedMovePct - distanceToTargetPct) * 100, 0), 2);
        rows.push({
          ...strategyC,
          volatilityEdgeBonus,
          compositeScore: formatNumber((strategyC.compositeScore ?? 0) + (volatilityEdgeBonus ?? 0) * 0.12, 2)
        });
      }
    }
  }

  const deduplicatedRows = rows
    .filter((row, index, array) => array.findIndex((item) => item.id === row.id) === index)
    .sort((left, right) => {
      if (right.compositeScore !== left.compositeScore) {
        return (right.compositeScore ?? -Infinity) - (left.compositeScore ?? -Infinity);
      }

      return (right.expectedValue ?? -Infinity) - (left.expectedValue ?? -Infinity);
    });
  const rankedRows = deduplicatedRows.slice(0, DEFAULT_TOP_RESULT_LIMIT);

  const settlementTypes = [...new Set(deduplicatedRows.map((row) => row.settlementType).filter(Boolean))];
  const strategyClasses = [...new Set(deduplicatedRows.map((row) => row.strategyClass).filter(Boolean))];

  return {
    generatedAt: new Date().toISOString(),
    warnings: [...new Set(warnings)],
    assumptions,
    summary: {
      executableEdges: rankedRows.length,
      candidatesGenerated: deduplicatedRows.length,
      assetsScanned: strategyScreenerV2AssetUniverse.length,
      marketsConsidered: strategyScreenerV2AssetUniverse.reduce(
        (sum, asset) => sum + getPolymarketMarketsForAsset(asset, polymarketMarkets).length,
        0
      ),
      capitalLimit,
      topLimit: DEFAULT_TOP_RESULT_LIMIT
    },
    filters: {
      settlementTypes,
      strategyClasses,
      expectedPriceRange: DEFAULT_EXPECTED_PRICE_RANGE,
      probabilityMismatchMin: 0,
      executionRiskMax: null,
      exitLiquidityMin: null,
      hedgeQualityMin: 0
    },
    rows: rankedRows
  };
}
