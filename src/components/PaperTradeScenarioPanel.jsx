import { useEffect, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import ScenarioHeatmap from "./ScenarioHeatmap.jsx";
import { getChartPalette } from "../theme.js";

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

function blackScholesPrice({ type, spot, strike, timeYears, volatility, riskFreeRate }) {
  if (!(spot > 0) || !(strike > 0)) {
    return 0;
  }

  if (timeYears <= 0) {
    return type === "put" ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  }

  const sqrtT = Math.sqrt(timeYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeYears);

  if (type === "put") {
    return discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1);
  }

  return spot * normalCdf(d1) - discountedStrike * normalCdf(d2);
}

function binaryCallPrice({ spot, strike, timeYears, volatility, riskFreeRate }) {
  if (timeYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return spot >= strike ? 1 : 0;
  }

  const sqrtT = Math.sqrt(timeYears);
  const d2 =
    (Math.log(spot / strike) + (riskFreeRate - 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);

  return Math.exp(-riskFreeRate * timeYears) * normalCdf(d2);
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

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function differenceInDays(startValue, endValue) {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);

  if (!start || !end) {
    return 0;
  }

  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function addDays(dateValue, days) {
  const date = parseIsoDate(dateValue);
  if (!date) {
    return "";
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function clampIsoDate(value, min, max) {
  if (!value) {
    return min || max || "";
  }

  if (min && value < min) {
    return min;
  }

  if (max && value > max) {
    return max;
  }

  return value;
}

function minIsoDate(values) {
  const dates = values.filter(Boolean).sort();
  return dates[0] ?? "";
}

function formatCurrency(value, currency = "USD", digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(Number(value));
}

function formatAbsoluteCurrency(value, currency = "USD", digits = 2) {
  return formatCurrency(Math.abs(Number(value) || 0), currency, digits);
}

function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return Number(value).toFixed(digits);
}

function getPolymarketEventUrl(url) {
  const normalizedUrl = String(url ?? "").trim();
  return normalizedUrl.startsWith("https://polymarket.com/event/") ? normalizedUrl : "";
}

function derivePolymarketEventSlug(url) {
  const eventUrl = getPolymarketEventUrl(url);
  if (!eventUrl) {
    return "";
  }

  const match = eventUrl.match(/^https:\/\/polymarket\.com\/event\/([^/?#]+)/i);
  return match?.[1] ?? "";
}

function buildPolymarketReferenceLine({ marketId, marketSlug, eventSlug, url, source }) {
  const parts = [];
  const derivedEventSlug = eventSlug || derivePolymarketEventSlug(url);

  if (marketId) {
    parts.push(`ID ${marketId}`);
  }

  if (marketSlug) {
    parts.push(`slug ${marketSlug}`);
  }

  if (derivedEventSlug) {
    parts.push(`event ${derivedEventSlug}`);
  }

  if (parts.length) {
    return parts.join(" · ");
  }

  return source === "seed" ? "Seed fallback market · no live slug/event yet" : "";
}

function formatDateLabel(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function formatShortDate(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short"
  }).format(date);
}

function formatDateTimeLabel(value) {
  if (!value) {
    return "n/a";
  }

  const normalizedValue =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatUnderlyingLabel(symbol, fallback = "Underlying") {
  const explicitLabels = {
    "BTC-USD": "Bitcoin",
    "ETH-USD": "Ethereum",
    "SPX-INDEX": "SPX index",
    "XAU-USD": "Gold",
    "WTI-USD": "WTI"
  };

  if (explicitLabels[symbol]) {
    return explicitLabels[symbol];
  }

  if (!symbol) {
    return fallback;
  }

  if (symbol.endsWith("-USD")) {
    return symbol.replace("-USD", "");
  }

  if (symbol.endsWith("-INDEX")) {
    return `${symbol.replace("-INDEX", "")} index`;
  }

  return symbol;
}

function determineStepFromRange(min, max) {
  const range = Math.max(max - min, 0);

  if (range > 10000) {
    return 100;
  }

  if (range > 1000) {
    return 10;
  }

  if (range > 100) {
    return 1;
  }

  if (range > 25) {
    return 0.1;
  }

  return 0.01;
}

function buildSpotEvaluationGrid({ start, end, targetThreshold, optionLegs }) {
  const denseSteps = 48;
  const epsilon = Math.max((end - start) / 400, 0.01);
  const denseGrid = Array.from(
    { length: denseSteps },
    (_value, index) => start + (((end - start) / (denseSteps - 1)) * index)
  );
  const criticalSpots = [
    targetThreshold - epsilon,
    targetThreshold,
    targetThreshold + epsilon,
    ...optionLegs.flatMap((leg) => [Number(leg.strike) - epsilon, Number(leg.strike), Number(leg.strike) + epsilon])
  ];

  return [...denseGrid, ...criticalSpots]
    .filter((spot) => Number.isFinite(spot) && spot >= start && spot <= end)
    .map((spot) => Number(spot.toFixed(4)))
    .filter((spot, index, array) => array.indexOf(spot) === index)
    .sort((left, right) => left - right);
}

function buildPayoffEvaluationRange({ currentSpot, targetThreshold, optionLegs }) {
  const optionStrikes = optionLegs
    .map((leg) => Number(leg.strike))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const referenceHigh = Math.max(currentSpot, targetThreshold, ...optionStrikes, 1);

  return {
    start: 0,
    end: Math.max(referenceHigh * 1.75, referenceHigh + 10, 25)
  };
}

function binaryPriceFromYes(outcome, yesPrice) {
  return outcome === "NO" ? 1 - yesPrice : yesPrice;
}

function binaryPnL({ action, entryPrice, markPrice, quantity }) {
  return (action === "LONG" ? markPrice - entryPrice : entryPrice - markPrice) * quantity;
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
          timeYears: effectiveTimeYears,
          volatility,
          riskFreeRate
        })
      : marketReferenceYesPrice;
  const currentModeledYesPrice =
    strike > 0 && currentSpot > 0
      ? binaryCallPrice({
          spot: currentSpot,
          strike,
          timeYears: effectiveCurrentTimeYears,
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
    logistic(logit(clampProbability(rawEstimatedYesPrice)) + (modelCalibration * calibrationWeight)),
    0.001,
    0.999
  );
}

function serializeScenarioOrder(order) {
  return {
    id: order.id,
    combinationLabel: order.combinationLabel,
    assetLabel: order.assetLabel,
    strategyType: order.strategyType,
    purchaseDate: order.purchaseDate,
    createdAt: order.createdAt,
    closedAt: order.closedAt,
    status: order.status,
    polymarketMarketId: order.polymarketMarketId ?? "",
    polymarketMarketSlug: order.polymarketMarketSlug ?? "",
    polymarketEventSlug: order.polymarketEventSlug ?? "",
    polymarketQuestion: order.polymarketQuestion,
    polymarketUrl: order.polymarketUrl,
    strategyCloseDate: order.strategyCloseDate,
    polymarketResolutionDate: order.polymarketResolutionDate,
    marketReferenceYesPrice: order.marketReferenceYesPrice ?? order.valuationContext?.currentYesPrice ?? 0.5,
    valuationContext: {
      proxySymbol: order.valuationContext?.proxySymbol ?? "",
      underlyingSymbol: order.valuationContext?.underlyingSymbol ?? "",
      currentProxySpot: Number(order.valuationContext?.currentProxySpot ?? 0),
      currentUnderlyingSpot: Number(order.valuationContext?.currentUnderlyingSpot ?? 0),
      conversionRatio: Number(order.valuationContext?.conversionRatio ?? 0),
      targetUnderlyingValue: Number(order.valuationContext?.targetUnderlyingValue ?? 0),
      currentYesPrice: Number(order.valuationContext?.currentYesPrice ?? 0.5)
    },
    legs: (order.legs ?? []).map((leg) => ({
      id: leg.id,
      label: leg.label,
      kind: leg.kind,
      action: leg.action,
      quantity: Number(leg.quantity ?? 0),
      entryPrice: Number(leg.entryPrice ?? 0),
      polymarketMarketId: leg.polymarketMarketId ?? "",
      contractMultiplier: Number(leg.contractMultiplier ?? 100),
      optionType: leg.optionType ?? null,
      expiry: leg.expiry ?? "",
      strike: Number(leg.strike ?? 0),
      contractSymbol: leg.contractSymbol ?? "",
      rootSymbol: leg.rootSymbol ?? "",
      impliedVolatility: Number(leg.impliedVolatility ?? 0) || null,
      riskFreeRate: Number(leg.riskFreeRate ?? 0.0425) || 0.0425,
      quoteSource: leg.quoteSource ?? "",
      isLive: leg.isLive === true,
      outcome: leg.outcome ?? null
    }))
  };
}

function buildDefaultControls(order, referenceTimestamp, snapshotControls = null) {
  const strategyCloseDate =
    minIsoDate([order.polymarketResolutionDate, ...(order.legs ?? []).map((leg) => leg.expiry)]) ||
    order.strategyCloseDate ||
    order.polymarketResolutionDate ||
    referenceTimestamp?.slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  const marketDate = referenceTimestamp?.slice(0, 10) || order.purchaseDate || new Date().toISOString().slice(0, 10);
  const defaultVolatility =
    ((order.legs ?? []).find((leg) => leg.kind === "option")?.impliedVolatility ?? 0.24) * 100;

  return {
    valuationDate:
      snapshotControls?.valuationDate ??
      clampIsoDate(marketDate, marketDate <= strategyCloseDate ? marketDate : strategyCloseDate, strategyCloseDate),
    underlyingPrice:
      snapshotControls?.underlyingPrice ??
      String(Number(order.valuationContext?.currentProxySpot ?? 0) || 0),
    impliedVolatility: snapshotControls?.impliedVolatility ?? String(Number(defaultVolatility.toFixed(2)))
  };
}

export default function PaperTradeScenarioPanel({
  order,
  lastUpdated,
  onSaveCalculatorSnapshot,
  theme = "dark"
}) {
  const chartTheme = getChartPalette(theme);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeSnapshotId, setActiveSnapshotId] = useState(null);
  const [controls, setControls] = useState(() => buildDefaultControls(order, lastUpdated));
  const [chartMode, setChartMode] = useState("date");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [chartPanelHeight, setChartPanelHeight] = useState(null);
  const mainLayoutRef = useRef(null);
  const sliderStackRef = useRef(null);
  const snapshots = order.calculatorSnapshots ?? [];
  const activeSnapshot =
    snapshots.find((snapshot) => String(snapshot.id) === String(activeSnapshotId)) ?? null;
  const scenarioOrder = activeSnapshot?.payload?.orderSnapshot ?? serializeScenarioOrder(order);
  const scenarioPolymarketEventUrl = getPolymarketEventUrl(scenarioOrder.polymarketUrl);
  const polymarketReferenceLine = buildPolymarketReferenceLine({
    marketId: scenarioOrder.polymarketMarketId,
    marketSlug: scenarioOrder.polymarketMarketSlug,
    eventSlug: scenarioOrder.polymarketEventSlug,
    url: scenarioOrder.polymarketUrl,
    source: scenarioOrder.polymarketSource
  });

  useEffect(() => {
    setActiveSnapshotId(null);
    setControls(buildDefaultControls(order, lastUpdated));
    setFeedback(null);
    setSavingSnapshot(false);
  }, [order.id]);

  useEffect(() => {
    if (!panelOpen || typeof window === "undefined") {
      setChartPanelHeight(null);
      return undefined;
    }

    const mainNode = mainLayoutRef.current;
    const sliderNode = sliderStackRef.current;

    if (!mainNode || !sliderNode) {
      setChartPanelHeight(null);
      return undefined;
    }

    let frameId = 0;

    const updateHeight = () => {
      if (window.innerWidth <= 1240) {
        setChartPanelHeight(null);
        return;
      }

      const nextHeight = Math.max(sliderNode.offsetHeight, 320);
      setChartPanelHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateHeight);
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);

    resizeObserver?.observe(mainNode);
    resizeObserver?.observe(sliderNode);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
    };
  }, [panelOpen, order.id, activeSnapshotId]);

  const optionLegs = (scenarioOrder.legs ?? []).filter((leg) => leg.kind === "option");
  const polymarketLegs = (scenarioOrder.legs ?? []).filter((leg) => leg.kind === "binary");
  const strategyCloseDate =
    minIsoDate([scenarioOrder.polymarketResolutionDate, ...optionLegs.map((leg) => leg.expiry)]) ||
    scenarioOrder.strategyCloseDate ||
    scenarioOrder.polymarketResolutionDate ||
    lastUpdated?.slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  const marketDate =
    activeSnapshot?.createdAt?.slice(0, 10) ||
    (scenarioOrder.status === "closed" ? scenarioOrder.closedAt?.slice(0, 10) : null) ||
    lastUpdated?.slice(0, 10) ||
    strategyCloseDate;
  const valuationMinDate = marketDate <= strategyCloseDate ? marketDate : strategyCloseDate;
  const valuationDate = clampIsoDate(controls.valuationDate, valuationMinDate, strategyCloseDate);
  const maxDateOffset = Math.max(differenceInDays(valuationMinDate, strategyCloseDate), 0);
  const currentDateOffset = clamp(differenceInDays(valuationMinDate, valuationDate), 0, maxDateOffset);
  const currentProxySpot = Number(scenarioOrder.valuationContext?.currentProxySpot ?? 0);
  const currentUnderlyingSpot = Number(scenarioOrder.valuationContext?.currentUnderlyingSpot ?? 0);
  const converterRatio =
    Number(scenarioOrder.valuationContext?.conversionRatio ?? 0) ||
    (currentUnderlyingSpot > 0 && currentProxySpot > 0 ? currentProxySpot / currentUnderlyingSpot : 0);
  const targetUnderlyingValue = Number(scenarioOrder.valuationContext?.targetUnderlyingValue ?? 0);
  const rawUnderlyingPrice = Number(controls.underlyingPrice ?? currentProxySpot ?? 0);
  const impliedVolatility = Number(controls.impliedVolatility ?? 24) / 100;
  const riskFreeRate =
    Number(optionLegs[0]?.riskFreeRate ?? order.legs?.find((leg) => leg.kind === "option")?.riskFreeRate ?? 0.0425) || 0.0425;
  const payoffTargetProxy =
    targetUnderlyingValue > 0 && converterRatio > 0 ? targetUnderlyingValue * converterRatio : targetUnderlyingValue;
  const payoffRange = buildPayoffEvaluationRange({
    currentSpot: currentProxySpot || rawUnderlyingPrice,
    targetThreshold: payoffTargetProxy,
    optionLegs
  });
  const spotMin = Math.max(Number(payoffRange.start.toFixed(2)), 0.01);
  const spotMax = Math.max(Number(payoffRange.end.toFixed(2)), spotMin + 1);
  const spotStep = spotMax - spotMin > 250 ? 1 : 0.1;
  const proxySpotDigits = spotStep >= 1 ? 0 : 2;
  const underlyingPrice = clamp(
    Number.isFinite(rawUnderlyingPrice) ? rawUnderlyingPrice : currentProxySpot || spotMin,
    spotMin,
    spotMax
  );
  const equivalentUnderlyingSpot = converterRatio > 0 ? underlyingPrice / converterRatio : underlyingPrice;
  const actualSpotMin =
    converterRatio > 0 ? Math.max(Number((spotMin / converterRatio).toFixed(2)), 0.01) : spotMin;
  const actualSpotMax =
    converterRatio > 0 ? Math.max(Number((spotMax / converterRatio).toFixed(2)), actualSpotMin + 1) : spotMax;
  const actualSpotStep = determineStepFromRange(actualSpotMin, actualSpotMax);
  const actualSpotDigits = actualSpotStep >= 1 ? 0 : 2;
  const proxySpotLabel = scenarioOrder.valuationContext?.proxySymbol || scenarioOrder.assetLabel || "Proxy";
  const actualSpotLabel = formatUnderlyingLabel(
    scenarioOrder.valuationContext?.underlyingSymbol,
    scenarioOrder.assetLabel || "Underlying"
  );
  const daysToMarketResolution = Math.max(differenceInDays(valuationDate, scenarioOrder.polymarketResolutionDate), 0);
  const currentDaysToMarketResolution = Math.max(
    differenceInDays(marketDate || valuationDate, scenarioOrder.polymarketResolutionDate),
    0
  );
  const timeToMarketResolutionYears = daysToMarketResolution / 365;
  const currentTimeToMarketResolutionYears = currentDaysToMarketResolution / 365;
  const referenceYesLeg = polymarketLegs.find((leg) => leg.outcome === "YES") ?? null;
  const referenceNoLeg = polymarketLegs.find((leg) => leg.outcome === "NO") ?? null;
  const marketReferenceYesPrice = Number(
    scenarioOrder.marketReferenceYesPrice ??
      referenceYesLeg?.entryPrice ??
      (referenceNoLeg ? 1 - Number(referenceNoLeg.entryPrice) : scenarioOrder.valuationContext?.currentYesPrice ?? 0.5)
  );
  const estimatedYesPrice = estimatePolymarketYesPrice({
    spot: equivalentUnderlyingSpot,
    strike: targetUnderlyingValue,
    timeYears: timeToMarketResolutionYears,
    volatility: impliedVolatility,
    riskFreeRate,
    marketReferenceYesPrice,
    currentSpot: currentUnderlyingSpot,
    currentTimeYears: currentTimeToMarketResolutionYears
  });

  const repricedOptionLegs = optionLegs.map((leg) => {
    const contractUnits = Number(leg.quantity ?? 0) * Number(leg.contractMultiplier ?? 100);
    const daysToExpiry = Math.max(
      Math.round(
        (new Date(`${leg.expiry}T00:00:00.000Z`).getTime() -
          new Date(`${valuationDate}T00:00:00.000Z`).getTime()) /
          (24 * 60 * 60 * 1000)
      ),
      0
    );
    const timeYears = Math.max(daysToExpiry / 365, 1 / 365);
    const modelPrice = blackScholesPrice({
      type: leg.optionType,
      spot: underlyingPrice,
      strike: Number(leg.strike),
      timeYears,
      volatility: impliedVolatility,
      riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate
    });
    const entryPrice = Number(leg.entryPrice ?? 0);
    const pnlPerUnit = leg.action === "LONG" ? modelPrice - entryPrice : entryPrice - modelPrice;
    const pnl = pnlPerUnit * contractUnits;
    const markValue = (leg.action === "LONG" ? 1 : -1) * modelPrice * contractUnits;
    const entryValue = (leg.action === "LONG" ? 1 : -1) * entryPrice * contractUnits;

    return {
      ...leg,
      contractUnits,
      modelPrice,
      daysToExpiry,
      pnl,
      markValue,
      entryValue
    };
  });

  const repricedPolymarketLegs = polymarketLegs.map((leg) => {
    const entryPrice = Number(leg.entryPrice ?? 0);
    const quantity = Number(leg.quantity ?? 0);
    const modelPrice = binaryPriceFromYes(leg.outcome, estimatedYesPrice);
    const pnl = binaryPnL({
      action: leg.action,
      entryPrice,
      markPrice: modelPrice,
      quantity
    });
    const markValue = (leg.action === "LONG" ? 1 : -1) * modelPrice * quantity;
    const entryValue = (leg.action === "LONG" ? 1 : -1) * entryPrice * quantity;

    return {
      ...leg,
      modelPrice,
      pnl,
      markValue,
      entryValue
    };
  });

  const optionsPnL = repricedOptionLegs.reduce((sum, leg) => sum + leg.pnl, 0);
  const polymarketPnL = repricedPolymarketLegs.reduce((sum, leg) => sum + leg.pnl, 0);
  const optionsMarkedValue = repricedOptionLegs.reduce((sum, leg) => sum + leg.markValue, 0);
  const optionsEntryValue = repricedOptionLegs.reduce((sum, leg) => sum + leg.entryValue, 0);
  const polymarketMarkedValue = repricedPolymarketLegs.reduce((sum, leg) => sum + leg.markValue, 0);
  const polymarketEntryValue = repricedPolymarketLegs.reduce((sum, leg) => sum + leg.entryValue, 0);
  const initialInvestment = optionsEntryValue + polymarketEntryValue;
  const currentMarkedValue = optionsMarkedValue + polymarketMarkedValue;
  const totalPnL = optionsPnL + polymarketPnL;

  const spotEvaluationGrid = buildSpotEvaluationGrid({
    start: payoffRange.start,
    end: spotMax,
    targetThreshold: payoffTargetProxy,
    optionLegs: repricedOptionLegs
  });
  const daysToMarketResolutionAtClose = Math.max(
    differenceInDays(strategyCloseDate, scenarioOrder.polymarketResolutionDate),
    0
  );
  const spotPayoffSeries = spotEvaluationGrid.map((spot) => {
    const optionPnL = repricedOptionLegs.reduce((sum, leg) => {
      const optionRemainingDaysAtClose = Math.max(differenceInDays(strategyCloseDate, leg.expiry), 0);
      const optionMarkPrice =
        optionRemainingDaysAtClose > 0
          ? blackScholesPrice({
              type: leg.optionType,
              spot,
              strike: Number(leg.strike),
              timeYears: Math.max(optionRemainingDaysAtClose / 365, 1 / 365),
              volatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
              riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate
            })
          : leg.optionType === "put"
            ? Math.max(Number(leg.strike) - spot, 0)
            : Math.max(spot - Number(leg.strike), 0);
      const pnlPerUnit = leg.action === "LONG" ? optionMarkPrice - Number(leg.entryPrice ?? 0) : Number(leg.entryPrice ?? 0) - optionMarkPrice;

      return sum + (pnlPerUnit * leg.contractUnits);
    }, 0);
    const settleUnderlying = converterRatio > 0 ? spot / converterRatio : spot;
    const binaryPnLAtSpot = repricedPolymarketLegs.reduce((sum, leg) => {
      const settlePrice =
        leg.outcome === "NO"
          ? targetUnderlyingValue > 0 && settleUnderlying < targetUnderlyingValue
            ? 1
            : 0
          : targetUnderlyingValue > 0 && settleUnderlying >= targetUnderlyingValue
            ? 1
            : 0;
      const markPrice =
        daysToMarketResolutionAtClose > 0
          ? binaryPriceFromYes(
              leg.outcome,
              estimatePolymarketYesPrice({
                spot: settleUnderlying,
                strike: targetUnderlyingValue,
                timeYears: daysToMarketResolutionAtClose / 365,
                volatility: impliedVolatility,
                riskFreeRate,
                marketReferenceYesPrice,
                currentSpot: currentUnderlyingSpot,
                currentTimeYears: currentTimeToMarketResolutionYears
              })
            )
          : settlePrice;

      return sum + binaryPnL({
        action: leg.action,
        entryPrice: Number(leg.entryPrice ?? 0),
        markPrice,
        quantity: Number(leg.quantity ?? 0)
      });
    }, 0);

    return {
      spot: formatNumber(spot, 2),
      totalPnL: formatNumber(optionPnL + binaryPnLAtSpot, 2)
    };
  });

  const dateProfitSeries = [];
  if (valuationMinDate && strategyCloseDate) {
    let cursor = parseIsoDate(valuationMinDate);
    const endDate = parseIsoDate(strategyCloseDate);

    while (cursor && endDate && cursor.getTime() <= endDate.getTime()) {
      const dateIso = toIsoDate(cursor);
      const optionsValue = repricedOptionLegs.reduce((sum, leg) => {
        const optionRemainingDays = Math.max(differenceInDays(dateIso, leg.expiry), 0);
        const modelPrice = blackScholesPrice({
          type: leg.optionType,
          spot: underlyingPrice,
          strike: Number(leg.strike),
          timeYears: Math.max(optionRemainingDays / 365, 1 / 365),
          volatility: impliedVolatility,
          riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate
        });
        const pnlPerUnit =
          leg.action === "LONG" ? modelPrice - Number(leg.entryPrice ?? 0) : Number(leg.entryPrice ?? 0) - modelPrice;

        return sum + (pnlPerUnit * leg.contractUnits);
      }, 0);

      const remainingPolymarketDays = Math.max(differenceInDays(dateIso, scenarioOrder.polymarketResolutionDate), 0);
      const timelineYesPrice = estimatePolymarketYesPrice({
        spot: equivalentUnderlyingSpot,
        strike: targetUnderlyingValue,
        timeYears: remainingPolymarketDays / 365,
        volatility: impliedVolatility,
        riskFreeRate,
        marketReferenceYesPrice,
        currentSpot: currentUnderlyingSpot,
        currentTimeYears: currentTimeToMarketResolutionYears
      });
      const timelineBinaryPnL = repricedPolymarketLegs.reduce((sum, leg) => {
        const timelineMarkPrice = binaryPriceFromYes(leg.outcome, timelineYesPrice);
        return sum + binaryPnL({
          action: leg.action,
          entryPrice: Number(leg.entryPrice ?? 0),
          markPrice: timelineMarkPrice,
          quantity: Number(leg.quantity ?? 0)
        });
      }, 0);

      dateProfitSeries.push({
        date: dateIso,
        dateLabel: formatShortDate(dateIso),
        totalPnL: formatNumber(optionsValue + timelineBinaryPnL, 2)
      });

      cursor = addDays(dateIso, 1) ? parseIsoDate(addDays(dateIso, 1)) : null;
    }
  }

  const chartData = chartMode === "date" ? dateProfitSeries : spotPayoffSeries;
  const chartXAxisKey = chartMode === "date" ? "dateLabel" : "spot";
  const chartValues = chartData.map((point) => Number(point.totalPnL)).filter((value) => Number.isFinite(value));
  const chartMin = chartValues.length ? Math.min(...chartValues) : -1;
  const chartMax = chartValues.length ? Math.max(...chartValues) : 1;
  const chartRange = Math.max(chartMax - chartMin, 1);
  const chartDomain = [chartMin - Math.max(chartRange * 0.08, 20), chartMax + Math.max(chartRange * 0.08, 20)];

  function calculateHeatmapPnL({ spot, date }) {
    const optionPnL = repricedOptionLegs.reduce((sum, leg) => {
      const remainingDays = Math.max(differenceInDays(date, leg.expiry), 0);
      const optionMarkPrice =
        remainingDays > 0
          ? blackScholesPrice({
              type: leg.optionType,
              spot,
              strike: Number(leg.strike),
              timeYears: remainingDays / 365,
              volatility: impliedVolatility,
              riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate
            })
          : leg.optionType === "put"
            ? Math.max(Number(leg.strike) - spot, 0)
            : Math.max(spot - Number(leg.strike), 0);
      const pnlPerUnit =
        leg.action === "LONG" ? optionMarkPrice - Number(leg.entryPrice ?? 0) : Number(leg.entryPrice ?? 0) - optionMarkPrice;

      return sum + pnlPerUnit * leg.contractUnits;
    }, 0);
    const settleUnderlying = converterRatio > 0 ? spot / converterRatio : spot;
    const remainingPolymarketDays = Math.max(differenceInDays(date, scenarioOrder.polymarketResolutionDate), 0);
    const yesPrice =
      remainingPolymarketDays > 0
        ? estimatePolymarketYesPrice({
            spot: settleUnderlying,
            strike: targetUnderlyingValue,
            timeYears: remainingPolymarketDays / 365,
            volatility: impliedVolatility,
            riskFreeRate,
            marketReferenceYesPrice,
            currentSpot: currentUnderlyingSpot || equivalentUnderlyingSpot,
            currentTimeYears: currentTimeToMarketResolutionYears
          })
        : targetUnderlyingValue > 0
          ? settleUnderlying >= targetUnderlyingValue
            ? 1
            : 0
          : marketReferenceYesPrice;
    const binaryPnLAtDate = repricedPolymarketLegs.reduce(
      (sum, leg) =>
        sum +
        binaryPnL({
          action: leg.action,
          entryPrice: Number(leg.entryPrice ?? 0),
          markPrice: binaryPriceFromYes(leg.outcome, yesPrice),
          quantity: Number(leg.quantity ?? 0)
        }),
      0
    );

    return optionPnL + binaryPnLAtDate;
  }

  async function handleSaveSnapshot() {
    if (!onSaveCalculatorSnapshot) {
      return;
    }

    setSavingSnapshot(true);
    setFeedback(null);

    try {
      await onSaveCalculatorSnapshot(order.id, {
        snapshotName: order.combinationLabel,
        payload: {
          savedFromOrderId: order.id,
          orderSnapshot: serializeScenarioOrder(scenarioOrder),
          controls: {
            valuationDate,
            underlyingPrice: String(underlyingPrice),
            impliedVolatility: String(controls.impliedVolatility ?? "24")
          }
        }
      });

      setFeedback({
        tone: "success",
        message: "Calculator snapshot saved."
      });
      setPanelOpen(true);
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error.message
      });
    } finally {
      setSavingSnapshot(false);
    }
  }

  function handleLoadSnapshot(snapshot) {
    setActiveSnapshotId(snapshot.id);
    setControls(
      buildDefaultControls(
        snapshot.payload?.orderSnapshot ?? order,
        snapshot.createdAt ?? lastUpdated,
        snapshot.payload?.controls ?? null
      )
    );
    setPanelOpen(true);
    setFeedback({
      tone: "info",
      message: `Loaded snapshot from ${formatDateTimeLabel(snapshot.createdAt)}`
    });
  }

  function handleResetToLive() {
    setActiveSnapshotId(null);
    setControls(buildDefaultControls(order, lastUpdated));
    setFeedback(null);
  }

  return (
    <section className="paper-scenario-card">
      <div className="paper-scenario-card__header">
        <div>
          <span className="brand__eyebrow">Scenario calculator</span>
          {activeSnapshot ? (
            <span className="timestamp">
              Reviewing snapshot saved {formatDateTimeLabel(activeSnapshot.createdAt)}
            </span>
          ) : null}
        </div>
        <div className="paper-scenario-card__actions">
          <button
            type="button"
            className={`chart-toggle ${panelOpen ? "chart-toggle--active" : ""}`}
            onClick={() => setPanelOpen((current) => !current)}
          >
            {panelOpen ? "Hide calculator" : "Show calculator"}
          </button>
          <button
            type="button"
            className={`chart-toggle ${savingSnapshot ? "chart-toggle--active" : ""}`}
            onClick={handleSaveSnapshot}
            disabled={savingSnapshot || !onSaveCalculatorSnapshot}
          >
            {savingSnapshot ? "Saving..." : "Save snapshot"}
          </button>
          {activeSnapshot ? (
            <button type="button" className="chart-toggle" onClick={handleResetToLive}>
              Use live trade
            </button>
          ) : null}
        </div>
      </div>

      {snapshots.length ? (
        <div className="paper-scenario-card__snapshots">
          {snapshots.map((snapshot) => (
            <button
              key={snapshot.id}
              type="button"
              className={`chart-toggle ${String(activeSnapshotId) === String(snapshot.id) ? "chart-toggle--active" : ""}`}
              onClick={() => handleLoadSnapshot(snapshot)}
            >
              {snapshot.snapshotName} · {formatDateTimeLabel(snapshot.createdAt)}
            </button>
          ))}
        </div>
      ) : null}

      {feedback ? (
        <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
          <span>{feedback.message}</span>
        </div>
      ) : null}

      {panelOpen ? (
        <>
          <ScenarioHeatmap
            className="paper-scenario-card__heatmap"
            title="Time series heat map"
            description="P/L across dates and proxy price levels, centered on the current proxy spot. The default view shows a 1x implied-vol range, with quick 2x and 3x range filters available."
            startDate={valuationMinDate}
            endDate={strategyCloseDate}
            currentPrice={currentProxySpot || underlyingPrice}
            volatility={impliedVolatility}
            spotLabel={proxySpotLabel}
            priceDigits={proxySpotDigits}
            secondarySpotLabel={converterRatio > 0 ? actualSpotLabel : ""}
            secondaryPriceDigits={actualSpotDigits}
            getSecondarySpot={converterRatio > 0 ? (spot) => spot / converterRatio : null}
            getCellPnL={calculateHeatmapPnL}
            theme={theme}
          />
          <div className="calculator-studio paper-scenario-card__studio">
          <div ref={mainLayoutRef} className="paper-scenario-card__main">
            <div
              className="detail-chart paper-scenario-card__chart"
              style={chartPanelHeight ? { height: `${chartPanelHeight}px` } : undefined}
            >
              <div className="detail-chart__header">
                <div>
                  <span className="brand__eyebrow">Scenario chart</span>
                  <p className="detail-chart__copy">
                    {chartMode === "date"
                      ? "Date P&L holds the current proxy spot and volatility constant while repricing time decay."
                      : "Expiry payoff shows how P&L changes across proxy spot levels at the trade close."}
                  </p>
                </div>
                <div className="chart-toggle-group">
                  <button
                    type="button"
                    className={`chart-toggle ${chartMode === "date" ? "chart-toggle--active" : ""}`}
                    onClick={() => setChartMode("date")}
                  >
                    Date P&amp;L
                  </button>
                  <button
                    type="button"
                    className={`chart-toggle ${chartMode === "spot" ? "chart-toggle--active" : ""}`}
                    onClick={() => setChartMode("spot")}
                  >
                    Expiry payoff
                  </button>
                </div>
              </div>
              <div className="paper-scenario-card__chart-frame">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData}>
                    <CartesianGrid stroke={chartTheme.grid} />
                    <XAxis dataKey={chartXAxisKey} tick={{ fill: chartTheme.axis, fontSize: 11 }} />
                    <YAxis domain={chartDomain} tick={{ fill: chartTheme.axis, fontSize: 11 }} />
                    <Tooltip
                      formatter={(value) => formatCurrency(value)}
                      labelFormatter={(label, payload) =>
                        chartMode === "date"
                          ? payload?.[0]?.payload?.date
                            ? formatDateLabel(payload[0].payload.date)
                            : label
                          : `Proxy spot ${label}`
                      }
                      contentStyle={{
                        background: chartTheme.tooltipBackground,
                        border: `1px solid ${chartTheme.tooltipBorder}`,
                        borderRadius: "14px"
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="totalPnL"
                      stroke={chartTheme.strategyAreaStroke}
                      fill={chartTheme.strategyAreaFill}
                      strokeWidth={2.2}
                    />
                    <Line
                      type="monotone"
                      dataKey="totalPnL"
                      stroke={chartTheme.strategyLineStroke}
                      dot={false}
                      strokeWidth={1.5}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div ref={sliderStackRef} className="calculator-slider-stack paper-scenario-card__sliders">
              <div className="calculator-slider">
                <div className="calculator-slider__header">
                  <div>
                    <span>Valuation date</span>
                    <strong>{formatDateLabel(valuationDate)}</strong>
                  </div>
                  <input
                    className="calculator-slider__number calculator-slider__number--date"
                    type="date"
                    min={valuationMinDate}
                    max={strategyCloseDate}
                    value={valuationDate}
                    onChange={(event) =>
                      setControls((current) => ({ ...current, valuationDate: event.target.value }))
                    }
                  />
                </div>
                <input
                  className="calculator-slider__range"
                  type="range"
                  min="0"
                  max={maxDateOffset}
                  step="1"
                  value={currentDateOffset}
                  onChange={(event) =>
                    setControls((current) => ({
                      ...current,
                      valuationDate: addDays(valuationMinDate, Number(event.target.value))
                    }))
                  }
                />
                <div className="calculator-slider__scale">
                  <span>{formatDateLabel(valuationMinDate)}</span>
                  <span>{formatDateLabel(strategyCloseDate)}</span>
                </div>
              </div>

              <div className="calculator-slider">
                <div className="calculator-slider__header calculator-slider__header--market">
                  <div className="calculator-slider__market-values">
                    <div className="calculator-slider__market-pair">
                      <span>{proxySpotLabel}</span>
                      <strong>{formatCurrency(underlyingPrice, "USD", proxySpotDigits)}</strong>
                      <span>{actualSpotLabel}</span>
                      <strong>{formatCurrency(equivalentUnderlyingSpot, "USD", actualSpotDigits)}</strong>
                    </div>
                  </div>
                  <input
                    className="calculator-slider__number"
                    type="number"
                    min={spotMin}
                    max={spotMax}
                    step={spotStep}
                    value={formatNumber(underlyingPrice, proxySpotDigits)}
                    onChange={(event) =>
                      setControls((current) => ({ ...current, underlyingPrice: event.target.value }))
                    }
                  />
                </div>
                <input
                  className="calculator-slider__range"
                  type="range"
                  min={spotMin}
                  max={spotMax}
                  step={spotStep}
                  value={clamp(underlyingPrice, spotMin, spotMax)}
                  onChange={(event) =>
                    setControls((current) => ({ ...current, underlyingPrice: event.target.value }))
                  }
                />
                <div className="calculator-slider__scale">
                  <span>
                    {proxySpotLabel} {formatCurrency(spotMin, "USD", proxySpotDigits)} · {actualSpotLabel}{" "}
                    {formatCurrency(actualSpotMin, "USD", actualSpotDigits)}
                  </span>
                  <span>
                    {proxySpotLabel} {formatCurrency(spotMax, "USD", proxySpotDigits)} · {actualSpotLabel}{" "}
                    {formatCurrency(actualSpotMax, "USD", actualSpotDigits)}
                  </span>
                </div>
              </div>

              <div className="calculator-slider">
                <div className="calculator-slider__header">
                  <div>
                    <span>Presumed volatility</span>
                    <strong>{formatNumber(impliedVolatility * 100, 2)}%</strong>
                  </div>
                  <input
                    className="calculator-slider__number"
                    type="number"
                    min="5"
                    max="150"
                    step="0.5"
                    value={controls.impliedVolatility ?? ""}
                    onChange={(event) =>
                      setControls((current) => ({ ...current, impliedVolatility: event.target.value }))
                    }
                  />
                </div>
                <input
                  className="calculator-slider__range"
                  type="range"
                  min="5"
                  max="150"
                  step="0.5"
                  value={clamp(Number(controls.impliedVolatility ?? 24), 5, 150)}
                  onChange={(event) =>
                    setControls((current) => ({ ...current, impliedVolatility: event.target.value }))
                  }
                />
                <div className="calculator-slider__scale">
                  <span>5%</span>
                  <span>150%</span>
                </div>
              </div>

              {polymarketLegs.length ? (
                <div className="calculator-slider">
                  <div className="calculator-slider__header">
                    <div>
                      <span>Estimated Poly YES</span>
                      <strong>{formatNumber(estimatedYesPrice, 2)}</strong>
                    </div>
                    <div className="calculator-slider__hint">Time decay + spot calibration</div>
                  </div>
                  <input
                    className="calculator-slider__range"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={clamp(estimatedYesPrice, 0, 1)}
                    readOnly
                    disabled
                  />
                  <div className="calculator-slider__scale">
                    <span>Threshold {formatCurrency(targetUnderlyingValue)}</span>
                    <span>{scenarioOrder.polymarketResolutionDate || "Resolution"}</span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="calculator-summary calculator-summary--studio paper-scenario-card__totals">
            <article className="calculator-total">
              <span>{initialInvestment < 0 ? "Net initial credit" : "Net initial cost"}</span>
              <strong className={initialInvestment < 0 ? "positive" : ""}>
                {formatAbsoluteCurrency(initialInvestment)}
              </strong>
            </article>
            <article className="calculator-total">
              <span>Projected marked value</span>
              <strong>{formatCurrency(currentMarkedValue)}</strong>
            </article>
            <article className="calculator-total">
              <span>Options P&amp;L</span>
              <strong className={optionsPnL >= 0 ? "positive" : "negative"}>
                {formatCurrency(optionsPnL)}
              </strong>
            </article>
            <article className="calculator-total">
              <span>Polymarket P&amp;L</span>
              <strong className={polymarketPnL >= 0 ? "positive" : "negative"}>
                {formatCurrency(polymarketPnL)}
              </strong>
            </article>
            <article className="calculator-total calculator-total--accent">
              <span>Total Profit/Loss</span>
              <strong className={totalPnL >= 0 ? "positive" : "negative"}>
                {formatCurrency(totalPnL)}
              </strong>
            </article>
          </div>

          <div className="calculator-lines">
            {repricedOptionLegs.map((leg) => (
              <div key={leg.id} className="calculator-line">
                <div className="calculator-line__body">
                  <p>
                    Option {leg.action} {String(leg.optionType ?? "call").toUpperCase()} {formatNumber(leg.strike, 1)} {leg.expiry}
                  </p>
                  <div className="calculator-line__meta">
                    <span>{leg.quantity} contracts</span>
                    <span>{leg.daysToExpiry} DTE</span>
                    <span>Entry {formatCurrency(leg.entryPrice)}</span>
                    <span className="calculator-line__calc">Calc price {formatCurrency(leg.modelPrice)}</span>
                  </div>
                  <div className="calculator-line__reference">
                    {leg.contractSymbol ? <code>{leg.contractSymbol}</code> : <span>{leg.label}</span>}
                    <span>{leg.rootSymbol || proxySpotLabel}</span>
                  </div>
                </div>
                <div className="calculator-line__editor">
                  <div className="calculator-line__value">
                    <span>Contracts</span>
                    <strong>{leg.quantity}</strong>
                  </div>
                  <div className="calculator-line__value">
                    <span>Entry cost</span>
                    <strong>{formatAbsoluteCurrency(leg.entryValue)}</strong>
                  </div>
                  <div className="calculator-line__value">
                    <span>Marked value</span>
                    <strong>{formatAbsoluteCurrency(leg.markValue)}</strong>
                  </div>
                  <div className="calculator-line__value">
                    <span>P&amp;L</span>
                    <strong className={leg.pnl >= 0 ? "positive" : "negative"}>{formatCurrency(leg.pnl)}</strong>
                  </div>
                </div>
              </div>
            ))}

            {repricedPolymarketLegs.map((leg) => (
              <div key={leg.id} className="calculator-line calculator-line--market">
                <div className="calculator-line__body">
                  <p>{scenarioOrder.polymarketQuestion || `Polymarket ${leg.label}`}</p>
                  <div className="calculator-line__meta">
                    <span>{leg.quantity} contracts</span>
                    <span>{scenarioOrder.assetLabel} equiv {formatCurrency(equivalentUnderlyingSpot)}</span>
                    <span>{daysToMarketResolution} DTE</span>
                    <span className="calculator-line__calc">Calc mark {formatNumber(leg.modelPrice, 2)}</span>
                  </div>
                  <div className="calculator-line__reference">
                    {scenarioPolymarketEventUrl ? (
                      <a href={scenarioPolymarketEventUrl} target="_blank" rel="noreferrer">
                        {scenarioPolymarketEventUrl}
                      </a>
                    ) : (
                      <span>Seed fallback market</span>
                    )}
                    {polymarketReferenceLine ? <span>{polymarketReferenceLine}</span> : null}
                    <span>{scenarioPolymarketEventUrl ? `${leg.action} ${leg.outcome}` : "No live event URL yet"}</span>
                  </div>
                </div>
                <div className="calculator-line__editor">
                  <div className="calculator-line__value">
                    <span>Contracts</span>
                    <strong>{leg.quantity}</strong>
                  </div>
                  <div className="calculator-line__value">
                    <span>{leg.action === "SHORT" ? "Entry credit" : "Entry cost"}</span>
                    <strong>{formatAbsoluteCurrency(leg.entryValue)}</strong>
                  </div>
                  <div className="calculator-line__value">
                    <span>{leg.action === "SHORT" ? "Current liability" : "Marked value"}</span>
                    <strong>{formatAbsoluteCurrency(leg.markValue)}</strong>
                  </div>
                  <div className="calculator-line__value">
                    <span>P&amp;L</span>
                    <strong className={leg.pnl >= 0 ? "positive" : "negative"}>{formatCurrency(leg.pnl)}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
