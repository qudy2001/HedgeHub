import {
  defaultStrategyConfig,
  strategyAssetUniverse
} from "./marketCatalog.js";
import { pickOptionReferencePrice } from "./optionPricing.js";
import { hasPublicPolymarketEvent, isTradablePolymarketMarket } from "./providers/polymarket.js";

function erf(x) {
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

  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampProbability(value) {
  return clamp(value, 0.001, 0.999);
}

function logit(value) {
  return Math.log(value / (1 - value));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

function differenceInDays(leftDate, rightDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((rightDate.getTime() - leftDate.getTime()) / millisecondsPerDay);
}

function addDays(date, days) {
  const clone = new Date(date);
  clone.setUTCDate(clone.getUTCDate() + days);
  return clone;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function minIsoDate(values) {
  const dates = values.filter(Boolean).sort();
  return dates[0] ?? null;
}

function startOfMonthIso(dateIso) {
  const value = new Date(`${dateIso}T00:00:00.000Z`);
  value.setUTCDate(1);
  return toIsoDate(value);
}

function getOptionSearchWindowForMarket(market, fallbackExpiry = defaultStrategyConfig.optionLeg.expiry) {
  const referenceExpiry = market.endDate?.slice(0, 10) || fallbackExpiry;
  return {
    referenceExpiry,
    from: startOfMonthIso(referenceExpiry),
    to: toIsoDate(addDays(new Date(`${referenceExpiry}T00:00:00.000Z`), 5))
  };
}

function isIsoDateWithinRange(dateIso, from, to) {
  return Boolean(dateIso) && (!from || dateIso >= from) && (!to || dateIso <= to);
}

export function parseTargetFromQuestion(question) {
  const match = question.match(
    /(?:above|over|reach(?:es)?|hits?|at least)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i
  );

  if (!match) {
    return null;
  }

  const rawValue = Number(match[1].replace(/,/g, ""));
  const scale = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;

  return rawValue * scale;
}

export function blackScholesCall({
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate
}) {
  if (timeToExpiryYears <= 0) {
    return Math.max(spot - strike, 0);
  }

  if (spot <= 0 || strike <= 0 || volatility <= 0) {
    return Math.max(spot - strike, 0);
  }

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiryYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;

  return spot * normalCdf(d1) - strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normalCdf(d2);
}

export function blackScholesPut({
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate
}) {
  if (timeToExpiryYears <= 0) {
    return Math.max(strike - spot, 0);
  }

  return (
    blackScholesCall({
      spot,
      strike,
      timeToExpiryYears,
      volatility,
      riskFreeRate
    }) -
    spot +
    strike * Math.exp(-riskFreeRate * timeToExpiryYears)
  );
}

export function binaryCallPrice({
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate
}) {
  if (timeToExpiryYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return spot >= strike ? 1 : 0;
  }

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d2 =
    (Math.log(spot / strike) + (riskFreeRate - 0.5 * volatility * volatility) * timeToExpiryYears) /
    (volatility * sqrtT);

  return Math.exp(-riskFreeRate * timeToExpiryYears) * normalCdf(d2);
}

export function computeCallGreeks({
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate
}) {
  if (timeToExpiryYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return {
      delta: spot > strike ? 1 : 0,
      gamma: 0,
      vega: 0,
      thetaPerDay: 0
    };
  }

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiryYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const pdf = normalPdf(d1);
  const delta = normalCdf(d1);
  const gamma = pdf / (spot * volatility * sqrtT);
  const vega = spot * pdf * sqrtT;
  const thetaPerYear =
    -(spot * pdf * volatility) / (2 * sqrtT) -
    riskFreeRate * strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normalCdf(d2);

  return {
    delta,
    gamma,
    vega,
    thetaPerDay: thetaPerYear / 365
  };
}

function projectOptionPriceWithGreeks({
  currentPremium,
  currentSpot,
  targetSpot,
  greeks,
  elapsedDays,
  volatilityShock
}) {
  const dSpot = targetSpot - currentSpot;
  const dVol = volatilityShock;
  const timeComponent = greeks.thetaPerDay * elapsedDays;

  return Math.max(
    currentPremium +
      greeks.delta * dSpot +
      0.5 * greeks.gamma * dSpot * dSpot +
      greeks.vega * dVol +
      timeComponent,
    0
  );
}

function buildDateSeries(expiryIso) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const expiry = new Date(`${expiryIso}T00:00:00.000Z`);
  const days = Math.max(differenceInDays(today, expiry), 0);

  return Array.from({ length: days + 1 }, (_, index) => addDays(today, index));
}

function quoteLookup(quotes) {
  return new Map(quotes.map((quote) => [quote.symbol, quote]));
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

const TARGET_OPTION_QUOTE_SIZE_THRESHOLDS = [10, 25, 50];
const DEFAULT_TARGET_OPTION_QUOTE_SIZE_THRESHOLD = TARGET_OPTION_QUOTE_SIZE_THRESHOLDS[0];

function hasUsableQuoteSize(option) {
  const bidSize = Number(option?.bidSize);
  const askSize = Number(option?.askSize);

  return Number.isFinite(bidSize) && bidSize > 0 && Number.isFinite(askSize) && askSize > 0;
}

function quoteSizeMeetsThreshold(option, threshold = DEFAULT_TARGET_OPTION_QUOTE_SIZE_THRESHOLD) {
  if (!hasUsableQuoteSize(option)) {
    return false;
  }

  const bidSize = Number(option?.bidSize);
  const askSize = Number(option?.askSize);
  return bidSize > threshold && askSize > threshold;
}

function getMinimumQuoteSize(optionLegBlueprints, side) {
  const sizeKey = side === "ask" ? "marketAskSize" : "marketBidSize";
  const sizes = optionLegBlueprints
    .map((leg) => Number(leg?.[sizeKey]))
    .filter((size) => Number.isFinite(size) && size > 0);

  if (!sizes.length) {
    return null;
  }

  return Math.min(...sizes);
}

function roundContracts(value, minimum = 1) {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.max(minimum, Math.round(value));
}

function getQuotePrice(quote) {
  return Number(quote?.regularMarketPrice ?? quote?.price ?? 0);
}

function solveImpliedVolatility({
  marketPrice,
  spot,
  strike,
  timeToExpiryYears,
  riskFreeRate,
  initialGuess = 0.35
}) {
  if (!marketPrice || timeToExpiryYears <= 0 || spot <= 0 || strike <= 0) {
    return initialGuess;
  }

  let low = 0.01;
  let high = 3;
  let guess = initialGuess;

  for (let index = 0; index < 60; index += 1) {
    guess = (low + high) / 2;
    const price = blackScholesCall({
      spot,
      strike,
      timeToExpiryYears,
      volatility: guess,
      riskFreeRate
    });

    if (price > marketPrice) {
      high = guess;
    } else {
      low = guess;
    }
  }

  return guess;
}

function buildSyntheticOptionCandidates({
  optionSymbol,
  currentSpot,
  targetSpot,
  referenceExpiry,
  expirationFrom,
  expirationTo,
  optionType = "call",
  volatility,
  riskFreeRate
}) {
  const baseDate = new Date(`${referenceExpiry}T00:00:00.000Z`);
  const todayIso = toIsoDate(new Date());
  const expiries = [
    expirationFrom,
    toIsoDate(addDays(baseDate, -7)),
    referenceExpiry,
    expirationTo
  ]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .filter((value) => value >= todayIso)
    .sort();
  const strikes = [0.9, 0.95, 1, 1.05, 1.1]
    .map((multiplier) => Math.round(currentSpot * multiplier))
    .filter((strike, index, array) => strike > 0 && array.indexOf(strike) === index)
    .sort((left, right) => left - right);

  return expiries.flatMap((expiration) => {
    const timeToExpiryYears = Math.max(
      differenceInDays(new Date(), new Date(`${expiration}T00:00:00.000Z`)) / 365,
      1 / 365
    );

    return strikes.map((strike) => ({
      contractSymbol: `${optionSymbol}-${expiration}-${optionType.toUpperCase()}-${strike}`,
      strike,
      expiration,
      lastPrice: formatNumber(
        priceOption({
          type: optionType,
          spot: currentSpot,
          strike,
          timeToExpiryYears,
          volatility,
          riskFreeRate
        }),
        4
      ),
      projectedTargetPrice: formatNumber(
        priceOption({
          type: optionType,
          spot: targetSpot,
          strike,
          timeToExpiryYears,
          volatility,
          riskFreeRate
        }),
        4
      ),
      impliedVolatility: volatility,
      optionType,
      isModeled: true
    }));
  });
}

function priceOption({
  type,
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate
}) {
  return type === "put"
    ? blackScholesPut({
        spot,
        strike,
        timeToExpiryYears,
        volatility,
        riskFreeRate
      })
    : blackScholesCall({
        spot,
        strike,
        timeToExpiryYears,
        volatility,
        riskFreeRate
      });
}

function daysUntil(isoDate) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.max(differenceInDays(today, new Date(`${isoDate}T00:00:00.000Z`)), 0);
}

function getAssetMarkets(asset, polymarketMarkets) {
  return polymarketMarkets.filter((market) => {
    const question = market.question.toLowerCase();
    return (
      isTradablePolymarketMarket(market) &&
      hasPublicPolymarketEvent(market) &&
      asset.polymarketQueries.some((query) => question.includes(query.split(" ")[0])) &&
      parseTargetFromQuestion(market.question)
    );
  });
}

function getOptionUniverseForMarket({
  asset,
  market,
  liveOptions,
  currentOptionSpot,
  currentUnderlyingSpot,
  fallbackVolatility,
  optionType = "call"
}) {
  const targetValue = parseTargetFromQuestion(market.question) || currentUnderlyingSpot || currentOptionSpot;
  const ratio =
    currentUnderlyingSpot > 0 && currentOptionSpot > 0
      ? currentOptionSpot / currentUnderlyingSpot
      : asset.conversionFallback;
  const targetSpot = Math.max(targetValue * ratio, currentOptionSpot || 1);
  const { from: windowFrom, to: windowTo, referenceExpiry } = getOptionSearchWindowForMarket(market);
  const matchingLiveOptions = liveOptions.filter(
    (option) =>
      isIsoDateWithinRange(option.expiration, windowFrom, windowTo) && (option.optionType ?? "call") === optionType
  );

  return matchingLiveOptions.length
    ? matchingLiveOptions.sort((left, right) => left.strike - right.strike)
    : buildSyntheticOptionCandidates({
        optionSymbol: asset.optionSymbol,
        currentSpot: currentOptionSpot || Math.max(targetSpot * 0.92, 10),
        targetSpot,
        referenceExpiry,
        expirationFrom: windowFrom,
        expirationTo: windowTo,
        optionType,
        volatility: fallbackVolatility,
        riskFreeRate: 0.0425
      })
        .filter((option) => isIsoDateWithinRange(option.expiration, windowFrom, windowTo))
        .sort((left, right) => left.strike - right.strike);
}

function getClosestStrikeOption(options, predicate) {
  return options.find(predicate) || null;
}

function groupOptionsByExpiration(options) {
  return options.reduce((groups, option) => {
    const key = option.expiration;
    if (!key) {
      return groups;
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(option);
    return groups;
  }, new Map());
}

function estimateBidAsk(unitPrice) {
  const mid = Math.max(unitPrice, 0.01);
  const spread = Math.max(mid * 0.08, 0.02);

  return {
    bid: formatNumber(mid - spread / 2, 4),
    ask: formatNumber(mid + spread / 2, 4)
  };
}

function binarySettlementValue(outcome, spot, targetThreshold) {
  if (outcome === "NO") {
    return spot < targetThreshold ? 1 : 0;
  }

  return spot >= targetThreshold ? 1 : 0;
}

function binaryPriceFromYes(outcome, yesPrice) {
  return outcome === "NO" ? 1 - yesPrice : yesPrice;
}

function estimatePolymarketYesPrice({
  spot,
  strike,
  timeYears,
  volatility,
  riskFreeRate,
  marketReferenceYesPrice,
  currentSpot,
  currentTimeYears
}) {
  if (timeYears < 0) {
    return spot >= strike ? 1 : 0;
  }

  const effectiveTimeYears = Math.max(timeYears, 1 / 365);
  const effectiveCurrentTimeYears = Math.max(currentTimeYears, 1 / 365);

  const rawEstimatedYesPrice =
    strike > 0 && spot > 0
      ? binaryCallPrice({
          spot,
          strike,
          timeToExpiryYears: effectiveTimeYears,
          volatility,
          riskFreeRate
        })
      : marketReferenceYesPrice;
  const currentModeledYesPrice =
    strike > 0 && currentSpot > 0
      ? binaryCallPrice({
          spot: currentSpot,
          strike,
          timeToExpiryYears: effectiveCurrentTimeYears,
          volatility,
          riskFreeRate
        })
      : marketReferenceYesPrice;

  if (!(marketReferenceYesPrice > 0 && currentModeledYesPrice > 0 && effectiveCurrentTimeYears > 0)) {
    return clamp(rawEstimatedYesPrice, 0.001, 0.999);
  }

  const modelCalibration =
    logit(clampProbability(marketReferenceYesPrice)) -
    logit(clampProbability(currentModeledYesPrice));
  const calibrationWeight = clamp(effectiveTimeYears / effectiveCurrentTimeYears, 0, 1);

  return clamp(
    logistic(logit(clampProbability(rawEstimatedYesPrice)) + modelCalibration * calibrationWeight),
    0.001,
    0.999
  );
}

function pickNearestOption(options, targetStrike) {
  if (!options.length) {
    return null;
  }

  return [...options].sort((left, right) => {
    const leftDistance = Math.abs(left.strike - targetStrike);
    const rightDistance = Math.abs(right.strike - targetStrike);
    return leftDistance === rightDistance ? left.strike - right.strike : leftDistance - rightDistance;
  })[0];
}

function getLowerOption(options, anchorStrike) {
  return [...options].reverse().find((option) => option.strike < anchorStrike) || options[0] || null;
}

function getHigherOption(options, anchorStrike) {
  return options.find((option) => option.strike > anchorStrike) || options[options.length - 1] || null;
}

function buildSpotEvaluationGrid({ start, end, targetThreshold, legs }) {
  const denseSteps = 48;
  const epsilon = Math.max((end - start) / 400, 0.01);
  const denseGrid = Array.from(
    { length: denseSteps },
    (_, index) => start + ((end - start) / (denseSteps - 1)) * index
  );
  const criticalSpots = [
    targetThreshold - epsilon,
    targetThreshold,
    targetThreshold + epsilon,
    ...legs.flatMap((leg) =>
      leg.kind === "option"
        ? [leg.strike - epsilon, leg.strike, leg.strike + epsilon]
        : []
    )
  ];

  return [...denseGrid, ...criticalSpots]
    .filter((spot) => Number.isFinite(spot) && spot >= start && spot <= end)
    .map((spot) => Number(spot.toFixed(4)))
    .filter((spot, index, array) => array.indexOf(spot) === index)
    .sort((left, right) => left - right);
}

function buildPayoffEvaluationRange({ currentSpot, targetSpot, targetThreshold, legs }) {
  const optionStrikes = legs
    .filter((leg) => leg.kind === "option")
    .map((leg) => Number(leg.strike))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const referenceHigh = Math.max(currentSpot, targetSpot, targetThreshold, ...optionStrikes, 1);

  return {
    start: 0,
    end: Math.max(referenceHigh * 1.75, referenceHigh + 10, 25)
  };
}

function calculateHighSpotSlope(legs) {
  return legs.reduce((sum, leg) => {
    if (leg.kind !== "option" || leg.optionType !== "call") {
      return sum;
    }

    const contractUnits = Number(leg.quantity ?? 0) * Number(leg.contractMultiplier ?? 100);
    return sum + (leg.action === "LONG" ? 1 : -1) * contractUnits;
  }, 0);
}

function evaluatePayoffExtremes(curve, legs) {
  const totalPnLs = curve.map((point) => point.totalPnL ?? 0);
  const highSpotSlope = calculateHighSpotSlope(legs);

  return {
    maxProfit: totalPnLs.length && highSpotSlope <= 0 ? Math.max(...totalPnLs) : null,
    maxLoss: totalPnLs.length && highSpotSlope >= 0 ? Math.min(...totalPnLs) : null,
    maxProfitUnbounded: highSpotSlope > 0,
    maxLossUnbounded: highSpotSlope < 0
  };
}

function findClosestCurvePoint(curve, referenceSpot) {
  if (!curve.length) {
    return null;
  }

  return curve.reduce((closest, point) => {
    if (!closest) {
      return point;
    }

    return Math.abs(Number(point.spot) - referenceSpot) < Math.abs(Number(closest.spot) - referenceSpot)
      ? point
      : closest;
  }, null);
}

function classifyStrategyBias(curve, referenceSpot) {
  const values = curve
    .map((point) => ({
      spot: Number(point.spot),
      totalPnL: Number(point.totalPnL)
    }))
    .filter((point) => Number.isFinite(point.spot) && Number.isFinite(point.totalPnL));

  if (!values.length) {
    return {
      label: "Neutral",
      tone: "neutral"
    };
  }

  const lowPoint = values[0];
  const highPoint = values[values.length - 1];
  const middlePoint = findClosestCurvePoint(values, referenceSpot) ?? values[Math.floor(values.length / 2)];
  const payoffValues = values.map((point) => point.totalPnL);
  const range = Math.max(...payoffValues) - Math.min(...payoffValues);
  const threshold = Math.max(range * 0.12, 25);

  if (
    middlePoint.totalPnL >= lowPoint.totalPnL + threshold &&
    middlePoint.totalPnL >= highPoint.totalPnL + threshold
  ) {
    return {
      label: "Range-bound",
      tone: "range"
    };
  }

  if (
    middlePoint.totalPnL <= lowPoint.totalPnL - threshold &&
    middlePoint.totalPnL <= highPoint.totalPnL - threshold
  ) {
    return {
      label: "Breakout",
      tone: "breakout"
    };
  }

  if (highPoint.totalPnL >= lowPoint.totalPnL + threshold) {
    return {
      label: "Bull",
      tone: "bull"
    };
  }

  if (lowPoint.totalPnL >= highPoint.totalPnL + threshold) {
    return {
      label: "Bear",
      tone: "bear"
    };
  }

  return {
    label: "Neutral",
    tone: "neutral"
  };
}

function buildPayoffCurve({
  currentSpot,
  targetSpot,
  targetThreshold,
  binaryTargetThreshold = targetThreshold,
  currentUnderlyingSpot = currentSpot,
  conversionRatio = 1,
  marketReferenceYesPrice = 0.5,
  strategyCloseDate = null,
  polymarketResolutionDate = null,
  volatility = 0.24,
  riskFreeRate = 0.0425,
  legs
}) {
  const { start, end } = buildPayoffEvaluationRange({
    currentSpot,
    targetSpot,
    targetThreshold,
    legs
  });
  const currentDate = new Date();
  const currentDateUtc = new Date(
    Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate())
  );
  const strategyCloseDateUtc = strategyCloseDate ? new Date(`${strategyCloseDate}T00:00:00.000Z`) : null;
  const polymarketResolutionDateUtc = polymarketResolutionDate
    ? new Date(`${polymarketResolutionDate}T00:00:00.000Z`)
    : null;
  const currentDaysToMarketResolution = polymarketResolutionDateUtc
    ? Math.max(differenceInDays(currentDateUtc, polymarketResolutionDateUtc), 0)
    : 0;
  const grid = buildSpotEvaluationGrid({
    start,
    end,
    targetThreshold,
    legs
  });

  return grid.map((spot) => {
    const total = legs.reduce((sum, leg) => {
      if (leg.kind === "binary") {
        const settleUnderlying = conversionRatio > 0 ? spot / conversionRatio : spot;
        const markPrice =
          strategyCloseDateUtc &&
          polymarketResolutionDateUtc &&
          strategyCloseDateUtc.getTime() < polymarketResolutionDateUtc.getTime()
            ? binaryPriceFromYes(
                leg.outcome,
                estimatePolymarketYesPrice({
                  spot: settleUnderlying,
                  strike: binaryTargetThreshold,
                  timeYears: Math.max(differenceInDays(strategyCloseDateUtc, polymarketResolutionDateUtc), 0) / 365,
                  volatility,
                  riskFreeRate,
                  marketReferenceYesPrice,
                  currentSpot: currentUnderlyingSpot,
                  currentTimeYears: currentDaysToMarketResolution / 365
                })
              )
            : binarySettlementValue(leg.outcome, settleUnderlying, binaryTargetThreshold);
        const perUnit = leg.action === "LONG" ? markPrice - leg.entryPrice : leg.entryPrice - markPrice;
        return sum + leg.quantity * perUnit;
      }

      const expiryDateUtc = leg.expiration ? new Date(`${leg.expiration}T00:00:00.000Z`) : strategyCloseDateUtc;
      const remainingOptionDays =
        strategyCloseDateUtc && expiryDateUtc
          ? Math.max(differenceInDays(strategyCloseDateUtc, expiryDateUtc), 0)
          : 0;
      const optionMarkPrice =
        strategyCloseDateUtc && expiryDateUtc && strategyCloseDateUtc.getTime() < expiryDateUtc.getTime()
          ? priceOption({
              type: leg.optionType,
              spot,
              strike: leg.strike,
              timeToExpiryYears: Math.max(remainingOptionDays / 365, 1 / 365),
              volatility: Number(leg.impliedVolatility ?? volatility) || volatility,
              riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate
            })
          : leg.optionType === "put"
            ? Math.max(leg.strike - spot, 0)
            : Math.max(spot - leg.strike, 0);
      const perContract =
        leg.action === "LONG" ? optionMarkPrice - leg.entryPrice : leg.entryPrice - optionMarkPrice;

      return sum + leg.quantity * leg.contractMultiplier * perContract;
    }, 0);

    return {
      spot: formatNumber(spot, 2),
      totalPnL: formatNumber(total, 2)
    };
  });
}

function approximateBreakevens(curve) {
  const values = [];

  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (previous.totalPnL == null || current.totalPnL == null) {
      continue;
    }

    if ((previous.totalPnL <= 0 && current.totalPnL >= 0) || (previous.totalPnL >= 0 && current.totalPnL <= 0)) {
      const slope = current.totalPnL - previous.totalPnL;
      const ratio = slope === 0 ? 0 : (0 - previous.totalPnL) / slope;
      const spot = previous.spot + (current.spot - previous.spot) * ratio;
      values.push(formatNumber(spot, 2));
    }
  }

  return values.filter((value, index, array) => value != null && array.indexOf(value) === index);
}

export function buildPayoffSummary({
  currentSpot,
  targetSpot,
  targetThreshold,
  binaryTargetThreshold = targetThreshold,
  currentUnderlyingSpot = currentSpot,
  conversionRatio = 1,
  marketReferenceYesPrice = 0.5,
  strategyCloseDate = null,
  polymarketResolutionDate = null,
  volatility = 0.24,
  riskFreeRate = 0.0425,
  legs
}) {
  const payoffCurve = buildPayoffCurve({
    currentSpot,
    targetSpot,
    targetThreshold,
    binaryTargetThreshold,
    currentUnderlyingSpot,
    conversionRatio,
    marketReferenceYesPrice,
    strategyCloseDate,
    polymarketResolutionDate,
    volatility,
    riskFreeRate,
    legs
  });
  const { maxProfit, maxLoss, maxProfitUnbounded, maxLossUnbounded } = evaluatePayoffExtremes(
    payoffCurve,
    legs
  );
  const breakevens = approximateBreakevens(payoffCurve);
  const marketBias = classifyStrategyBias(payoffCurve, currentSpot);

  return {
    payoffCurve,
    maxProfit,
    maxLoss,
    maxProfitUnbounded,
    maxLossUnbounded,
    breakevens,
    marketBias
  };
}

const polymarketStructures = [
  {
    id: "pm-yes",
    legs: [{ outcome: "YES", action: "LONG", label: "PM YES", budgetShare: 1 }],
    displayOutcome: "YES"
  },
  {
    id: "pm-no",
    legs: [{ outcome: "NO", action: "LONG", label: "PM NO", budgetShare: 1 }],
    displayOutcome: "NO"
  },
  {
    id: "pm-yes-short",
    legs: [{ outcome: "YES", action: "SHORT", label: "PM YES Short", budgetShare: 1 }],
    displayOutcome: "YES"
  },
  {
    id: "pm-no-short",
    legs: [{ outcome: "NO", action: "SHORT", label: "PM NO Short", budgetShare: 1 }],
    displayOutcome: "NO"
  },
  {
    id: "pm-yes-plus-no-short",
    legs: [
      { outcome: "YES", action: "LONG", label: "PM YES", budgetShare: 0.5 },
      { outcome: "NO", action: "SHORT", label: "PM NO Short", budgetShare: 0.5 }
    ],
    displayOutcome: "YES"
  },
  {
    id: "pm-no-plus-yes-short",
    legs: [
      { outcome: "NO", action: "LONG", label: "PM NO", budgetShare: 0.5 },
      { outcome: "YES", action: "SHORT", label: "PM YES Short", budgetShare: 0.5 }
    ],
    displayOutcome: "NO"
  }
];

function buildPolymarketBlueprints(market, structure) {
  const yesPrice = clamp(market.yesPrice, 0.001, 0.999);
  const noPrice = clamp(
    Number.isFinite(Number(market.noPrice)) ? Number(market.noPrice) : 1 - yesPrice,
    0.001,
    0.999
  );

  return structure.legs.map((leg) => ({
    id: `${market.id}-${structure.id}-${leg.outcome.toLowerCase()}-${leg.action.toLowerCase()}`,
    kind: "binary",
    outcome: leg.outcome,
    action: leg.action,
    label: leg.label,
    entryPrice: leg.outcome === "YES" ? yesPrice : noPrice,
    budgetShare: leg.budgetShare,
    displayPrice:
      structure.displayOutcome === "YES"
        ? yesPrice
        : noPrice
  }));
}

function buildCombination({
  asset,
  market,
  polymarketBlueprints,
  polymarketStructureId,
  strategyType,
  optionLegBlueprints,
  currentOptionSpot,
  currentUnderlyingSpot
}) {
  const targetThreshold = parseTargetFromQuestion(market.question) || currentUnderlyingSpot;
  const conversionRatio =
    currentUnderlyingSpot > 0 && currentOptionSpot > 0
      ? currentOptionSpot / currentUnderlyingSpot
      : asset.conversionFallback;
  const polymarketBudget = 1000;
  const optionBudget = 1000;
  const structureEntryPerUnit = optionLegBlueprints.reduce((sum, leg) => {
    const sign = leg.action === "LONG" ? 1 : -1;
    return sum + sign * leg.entryPrice;
  }, 0);
  const optionStructureCost = Math.max(Math.abs(structureEntryPerUnit) * 100, 25);
  const structureQuantity = roundContracts(optionBudget / optionStructureCost);
  const payoffLegs = [
    ...polymarketBlueprints.map((leg) => ({
      ...leg,
      quantity: roundContracts((polymarketBudget * (leg.budgetShare ?? 1)) / Math.max(leg.entryPrice, 0.01))
    })),
    ...optionLegBlueprints.map((leg) => ({
      ...leg,
      kind: "option",
      quantity: structureQuantity,
      contractMultiplier: 100
    }))
  ];
  const polymarketResolutionDate = market.endDate?.slice(0, 10) || null;
  const strategyCloseDate =
    minIsoDate([polymarketResolutionDate, ...optionLegBlueprints.map((leg) => leg.expiration)]) ||
    polymarketResolutionDate ||
    optionLegBlueprints[0]?.expiration ||
    defaultStrategyConfig.optionLeg.expiry;
  const {
    payoffCurve,
    maxProfit,
    maxLoss,
    maxProfitUnbounded,
    maxLossUnbounded,
    breakevens,
    marketBias
  } = buildPayoffSummary({
    currentSpot: currentOptionSpot,
    targetSpot: optionLegBlueprints[0]?.targetSpot || currentOptionSpot,
    targetThreshold: optionLegBlueprints[0]?.targetSpot || currentOptionSpot,
    binaryTargetThreshold: targetThreshold,
    currentUnderlyingSpot,
    conversionRatio,
    marketReferenceYesPrice: market.yesPrice,
    strategyCloseDate,
    polymarketResolutionDate,
    volatility:
      Number(optionLegBlueprints[0]?.impliedVolatility ?? optionLegBlueprints[1]?.impliedVolatility ?? 0) || 0.24,
    riskFreeRate:
      Number(optionLegBlueprints[0]?.riskFreeRate ?? optionLegBlueprints[1]?.riskFreeRate ?? 0) || 0.0425,
    legs: payoffLegs
  });
  const expPayoff =
    payoffCurve.find((point) => Math.abs(point.spot - (optionLegBlueprints[0]?.targetSpot || currentOptionSpot)) < 0.5)
      ?.totalPnL ?? null;
  const positivePoints = payoffCurve.filter((point) => (point.totalPnL ?? 0) > 0).length;
  const probabilityOfProfit = (positivePoints / payoffCurve.length) * 100;
  const netBid = optionLegBlueprints.reduce(
    (sum, leg) => sum + (leg.action === "LONG" ? (leg.marketBid ?? leg.entryPrice) : -(leg.marketAsk ?? leg.entryPrice)),
    0
  );
  const netAsk = optionLegBlueprints.reduce(
    (sum, leg) => sum + (leg.action === "LONG" ? (leg.marketAsk ?? leg.entryPrice) : -(leg.marketBid ?? leg.entryPrice)),
    0
  );
  const targetOptionBidSize = getMinimumQuoteSize(optionLegBlueprints, "bid");
  const targetOptionAskSize = getMinimumQuoteSize(optionLegBlueprints, "ask");
  const targetOptionQuoteSize =
    targetOptionBidSize != null && targetOptionAskSize != null
      ? Math.min(targetOptionBidSize, targetOptionAskSize)
      : null;
  const hasRealNetSpread =
    optionLegBlueprints.length > 0 && optionLegBlueprints.every((leg) => leg.hasRealBidAsk === true);
  const spreadPct =
    hasRealNetSpread && Math.abs(netAsk) + Math.abs(netBid) > 0
      ? (Math.abs(netAsk - netBid) / Math.max(Math.abs((netAsk + netBid) / 2), 0.01)) * 100
      : null;
  const primaryPolymarketLeg = payoffLegs.find((leg) => leg.kind === "binary") ?? null;
  const polymarketPrice = primaryPolymarketLeg?.entryPrice ?? market.yesPrice;
  const polymarketPriceSide = primaryPolymarketLeg?.outcome ?? "YES";

  return {
    id: `${market.id}-${asset.id}-${polymarketStructureId}-${strategyType.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${optionLegBlueprints
      .map((leg) => `${leg.expiration}-${leg.strike}-${leg.optionType}-${leg.action}`)
      .join("-")}`,
    assetId: asset.id,
    assetLabel: asset.label,
    polymarketMarketId: market.id,
    polymarketMarketSlug: market.slug ?? "",
    polymarketEventSlug: market.eventSlug ?? "",
    polymarketQuestion: market.question,
    polymarketSource: market.source || "live",
    polymarketUrl: market.url,
    polymarketPrice: formatNumber(polymarketPrice, 4),
    polymarketPriceSide,
    expiration: strategyCloseDate,
    strategyCloseDate,
    polymarketResolutionDate,
    marketBias: marketBias.label,
    marketBiasTone: marketBias.tone,
    optionExpiry: optionLegBlueprints[0]?.expiration ?? null,
    days: daysUntil(strategyCloseDate),
    strategyType,
    formula: [
      ...polymarketBlueprints.map((leg) => ({
        label: leg.label,
        tone: leg.action === "SHORT" ? "market-short" : "market"
      })),
      ...optionLegBlueprints.map((leg) => ({
        label: `${formatNumber(leg.strike, 1)}${leg.optionType === "put" ? "P" : "C"}`,
        tone: leg.optionType === "put" ? "put" : leg.action === "SHORT" ? "short" : "call"
      }))
    ],
    maxProfit: formatNumber(maxProfit, 2),
    maxLoss: formatNumber(maxLoss, 2),
    maxProfitUnbounded,
    maxLossUnbounded,
    rewardRisk: maxLoss < 0 ? formatNumber(maxProfit / Math.abs(maxLoss), 2) : null,
    breakevens,
    theoPrice: formatNumber(structureEntryPerUnit, 4),
    bid: formatNumber(netBid, 4),
    ask: formatNumber(netAsk, 4),
    targetOptionBidSize: formatNumber(targetOptionBidSize, 0),
    targetOptionAskSize: formatNumber(targetOptionAskSize, 0),
    targetOptionQuoteSize: formatNumber(targetOptionQuoteSize, 0),
    bidAskSpread: formatNumber(spreadPct, 2),
    expPayoff: formatNumber(expPayoff, 2),
    payoffCurve,
    quickOverview: {
      underlyingPrice: formatNumber(currentOptionSpot, 2),
      theoPrice: formatNumber(structureEntryPerUnit, 4),
      bid: formatNumber(netBid, 4),
      ask: formatNumber(netAsk, 4),
      targetOptionBidSize: formatNumber(targetOptionBidSize, 0),
      targetOptionAskSize: formatNumber(targetOptionAskSize, 0),
      targetOptionQuoteSize: formatNumber(targetOptionQuoteSize, 0),
      breakevens,
      probabilityOfProfit: formatNumber(probabilityOfProfit, 2)
    },
    marketContext: {
      proxySymbol: asset.optionSymbol,
      underlyingSymbol: asset.underlyingSymbol,
      currentProxySpot: formatNumber(currentOptionSpot, 4),
      currentUnderlyingSpot: formatNumber(currentUnderlyingSpot, 2),
      conversionRatio: formatNumber(conversionRatio, 6),
      targetUnderlyingValue: formatNumber(targetThreshold, 2)
    },
    riskAnalysis: {
      expPayoff: formatNumber(expPayoff, 2),
      maxProfit: formatNumber(maxProfit, 2),
      maxLoss: formatNumber(maxLoss, 2),
      maxProfitUnbounded,
      maxLossUnbounded,
      rewardRisk: maxLoss < 0 ? formatNumber(maxProfit / Math.abs(maxLoss), 2) : null
    },
    legs: payoffLegs.map((leg) =>
      leg.kind === "binary"
        ? {
            id: leg.id,
            label: leg.label,
            action: leg.action,
            quantity: leg.quantity,
            strike: leg.outcome,
            bid: formatNumber(leg.entryPrice, 4),
            ask: formatNumber(leg.entryPrice, 4),
            spread: 0,
            entryPrice: formatNumber(leg.entryPrice, 4),
            kind: leg.kind,
            outcome: leg.outcome,
            polymarketMarketId: market.id,
            expiry: polymarketResolutionDate,
            strategyCloseDate,
            marketQuestion: market.question
          }
        : {
            id: leg.id,
            label: `${asset.optionSymbol} ${leg.expiration} ${formatNumber(leg.strike, 1)} ${leg.optionType.toUpperCase()}`,
            contractSymbol: leg.contractSymbol,
            action: leg.action,
            quantity: leg.quantity,
            strike: formatNumber(leg.strike, 1),
            bid: leg.marketBid,
            ask: leg.marketAsk,
            bidSize: formatNumber(leg.marketBidSize, 0),
            askSize: formatNumber(leg.marketAskSize, 0),
            spread:
              leg.hasRealBidAsk === true && leg.marketBid != null && leg.marketAsk != null
                ? formatNumber(
                    (Math.abs(leg.marketAsk - leg.marketBid) /
                      Math.max(Math.abs((leg.marketAsk + leg.marketBid) / 2), 0.01)) *
                      100,
                    2
                  )
                : null,
            entryPrice: formatNumber(leg.entryPrice, 4),
            kind: leg.kind,
            optionType: leg.optionType,
            expiry: leg.expiration,
            impliedVolatility: formatNumber(leg.impliedVolatility, 4),
            contractMultiplier: leg.contractMultiplier,
            quoteSource: leg.quoteSource ?? "seed",
            isLive: leg.isLive === true,
            hasRealBidAsk: leg.hasRealBidAsk === true
          }
    )
  };
}

function buildStrategyFinder({
  quotes,
  polymarketMarkets,
  optionMatches
}) {
  const quoteMap = quoteLookup(quotes);
  const fallbackVolatility = {
    btc: 0.44,
    eth: 0.56,
    gold: 0.18,
    oil: 0.3,
    stocks: 0.22
  };

  const rows = strategyAssetUniverse.flatMap((asset) => {
    const currentOptionSpot = getQuotePrice(quoteMap.get(asset.optionSymbol));
    const currentUnderlyingSpot = getQuotePrice(quoteMap.get(asset.underlyingSymbol));
    const liveOptions = optionMatches.filter((option) => option.rootSymbol === asset.optionSymbol);
    const hasAssetQuoteSizeData = liveOptions.some((option) => hasUsableQuoteSize(option));
    const markets = getAssetMarkets(asset, polymarketMarkets);

    return markets.flatMap((market) => {
      const callUniverse = getOptionUniverseForMarket({
        asset,
        market,
        liveOptions,
        currentOptionSpot,
        currentUnderlyingSpot,
        fallbackVolatility: fallbackVolatility[asset.id] || 0.24,
        optionType: "call"
      });
      const putUniverse = getOptionUniverseForMarket({
        asset,
        market,
        liveOptions,
        currentOptionSpot,
        currentUnderlyingSpot,
        fallbackVolatility: fallbackVolatility[asset.id] || 0.24,
        optionType: "put"
      });

      if (callUniverse.length < 1 && putUniverse.length < 1) {
        return [];
      }

      const callUniverseByExpiry = groupOptionsByExpiration(callUniverse);
      const putUniverseByExpiry = groupOptionsByExpiration(putUniverse);
      const expiries = [...new Set([...callUniverseByExpiry.keys(), ...putUniverseByExpiry.keys()])].sort();

      const targetValue = parseTargetFromQuestion(market.question) || currentUnderlyingSpot || currentOptionSpot;
      const ratio =
        currentUnderlyingSpot > 0 && currentOptionSpot > 0
          ? currentOptionSpot / currentUnderlyingSpot
          : asset.conversionFallback;
      const targetSpot = Math.max(targetValue * ratio, currentOptionSpot || 1);

      const buildLeg = (option, action) => {
        const price = pickOptionReferencePrice(option, option.projectedTargetPrice ?? 0.05);
        const quotes =
          option.bid != null && option.ask != null
            ? {
                bid: formatNumber(option.bid, 4),
                ask: formatNumber(option.ask, 4)
              }
            : estimateBidAsk(price);

        return {
          id: `${market.id}-${option.contractSymbol}-${action.toLowerCase()}`,
          contractSymbol: option.contractSymbol,
          action,
          entryPrice: formatNumber(price, 4),
          strike: option.strike,
          expiration: option.expiration,
          optionType: option.optionType ?? "call",
          impliedVolatility: option.impliedVolatility || fallbackVolatility[asset.id] || 0.24,
          targetSpot: formatNumber(targetSpot, 2),
          marketBid: quotes.bid,
          marketAsk: quotes.ask,
          marketBidSize: formatNumber(Number(option.bidSize), 0),
          marketAskSize: formatNumber(Number(option.askSize), 0),
          quoteSource: option.source || (option.isModeled ? "modeled" : "seed"),
          isLive: option.isLive === true,
          hasRealBidAsk: option.hasRealBidAsk === true
        };
      };

      return expiries.flatMap((expiry) => {
        const expiryCalls = [...(callUniverseByExpiry.get(expiry) ?? [])].sort(
          (left, right) => left.strike - right.strike
        );
        const expiryPuts = [...(putUniverseByExpiry.get(expiry) ?? [])].sort(
          (left, right) => left.strike - right.strike
        );

        if (expiryCalls.length < 1 && expiryPuts.length < 1) {
          return [];
        }

        const nearCall = pickNearestOption(expiryCalls, targetSpot);
        const higherCall = nearCall ? getHigherOption(expiryCalls, nearCall.strike) : null;
        const lowerCall = nearCall ? getLowerOption(expiryCalls, nearCall.strike) : null;
        const nearPut = pickNearestOption(expiryPuts, targetSpot);
        const higherPut = nearPut ? getHigherOption(expiryPuts, nearPut.strike) : null;
        const lowerPut = nearPut ? getLowerOption(expiryPuts, nearPut.strike) : null;
        const distinctHigherCall = higherCall && nearCall && higherCall.strike !== nearCall.strike ? higherCall : null;
        const distinctLowerCall = lowerCall && nearCall && lowerCall.strike !== nearCall.strike ? lowerCall : null;
        const distinctHigherPut = higherPut && nearPut && higherPut.strike !== nearPut.strike ? higherPut : null;
        const distinctLowerPut = lowerPut && nearPut && lowerPut.strike !== nearPut.strike ? lowerPut : null;

        const optionStrategies = [
          nearCall ? { label: "Long Call", legs: [buildLeg(nearCall, "LONG")] } : null,
          nearCall ? { label: "Short Call", legs: [buildLeg(nearCall, "SHORT")] } : null,
          nearPut ? { label: "Long Put", legs: [buildLeg(nearPut, "LONG")] } : null,
          nearPut ? { label: "Short Put", legs: [buildLeg(nearPut, "SHORT")] } : null,
          distinctLowerCall && nearCall
            ? {
                label: "Bull Call Spread",
                legs: [buildLeg(distinctLowerCall, "LONG"), buildLeg(nearCall, "SHORT")]
              }
            : null,
          nearCall && distinctHigherCall
            ? {
                label: "Bear Call Spread",
                legs: [buildLeg(nearCall, "SHORT"), buildLeg(distinctHigherCall, "LONG")]
              }
            : null,
          nearPut && distinctLowerPut
            ? {
                label: "Bear Put Spread",
                legs: [buildLeg(nearPut, "LONG"), buildLeg(distinctLowerPut, "SHORT")]
              }
            : null,
          distinctHigherPut && distinctLowerPut && distinctHigherPut.strike !== distinctLowerPut.strike
            ? {
                label: "Bull Put Spread",
                legs: [buildLeg(distinctHigherPut, "SHORT"), buildLeg(distinctLowerPut, "LONG")]
              }
            : null,
          nearCall && nearPut
            ? { label: "Long Straddle", legs: [buildLeg(nearCall, "LONG"), buildLeg(nearPut, "LONG")] }
            : null,
          nearCall && nearPut
            ? { label: "Short Straddle", legs: [buildLeg(nearCall, "SHORT"), buildLeg(nearPut, "SHORT")] }
            : null,
          distinctHigherCall && distinctLowerPut
            ? {
                label: "Long Strangle",
                legs: [buildLeg(distinctHigherCall, "LONG"), buildLeg(distinctLowerPut, "LONG")]
              }
            : null,
          distinctHigherCall && distinctLowerPut
            ? {
                label: "Short Strangle",
                legs: [buildLeg(distinctHigherCall, "SHORT"), buildLeg(distinctLowerPut, "SHORT")]
              }
            : null,
          distinctHigherCall && distinctLowerPut
            ? {
                label: "Bull Risk Reversal",
                legs: [buildLeg(distinctHigherCall, "LONG"), buildLeg(distinctLowerPut, "SHORT")]
              }
            : null,
          nearPut && nearCall
            ? { label: "Bear Risk Reversal", legs: [buildLeg(nearPut, "LONG"), buildLeg(nearCall, "SHORT")] }
            : null,
          distinctLowerPut && nearPut && nearCall && distinctHigherCall
            ? {
                label: "Iron Condor",
                legs: [
                  buildLeg(distinctLowerPut, "LONG"),
                  buildLeg(nearPut, "SHORT"),
                  buildLeg(nearCall, "SHORT"),
                  buildLeg(distinctHigherCall, "LONG")
                ]
              }
            : null
        ]
          .filter(Boolean)
          .filter((strategy) =>
            !hasAssetQuoteSizeData ||
            strategy.legs.every((leg) =>
              quoteSizeMeetsThreshold(
                {
                  bidSize: leg.marketBidSize,
                  askSize: leg.marketAskSize
                },
                DEFAULT_TARGET_OPTION_QUOTE_SIZE_THRESHOLD
              )
            )
          )
          .filter((strategy, index, array) => {
            const signature = `${expiry}:${strategy.label}:${strategy.legs
              .map((leg) => `${leg.action}-${leg.optionType}-${leg.strike}`)
              .join("|")}`;
            return (
              array.findIndex((item) => {
                const itemSignature = `${expiry}:${item.label}:${item.legs
                  .map((leg) => `${leg.action}-${leg.optionType}-${leg.strike}`)
                  .join("|")}`;
                return itemSignature === signature;
              }) === index
            );
          });

        return polymarketStructures.flatMap((polymarketStructure) => {
          const polymarketBlueprints = buildPolymarketBlueprints(market, polymarketStructure);

          return optionStrategies.map((strategy) =>
            buildCombination({
              asset,
              market,
              polymarketBlueprints,
              polymarketStructureId: polymarketStructure.id,
              strategyType: strategy.label,
              optionLegBlueprints: strategy.legs,
              currentOptionSpot,
              currentUnderlyingSpot
            })
          );
        });
      });
    });
  });

  const selectedRow = rows[0] ?? null;
  const quoteSizeDataAvailable = rows.some((row) => {
    const quoteSize = Number(row.targetOptionQuoteSize);
    return Number.isFinite(quoteSize) && quoteSize > 0;
  });

  return {
    filters: {
      dateRange: {
        from: new Date().toISOString().slice(0, 10),
        to: selectedRow?.expiration ?? defaultStrategyConfig.optionLeg.expiry
      },
      priceRange: "+5% to +10%",
      strategyTypes: [...new Set(rows.map((row) => row.strategyType))],
      quoteSizeDataAvailable,
      targetOptionQuoteSizeThresholds: TARGET_OPTION_QUOTE_SIZE_THRESHOLDS,
      defaultTargetOptionQuoteSizeThreshold: DEFAULT_TARGET_OPTION_QUOTE_SIZE_THRESHOLD
    },
    rows: rows.sort((left, right) => {
      if (right.rewardRisk !== left.rewardRisk) {
        return (right.rewardRisk ?? -Infinity) - (left.rewardRisk ?? -Infinity);
      }

      return (right.expPayoff ?? -Infinity) - (left.expPayoff ?? -Infinity);
    }),
    selectedRowId: selectedRow?.id ?? null,
    calculatorDefaults: selectedRow
      ? {
          valuationDate: selectedRow.expiration,
          underlyingPrice: selectedRow.payoffCurve.find((point) => point.totalPnL === selectedRow.expPayoff)?.spot ?? null,
          impliedVolatility: selectedRow.legs.find((leg) => leg.kind === "option")?.impliedVolatility ?? 0.24,
          polymarketYesPrice: 1
        }
      : null
  };
}

function buildScenarioFromConfig({
  config,
  quotes,
  polymarketMarket = null,
  optionCandidates = []
}) {
  const quoteMap = quoteLookup(quotes);
  const optionQuote = quoteMap.get(config.optionLeg.symbol);
  const underlyingQuote = quoteMap.get(config.optionLeg.proxyUnderlying);
  const currentOptionSpot = getQuotePrice(optionQuote) || config.optionLeg.strike * 0.92;
  const currentUnderlyingSpot = getQuotePrice(underlyingQuote) || config.yesLeg.targetValue * 0.84;
  const targetUnderlyingValue =
    parseTargetFromQuestion(polymarketMarket?.question ?? "") || config.yesLeg.targetValue;
  const conversionRatio = currentUnderlyingSpot > 0 ? currentOptionSpot / currentUnderlyingSpot : 1;
  const targetOptionSpot = Math.max(targetUnderlyingValue * conversionRatio, config.optionLeg.strike);
  const premium = pickOptionReferencePrice(optionCandidates[0], config.optionLeg.premium);
  const timeSeriesDates = buildDateSeries(config.optionLeg.expiry);
  const now = new Date();
  const daysToExpiry = Math.max(
    differenceInDays(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      new Date(`${config.optionLeg.expiry}T00:00:00.000Z`)
    ),
    1
  );
  const currentTimeToExpiryYears = daysToExpiry / 365;
  const impliedVolatility =
    optionCandidates[0]?.impliedVolatility ??
    solveImpliedVolatility({
      marketPrice: premium,
      spot: currentOptionSpot,
      strike: config.optionLeg.strike,
      timeToExpiryYears: currentTimeToExpiryYears,
      riskFreeRate: config.optionLeg.riskFreeRate,
      initialGuess: config.optionLeg.impliedVolatility
    });
  const greeks = computeCallGreeks({
    spot: currentOptionSpot,
    strike: config.optionLeg.strike,
    timeToExpiryYears: currentTimeToExpiryYears,
    volatility: impliedVolatility,
    riskFreeRate: config.optionLeg.riskFreeRate
  });
  const yesContracts = roundContracts(config.yesLeg.allocation / config.yesLeg.price);
  const shortCallUnits = roundContracts(config.optionLeg.allocation / premium);
  const premiumCollected = config.optionLeg.allocation;

  const scenarioSeries = timeSeriesDates.map((date) => {
    const remainingDays = Math.max(
      differenceInDays(date, new Date(`${config.optionLeg.expiry}T00:00:00.000Z`)),
      0
    );
    const elapsedDays = daysToExpiry - remainingDays;
    const timeToExpiryYears = Math.max(remainingDays / 365, 1 / 365);
    const theoreticalPrice = blackScholesCall({
      spot: targetOptionSpot,
      strike: config.optionLeg.strike,
      timeToExpiryYears,
      volatility: impliedVolatility,
      riskFreeRate: config.optionLeg.riskFreeRate
    });
    const greekApproximation = projectOptionPriceWithGreeks({
      currentPremium: premium,
      currentSpot: currentOptionSpot,
      targetSpot: targetOptionSpot,
      greeks,
      elapsedDays,
      volatilityShock: clamp(impliedVolatility * 0.12, 0.04, 0.18)
    });
    const maxProjectedOptionPrice = Math.max(
      theoreticalPrice,
      greekApproximation,
      targetOptionSpot - config.optionLeg.strike,
      0
    );
    const profitIfHit =
      yesContracts * config.yesLeg.payoutOnYes - shortCallUnits * theoreticalPrice + premiumCollected;
    const stressProfit =
      yesContracts * config.yesLeg.payoutOnYes -
      shortCallUnits * maxProjectedOptionPrice +
      premiumCollected;

    return {
      date: toIsoDate(date),
      theoreticalOptionPrice: formatNumber(theoreticalPrice, 4),
      greekApproximation: formatNumber(greekApproximation, 4),
      maxProjectedOptionPrice: formatNumber(maxProjectedOptionPrice, 4),
      projectedProfit: formatNumber(profitIfHit, 2),
      stressProfit: formatNumber(stressProfit, 2),
      remainingDays
    };
  });

  const terminalScenario = scenarioSeries[scenarioSeries.length - 1];

  return {
    id: config.id,
    label: config.name,
    assumptions: [
      "Binary YES leg is marked at full payout when the target condition is reached.",
      "Option leg uses Black-Scholes plus a Greek-based upper-band estimate from delta, gamma, vega, and theta.",
      "ETF proxy target price is derived from the current ETF-to-underlying ratio."
    ],
    marketReference: polymarketMarket
      ? {
          question: polymarketMarket.question,
          url: polymarketMarket.url,
          yesPrice: polymarketMarket.yesPrice,
          endDate: polymarketMarket.endDate
        }
      : null,
    quoteContext: {
      currentUnderlyingSpot: formatNumber(currentUnderlyingSpot, 2),
      currentOptionSpot: formatNumber(currentOptionSpot, 2),
      targetUnderlyingValue: formatNumber(targetUnderlyingValue, 2),
      targetOptionSpot: formatNumber(targetOptionSpot, 2),
      conversionRatio: formatNumber(conversionRatio, 6)
    },
    sizing: {
      bankroll: config.bankroll,
      yesAllocation: config.yesLeg.allocation,
      yesPrice: config.yesLeg.price,
      yesContracts,
      shortCallAllocation: config.optionLeg.allocation,
      optionPremium: formatNumber(premium, 4),
      shortCallUnits,
      premiumCollected: formatNumber(premiumCollected, 2)
    },
    greeks: {
      delta: formatNumber(greeks.delta, 4),
      gamma: formatNumber(greeks.gamma, 6),
      vega: formatNumber(greeks.vega, 4),
      thetaPerDay: formatNumber(greeks.thetaPerDay, 4)
    },
    optionCandidates,
    timeline: scenarioSeries,
    headline: {
      projectedProfitAtExpiry: terminalScenario?.projectedProfit ?? null,
      stressProfitAtExpiry: terminalScenario?.stressProfit ?? null,
      projectedMaxOptionPriceAtExpiry: terminalScenario?.maxProjectedOptionPrice ?? null,
      exampleProfitFromPrompt: formatNumber(
        config.yesLeg.allocation / config.yesLeg.price -
          (config.optionLeg.allocation / config.optionLeg.premium) * 0.45 +
          config.optionLeg.allocation,
        7
      )
    }
  };
}

function scoreOpportunity(scenario) {
  const finalPoint = scenario.timeline[scenario.timeline.length - 1];
  const peakPoint = scenario.timeline.reduce((best, point) =>
    (point.projectedProfit ?? -Infinity) > (best.projectedProfit ?? -Infinity) ? point : best
  );

  return {
    projectedProfitAtExpiry: finalPoint?.projectedProfit ?? -Infinity,
    peakProjectedProfit: peakPoint?.projectedProfit ?? -Infinity
  };
}

export async function buildStrategySummary({
  quotes,
  polymarketMarkets,
  optionMatches
}) {
  const primaryMarket =
    polymarketMarkets.find((market) => {
      const question = market.question.toLowerCase();
      return (question.includes("bitcoin") || question.includes("btc")) && parseTargetFromQuestion(market.question);
    }) ?? null;
  const primaryScenario = buildScenarioFromConfig({
    config: defaultStrategyConfig,
    quotes,
    polymarketMarket: primaryMarket,
    optionCandidates: optionMatches
  });

  return {
    ...primaryScenario,
    finder: buildStrategyFinder({
      quotes,
      polymarketMarkets,
      optionMatches
    }),
    scanUniverse: buildAssetScans({
      quotes,
      polymarketMarkets,
      optionMatches
    })
  };
}

function buildAssetScans({
  quotes,
  polymarketMarkets,
  optionMatches
}) {
  const quoteMap = quoteLookup(quotes);
  const fallbackVolatility = {
    btc: 0.46,
    eth: 0.58,
    gold: 0.18,
    oil: 0.32,
    stocks: 0.22
  };

  return strategyAssetUniverse
    .map((asset) => {
      const matches = polymarketMarkets.filter((market) => {
        const question = market.question.toLowerCase();
        return asset.polymarketQueries.some((query) => question.includes(query.split(" ")[0]));
      });

      const optionQuote = quoteMap.get(asset.optionSymbol);
      const underlyingQuote = quoteMap.get(asset.underlyingSymbol);
      const currentOptionSpot = getQuotePrice(optionQuote);
      const currentUnderlyingSpot = getQuotePrice(underlyingQuote);
      const liveOptions = optionMatches.filter((option) => option.rootSymbol === asset.optionSymbol);
      const hasAssetQuoteSizeData = liveOptions.some((option) => hasUsableQuoteSize(option));

      const opportunities = matches
        .slice(0, 3)
        .map((market) => {
          const parsedTarget = parseTargetFromQuestion(market.question);
          const targetValue = parsedTarget || 0;
          const ratio =
            currentUnderlyingSpot > 0 && currentOptionSpot > 0
              ? currentOptionSpot / currentUnderlyingSpot
              : asset.conversionFallback;
          const proxyTarget = Math.max(targetValue * ratio, currentOptionSpot || 0);
          const optionUniverse = getOptionUniverseForMarket({
            asset,
            market,
            liveOptions,
            currentOptionSpot,
            currentUnderlyingSpot,
            fallbackVolatility: fallbackVolatility[asset.id] || 0.25,
            optionType: "call"
          }).filter(
            (option) =>
              !hasAssetQuoteSizeData ||
              quoteSizeMeetsThreshold(option, DEFAULT_TARGET_OPTION_QUOTE_SIZE_THRESHOLD)
          );
          const option = optionUniverse
            .sort((left, right) => {
              const leftDistance = Math.abs(
                pickOptionReferencePrice(left, left.projectedTargetPrice ?? 0) - 0.45
              );
              const rightDistance = Math.abs(
                pickOptionReferencePrice(right, right.projectedTargetPrice ?? 0) - 0.45
              );
              if (leftDistance !== rightDistance) {
                return leftDistance - rightDistance;
              }

              return Math.abs(left.strike - proxyTarget) - Math.abs(right.strike - proxyTarget);
            })[0];

          if (!parsedTarget || !option || !proxyTarget || !market.yesPrice) {
            return null;
          }

          const optionReferencePrice = pickOptionReferencePrice(option, option.projectedTargetPrice ?? 0);

          const timeToExpiryYears = Math.max(
            differenceInDays(
              new Date(),
              new Date(`${option.expiration}T00:00:00.000Z`)
            ) / 365,
            1 / 365
          );
          const theoreticalPrice = blackScholesCall({
            spot: proxyTarget,
            strike: option.strike,
            timeToExpiryYears,
            volatility: option.impliedVolatility || 0.55,
            riskFreeRate: 0.0425
          });

          const grossYesUnits = market.yesPrice ? 1000 / market.yesPrice : 0;
          const shortUnits = optionReferencePrice ? 1000 / optionReferencePrice : 0;
          const projectedProfit = grossYesUnits - shortUnits * theoreticalPrice + 1000;

          return {
            asset: asset.label,
            question: market.question,
            url: market.url,
            yesPrice: formatNumber(market.yesPrice, 4),
            optionSymbol: asset.optionSymbol,
            optionReference: asset.referenceSymbol,
            optionStrike: option.strike,
            optionExpiry: option.expiration,
            liveOptionPrice: formatNumber(optionReferencePrice, 4),
            optionPriceSource: option.isModeled ? "modeled" : "live",
            theoreticalOptionPriceAtTarget: formatNumber(theoreticalPrice, 4),
            targetUnderlyingValue: formatNumber(targetValue, 2),
            projectedProxyTarget: formatNumber(proxyTarget, 2),
            projectedProfit: formatNumber(projectedProfit, 2)
          };
        })
        .filter(Boolean)
        .sort((left, right) => (right.projectedProfit ?? -Infinity) - (left.projectedProfit ?? -Infinity));

      return {
        id: asset.id,
        label: asset.label,
        optionSymbol: asset.optionSymbol,
        opportunities
      };
    })
    .filter((asset) => asset.opportunities.length > 0)
    .sort((left, right) => {
      const leftScore = scoreOpportunity({ timeline: left.opportunities.map((opportunity) => ({
        projectedProfit: opportunity.projectedProfit
      })) });
      const rightScore = scoreOpportunity({ timeline: right.opportunities.map((opportunity) => ({
        projectedProfit: opportunity.projectedProfit
      })) });

      return rightScore.peakProjectedProfit - leftScore.peakProjectedProfit;
    });
}
