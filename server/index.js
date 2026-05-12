import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import cors from "cors";
import "./env.js";
import {
  buildRequestLogContext,
  createRequestLoggingMiddleware,
  installProcessErrorHandlers,
  logError,
  logInfo,
  logWarn,
  patchExpressAsync
} from "./logger.js";
import { hashPlaintextPassword, registerAuthRoutes, requireAdmin, requireAuth } from "./auth.js";
import {
  calendarWidgets,
  defaultStrategyConfig,
  fallbackPolymarketMarkets,
  marketSections
} from "./marketCatalog.js";
import { buildMacroDashboardPayload, buildMacroHeroStats } from "./macroDashboard.js";
import {
  addStrategyToWatchlist,
  createUserApiKey,
  createUser,
  createPaperCalculatorSnapshot,
  createPaperOrder,
  deleteSetupWatchlistItem,
  createScannerPromotion,
  deletePaperCalculatorSnapshots,
  deletePaperOrderSnapshots,
  deletePaperOrder,
  getLatestScannerRun,
  getLatestMacroDashboardSnapshot,
  getLatestIvRankDaily,
  listPaperCalculatorSnapshots,
  listCandidateRankHistory,
  listDeltaHedgeScannerSymbols,
  listIv30History,
  listScannerPresets,
  listUsers,
  getLatestSnapshots,
  listSetupWatchlist,
  listStrategyWatchlist,
  listPaperOrderSnapshots,
  listPaperOrders,
  listStrategyAssetMappings,
  getRecentRuns,
  getStrategies,
  removeStrategyFromWatchlist,
  recordMarketSnapshots,
  recordPaperOrderSnapshots,
  saveMacroDashboardSnapshot,
  saveScannerRun,
  saveStrategyRun,
  upsertScannerPreset,
  upsertIv30History,
  upsertIvRankDaily,
  upsertSetupWatchlistItem,
  getIbkrSettings,
  getUserApiKeyWithUser,
  upsertIbkrSettings,
  upsertDeltaHedgeScannerSymbol,
  upsertStrategyAssetMapping,
  deleteDeltaHedgeScannerSymbol,
  deleteStrategyAssetMapping,
  listUserApiKeys,
  revokeUserApiKey,
  touchUserApiKey,
  updatePaperOrder
} from "./db.js";
import {
  initializeDashboardLayoutsDirectory,
  listDashboardLayouts,
  readDashboardLayout,
  saveDashboardLayout
} from "./dashboardLayouts.js";
import {
  fetchPolymarketMarketsFromEventPage,
  isTradablePolymarketMarket,
  searchPolymarketMarkets
} from "./providers/polymarket.js";
import {
  fetchCompanyEventsCalendar,
  fetchEconomicCalendar
} from "./providers/tradingViewCalendars.js";
import { scanTradingViewStrategyFinder } from "./providers/tradingViewStrategyFinder.js";
import {
  fetchPolygonMarketStatusNow,
  fetchPolygonUpcomingMarketClosures
} from "./providers/polygonMarketStatus.js";
import { fetchOptionChain, fetchPolygonAtmIv30Snapshot, fetchQuotes } from "./providers/yahooFinance.js";
import {
  blackScholesCall,
  blackScholesPut,
  buildPayoffSummary,
  buildStrategySummary,
  getResolvedStrategyMarketsForAsset,
  parseTargetFromQuestion
} from "./strategyEngine.js";
import { buildStrategyScreenerV2 } from "./strategyScreenerV2.js";
import {
  buildDeltaHedgeStockUniverse,
  buildStockDeltaHedgeScan,
  normalizeDeltaHedgeStock,
  normalizeDeltaHedgeTicker
} from "./deltaHedgeScanner.js";
import { buildVolatilityOpportunityScan } from "./volatilityOpportunityScreener.js";
import { fetchStockFundamentals } from "./stockFundamentals.js";
import { fetchStockTechnicals } from "./stockTechnicals.js";
import { buildVolCrushEarningsScan } from "./earningsVolCrush.js";
import { buildCoveredIncomeScan } from "./coveredIncomeScanner.js";
import { fetchStockDailyOhlcHistory } from "./stockOhlcHistory.js";
import {
  buildEffectiveStrategyAssets,
  buildStrategyQuoteWatchlist,
  collectStrategyPolymarketEventUrls,
  collectStrategyPolymarketQueries,
  normalizeStrategyAssetMapping,
  resolveStrategySettingsAssetId,
  STRATEGY_COMPARE_MODES,
  strategyAssetMatchesMarket
} from "./strategyAssets.js";
import {
  calculateIbkrLimitPrice,
  cancelIbkrOrder,
  continueIbkrOrderConfirmation,
  fetchIbkrOrderBook,
  fetchIbkrOrderStatus,
  getIbkrStatus,
  groupTradesByOrderRef,
  isIbkrFilledStatus,
  isIbkrTerminalStatus,
  isIbkrWorkingStatus,
  normalizeIbkrLiveOrder,
  submitIbkrStockOrder,
  submitIbkrOptionOrder,
  tickleIbkrSession
} from "./ibkrClientPortal.js";
import { parseTwsPaperOrderRef, twsPaperApi } from "./ibkrTwsApi.js";
import {
  applyPaperOrderPatch,
  attachPaperOrderHistory,
  buildPaperOrderSnapshot,
  buildPaperPortfolio,
  closePaperOrderPayload,
  sanitizePaperOrderPayload
} from "./paperTrading.js";
import {
  buildCoveredIncomeEv,
  buildExplainability,
  buildIvRankDailySnapshot,
  buildMarketRegime,
  buildPortfolioContext,
  buildPortfolioImpact,
  buildRankDrift,
  buildRiskFlags,
  buildTradingViewEv,
  buildVolatilityMetrics
} from "./scannerIntelligence.js";

installProcessErrorHandlers();

const app = express();
patchExpressAsync(app);
const port = Number(process.env.PORT || 8787);
const host = (process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const MACRO_DASHBOARD_REFRESH_MS = 24 * 60 * 60 * 1000;
const MACRO_DASHBOARD_CHECK_MS = 60 * 60 * 1000;
const MACRO_DASHBOARD_SCHEMA_VERSION = 3;
const CALENDAR_REFRESH_MS = 60 * 60 * 1000;
const CALENDAR_WINDOW_DAYS = 30;
const REFERENCE_REFRESH_MS = 5 * 60 * 1000;
const ALWAYS_TRACKED_OPTION_CONTRACTS_PER_SIDE = 6;
const PAPER_STREAM_HEARTBEAT_MS = Math.max(
  Number(process.env.PAPER_STREAM_HEARTBEAT_MS ?? 10000) || 10000,
  5000
);
const PAPER_STREAM_BROADCAST_DEBOUNCE_MS = 750;
const PAPER_QUOTE_BROADCAST_DEBOUNCE_MS = Math.max(
  Number(process.env.PAPER_QUOTE_BROADCAST_DEBOUNCE_MS ?? 2500) || 2500,
  250
);
const PAPER_ORDER_SNAPSHOT_INTERVAL_MS = 60 * 1000;
const IBKR_SYNC_INTERVAL_MS = Math.max(Number(process.env.IBKR_SYNC_INTERVAL_MS ?? 15000) || 15000, 10000);
const TWS_SYNC_INTERVAL_MS = Math.max(Number(process.env.TWS_SYNC_INTERVAL_MS ?? 15000) || 15000, 5000);
const MASSIVE_OPTIONS_WS_URL = process.env.POLYGON_WS_URL || "wss://socket.massive.com/options";
const POLYGON_MARKET_STATUS_REFRESH_MS = 60 * 1000;
const POLYGON_MARKET_UPCOMING_REFRESH_MS = 6 * 60 * 60 * 1000;
const SMART_ORDER_QUOTE_MAX_AGE_MS = 90 * 1000;
const SMART_ORDER_MIN_TICK = 0.05;
const SMART_ORDER_MAX_REPLACES = 3;
const SMART_ORDER_COOLDOWN_MS = 30 * 1000;
const SMART_ORDER_EPSILON = 0.000001;
const PAPER_ORDER_SEED_CACHE_TTL_MS = Math.max(
  Number(process.env.PAPER_ORDER_SEED_CACHE_TTL_MS ?? 15000) || 15000,
  1000
);
const PAPER_QUOTE_SLOW_PROCESS_MS = Math.max(
  Number(process.env.PAPER_QUOTE_SLOW_PROCESS_MS ?? 250) || 250,
  50
);
const EVENT_LOOP_MONITOR_INTERVAL_MS = Math.max(
  Number(process.env.EVENT_LOOP_MONITOR_INTERVAL_MS ?? 1000) || 1000,
  250
);
const EVENT_LOOP_LAG_WARN_MS = Math.max(
  Number(process.env.EVENT_LOOP_LAG_WARN_MS ?? 500) || 500,
  50
);
const GPT_API_KEY_PREFIX = "hhk_";

app.use(createRequestLoggingMiddleware());
app.use(cors());
app.use(express.json());
app.set("trust proxy", 1);
initializeDashboardLayoutsDirectory();

registerAuthRoutes(app);

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function normalizeGptTicker(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function hashApiKeyToken(token) {
  return crypto.createHash("sha256").update(String(token ?? "")).digest("hex");
}

function buildStockQuoteRequest(symbol) {
  return {
    symbol,
    sourceSymbol: `${String(symbol ?? "").trim().toLowerCase().replace(/\./g, "-")}.us`,
    label: symbol,
    provider: "stooq",
    group: "GPT"
  };
}

function parseIsoDate(value) {
  const normalizedValue = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return null;
  }

  const date = new Date(`${normalizedValue}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function differenceInDays(startDate, endDate) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return null;
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    return null;
  }

  const startUtc = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return Math.round((endUtc - startUtc) / (24 * 60 * 60 * 1000));
}

function isIsoDateWithinRange(value, startIso, endIso) {
  const normalizedValue = String(value ?? "").trim();
  return Boolean(normalizedValue && normalizedValue >= startIso && normalizedValue <= endIso);
}

function computeComboBidAskFromLegs(legs = []) {
  const normalizedLegs = Array.isArray(legs) ? legs : [];
  if (!normalizedLegs.length) {
    return { bid: null, ask: null, mid: null, spreadPercent: null };
  }

  let comboBid = 0;
  let comboAsk = 0;
  let hasBid = true;
  let hasAsk = true;

  for (const leg of normalizedLegs) {
    const quantity = Math.max(Number(leg?.quantity ?? 1) || 1, 1);
    const bid = Number(leg?.bid);
    const ask = Number(leg?.ask);
    const action = String(leg?.action ?? "LONG").trim().toUpperCase();

    if (action === "SHORT") {
      if (!Number.isFinite(bid)) {
        hasBid = false;
      } else {
        comboBid += bid * quantity;
      }

      if (!Number.isFinite(ask)) {
        hasAsk = false;
      } else {
        comboAsk += ask * quantity;
      }
    } else {
      if (!Number.isFinite(ask)) {
        hasBid = false;
      } else {
        comboBid -= ask * quantity;
      }

      if (!Number.isFinite(bid)) {
        hasAsk = false;
      } else {
        comboAsk -= bid * quantity;
      }
    }
  }

  const resolvedBid = hasBid ? comboBid : null;
  const resolvedAsk = hasAsk ? comboAsk : null;
  const mid =
    resolvedBid != null && resolvedAsk != null ? (resolvedBid + resolvedAsk) / 2 : resolvedBid ?? resolvedAsk ?? null;
  const midpointAbs = Math.abs(mid ?? 0);
  const spreadPercent =
    resolvedBid != null && resolvedAsk != null && midpointAbs > 0
      ? (Math.abs(resolvedAsk - resolvedBid) / midpointAbs) * 100
      : null;

  return {
    bid: formatNumber(resolvedBid, 2),
    ask: formatNumber(resolvedAsk, 2),
    mid: formatNumber(mid, 2),
    spreadPercent: formatNumber(spreadPercent, 2)
  };
}

function resolveTradingViewLegEntryPrice(leg) {
  const candidates = [
    Number(leg?.mark),
    Number(leg?.midPrice),
    Number(leg?.entryPrice),
    Number(leg?.bid) && Number(leg?.ask) ? (Number(leg.bid) + Number(leg.ask)) / 2 : Number.NaN,
    String(leg?.action ?? "LONG").trim().toUpperCase() === "SHORT" ? Number(leg?.bid) : Number(leg?.ask)
  ];

  const entryPrice = candidates.find((value) => Number.isFinite(value));
  return Number.isFinite(entryPrice) ? entryPrice : 0;
}

function buildRepricedTradingViewRow(row) {
  const legs = Array.isArray(row?.legs) ? row.legs : [];
  if (!legs.length) {
    return null;
  }
  if (!legs.every((leg) => leg?.isLive === true && Number.isFinite(Number(leg?.bid)) && Number.isFinite(Number(leg?.ask)))) {
    return null;
  }

  const underlyingPrice = Number(row?.underlyingPrice ?? 0);
  if (!(underlyingPrice > 0)) {
    return null;
  }

  const repricedLegs = legs.map((leg) => ({
    ...leg,
    contractMultiplier: Math.max(Number(leg?.contractMultiplier ?? 100) || 100, 1),
    entryPrice: resolveTradingViewLegEntryPrice(leg),
    quoteSource: leg?.isLive === true ? "live" : leg?.quoteSource ?? "unknown"
  }));
  const comboQuote = computeComboBidAskFromLegs(repricedLegs);
  const primaryVolatility =
    formatNumber(
      repricedLegs
        .map((leg) => Number(leg?.impliedVolatility))
        .filter((value) => Number.isFinite(value) && value > 0)
        .reduce((sum, value, _index, values) => sum + value / values.length, 0),
      4
    ) ??
    formatNumber(Number(row?.averageImpliedVolatility ?? row?.annualizedVolatility ?? 0.24), 4) ??
    0.24;
  const riskFreeRate = Number(repricedLegs[0]?.riskFreeRate ?? 0.0425) || 0.0425;
  const expiration = String(row?.expiration ?? repricedLegs[0]?.expiration ?? "").trim();
  const payoffSummary = buildPayoffSummary({
    currentSpot: underlyingPrice,
    targetSpot: underlyingPrice,
    targetThreshold: underlyingPrice,
    currentUnderlyingSpot: underlyingPrice,
    conversionRatio: 1,
    strategyCloseDate: expiration || null,
    polymarketResolutionDate: expiration || null,
    volatility: primaryVolatility,
    riskFreeRate,
    legs: repricedLegs.map((leg) => ({
      kind: "option",
      action: String(leg?.action ?? "LONG").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG",
      quantity: Math.max(Math.round(Number(leg?.quantity ?? 1) || 1), 1),
      entryPrice: Number(leg?.entryPrice ?? 0) || 0,
      optionType: String(leg?.optionType ?? "call").trim().toLowerCase() === "put" ? "put" : "call",
      strike: Number(leg?.strike ?? 0) || 0,
      expiration: String(leg?.expiration ?? expiration).trim(),
      contractMultiplier: Math.max(Number(leg?.contractMultiplier ?? 100) || 100, 1),
      impliedVolatility: Number(leg?.impliedVolatility ?? primaryVolatility) || primaryVolatility,
      riskFreeRate: Number(leg?.riskFreeRate ?? riskFreeRate) || riskFreeRate
    }))
  });

  const maxProfit = Number(payoffSummary?.maxProfit);
  const maxLoss = Number(payoffSummary?.maxLoss);
  const positivePoints = Array.isArray(payoffSummary?.payoffCurve)
    ? payoffSummary.payoffCurve.filter((point) => Number(point?.totalPnL ?? 0) > 0).length
    : 0;
  const probabilityOfProfit =
    Array.isArray(payoffSummary?.payoffCurve) && payoffSummary.payoffCurve.length
      ? (positivePoints / payoffSummary.payoffCurve.length) * 100
      : null;

  return {
    scannerCandidateId: row?.scannerCandidateId ?? null,
    scannerRunId: row?.scannerRunId ?? null,
    strategyId: "strategy-tv-finder",
    scannerType: "tradingview-finder",
    rowId: row?.id ?? "",
    ticker: String(row?.underlyingSymbol ?? "").trim(),
    strategyTypeKey: row?.strategyTypeKey ?? "",
    strategyTypeLabel: row?.strategyTypeLabel ?? "",
    expiration: row?.expiration ?? "",
    daysToExpiration: row?.daysToExpiration ?? null,
    legs: repricedLegs,
    entryPrice: comboQuote.mid,
    bid: comboQuote.bid,
    ask: comboQuote.ask,
    bidAskSpreadPercent: comboQuote.spreadPercent,
    underlyingPrice: formatNumber(underlyingPrice, 2),
    averageImpliedVolatility: primaryVolatility,
    normalizedOptionVolume: row?.normalizedOptionVolume ?? null,
    normalizedOptionOpenInterest: row?.normalizedOptionOpenInterest ?? null,
    maxProfit: formatNumber(maxProfit, 2),
    maxLoss: formatNumber(maxLoss, 2),
    rewardRisk: maxLoss < 0 ? formatNumber(maxProfit / Math.abs(maxLoss), 2) : null,
    probabilityOfProfit: formatNumber(probabilityOfProfit, 2),
    breakevens: Array.isArray(payoffSummary?.breakevens) ? payoffSummary.breakevens : [],
    score: row?.score ?? null,
    pageUrl: row?.pageUrl ?? "",
    intelligence: row?.intelligence ?? null
  };
}

function sanitizeGptStrategyQueryRequest(body = {}) {
  const ticker = normalizeGptTicker(body?.ticker);
  const startDate = parseIsoDate(body?.optionExpirationStartDate);
  const endDate = parseIsoDate(body?.optionExpirationEndDate);
  const expectedPriceRangeLow = Number(body?.expectedPriceRangeLow);
  const expectedPriceRangeHigh = Number(body?.expectedPriceRangeHigh);

  if (!ticker) {
    throw new Error("ticker is required");
  }
  if (!startDate || !endDate) {
    throw new Error("optionExpirationStartDate and optionExpirationEndDate must be YYYY-MM-DD");
  }
  if (endDate.getTime() < startDate.getTime()) {
    throw new Error("optionExpirationEndDate must be on or after optionExpirationStartDate");
  }
  if (!Number.isFinite(expectedPriceRangeLow) || !Number.isFinite(expectedPriceRangeHigh)) {
    throw new Error("expectedPriceRangeLow and expectedPriceRangeHigh must be numbers");
  }

  return {
    ticker,
    optionExpirationStartDate: body.optionExpirationStartDate,
    optionExpirationEndDate: body.optionExpirationEndDate,
    expectedPriceRangeLow: Math.min(expectedPriceRangeLow, expectedPriceRangeHigh),
    expectedPriceRangeHigh: Math.max(expectedPriceRangeLow, expectedPriceRangeHigh),
    startDate,
    endDate
  };
}

async function requireApiKey(request, response, next) {
  try {
    const rawApiKey = String(request.headers["x-api-key"] ?? "").trim();
    if (!rawApiKey) {
      response.status(401).json({ error: "API key required" });
      return;
    }

    const tokenHash = hashApiKeyToken(rawApiKey);
    const apiKey = getUserApiKeyWithUser(tokenHash);
    if (!apiKey || apiKey.revokedAt || Number(apiKey.disabled ?? 0) === 1) {
      response.status(401).json({ error: "Invalid API key" });
      return;
    }

    request.user = {
      id: apiKey.userId,
      username: apiKey.username,
      role: apiKey.role
    };
    request.apiKey = apiKey;
    touchUserApiKey(apiKey.id);
    next();
  } catch (error) {
    logError("API key authentication failed", {
      error,
      request: buildRequestLogContext(request)
    });
    response.status(500).json({ error: error.message });
  }
}

async function buildThresholdHedgeGptResults(query) {
  const { finderAssets } = getStrategyAssetContext();
  const matchingAssets = finderAssets.filter((asset) => {
    const symbolMatches =
      String(asset?.optionSymbol ?? "").trim().toUpperCase() === query.ticker ||
      String(asset?.underlyingSymbol ?? "").trim().toUpperCase() === query.ticker ||
      String(asset?.referenceSymbol ?? "")
        .trim()
        .toUpperCase()
        .endsWith(`:${query.ticker}`);
    return symbolMatches && String(asset?.polymarketEventUrl ?? "").trim();
  });

  if (!matchingAssets.length) {
    return {
      count: 0,
      items: [],
      warnings: [`No Threshold Hedge mapping found for ${query.ticker}.`]
    };
  }

  const strategySummary = await buildStrategySummary({
    quotes: liveState.quotes,
    polymarketMarkets: liveState.polymarketMarkets,
    optionMatches: buildLiveOptionMatches(),
    assetUniverse: matchingAssets
  });

  const items = (strategySummary?.scanUniverse ?? [])
    .flatMap((asset) =>
      (asset?.opportunities ?? []).map((opportunity) => ({
        strategyId: "strategy-1",
        scannerType: "threshold-hedge",
        ...opportunity
      }))
    )
    .filter((item) => isIsoDateWithinRange(item.optionExpiry, query.optionExpirationStartDate, query.optionExpirationEndDate));

  return {
    count: items.length,
    items,
    warnings: items.length ? [] : [`No Threshold Hedge opportunities matched ${query.ticker} in the requested expiry window.`]
  };
}

async function buildTradingViewGptResults(query) {
  const quote = withDerivedQuotes(await fetchQuotes([buildStockQuoteRequest(query.ticker)]))[0] ?? null;
  const underlyingPrice = Number(quote?.regularMarketPrice ?? 0);
  const percentLow =
    underlyingPrice > 0 ? ((query.expectedPriceRangeLow - underlyingPrice) / underlyingPrice) * 100 : -20;
  const percentHigh =
    underlyingPrice > 0 ? ((query.expectedPriceRangeHigh - underlyingPrice) / underlyingPrice) * 100 : 20;
  const payload = await scanTradingViewStrategyFinder({
    symbol: query.ticker,
    dateRange: {
      from: query.optionExpirationStartDate,
      to: query.optionExpirationEndDate
    },
    priceRange: {
      min: percentLow,
      max: percentHigh
    }
  });
  const enrichedPayload = await enrichTradingViewPayload(payload, query.userId);
  const warnings = Array.isArray(enrichedPayload?.warnings) ? [...enrichedPayload.warnings] : [];
  const filteredRows = (enrichedPayload?.rows ?? []).filter((row) =>
    isIsoDateWithinRange(row?.expiration, query.optionExpirationStartDate, query.optionExpirationEndDate)
  );
  const items = filteredRows.map((row) => buildRepricedTradingViewRow(row)).filter(Boolean);
  if (items.length < filteredRows.length) {
    warnings.push("Some TradingView rows were excluded because live option quotes could not be fully verified.");
  }

  return {
    count: items.length,
    items,
    warnings
  };
}

async function buildCoveredIncomeGptResults(query) {
  const targetDte = [];
  const today = new Date();
  const startDte = Math.max(differenceInDays(today, query.startDate) ?? 1, 1);
  const endDte = Math.max(differenceInDays(today, query.endDate) ?? startDte, startDte);
  for (let dte = startDte; dte <= endDte; dte += 1) {
    targetDte.push(dte);
  }

  const payload = await buildCoveredIncomeScan({
    input: {
      symbols: [query.ticker],
      targetDte,
      topResults: Math.max(targetDte.length, 10)
    },
    fetchQuotes,
    fetchOptionChain,
    companyEvents: liveState.companyEvents?.events ?? []
  });
  const enrichedPayload = await enrichCoveredIncomePayload(payload, query.userId);
  const items = (enrichedPayload?.rows ?? []).filter((row) =>
    isIsoDateWithinRange(row?.expiryDate, query.optionExpirationStartDate, query.optionExpirationEndDate)
  );

  return {
    count: items.length,
    items,
    warnings: Array.isArray(enrichedPayload?.warnings) ? enrichedPayload.warnings : []
  };
}

app.use((request, response, next) => {
  if (!request.path.startsWith("/api/")) {
    next();
    return;
  }

  if (request.path === "/api/health" || request.path.startsWith("/api/auth/") || request.path.startsWith("/api/gpt/")) {
    next();
    return;
  }

  requireAuth(request, response, next);
});

app.get("/api/admin/users", requireAdmin, (_request, response) => {
  const users = listUsers().map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }));

  response.json({ users });
});

app.post("/api/admin/users", requireAdmin, (request, response) => {
  const username = String(request.body?.username ?? "").trim();
  const password = String(request.body?.password ?? "");
  const roleInput = String(request.body?.role ?? "user").trim().toLowerCase();
  const role = roleInput === "admin" ? "admin" : "user";

  if (!username) {
    response.status(400).json({ error: "username is required" });
    return;
  }

  if (!password) {
    response.status(400).json({ error: "password is required" });
    return;
  }

  try {
    const created = createUser({
      id: crypto.randomUUID(),
      username,
      passwordHash: hashPlaintextPassword(password),
      role,
      disabled: false
    });

    response.status(201).json({
      ok: true,
      user: {
        id: created.id,
        username: created.username,
        role: created.role,
        disabled: Boolean(created.disabled),
        createdAt: created.createdAt,
        updatedAt: created.updatedAt
      }
    });
  } catch (error) {
    if (String(error?.code ?? "") === "SQLITE_CONSTRAINT_UNIQUE") {
      response.status(409).json({ error: "Username already exists" });
      return;
    }

    response.status(400).json({ error: error.message });
  }
});

app.get("/api/admin/api-keys", requireAdmin, (_request, response) => {
  response.json({
    apiKeys: listUserApiKeys().map((apiKey) => ({
      id: apiKey.id,
      userId: apiKey.userId,
      username: apiKey.username,
      label: apiKey.label,
      tokenPrefix: apiKey.tokenPrefix,
      revokedAt: apiKey.revokedAt,
      lastUsedAt: apiKey.lastUsedAt,
      createdAt: apiKey.createdAt,
      updatedAt: apiKey.updatedAt
    }))
  });
});

app.post("/api/admin/api-keys", requireAdmin, (request, response) => {
  const userId = String(request.body?.userId ?? "").trim();
  const label = String(request.body?.label ?? "").trim() || "GPT access";

  if (!userId) {
    response.status(400).json({ error: "userId is required" });
    return;
  }

  const user = listUsers().find((item) => item.id === userId) ?? null;
  if (!user) {
    response.status(404).json({ error: "User not found" });
    return;
  }

  try {
    const token = `${GPT_API_KEY_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
    const tokenPrefix = token.slice(0, Math.min(token.length, 12));
    const apiKey = createUserApiKey({
      id: crypto.randomUUID(),
      userId,
      label,
      tokenHash: hashApiKeyToken(token),
      tokenPrefix
    });

    response.status(201).json({
      ok: true,
      apiKey: {
        ...apiKey,
        plainTextKey: token
      }
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.delete("/api/admin/api-keys/:id", requireAdmin, (request, response) => {
  const id = String(request.params.id ?? "").trim();
  if (!id) {
    response.status(400).json({ error: "id is required" });
    return;
  }

  const revoked = revokeUserApiKey(id);
  if (!revoked) {
    response.status(404).json({ error: "API key not found" });
    return;
  }

  response.json({ ok: true });
});

function buildDefaultIbkrSettings() {
  const baseUrl = String(process.env.IBKR_CP_BASE_URL || "https://127.0.0.1:5000/v1/api")
    .trim()
    .replace(/\/+$/, "");

  return {
    baseUrl,
    timeoutMs: Math.max(Number(process.env.IBKR_CP_TIMEOUT_MS ?? 15000) || 15000, 5000),
    allowSelfSigned: String(process.env.IBKR_CP_ALLOW_SELF_SIGNED ?? "true").trim().toLowerCase() !== "false",
    accountId: String(process.env.IBKR_CP_ACCOUNT_ID ?? "").trim(),
    requirePaper: String(process.env.IBKR_CP_REQUIRE_PAPER ?? "true").trim().toLowerCase() !== "false",
    extOperator: String(process.env.IBKR_CP_EXT_OPERATOR ?? "").trim(),
    manualIndicator: String(process.env.IBKR_CP_MANUAL_INDICATOR ?? "false").trim().toLowerCase() === "true"
  };
}

function normalizeIbkrSettings(payload) {
  const defaults = buildDefaultIbkrSettings();
  const baseUrl = String(payload?.baseUrl ?? payload?.IBKR_CP_BASE_URL ?? defaults.baseUrl)
    .trim()
    .replace(/\/+$/, "");

  if (!baseUrl || !(baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))) {
    throw new Error("baseUrl must start with http:// or https://");
  }

  return {
    baseUrl,
    timeoutMs: Math.max(Number(payload?.timeoutMs ?? defaults.timeoutMs) || defaults.timeoutMs, 5000),
    allowSelfSigned: Boolean(payload?.allowSelfSigned ?? defaults.allowSelfSigned),
    accountId: String(payload?.accountId ?? defaults.accountId).trim(),
    requirePaper: Boolean(payload?.requirePaper ?? defaults.requirePaper),
    extOperator: String(payload?.extOperator ?? defaults.extOperator).trim(),
    manualIndicator: Boolean(payload?.manualIndicator ?? defaults.manualIndicator)
  };
}

function getEffectiveIbkrSettingsForUser(userId) {
  const defaults = buildDefaultIbkrSettings();
  const saved = getIbkrSettings(String(userId ?? "").trim());
  const savedConfig = saved?.config && typeof saved.config === "object" ? saved.config : null;

  return savedConfig ? { ...defaults, ...savedConfig } : defaults;
}

function getIbkrContextForUser(userId) {
  const normalizedUserId = String(userId ?? "").trim() || "anonymous";
  return {
    config: getEffectiveIbkrSettingsForUser(normalizedUserId),
    cookieJarKey: normalizedUserId
  };
}

app.get("/api/settings/ibkr", (request, response) => {
  const saved = getIbkrSettings(request.user.id);
  const defaults = buildDefaultIbkrSettings();
  const effective = saved?.config && typeof saved.config === "object" ? { ...defaults, ...saved.config } : defaults;

  response.json({
    saved: saved?.config ?? null,
    effective
  });
});

app.put("/api/settings/ibkr", (request, response) => {
  try {
    const normalized = normalizeIbkrSettings(request.body ?? {});
    const saved = upsertIbkrSettings(request.user.id, normalized);
    response.json({
      ok: true,
      saved: saved?.config ?? null,
      effective: normalized
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true
  });
});

const liveState = {
  quotes: [],
  polymarketMarkets: [],
  polymarketValuationMarkets: [],
  optionMatches: [],
  macroDashboard: null,
  economicCalendar: null,
  companyEvents: null,
  calendarsRefreshedAt: null,
  lastUpdated: null,
  warnings: [],
  calendarWarnings: []
};
const strategyResponseCache = {
  buildPromise: null,
  response: null,
  finderRowDetails: new Map(),
  version: 0
};
let initialLiveStateReadyPromise = null;
const paperStreamClientsByUserId = new Map();
const paperLiveState = {
  socket: null,
  authenticated: false,
  desiredSymbols: new Set(),
  subscribedSymbols: new Set(),
  reconnectTimer: null,
  broadcastTimer: null,
  lastSnapshotAt: 0,
  lastAuthAt: null,
  lastMessageAt: null,
  lastQuoteAt: null,
  lastDisconnectAt: null,
  lastError: null,
  quoteCountSinceSeedRefresh: 0,
  broadcastInFlight: false,
  lastBroadcastStartedAt: null,
  lastBroadcastCompletedAt: null,
  skippedQuoteBroadcasts: 0,
  lastQuoteBroadcastSkipLoggedAt: 0
};
const paperOrderSeedCache = {
  expiresAtMs: 0,
  seeds: new Map(),
  lastRefreshAt: null,
  lastRefreshDurationMs: null,
  lastRefreshError: null
};
const liveOptionContractIndexCache = {
  sourceRef: null,
  size: 0,
  bySymbol: new Map(),
  lastBuildAt: null,
  lastBuildDurationMs: null
};
const paperBrokerState = {
  ibkrByUserId: new Map(),
  tws: {
    configured: false,
    host: "",
    port: null,
    clientId: 107,
    connected: false,
    authenticated: false,
    ready: false,
    isPaper: false,
    selectedAccount: "",
    accounts: [],
    error: "",
    updatedAt: null,
    lastSyncAt: null,
    lastSyncError: null
  }
};
const livePaperOptionQuotes = new Map();
const polygonMarketStatusCache = {
  now: null,
  upcoming: [],
  nowFetchedAt: 0,
  upcomingFetchedAt: 0,
  lastSuccessAt: null,
  error: "",
  promise: null
};

function envFlagEnabled(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function shouldRunBackgroundPaperTasks() {
  return paperStreamClientsByUserId.size > 0 || envFlagEnabled("HEDGEHUB_BACKGROUND_PAPER_TASKS", false);
}

function shouldRunBackgroundIbkrSync() {
  return shouldRunBackgroundPaperTasks() || envFlagEnabled("HEDGEHUB_BACKGROUND_IBKR_SYNC", false);
}

function shouldStartBackgroundJobs() {
  return envFlagEnabled("HEDGEHUB_BACKGROUND_JOBS", false);
}

function shouldRunBackgroundMarketRefresh() {
  return shouldStartBackgroundJobs() || envFlagEnabled("HEDGEHUB_BACKGROUND_MARKET_REFRESH", false);
}

function shouldRunBackgroundMacroRefresh() {
  return shouldStartBackgroundJobs() || envFlagEnabled("HEDGEHUB_BACKGROUND_MACRO_REFRESH", false);
}

function shouldRunBackgroundCalendarRefresh() {
  return shouldStartBackgroundJobs() || envFlagEnabled("HEDGEHUB_BACKGROUND_CALENDAR_REFRESH", false);
}

function shouldRunBackgroundPaperHeartbeat() {
  return shouldStartBackgroundJobs() || envFlagEnabled("HEDGEHUB_BACKGROUND_PAPER_HEARTBEAT", false);
}

function shouldRunBackgroundTwsSync() {
  return shouldStartBackgroundJobs() || envFlagEnabled("HEDGEHUB_BACKGROUND_TWS_SYNC", false);
}

function buildEmptyIbkrStatus() {
  return {
    configured: false,
    connected: false,
    authenticated: false,
    isPaper: false,
    selectedAccount: "",
    accounts: [],
    aliases: {},
    allowedAssetTypes: "",
    error: "",
    updatedAt: null
  };
}

function getIbkrBrokerState(userId) {
  const normalizedUserId = String(userId ?? "").trim();
  const key = normalizedUserId || "anonymous";
  const existing = paperBrokerState.ibkrByUserId.get(key);
  if (existing) {
    return existing;
  }

  const created = {
    status: buildEmptyIbkrStatus(),
    syncing: false,
    lastSyncAt: null,
    lastSyncError: null
  };
  paperBrokerState.ibkrByUserId.set(key, created);
  return created;
}

function getIbkrStatusForUser(userId) {
  return getIbkrBrokerState(userId).status;
}

function normalizeTimestamp(value) {
  if (!value) {
    return "";
  }

  const normalizedValue =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(normalizedValue);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function buildPolygonMarketStatusResponse() {
  return {
    configured: Boolean(process.env.POLYGON_API_KEY),
    provider: "polygon",
    fetchedAt: new Date().toISOString(),
    lastSuccessAt: polygonMarketStatusCache.lastSuccessAt,
    error: polygonMarketStatusCache.error,
    statusNow: polygonMarketStatusCache.now,
    upcoming: polygonMarketStatusCache.upcoming
  };
}

async function getPolygonMarketStatusPayload({ force = false } = {}) {
  if (!process.env.POLYGON_API_KEY) {
    return buildPolygonMarketStatusResponse();
  }

  const now = Date.now();
  const shouldRefreshNow =
    force ||
    !polygonMarketStatusCache.now ||
    now - polygonMarketStatusCache.nowFetchedAt >= POLYGON_MARKET_STATUS_REFRESH_MS;
  const shouldRefreshUpcoming =
    force ||
    !polygonMarketStatusCache.upcomingFetchedAt ||
    now - polygonMarketStatusCache.upcomingFetchedAt >= POLYGON_MARKET_UPCOMING_REFRESH_MS;

  if (!shouldRefreshNow && !shouldRefreshUpcoming) {
    return buildPolygonMarketStatusResponse();
  }

  if (polygonMarketStatusCache.promise) {
    return polygonMarketStatusCache.promise;
  }

  polygonMarketStatusCache.promise = (async () => {
    const errors = [];

    if (shouldRefreshNow) {
      try {
        polygonMarketStatusCache.now = await fetchPolygonMarketStatusNow();
        polygonMarketStatusCache.nowFetchedAt = Date.now();
      } catch (error) {
        errors.push(`Live status unavailable: ${error.message}`);
      }
    }

    if (shouldRefreshUpcoming) {
      try {
        polygonMarketStatusCache.upcoming = await fetchPolygonUpcomingMarketClosures();
        polygonMarketStatusCache.upcomingFetchedAt = Date.now();
      } catch (error) {
        errors.push(`Holiday calendar unavailable: ${error.message}`);
      }
    }

    polygonMarketStatusCache.error = errors.join(" | ");

    if (!polygonMarketStatusCache.error) {
      polygonMarketStatusCache.lastSuccessAt = new Date().toISOString();
    }

    return buildPolygonMarketStatusResponse();
  })();

  try {
    return await polygonMarketStatusCache.promise;
  } finally {
    polygonMarketStatusCache.promise = null;
  }
}

function getPaperValuationPolymarketMarkets() {
  return liveState.polymarketValuationMarkets?.length
    ? liveState.polymarketValuationMarkets
    : liveState.polymarketMarkets;
}

function toNonNegativeNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : fallback;
}

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function isIbkrPaperRoute(order) {
  return String(order?.execution?.route ?? "").trim().toLowerCase() === "ibkr-paper";
}

function isTwsPaperRoute(order) {
  return String(order?.execution?.route ?? "").trim().toLowerCase() === "tws-paper";
}

function isTwsPaperExecution(execution) {
  return String(execution?.route ?? "").trim().toLowerCase() === "tws-paper";
}

function hasOptionLegs(order) {
  return (order?.legs ?? []).some((leg) => leg?.kind === "option");
}

function getStockHedgeLeg(order) {
  return (order?.legs ?? []).find((leg) => leg?.kind === "stock" && Number(leg?.quantity ?? 0) > 0) ?? null;
}

function buildRequestedExecutionLegs(order) {
  const existingRequestedLegs = Array.isArray(order?.execution?.requestedLegs)
    ? order.execution.requestedLegs
    : [];

  if (existingRequestedLegs.length) {
    return existingRequestedLegs.map((leg) => ({
      legId: String(leg.legId ?? leg.id ?? ""),
      label: String(leg.label ?? leg.legId ?? "Option"),
      rootSymbol: String(leg.rootSymbol ?? order?.marketContext?.proxySymbol ?? ""),
      contractSymbol: String(leg.contractSymbol ?? ""),
      optionType: String(leg.optionType ?? "call").toLowerCase() === "put" ? "put" : "call",
      action: String(leg.action ?? "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG",
      expiry: String(leg.expiry ?? ""),
      strike: Number(leg.strike ?? 0) || 0,
      requestedQuantity: Math.max(Number(leg.requestedQuantity ?? 0) || 0, 0),
      ratio: Math.max(Number(leg.ratio ?? 1) || 1, 1),
      entryPrice: Number(leg.entryPrice ?? 0) || 0,
      contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
      brokerConid: String(leg.brokerConid ?? ""),
      localSymbol: String(leg.localSymbol ?? "")
    }));
  }

  return (order?.legs ?? [])
    .filter((leg) => leg?.kind === "option")
    .map((leg) => ({
      legId: String(leg.id ?? ""),
      label: String(leg.label ?? leg.id ?? "Option"),
      rootSymbol: String(leg.rootSymbol ?? order?.marketContext?.proxySymbol ?? ""),
      contractSymbol: String(leg.contractSymbol ?? ""),
      optionType: String(leg.optionType ?? "call").toLowerCase() === "put" ? "put" : "call",
      action: String(leg.action ?? "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG",
      expiry: String(leg.expiry ?? ""),
      strike: Number(leg.strike ?? 0) || 0,
      requestedQuantity: Math.max(Number(leg.quantity ?? 0) || 0, 0),
      ratio: 1,
      entryPrice: Number(leg.entryPrice ?? 0) || 0,
      contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
      brokerConid: String(leg.brokerConid ?? ""),
      localSymbol: String(leg.localSymbol ?? "")
    }));
}

function getSmartExecutionState(execution) {
  return execution?.smart && typeof execution.smart === "object" ? execution.smart : {};
}

function isSmartEntryEnabled(execution) {
  return getSmartExecutionState(execution).enabled === true;
}

function roundPriceTowardsFill(value, minTick = SMART_ORDER_MIN_TICK) {
  const numericValue = toNumber(value, null);
  const tick = Math.max(toNumber(minTick, SMART_ORDER_MIN_TICK) ?? SMART_ORDER_MIN_TICK, 0.01);
  if (numericValue == null) {
    return null;
  }

  return Number((Math.ceil((numericValue + SMART_ORDER_EPSILON) / tick) * tick).toFixed(2));
}

function getNormalizedOptionContractSymbol(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
}

function findSmartQuoteForExecutionLeg(leg, optionMatches = []) {
  const requestedContractSymbol = getNormalizedOptionContractSymbol(leg?.contractSymbol ?? leg?.localSymbol ?? "");
  if (requestedContractSymbol) {
    const exactMatch = (optionMatches ?? []).find((contract) => {
      const candidateContractSymbol = getNormalizedOptionContractSymbol(
        contract?.contractSymbol ?? contract?.localSymbol ?? ""
      );
      return candidateContractSymbol === requestedContractSymbol;
    });

    if (exactMatch) {
      return exactMatch;
    }
  }

  const normalizedStrike = toNumber(leg?.strike, null);
  const normalizedRootSymbol = String(leg?.rootSymbol ?? "").trim().toUpperCase();
  const normalizedOptionType = String(leg?.optionType ?? "call").trim().toLowerCase();
  const normalizedExpiry = String(leg?.expiry ?? "").trim();

  return (
    (optionMatches ?? []).find((contract) => {
      if (String(contract?.rootSymbol ?? "").trim().toUpperCase() !== normalizedRootSymbol) {
        return false;
      }

      if (String(contract?.optionType ?? "call").trim().toLowerCase() !== normalizedOptionType) {
        return false;
      }

      if (String(contract?.expiration ?? contract?.expiry ?? "").trim() !== normalizedExpiry) {
        return false;
      }

      const candidateStrike = toNumber(contract?.strike, null);
      if (normalizedStrike == null || candidateStrike == null) {
        return false;
      }

      return Math.abs(candidateStrike - normalizedStrike) < 0.01;
    }) ?? null
  );
}

function buildSmartComboQuote(legs = [], optionMatches = buildPaperValuationOptionMatches()) {
  if (!Array.isArray(legs) || !legs.length) {
    return {
      ready: false,
      reason: "No option legs are available for smart pricing."
    };
  }

  let bestPrice = 0;
  let midPrice = 0;
  let worstPrice = 0;
  let oldestQuoteAt = null;

  for (const leg of legs) {
    const ratio = Math.max(Math.round(Number(leg?.ratio ?? 1) || 1), 1);
    const quote = findSmartQuoteForExecutionLeg(leg, optionMatches);
    const bid = toNonNegativeNumber(quote?.bid, null);
    const ask = toNonNegativeNumber(quote?.ask, null);

    if (!(bid > 0) || !(ask > 0) || ask < bid || quote?.hasRealBidAsk !== true) {
      return {
        ready: false,
        reason: `Live bid/ask is unavailable for ${leg?.label || leg?.contractSymbol || leg?.legId || "an option leg"}.`
      };
    }

    const updatedAt = normalizeTimestamp(quote?.updatedAt ?? "");
    if (!updatedAt) {
      return {
        ready: false,
        reason: `Live quote timing is unavailable for ${leg?.label || leg?.contractSymbol || leg?.legId || "an option leg"}.`
      };
    }

    const quoteAgeMs = Date.now() - new Date(updatedAt).getTime();
    if (!Number.isFinite(quoteAgeMs) || quoteAgeMs > SMART_ORDER_QUOTE_MAX_AGE_MS) {
      return {
        ready: false,
        reason: `Live bid/ask is stale for ${leg?.label || leg?.contractSymbol || leg?.legId || "an option leg"}.`
      };
    }

    oldestQuoteAt =
      !oldestQuoteAt || new Date(updatedAt).getTime() < new Date(oldestQuoteAt).getTime() ? updatedAt : oldestQuoteAt;

    const midpoint = (bid + ask) / 2;
    if (String(leg?.action ?? "LONG").trim().toUpperCase() === "SHORT") {
      bestPrice += (-ask * ratio);
      midPrice += (-midpoint * ratio);
      worstPrice += (-bid * ratio);
    } else {
      bestPrice += (bid * ratio);
      midPrice += (midpoint * ratio);
      worstPrice += (ask * ratio);
    }
  }

  return {
    ready: true,
    bestPrice: Number(bestPrice.toFixed(2)),
    midPrice: Number(midPrice.toFixed(2)),
    worstPrice: Number(worstPrice.toFixed(2)),
    width: Number(Math.max(worstPrice - bestPrice, 0).toFixed(2)),
    oldestQuoteAt
  };
}

function deriveSmartThresholdPrice(anchorWidthPrice, anchorLimitPrice, minTick = SMART_ORDER_MIN_TICK) {
  const width = Math.max(toNumber(anchorWidthPrice, 0) ?? 0, 0);
  const referenceLimit = Math.abs(toNumber(anchorLimitPrice, 0) ?? 0);
  return Number(
    Math.max(
      Math.max(toNumber(minTick, SMART_ORDER_MIN_TICK) ?? SMART_ORDER_MIN_TICK, 0.01) * 2,
      width * 0.35,
      referenceLimit * 0.02
    ).toFixed(2)
  );
}

function deriveSmartGuardrailLimit(anchorLimitPrice, anchorWidthPrice, minTick = SMART_ORDER_MIN_TICK) {
  const limitPrice = toNumber(anchorLimitPrice, null);
  if (limitPrice == null) {
    return null;
  }

  const width = Math.max(toNumber(anchorWidthPrice, 0) ?? 0, 0);
  return roundPriceTowardsFill(
    limitPrice + Math.max(
      Math.max(toNumber(minTick, SMART_ORDER_MIN_TICK) ?? SMART_ORDER_MIN_TICK, 0.01) * 2,
      width * 0.75
    ),
    minTick
  );
}

function getSmartExecutionPatch(order, execution = order?.execution) {
  const currentExecution = execution && typeof execution === "object" ? execution : order?.execution ?? null;
  if (!currentExecution || !isIbkrPaperRoute(order)) {
    return null;
  }

  const existingSmart = getSmartExecutionState(currentExecution);
  const smartEnabled = existingSmart.enabled === true;
  const orderType = String(currentExecution.orderType ?? "LMT").trim().toUpperCase();
  const minTick = Math.max(toNumber(existingSmart.minTick, SMART_ORDER_MIN_TICK) ?? SMART_ORDER_MIN_TICK, 0.01);
  const replaceCount = Math.max(Math.round(toNumber(existingSmart.replaceCount, 0) ?? 0), 0);
  const maxReplaceCount = Math.max(
    Math.round(toNumber(existingSmart.maxReplaceCount, SMART_ORDER_MAX_REPLACES) ?? SMART_ORDER_MAX_REPLACES),
    0
  );
  const cooldownMs = Math.max(
    Math.round(toNumber(existingSmart.cooldownMs, SMART_ORDER_COOLDOWN_MS) ?? SMART_ORDER_COOLDOWN_MS),
    5000
    );

  if (!smartEnabled) {
    return {
      ...existingSmart,
      enabled: false,
      status: "disabled",
      mode: "balanced",
      minTick,
      replaceCount,
      maxReplaceCount,
      cooldownMs,
      pendingLimitPrice: null
    };
  }

  if (orderType !== "LMT") {
    return {
      ...existingSmart,
      enabled: false,
      status: "disabled",
      mode: "balanced",
      minTick,
      replaceCount,
      maxReplaceCount,
      cooldownMs,
      pendingLimitPrice: null,
      lastDecision: "unsupported_order_type",
      lastDecisionReason: "Smart pricing only runs on IBKR limit entry orders."
    };
  }

  const limitPrice = toNumber(currentExecution.limitPrice, null);
  const quote = buildSmartComboQuote(
    Array.isArray(currentExecution.requestedLegs) && currentExecution.requestedLegs.length
      ? currentExecution.requestedLegs
      : buildRequestedExecutionLegs(order)
  );
  const anchorLimitPrice = toNumber(existingSmart.anchorLimitPrice, limitPrice);
  const anchorWidthPrice =
    existingSmart.anchorWidthPrice == null
      ? Math.max(toNumber(quote?.width, 0) ?? 0, minTick * 2)
      : Math.max(toNumber(existingSmart.anchorWidthPrice, 0) ?? 0, minTick * 2);
  const thresholdPrice =
    existingSmart.thresholdPrice == null
      ? deriveSmartThresholdPrice(anchorWidthPrice, anchorLimitPrice, minTick)
      : Math.max(toNumber(existingSmart.thresholdPrice, 0) ?? 0, minTick);
  const guardrailLimitPrice =
    existingSmart.guardrailLimitPrice == null
      ? deriveSmartGuardrailLimit(anchorLimitPrice, anchorWidthPrice, minTick)
      : toNumber(existingSmart.guardrailLimitPrice, null);
  const currentStatus =
    existingSmart.pendingLimitPrice != null
      ? "pending_replace"
      : String(existingSmart.status ?? "").trim().toLowerCase() === "disabled"
        ? quote.ready
          ? "watching"
          : "paused"
        : existingSmart.status || (quote.ready ? "watching" : "paused");

  return {
    ...existingSmart,
    enabled: true,
    status: currentStatus,
    mode: "balanced",
    anchorLimitPrice,
    anchorWidthPrice,
    guardrailLimitPrice,
    thresholdPrice,
    minTick,
    replaceCount,
    maxReplaceCount,
    cooldownMs,
    pendingLimitPrice:
      existingSmart.pendingLimitPrice == null ? null : toNumber(existingSmart.pendingLimitPrice, null),
    lastDecision: String(existingSmart.lastDecision ?? (quote.ready ? "armed" : "paused_quotes")),
    lastDecisionReason: String(
      existingSmart.lastDecisionReason ??
        (quote.ready
          ? "Smart pricing armed. HedgeHub will reprice stale entry limits conservatively."
          : quote.reason || "Smart pricing is waiting for live option bid/ask quotes.")
    ),
    lastMarketPrice:
      existingSmart.lastMarketPrice == null || !quote.ready
        ? existingSmart.lastMarketPrice ?? null
        : toNumber(existingSmart.lastMarketPrice, quote.midPrice),
    lastSuggestedLimitPrice:
      existingSmart.lastSuggestedLimitPrice == null ? null : toNumber(existingSmart.lastSuggestedLimitPrice, null)
  };
}

function reconcileSmartEntryExecution(order) {
  if (!isIbkrPaperRoute(order) || !order?.execution) {
    return order;
  }

  const nextSmart = getSmartExecutionPatch(order, order.execution);
  if (!nextSmart) {
    return order;
  }

  const currentSmart = getSmartExecutionState(order.execution);
  if (JSON.stringify(nextSmart) === JSON.stringify(currentSmart)) {
    return order;
  }

  return sanitizePaperOrderPayload(
    {
      ...order,
      execution: {
        ...order.execution,
        smart: nextSmart
      }
    },
    order
  );
}

function buildPendingIbkrExecution(order, overrides = {}) {
  const orderType =
    String(overrides.orderType ?? order?.execution?.orderType ?? "LMT").trim().toUpperCase() === "MKT"
      ? "MKT"
      : "LMT";
  const limitPrice =
    orderType === "LMT"
      ? Number(
          overrides.limitPrice ??
            order?.execution?.limitPrice ??
            calculateIbkrLimitPrice({
              ...order,
              execution: {
                ...(order?.execution ?? {}),
                requestedLegs: buildRequestedExecutionLegs(order)
              }
            }) ??
            0
        )
      : null;

  const baseExecution = {
    ...(order?.execution ?? {}),
    route: "ibkr-paper",
    purpose: "entry",
    status: String(overrides.status ?? order?.execution?.status ?? "pending_submit"),
    statusText: String(
      overrides.statusText ?? order?.execution?.statusText ?? "Queued for IBKR paper submission"
    ),
    orderType,
    tif:
      String(overrides.tif ?? order?.execution?.tif ?? "DAY").trim().toUpperCase() === "GTC"
        ? "GTC"
        : "DAY",
    outsideRth: overrides.outsideRth ?? order?.execution?.outsideRth === true,
    limitPrice,
    accountId: String(overrides.accountId ?? order?.execution?.accountId ?? ""),
    requestedLegs: buildRequestedExecutionLegs(order),
    lastError: String(overrides.lastError ?? ""),
    lastWarning: String(overrides.lastWarning ?? ""),
    warningMessages: Array.isArray(overrides.warningMessages) ? overrides.warningMessages : [],
    pendingReplyId: String(overrides.pendingReplyId ?? ""),
    pendingReplyMessages: Array.isArray(overrides.pendingReplyMessages) ? overrides.pendingReplyMessages : [],
    smart: (() => {
      const mergedSmart =
        overrides.smart && typeof overrides.smart === "object"
          ? {
              ...(order?.execution?.smart ?? {}),
              ...overrides.smart
            }
          : order?.execution?.smart ?? null;

      if (mergedSmart?.enabled !== true) {
        return mergedSmart ?? null;
      }

      return {
        ...mergedSmart,
        status: "watching",
        pendingLimitPrice: null,
        lastDecision: "armed",
        lastDecisionReason: "Smart pricing armed for this IBKR limit entry."
      };
    })()
  };

  return reconcileSmartEntryExecution({
    ...(order ?? {}),
    execution: baseExecution
  }).execution;
}

function buildPendingTwsExecution(order, overrides = {}) {
  const orderType =
    String(overrides.orderType ?? order?.execution?.orderType ?? "LMT").trim().toUpperCase() === "MKT"
      ? "MKT"
      : "LMT";
  const limitPrice =
    orderType === "LMT"
      ? Number(
          overrides.limitPrice ??
            order?.execution?.limitPrice ??
            calculateIbkrLimitPrice({
              ...order,
              execution: {
                ...(order?.execution ?? {}),
                requestedLegs: buildRequestedExecutionLegs(order)
              }
            }) ??
            0
        )
      : null;

  return {
    ...(order?.execution ?? {}),
    route: "tws-paper",
    purpose: "entry",
    status: String(overrides.status ?? order?.execution?.status ?? "pending_submit"),
    statusText: String(overrides.statusText ?? order?.execution?.statusText ?? "Queued for TWS submission"),
    orderType,
    tif:
      String(overrides.tif ?? order?.execution?.tif ?? "DAY").trim().toUpperCase() === "GTC"
        ? "GTC"
        : "DAY",
    outsideRth: overrides.outsideRth ?? order?.execution?.outsideRth === true,
    limitPrice,
    accountId: String(overrides.accountId ?? order?.execution?.accountId ?? paperBrokerState.tws.selectedAccount ?? ""),
    requestedLegs: buildRequestedExecutionLegs(order),
    lastError: String(overrides.lastError ?? ""),
    lastWarning: String(overrides.lastWarning ?? ""),
    warningMessages: Array.isArray(overrides.warningMessages) ? overrides.warningMessages : [],
    pendingReplyId: "",
    pendingReplyMessages: []
  };
}

function prepareOrderForIbkrEntry(order) {
  const requestedExecutionLegs = buildRequestedExecutionLegs(order);

  return sanitizePaperOrderPayload(
    {
      ...order,
      execution: buildPendingIbkrExecution(order),
      closeExecution: null,
      legs: (order?.legs ?? []).map((leg) =>
        leg?.kind === "option"
          ? {
              ...leg,
              brokerConid:
                requestedExecutionLegs.find((requestedLeg) => String(requestedLeg.legId) === String(leg.id))
                  ?.brokerConid ?? leg?.brokerConid ?? "",
              localSymbol:
                requestedExecutionLegs.find((requestedLeg) => String(requestedLeg.legId) === String(leg.id))
                  ?.localSymbol ?? leg?.localSymbol ?? ""
            }
          : leg
      )
    },
    order
  );
}

function prepareOrderForTwsEntry(order) {
  const requestedExecutionLegs = buildRequestedExecutionLegs(order);

  return sanitizePaperOrderPayload(
    {
      ...order,
      execution: buildPendingTwsExecution(order),
      closeExecution: null,
      legs: (order?.legs ?? []).map((leg) =>
        leg?.kind === "option"
          ? {
              ...leg,
              brokerConid:
                requestedExecutionLegs.find((requestedLeg) => String(requestedLeg.legId) === String(leg.id))
                  ?.brokerConid ?? leg?.brokerConid ?? "",
              localSymbol:
                requestedExecutionLegs.find((requestedLeg) => String(requestedLeg.legId) === String(leg.id))
                  ?.localSymbol ?? leg?.localSymbol ?? ""
            }
          : leg
      )
    },
    order
  );
}

function mapCloseExecutionToRoute(execution, order) {
  if (!execution) {
    return null;
  }

  return {
    ...(execution ?? {}),
    route: "ibkr-paper",
    purpose: "exit",
    status: String(execution.status ?? "pending_submit"),
    statusText: String(execution.statusText ?? "IBKR exit order working"),
    orderType: String(execution.orderType ?? "MKT"),
    tif: String(execution.tif ?? "DAY"),
    accountId: String(execution.accountId ?? order?.execution?.accountId ?? ""),
    accountAlias: String(execution.accountAlias ?? order?.execution?.accountAlias ?? ""),
    isPaper: execution.isPaper === true || order?.execution?.isPaper === true
  };
}

function sanitizeExecutionMessages(messages = []) {
  return Array.isArray(messages)
    ? messages.map((message) => String(message ?? "").trim()).filter(Boolean)
    : [];
}

function getExecutionWarningMessages(execution) {
  const warningMessages = sanitizeExecutionMessages(execution?.warningMessages);
  if (warningMessages.length) {
    return warningMessages;
  }

  const lastWarning = String(execution?.lastWarning ?? "").trim();
  return lastWarning ? lastWarning.split(" | ").map((message) => message.trim()).filter(Boolean) : [];
}

function getPendingReplyMessages(execution) {
  const pendingMessages = sanitizeExecutionMessages(execution?.pendingReplyMessages);
  if (pendingMessages.length) {
    return pendingMessages;
  }

  const statusDescription = String(execution?.statusDescription ?? "").trim();
  return statusDescription ? [statusDescription] : [];
}

function isExecutionConfirmationPending(execution) {
  return (
    String(execution?.status ?? "").trim().toLowerCase() === "pending_confirmation" &&
    String(execution?.pendingReplyId ?? "").trim().length > 0
  );
}

function findPendingConfirmationExecution(order) {
  if (
    String(order?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper" &&
    isExecutionConfirmationPending(order?.closeExecution)
  ) {
    return {
      key: "closeExecution",
      value: order.closeExecution,
      purpose: "exit"
    };
  }

  if (isIbkrPaperRoute(order) && isExecutionConfirmationPending(order?.execution)) {
    return {
      key: "execution",
      value: order.execution,
      purpose: "entry"
    };
  }

  if (
    String(order?.stockExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper" &&
    isExecutionConfirmationPending(order?.stockExecution)
  ) {
    return {
      key: "stockExecution",
      value: order.stockExecution,
      purpose: "entry"
    };
  }

  return null;
}

function buildIbkrSubmissionMessage(submission, purpose = "entry") {
  if (submission?.pendingReplyId) {
    const prompt = sanitizeExecutionMessages(submission.pendingReplyMessages).join(" | ");
    return prompt
      ? `IBKR confirmation required: ${prompt}`
      : "IBKR confirmation required before the broker will accept this order.";
  }

  const orderLabel = purpose === "exit" ? "IBKR paper exit order" : "IBKR paper order";
  return submission?.lastWarning
    ? `${orderLabel} submitted with warnings: ${submission.lastWarning}`
    : `${orderLabel} submitted.`;
}

function buildIbkrStockHedgeSubmissionMessage(submission) {
  if (!submission) {
    return "";
  }

  if (submission?.pendingReplyId) {
    const prompt = sanitizeExecutionMessages(submission.pendingReplyMessages).join(" | ");
    return prompt
      ? `IBKR stock hedge confirmation required: ${prompt}`
      : "IBKR stock hedge confirmation required before the broker will accept this order.";
  }

  return submission?.lastWarning
    ? `IBKR stock hedge submitted with warnings: ${submission.lastWarning}`
    : "IBKR stock hedge submitted.";
}

function getOpenPaperOrders() {
  return listPaperOrders().filter(
    (order) => String(order.position?.status ?? "open").toLowerCase() !== "closed"
  );
}

function buildOpenPaperOptionContractSeeds() {
  const seeds = new Map();

  getOpenPaperOrders().forEach((order) => {
    const proxySymbol = String(order.position?.marketContext?.proxySymbol ?? "").trim();

    (order.position?.legs ?? []).forEach((leg) => {
      if (leg?.kind !== "option") {
        return;
      }

      if (String(leg?.status ?? "open").trim().toLowerCase() === "closed") {
        return;
      }

      const contractSymbol = String(leg.contractSymbol ?? "").trim();
      if (!contractSymbol) {
        return;
      }

      seeds.set(contractSymbol, {
        contractSymbol,
        strike: Number(leg.strike ?? 0) || null,
        expiration: String(leg.expiry ?? "").trim() || null,
        optionType: String(leg.optionType ?? "call").toLowerCase() === "put" ? "put" : "call",
        rootSymbol: String(leg.rootSymbol ?? proxySymbol ?? "").trim() || null,
        bid: Number(leg.bid ?? 0) || null,
        ask: Number(leg.ask ?? 0) || null,
        bidSize: Number(leg.bidSize ?? 0) || null,
        askSize: Number(leg.askSize ?? 0) || null,
        volume: Number(leg.volume ?? 0) || null,
        openInterest: Number(leg.openInterest ?? 0) || null,
        source: String(leg.quoteSource ?? "paper-order"),
        sourceLabel: "Paper order",
        isLive: leg.isLive === true,
        hasRealBidAsk: false
      });
    });
  });

  return seeds;
}

function invalidatePaperOrderSeedCache(reason = "unknown") {
  paperOrderSeedCache.expiresAtMs = 0;
  paperOrderSeedCache.lastRefreshError = null;
  logInfo("Paper order seed cache invalidated", {
    subsystem: "paper-order-seeds",
    reason
  });
}

function getOpenPaperOptionContractSeeds(options = {}) {
  const { forceRefresh = false, reason = "read" } = options;
  const nowMs = Date.now();

  if (!forceRefresh && paperOrderSeedCache.expiresAtMs > nowMs) {
    return paperOrderSeedCache.seeds;
  }

  const startedAt = process.hrtime.bigint();

  try {
    const nextSeeds = buildOpenPaperOptionContractSeeds();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    paperOrderSeedCache.seeds = nextSeeds;
    paperOrderSeedCache.expiresAtMs = nowMs + PAPER_ORDER_SEED_CACHE_TTL_MS;
    paperOrderSeedCache.lastRefreshAt = new Date().toISOString();
    paperOrderSeedCache.lastRefreshDurationMs = Number(durationMs.toFixed(1));
    paperOrderSeedCache.lastRefreshError = null;
    paperLiveState.quoteCountSinceSeedRefresh = 0;

    if (forceRefresh || durationMs >= PAPER_QUOTE_SLOW_PROCESS_MS) {
      logInfo("Paper order seed cache refreshed", {
        subsystem: "paper-order-seeds",
        reason,
        seedCount: nextSeeds.size,
        durationMs: Number(durationMs.toFixed(1)),
        ttlMs: PAPER_ORDER_SEED_CACHE_TTL_MS
      });
    }

    return nextSeeds;
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    paperOrderSeedCache.lastRefreshDurationMs = Number(durationMs.toFixed(1));
    paperOrderSeedCache.lastRefreshError = error.message;
    logWarn("Paper order seed cache refresh failed", {
      subsystem: "paper-order-seeds",
      reason,
      durationMs: Number(durationMs.toFixed(1)),
      cachedSeedCount: paperOrderSeedCache.seeds.size,
      error
    });
    return paperOrderSeedCache.seeds;
  }
}

function normalizeOptionType(value) {
  return String(value ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
}

function getOptionContractSortScore(contract, currentSpot) {
  const strike = Number(contract?.strike ?? 0);
  const expiryValue = String(contract?.expiration ?? "").trim();
  const expiryMs = expiryValue ? new Date(`${expiryValue}T00:00:00.000Z`).getTime() : Number.MAX_SAFE_INTEGER;
  const bid = Number(contract?.bid ?? 0);
  const ask = Number(contract?.ask ?? 0);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : Math.max(bid, ask, 0);

  return {
    hasRealBidAsk: contract?.hasRealBidAsk === true ? 1 : 0,
    strikeDistance:
      currentSpot > 0 && Number.isFinite(strike) && strike > 0
        ? Math.abs(strike - currentSpot) / currentSpot
        : Number.POSITIVE_INFINITY,
    expiryMs: Number.isFinite(expiryMs) ? expiryMs : Number.MAX_SAFE_INTEGER,
    spreadPct:
      bid > 0 && ask > 0 && midpoint > 0
        ? Math.abs(ask - bid) / midpoint
        : Number.POSITIVE_INFINITY,
    volume: Number(contract?.volume ?? 0),
    openInterest: Number(contract?.openInterest ?? 0),
    contractSymbol: String(contract?.contractSymbol ?? "").trim()
  };
}

function compareOptionContractsForStreaming(left, right, currentSpot) {
  const leftScore = getOptionContractSortScore(left, currentSpot);
  const rightScore = getOptionContractSortScore(right, currentSpot);

  if (leftScore.hasRealBidAsk !== rightScore.hasRealBidAsk) {
    return rightScore.hasRealBidAsk - leftScore.hasRealBidAsk;
  }

  if (leftScore.strikeDistance !== rightScore.strikeDistance) {
    return leftScore.strikeDistance - rightScore.strikeDistance;
  }

  if (leftScore.expiryMs !== rightScore.expiryMs) {
    return leftScore.expiryMs - rightScore.expiryMs;
  }

  if (leftScore.spreadPct !== rightScore.spreadPct) {
    return leftScore.spreadPct - rightScore.spreadPct;
  }

  if (leftScore.volume !== rightScore.volume) {
    return rightScore.volume - leftScore.volume;
  }

  if (leftScore.openInterest !== rightScore.openInterest) {
    return rightScore.openInterest - leftScore.openInterest;
  }

  return leftScore.contractSymbol.localeCompare(rightScore.contractSymbol);
}

function getAlwaysTrackedOptionContractSeeds() {
  const latestContractsBySymbol = new Map();

  (liveState.optionMatches ?? []).forEach((contract) => {
    const contractSymbol = String(contract?.contractSymbol ?? "").trim();
    const rootSymbol = String(contract?.rootSymbol ?? "").trim();
    if (!contractSymbol || !rootSymbol || contract?.isLive !== true) {
      return;
    }

    const existing = latestContractsBySymbol.get(contractSymbol);
    if (!existing) {
      latestContractsBySymbol.set(contractSymbol, contract);
      return;
    }

    if (compareOptionContractsForStreaming(contract, existing, 0) < 0) {
      latestContractsBySymbol.set(contractSymbol, contract);
    }
  });

  const contractsByRoot = new Map();
  latestContractsBySymbol.forEach((contract) => {
    const rootSymbol = String(contract.rootSymbol ?? "").trim();
    if (!contractsByRoot.has(rootSymbol)) {
      contractsByRoot.set(rootSymbol, []);
    }
    contractsByRoot.get(rootSymbol).push(contract);
  });

  const quoteMap = new Map(
    (liveState.quotes ?? []).map((quote) => [String(quote.symbol ?? "").trim(), Number(quote.regularMarketPrice ?? 0)])
  );
  const seeds = new Map();

  contractsByRoot.forEach((contracts, rootSymbol) => {
    const currentSpot = Number(quoteMap.get(rootSymbol) ?? 0);

    ["call", "put"].forEach((optionType) => {
      contracts
        .filter((contract) => normalizeOptionType(contract.optionType) === optionType)
        .sort((left, right) => compareOptionContractsForStreaming(left, right, currentSpot))
        .slice(0, ALWAYS_TRACKED_OPTION_CONTRACTS_PER_SIDE)
        .forEach((contract) => {
          seeds.set(contract.contractSymbol, {
            ...contract,
            optionType
          });
        });
    });
  });

  return seeds;
}

function getLiveOptionContractIndex() {
  if (
    liveOptionContractIndexCache.sourceRef === liveState.optionMatches &&
    liveOptionContractIndexCache.size === liveState.optionMatches.length
  ) {
    return liveOptionContractIndexCache.bySymbol;
  }

  const startedAt = process.hrtime.bigint();
  const bySymbol = new Map();

  (liveState.optionMatches ?? []).forEach((contract) => {
    const contractSymbol = String(contract?.contractSymbol ?? "").trim();
    if (!contractSymbol || bySymbol.has(contractSymbol)) {
      return;
    }
    bySymbol.set(contractSymbol, contract);
  });

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  liveOptionContractIndexCache.sourceRef = liveState.optionMatches;
  liveOptionContractIndexCache.size = liveState.optionMatches.length;
  liveOptionContractIndexCache.bySymbol = bySymbol;
  liveOptionContractIndexCache.lastBuildAt = new Date().toISOString();
  liveOptionContractIndexCache.lastBuildDurationMs = Number(durationMs.toFixed(1));

  if (durationMs >= PAPER_QUOTE_SLOW_PROCESS_MS) {
    logInfo("Live option contract index rebuilt", {
      subsystem: "paper-options-stream",
      contractCount: bySymbol.size,
      durationMs: Number(durationMs.toFixed(1))
    });
  }

  return bySymbol;
}

function getDesiredPaperOptionSymbols() {
  const desiredSymbols = new Set();

  getAlwaysTrackedOptionContractSeeds().forEach((contract, contractSymbol) => {
    if (contract?.isLive === true && contractSymbol) {
      desiredSymbols.add(contractSymbol);
    }
  });

  getOpenPaperOptionContractSeeds({ reason: "desired-symbols" }).forEach((contract, contractSymbol) => {
    if (contract?.isLive === true && contractSymbol) {
      desiredSymbols.add(contractSymbol);
    }
  });

  return [...desiredSymbols];
}

function buildLiveOptionMatches() {
  const mergedContracts = new Map(
    liveState.optionMatches.map((contract) => [contract.contractSymbol, contract])
  );

  livePaperOptionQuotes.forEach((quote, contractSymbol) => {
    mergedContracts.set(contractSymbol, {
      ...(mergedContracts.get(contractSymbol) ?? {
        contractSymbol
      }),
      ...quote
    });
  });

  return [...mergedContracts.values()];
}

function buildPaperValuationOptionMatches() {
  const mergedContracts = new Map(
    buildLiveOptionMatches().map((contract) => [contract.contractSymbol, contract])
  );
  const orderSeeds = getOpenPaperOptionContractSeeds({ reason: "paper-valuation" });

  orderSeeds.forEach((contract, contractSymbol) => {
    if (!mergedContracts.has(contractSymbol)) {
      mergedContracts.set(contractSymbol, contract);
    }
  });

  livePaperOptionQuotes.forEach((quote, contractSymbol) => {
    mergedContracts.set(contractSymbol, {
      ...(mergedContracts.get(contractSymbol) ?? orderSeeds.get(contractSymbol) ?? {
        contractSymbol
      }),
      ...quote
    });
  });

  return [...mergedContracts.values()];
}

function getPaperQuoteContractSeed(contractSymbol) {
  return (
    livePaperOptionQuotes.get(contractSymbol) ??
    getLiveOptionContractIndex().get(contractSymbol) ??
    getOpenPaperOptionContractSeeds({ reason: "quote-fallback" }).get(contractSymbol) ??
    { contractSymbol }
  );
}

function buildValuedPaperPortfolio(userId = null) {
  return buildPaperPortfolio({
    orders: listPaperOrders(null, userId),
    quotes: liveState.quotes,
    polymarketMarkets: getPaperValuationPolymarketMarkets(),
    optionMatches: buildPaperValuationOptionMatches()
  });
}

function buildPaperPortfolioPreviewResponse(userId = null) {
  const portfolio = buildValuedPaperPortfolio(userId);

  return {
    summary: portfolio.summary ?? null,
    brokerStatus: {
      ibkr: getIbkrStatusForUser(userId),
      tws: paperBrokerState.tws
    }
  };
}

function buildPaperPortfolioResponse(userId = null) {
  const orders = listPaperOrders(null, userId);
  const portfolio = buildPaperPortfolio({
    orders,
    quotes: liveState.quotes,
    polymarketMarkets: getPaperValuationPolymarketMarkets(),
    optionMatches: buildPaperValuationOptionMatches()
  });
  const orderIds = orders
    .map((order) => Number(order.id))
    .filter((orderId) => Number.isInteger(orderId) && orderId > 0);
  const withHistory = attachPaperOrderHistory(
    portfolio,
    orderIds.length ? listPaperOrderSnapshots(orderIds) : [],
    liveState.lastUpdated ?? new Date().toISOString()
  );
  const calculatorSnapshotsByOrderId = new Map();

  for (const snapshot of orderIds.length ? listPaperCalculatorSnapshots(orderIds) : []) {
    const orderId = Number(snapshot.orderId);
    if (!calculatorSnapshotsByOrderId.has(orderId)) {
      calculatorSnapshotsByOrderId.set(orderId, []);
    }
    calculatorSnapshotsByOrderId.get(orderId).push(snapshot);
  }

  const openOrders = (withHistory.openOrders ?? []).map((order) => ({
    ...order,
    calculatorSnapshots: calculatorSnapshotsByOrderId.get(Number(order.id)) ?? []
  }));
  const closedOrders = (withHistory.closedOrders ?? []).map((order) => ({
    ...order,
    calculatorSnapshots: calculatorSnapshotsByOrderId.get(Number(order.id)) ?? []
  }));

  return {
    ...withHistory,
    orders: openOrders,
    openOrders,
    closedOrders,
    brokerStatus: {
      ibkr: getIbkrStatusForUser(userId),
      tws: paperBrokerState.tws
    }
  };
}

function buildPaperPortfolioResponseSafe(userId = null) {
  try {
    return buildPaperPortfolioResponse(userId);
  } catch (error) {
    logWarn("Failed to build paper portfolio response", {
      subsystem: "paper",
      userId,
      error
    });
    return null;
  }
}

function invalidateStrategyResponseCache() {
  strategyResponseCache.version += 1;
  strategyResponseCache.response = null;
  strategyResponseCache.finderRowDetails = new Map();
}

function buildComparableIbkrStatus(status) {
  return {
    configured: status?.configured === true,
    connected: status?.connected === true,
    authenticated: status?.authenticated === true,
    isPaper: status?.isPaper === true,
    selectedAccount: String(status?.selectedAccount ?? ""),
    accounts: Array.isArray(status?.accounts)
      ? status.accounts.map((account) => String(account ?? ""))
      : [],
    aliases:
      status?.aliases && typeof status.aliases === "object" ? status.aliases : {},
    allowedAssetTypes: String(status?.allowedAssetTypes ?? ""),
    error: String(status?.error ?? "")
  };
}

function syncStrategyCacheBrokerStatus() {
  // Broker status is computed per-user in buildStrategiesResponse().
}

function buildFinderRowSummary(row) {
  const usesSyntheticChain = (row.legs ?? []).some((leg) => {
    if (leg?.kind !== "option") {
      return false;
    }

    const normalizedQuoteSource = String(leg.quoteSource ?? "")
      .trim()
      .toLowerCase();

    return (
      normalizedQuoteSource === "modeled" ||
      normalizedQuoteSource === "modeled chain" ||
      normalizedQuoteSource === "synthetic chain"
    );
  });
  const currentUnderlyingSpot = Number(row?.marketContext?.currentUnderlyingSpot ?? NaN);
  const targetUnderlyingValue = Number(row?.marketContext?.targetUnderlyingValue ?? NaN);
  const expectedMovePercent =
    currentUnderlyingSpot > 0 && targetUnderlyingValue > 0
      ? ((targetUnderlyingValue / currentUnderlyingSpot) - 1) * 100
      : null;

  return {
    id: row.id,
    assetLabel: row.assetLabel,
    expiration: row.expiration,
    strategyCloseDate: row.strategyCloseDate,
    days: row.days,
    strategyType: row.strategyType,
    marketBias: row.marketBias,
    marketBiasTone: row.marketBiasTone,
    formula: row.formula ?? [],
    polymarketPrice: row.polymarketPrice,
    polymarketPriceSide: row.polymarketPriceSide,
    polymarketVolume: row.polymarketVolume,
    polymarketSource: row.polymarketSource,
    expectedMovePercent,
    maxProfit: row.maxProfit,
    maxLoss: row.maxLoss,
    maxProfitUnbounded: row.maxProfitUnbounded,
    maxLossUnbounded: row.maxLossUnbounded,
    rewardRisk: row.rewardRisk,
    breakevens: row.breakevens ?? [],
    theoPrice: row.theoPrice,
    bid: row.bid,
    ask: row.ask,
    bidAskSpread: row.bidAskSpread,
    normalizedOptionVolume: row.normalizedOptionVolume,
    expPayoff: row.expPayoff,
    targetOptionQuoteSize: row.targetOptionQuoteSize,
    usesSyntheticChain,
    maxProfitRangeTag: row.maxProfitRangeTag ?? null,
    maxLossRangeTag: row.maxLossRangeTag ?? null
  };
}

function buildSlimPrimaryStrategy(strategySummary) {
  if (!strategySummary) {
    return null;
  }

  return {
    finder: {
      ...(strategySummary.finder ?? {}),
      rows: (strategySummary.finder?.rows ?? []).map(buildFinderRowSummary)
    },
    scanUniverse: strategySummary.scanUniverse ?? []
  };
}

function getCachedFinderRowDetail(rowId) {
  const normalizedRowId = String(rowId ?? "").trim();
  if (!normalizedRowId) {
    return null;
  }

  return strategyResponseCache.finderRowDetails.get(normalizedRowId) ?? null;
}

async function refreshIbkrStatusCacheForUser(userId) {
  const brokerState = getIbkrBrokerState(userId);
  const previousComparableStatus = JSON.stringify(buildComparableIbkrStatus(brokerState.status));
  const context = getIbkrContextForUser(userId);

  const ibkrStatus = await getIbkrStatus(context);
  brokerState.status = {
    ...ibkrStatus,
    updatedAt: new Date().toISOString()
  };

  syncStrategyCacheBrokerStatus();
  const nextComparableStatus = JSON.stringify(buildComparableIbkrStatus(brokerState.status));
  if (previousComparableStatus !== nextComparableStatus) {
    schedulePaperPortfolioBroadcast(0);
  }

  return brokerState.status;
}

async function refreshIbkrStatusCacheForActiveUsers() {
  const userIds = [...paperStreamClientsByUserId.keys()];
  if (!userIds.length) {
    return [];
  }

  const results = [];

  for (const userId of userIds) {
    try {
      results.push(await refreshIbkrStatusCacheForUser(userId));
    } catch (_error) {
      results.push(null);
    }
  }

  return results;
}

async function handleTwsOrderStatusUpdate(event) {
  if (!event || typeof event !== "object") {
    return;
  }

  const orderId = Number(event.orderId ?? 0);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return;
  }

  const paperOrderIdFromRef = Number(event.parsedRef?.paperOrderId ?? 0) || null;
  const orderRecord = paperOrderIdFromRef
    ? listPaperOrders().find((record) => Number(record.id) === paperOrderIdFromRef) ?? null
    : listPaperOrders().find(
        (record) => String(record?.position?.execution?.brokerOrderId ?? "").trim() === String(orderId)
      ) ?? null;

  if (!orderRecord?.position || !isTwsPaperRoute(orderRecord.position)) {
    return;
  }

  const existingOrder = orderRecord.position;
  const existingExecution = existingOrder.execution ?? null;
  if (!existingExecution) {
    return;
  }

  const trades = twsPaperApi
    .getTradesForOrder(orderId)
    .map((fill) => ({
      conid: String(fill?.contract?.conId ?? "").trim(),
      quantity: Math.abs(Number(fill?.shares ?? 0) || 0),
      price: Number(fill?.price ?? 0) || 0,
      execution_time: String(fill?.time ?? "")
    }))
    .filter((fill) => fill.conid && fill.quantity > 0);
  const tradeFillMap = buildTradeFillMap(trades);
  const latestTradeTimestamp = [...tradeFillMap.values()]
    .map((fill) => fill.latestAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];

  const normalizedStatus = String(event.normalizedStatus ?? existingExecution.status ?? "submitted")
    .trim()
    .toLowerCase();
  const filledQuantity = toNumber(event.filled, existingExecution.filledQuantity);
  const remainingQuantity = toNumber(event.remaining, existingExecution.remainingQuantity);
  const totalQuantity =
    existingExecution.totalQuantity != null
      ? Number(existingExecution.totalQuantity)
      : filledQuantity != null && remainingQuantity != null
        ? filledQuantity + remainingQuantity
        : null;
  const nowIso = new Date().toISOString();

  const nextExecution = {
    ...existingExecution,
    route: "tws-paper",
    purpose: "entry",
    status: normalizedStatus,
    statusText: String(event.status ?? existingExecution.statusText ?? normalizedStatus).trim() || normalizedStatus,
    brokerOrderId: String(orderId),
    orderRef: String(event.orderRef ?? existingExecution.orderRef ?? "").trim(),
    accountId: String(existingExecution.accountId ?? paperBrokerState.tws.selectedAccount ?? ""),
    isPaper: paperBrokerState.tws.isPaper === true,
    avgFillPrice:
      event.avgFillPrice != null ? toNumber(event.avgFillPrice, null) : existingExecution.avgFillPrice,
    filledQuantity,
    remainingQuantity,
    totalQuantity,
    filledAt:
      normalizedStatus === "filled"
        ? existingExecution.filledAt || latestTradeTimestamp || nowIso
        : existingExecution.filledAt,
    cancelledAt:
      normalizedStatus === "cancelled" || normalizedStatus === "api_cancelled" || normalizedStatus === "apicancelled"
        ? existingExecution.cancelledAt || latestTradeTimestamp || nowIso
        : existingExecution.cancelledAt,
    lastSyncAt: nowIso
  };

  let nextOrder = sanitizePaperOrderPayload(
    {
      ...existingOrder,
      execution: nextExecution
    },
    existingOrder
  );

  nextOrder = applyEntryExecutionToOrder(nextOrder, nextOrder.execution, trades);

  if (JSON.stringify(nextOrder) === JSON.stringify(existingOrder)) {
    return;
  }

  const storedOrder = updatePaperOrder(Number(orderRecord.id), nextOrder);
  const valuation = buildPaperPortfolio({
    orders: [storedOrder],
    quotes: liveState.quotes,
    polymarketMarkets: getPaperValuationPolymarketMarkets(),
    optionMatches: buildPaperValuationOptionMatches()
  });
  const valuedOrder = valuation.openOrders[0] ?? valuation.closedOrders[0] ?? valuation.orders[0] ?? null;
  if (valuedOrder) {
    recordPaperOrderSnapshots([
      buildPaperOrderSnapshot(
        valuedOrder,
        nextOrder.closedAt || nextExecution.filledAt || nextExecution.lastSyncAt || nowIso
      )
    ]);
  }

  paperBrokerState.tws = {
    ...paperBrokerState.tws,
    lastSyncAt: nowIso,
    lastSyncError: null
  };
  syncStrategyCacheBrokerStatus();
  invalidateStrategyResponseCache();
  syncPaperOptionStreamSubscriptions();
  schedulePaperPortfolioBroadcast(0);
}

twsPaperApi.on("status", (status) => {
  paperBrokerState.tws = {
    ...paperBrokerState.tws,
    ...(status ?? {})
  };
  syncStrategyCacheBrokerStatus();
  schedulePaperPortfolioBroadcast(0);
});

twsPaperApi.on("orderStatus", (event) => {
  void handleTwsOrderStatusUpdate(event);
});

async function ensureInitialLiveStateReady() {
  if (!initialLiveStateReadyPromise) {
    return;
  }

  await initialLiveStateReadyPromise;
}

function isBrokerTrackedOrder(order) {
  return (
    isIbkrPaperRoute(order) ||
    isTwsPaperRoute(order) ||
    String(order?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper" ||
    isTwsPaperExecution(order?.closeExecution)
  );
}

function getTradeConid(trade) {
  return String(trade?.conidEx ?? trade?.conid ?? trade?.contract_conid ?? trade?.contractConid ?? "").trim();
}

function getTradeQuantity(trade) {
  return Math.abs(
    Number(
      trade?.quantity ??
        trade?.qty ??
        trade?.size ??
        trade?.execution_size ??
        trade?.cumQty ??
        trade?.cum_qty ??
        0
    ) || 0
  );
}

function getTradePrice(trade) {
  return Number(
    trade?.price ??
      trade?.trade_price ??
      trade?.avgPrice ??
      trade?.avg_price ??
      trade?.execution_price ??
      0
  ) || 0;
}

function getTradeTimestamp(trade) {
  return (
    normalizeTimestamp(
      trade?.trade_time_r ??
        trade?.tradeTimeR ??
        trade?.trade_time ??
        trade?.tradeTime ??
        trade?.execution_time ??
        trade?.executionTime
    ) || ""
  );
}

function buildTradeFillMap(trades = []) {
  const fillMap = new Map();

  (trades ?? []).forEach((trade) => {
    const conid = getTradeConid(trade);
    if (!conid) {
      return;
    }

    const quantity = getTradeQuantity(trade);
    const price = getTradePrice(trade);
    const timestamp = getTradeTimestamp(trade);
    const existing = fillMap.get(conid) ?? {
      quantity: 0,
      weightedValue: 0,
      avgPrice: null,
      latestAt: "",
      earliestAt: ""
    };

    const nextQuantity = existing.quantity + quantity;
    const nextWeightedValue = existing.weightedValue + (quantity * price);
    fillMap.set(conid, {
      quantity: nextQuantity,
      weightedValue: nextWeightedValue,
      avgPrice: nextQuantity > 0 ? nextWeightedValue / nextQuantity : null,
      latestAt:
        existing.latestAt && timestamp ? [existing.latestAt, timestamp].sort().slice(-1)[0] : existing.latestAt || timestamp,
      earliestAt:
        existing.earliestAt && timestamp ? [existing.earliestAt, timestamp].sort()[0] : existing.earliestAt || timestamp
    });
  });

  return fillMap;
}

function deriveExecutionFilledQuantity(execution, tradeFillMap) {
  const requestedLegs = Array.isArray(execution?.requestedLegs) ? execution.requestedLegs : [];
  const comboQuantities = requestedLegs
    .map((leg) => {
      const fill = tradeFillMap.get(String(leg.brokerConid ?? "").trim());
      if (!fill || !(fill.quantity > 0)) {
        return null;
      }

      const ratio = Math.max(Number(leg.ratio ?? 1) || 1, 1);
      return fill.quantity / ratio;
    })
    .filter((value) => value != null);

  if (!comboQuantities.length) {
    return null;
  }

  return Math.max(Math.round(Math.min(...comboQuantities)), 0);
}

function mergeExecutionState(existingExecution, liveOrder, trades = []) {
  if (!existingExecution) {
    return null;
  }

  const tradeFillMap = buildTradeFillMap(trades);
  const derivedFilledQuantity = deriveExecutionFilledQuantity(existingExecution, tradeFillMap);
  const normalizedLiveOrder = liveOrder ? normalizeIbkrLiveOrder(liveOrder) : null;
  const pendingReplyId = String(existingExecution.pendingReplyId ?? "").trim();
  const smartState = getSmartExecutionState(existingExecution);
  const preservePendingConfirmation =
    String(existingExecution.status ?? "").trim().toLowerCase() === "pending_confirmation" &&
    pendingReplyId.length > 0;
  const preservePendingSmartCancel =
    smartState.enabled === true &&
    smartState.pendingLimitPrice != null &&
    ["pending_cancel", "pre_cancelled"].includes(String(existingExecution.status ?? "").trim().toLowerCase()) &&
    normalizedLiveOrder &&
    isIbkrWorkingStatus(normalizedLiveOrder.status) &&
    !isIbkrFilledStatus(normalizedLiveOrder.status);
  const status = normalizedLiveOrder?.status ?? String(existingExecution.status ?? "submitted");
  const resolvedBrokerOrderId = String(
    normalizedLiveOrder?.brokerOrderId ?? existingExecution.brokerOrderId ?? ""
  ).trim();
  const hasResolvedBrokerState =
    !preservePendingConfirmation &&
    !preservePendingSmartCancel &&
    (
      Boolean(String(normalizedLiveOrder?.brokerOrderId ?? "").trim()) ||
      (status !== "pending_confirmation" && resolvedBrokerOrderId.length > 0)
    );
  const nextStatus = preservePendingConfirmation
    ? "pending_confirmation"
    : preservePendingSmartCancel
      ? String(existingExecution.status ?? "pending_cancel")
      : status;
  const nextStatusText = preservePendingConfirmation
    ? String(existingExecution.statusText ?? "Broker confirmation required")
    : preservePendingSmartCancel
      ? String(existingExecution.statusText ?? "Smart replace cancel requested")
    : normalizedLiveOrder?.statusText ?? existingExecution.statusText;
  const nextStatusDescription = preservePendingConfirmation
    ? String(existingExecution.statusDescription ?? "")
    : preservePendingSmartCancel
      ? String(existingExecution.statusDescription ?? "")
    : normalizedLiveOrder?.statusDescription ?? existingExecution.statusDescription ?? "";
  const filledQuantity =
    normalizedLiveOrder?.filledQuantity ??
    (derivedFilledQuantity != null ? derivedFilledQuantity : existingExecution.filledQuantity);
  const totalQuantity =
    normalizedLiveOrder?.totalQuantity ??
    (existingExecution.totalQuantity != null ? Number(existingExecution.totalQuantity) : null);
  const remainingQuantity =
    normalizedLiveOrder?.remainingQuantity ??
    (totalQuantity != null && filledQuantity != null ? Math.max(totalQuantity - filledQuantity, 0) : existingExecution.remainingQuantity);
  const latestTradeTimestamp = [...tradeFillMap.values()]
    .map((fill) => fill.latestAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];

  return {
    ...existingExecution,
    status: nextStatus,
    statusText: nextStatusText,
    statusDescription: nextStatusDescription,
    brokerOrderId: normalizedLiveOrder?.brokerOrderId ?? existingExecution.brokerOrderId,
    avgFillPrice:
      normalizedLiveOrder?.avgFillPrice != null
        ? normalizedLiveOrder.avgFillPrice
        : existingExecution.avgFillPrice,
    filledQuantity,
    totalQuantity,
    remainingQuantity,
    submittedAt: existingExecution.submittedAt || new Date().toISOString(),
    filledAt:
      isIbkrFilledStatus(nextStatus)
        ? existingExecution.filledAt || normalizedLiveOrder?.lastExecutionAt || latestTradeTimestamp || new Date().toISOString()
        : existingExecution.filledAt,
    cancelledAt:
      nextStatus === "cancelled"
        ? existingExecution.cancelledAt || normalizedLiveOrder?.lastExecutionAt || latestTradeTimestamp || new Date().toISOString()
        : existingExecution.cancelledAt,
    lastSyncAt: new Date().toISOString(),
    lastError:
      preservePendingConfirmation
        ? ""
        : preservePendingSmartCancel
        ? ""
        : nextStatus === "rejected" || nextStatus === "error"
        ? normalizedLiveOrder?.statusDescription || existingExecution.lastError
        : existingExecution.lastError,
    lastWarning: existingExecution.lastWarning || "",
    pendingReplyId: hasResolvedBrokerState ? "" : pendingReplyId,
    pendingReplyMessages: hasResolvedBrokerState
      ? []
      : Array.isArray(existingExecution.pendingReplyMessages)
        ? existingExecution.pendingReplyMessages
        : []
  };
}

function applyEntryExecutionToOrder(order, execution, trades = [], { applyFills = false } = {}) {
  if (!execution) {
    return order;
  }

  const fillMap = buildTradeFillMap(trades);
  const derivedFilledQuantity = deriveExecutionFilledQuantity(execution, fillMap);
  const filledQuantity =
    derivedFilledQuantity != null
      ? derivedFilledQuantity
      : execution.filledQuantity != null
        ? Number(execution.filledQuantity)
        : null;
  const hasFillQuantity = filledQuantity != null && Number.isFinite(filledQuantity) && filledQuantity > 0;
  const shouldApplyFills = applyFills === true && hasFillQuantity;

  return sanitizePaperOrderPayload(
    {
      ...order,
      execution,
      legs: (order.legs ?? []).map((leg) => {
        if (leg?.kind !== "option") {
          return leg;
        }

        const requestedLeg =
          execution.requestedLegs?.find((candidate) => String(candidate.legId) === String(leg.id)) ?? null;
        if (!requestedLeg) {
          return leg;
        }

        const fillQuantity =
          shouldApplyFills
            ? Math.max(
                Math.round((Number(requestedLeg.ratio ?? 1) || 1) * Number(filledQuantity ?? 0)),
                0
              )
            : Number(leg.quantity ?? 0) || 0;
        const fill = fillMap.get(String(requestedLeg.brokerConid ?? leg.brokerConid ?? "").trim()) ?? null;

        return {
          ...leg,
          ...(shouldApplyFills
            ? {
                quantity: fillQuantity,
                entryPrice: fill?.avgPrice != null ? fill.avgPrice : leg.entryPrice
              }
            : {}),
          brokerConid: requestedLeg.brokerConid ?? leg.brokerConid ?? "",
          localSymbol: requestedLeg.localSymbol ?? leg.localSymbol ?? ""
        };
      })
    },
    order
  );
}

function updateEntrySmartExecution(order, smartPatch = {}, executionPatch = {}) {
  return sanitizePaperOrderPayload(
    {
      ...order,
      execution: {
        ...(order?.execution ?? {}),
        ...executionPatch,
        smart: {
          ...getSmartExecutionState(order?.execution),
          ...smartPatch
        }
      }
    },
    order
  );
}

function buildSmartReplacementLimit(limitPrice, smartState, comboQuote) {
  const currentLimitPrice = toNumber(limitPrice, null);
  if (currentLimitPrice == null || !comboQuote?.ready) {
    return null;
  }

  const minTick = Math.max(toNumber(smartState?.minTick, SMART_ORDER_MIN_TICK) ?? SMART_ORDER_MIN_TICK, 0.01);
  const step = Math.max(minTick, Number(comboQuote.width ?? 0) * 0.25);
  const candidate = Math.max(
    currentLimitPrice + step,
    Number(comboQuote.midPrice ?? currentLimitPrice) + Math.min(Number(comboQuote.width ?? 0) * 0.15, step)
  );
  const bounded = Math.min(
    candidate,
    Number(comboQuote.worstPrice ?? candidate),
    toNumber(smartState?.guardrailLimitPrice, candidate) ?? candidate
  );
  const rounded = roundPriceTowardsFill(bounded, minTick);
  return rounded == null ? null : Math.min(rounded, Number(comboQuote.worstPrice ?? rounded), Number(smartState?.guardrailLimitPrice ?? rounded));
}

function getSmartDecisionPausePatch(order, { decision, reason, keepEnabled = true } = {}) {
  const smartState = getSmartExecutionState(order?.execution);

  return updateEntrySmartExecution(order, {
    ...smartState,
    enabled: keepEnabled && smartState.enabled === true,
    status: keepEnabled && smartState.enabled === true ? "paused" : "disabled",
    pendingLimitPrice: null,
    lastDecision: String(decision ?? "paused"),
    lastDecisionReason: String(reason ?? "Smart pricing paused."),
    lastSuggestedLimitPrice: null
  });
}

async function maybeManageSmartEntryExecution(record, order, ibkrContext = null) {
  if (!isIbkrPaperRoute(order) || !order?.execution || !isSmartEntryEnabled(order.execution)) {
    return null;
  }

  const baseOrder = reconcileSmartEntryExecution(order);
  const execution = baseOrder.execution ?? null;
  if (!execution) {
    return JSON.stringify(baseOrder) !== JSON.stringify(order) ? baseOrder : null;
  }

  const smartState = getSmartExecutionState(execution);
  const executionStatus = String(execution.status ?? "").trim().toLowerCase();
  const limitPrice = toNumber(execution.limitPrice, null);
  const replaceCount = Math.max(Math.round(toNumber(smartState.replaceCount, 0) ?? 0), 0);
  const maxReplaceCount = Math.max(
    Math.round(toNumber(smartState.maxReplaceCount, SMART_ORDER_MAX_REPLACES) ?? SMART_ORDER_MAX_REPLACES),
    0
  );
  const cooldownMs = Math.max(
    Math.round(toNumber(smartState.cooldownMs, SMART_ORDER_COOLDOWN_MS) ?? SMART_ORDER_COOLDOWN_MS),
    5000
  );
  const requestedLegs =
    Array.isArray(execution.requestedLegs) && execution.requestedLegs.length
      ? execution.requestedLegs
      : buildRequestedExecutionLegs(baseOrder);

  if (String(execution.orderType ?? "").trim().toUpperCase() !== "LMT") {
    const disabledOrder = updateEntrySmartExecution(baseOrder, {
      ...smartState,
      enabled: false,
      status: "disabled",
      pendingLimitPrice: null,
      lastDecision: "unsupported_order_type",
      lastDecisionReason: "Smart pricing only runs on IBKR limit entry orders."
    });
    return JSON.stringify(disabledOrder) !== JSON.stringify(order) ? disabledOrder : null;
  }

  if (isExecutionConfirmationPending(execution)) {
    return JSON.stringify(baseOrder) !== JSON.stringify(order) ? baseOrder : null;
  }

  if (limitPrice == null) {
    const pausedOrder = getSmartDecisionPausePatch(baseOrder, {
      decision: "missing_limit",
      reason: "Smart pricing paused because this order does not have a valid limit price."
    });
    return JSON.stringify(pausedOrder) !== JSON.stringify(order) ? pausedOrder : null;
  }

  if (Number(execution.filledQuantity ?? 0) > 0 && !isIbkrFilledStatus(execution.status)) {
    const pausedOrder = getSmartDecisionPausePatch(baseOrder, {
      decision: "partial_fill",
      reason: "Smart pricing paused because the order has already filled partially."
    });
    return JSON.stringify(pausedOrder) !== JSON.stringify(order) ? pausedOrder : null;
  }

  if (smartState.pendingLimitPrice != null) {
    if (executionStatus === "cancelled") {
      const replacementLimitPrice = toNumber(smartState.pendingLimitPrice, null);
      if (replacementLimitPrice == null) {
        const clearedOrder = updateEntrySmartExecution(baseOrder, {
          ...smartState,
          status: "watching",
          pendingLimitPrice: null,
          lastDecision: "replace_cleared",
          lastDecisionReason: "Smart replacement target cleared before submission."
        });
        return JSON.stringify(clearedOrder) !== JSON.stringify(order) ? clearedOrder : null;
      }

      const replacementOrder = sanitizePaperOrderPayload(
        {
          ...baseOrder,
          execution: {
            ...execution,
            status: "pending_submit",
            statusText: "Submitting smart replacement",
            statusDescription: "",
            brokerOrderId: "",
            orderRef: "",
            limitPrice: replacementLimitPrice,
            submittedAt: "",
            lastSyncAt: "",
            filledAt: "",
            cancelledAt: "",
            avgFillPrice: null,
            filledQuantity: 0,
            remainingQuantity: execution.totalQuantity ?? null,
            lastError: "",
            lastWarning: "",
            warningMessages: [],
            pendingReplyId: "",
            pendingReplyMessages: [],
            smart: {
              ...smartState,
              status: "watching",
              replaceCount: replaceCount + 1,
              pendingLimitPrice: null,
              lastTriggeredAt: new Date().toISOString(),
              lastDecision: "replace_submitted",
              lastDecisionReason: `Smart replacement submitted at ${replacementLimitPrice.toFixed(2)}.`,
              lastSuggestedLimitPrice: replacementLimitPrice
            }
          }
        },
        baseOrder
      );

      try {
        const submission = await submitIbkrOptionOrder({
          order: {
            ...replacementOrder,
            id: Number(record.id)
          },
          purpose: "entry"
        }, ibkrContext ?? {});

        return sanitizePaperOrderPayload(
          {
            ...replacementOrder,
            execution: submission
          },
          replacementOrder
        );
      } catch (error) {
        return getSmartDecisionPausePatch(baseOrder, {
          decision: "replace_failed",
          reason: `Smart replacement failed after cancel: ${error.message}`
        });
      }
    }

    if (["pending_cancel", "pre_cancelled", "submitted", "pre_submitted"].includes(executionStatus)) {
      const pendingReplaceOrder = updateEntrySmartExecution(baseOrder, {
        ...smartState,
        status: "pending_replace"
      });
      return JSON.stringify(pendingReplaceOrder) !== JSON.stringify(order) ? pendingReplaceOrder : null;
    }
  }

  if (!isIbkrWorkingStatus(execution.status) || ["pending_cancel", "pre_cancelled"].includes(executionStatus)) {
    return JSON.stringify(baseOrder) !== JSON.stringify(order) ? baseOrder : null;
  }

  const comboQuote = buildSmartComboQuote(requestedLegs);
  if (!comboQuote.ready) {
    const pausedOrder = getSmartDecisionPausePatch(baseOrder, {
      decision: "quotes_unavailable",
      reason: comboQuote.reason || "Smart pricing is waiting for fresh option bid/ask quotes."
    });
    return JSON.stringify(pausedOrder) !== JSON.stringify(order) ? pausedOrder : null;
  }

  const thresholdPrice = Math.max(toNumber(smartState.thresholdPrice, 0) ?? 0, 0);
  const guardrailLimitPrice = toNumber(smartState.guardrailLimitPrice, null);
  const marketDrift = Number(comboQuote.midPrice ?? limitPrice) - limitPrice;
  const smartDecision = String(smartState.lastDecision ?? "").trim().toLowerCase();
  const nextWatchingOrder =
    smartState.pendingLimitPrice == null &&
    (
      String(smartState.status ?? "").trim().toLowerCase() !== "watching" &&
      (
        String(smartState.status ?? "").trim().toLowerCase() !== "paused" ||
        smartDecision === "quotes_unavailable"
      )
    )
      ? updateEntrySmartExecution(baseOrder, {
          ...smartState,
          status: "watching",
          lastDecision: smartDecision === "quotes_unavailable" ? "watching" : String(smartState.lastDecision ?? "watching"),
          lastDecisionReason:
            smartDecision === "quotes_unavailable"
              ? "Smart pricing resumed after live option bid/ask quotes returned."
              : String(smartState.lastDecisionReason ?? "Smart pricing is monitoring the live combo quote.")
        })
      : baseOrder;

  if (marketDrift <= thresholdPrice + SMART_ORDER_EPSILON) {
    return JSON.stringify(nextWatchingOrder) !== JSON.stringify(order) ? nextWatchingOrder : null;
  }

  if (guardrailLimitPrice != null && Number(comboQuote.midPrice ?? limitPrice) > guardrailLimitPrice + SMART_ORDER_EPSILON) {
    const pausedOrder = getSmartDecisionPausePatch(baseOrder, {
      decision: "guardrail_reached",
      reason: `Smart pricing paused because the live combo moved beyond the ${guardrailLimitPrice.toFixed(2)} guardrail.`
    });
    return JSON.stringify(pausedOrder) !== JSON.stringify(order) ? pausedOrder : null;
  }

  if (replaceCount >= maxReplaceCount) {
    const pausedOrder = getSmartDecisionPausePatch(baseOrder, {
      decision: "replace_limit_reached",
      reason: `Smart pricing used all ${maxReplaceCount} allowed replacements for this order.`
    });
    return JSON.stringify(pausedOrder) !== JSON.stringify(order) ? pausedOrder : null;
  }

  const lastTriggeredAtMs = smartState.lastTriggeredAt ? new Date(smartState.lastTriggeredAt).getTime() : 0;
  if (lastTriggeredAtMs && Date.now() - lastTriggeredAtMs < cooldownMs) {
    return JSON.stringify(nextWatchingOrder) !== JSON.stringify(order) ? nextWatchingOrder : null;
  }

  const replacementLimitPrice = buildSmartReplacementLimit(limitPrice, smartState, comboQuote);
  if (!(replacementLimitPrice > limitPrice + SMART_ORDER_EPSILON)) {
    return JSON.stringify(nextWatchingOrder) !== JSON.stringify(order) ? nextWatchingOrder : null;
  }

  try {
    await cancelIbkrOrder({
      accountId: execution.accountId,
      orderId: execution.brokerOrderId
    }, ibkrContext ?? {});

    return updateEntrySmartExecution(
      sanitizePaperOrderPayload(
        {
          ...baseOrder,
          execution: {
            ...execution,
            status: "pending_cancel",
            statusText: "Smart replace cancel requested",
            statusDescription: `Smart repricing requested at ${replacementLimitPrice.toFixed(2)}.`,
            lastSyncAt: new Date().toISOString()
          }
        },
        baseOrder
      ),
      {
        ...smartState,
        status: "pending_replace",
        pendingLimitPrice: replacementLimitPrice,
        lastTriggeredAt: new Date().toISOString(),
        lastDecision: "replace_requested",
        lastDecisionReason: `Smart repricing requested: ${limitPrice.toFixed(2)} -> ${replacementLimitPrice.toFixed(2)}.`,
        lastMarketPrice: Number(comboQuote.midPrice ?? limitPrice),
        lastSuggestedLimitPrice: replacementLimitPrice
      }
    );
  } catch (error) {
    return getSmartDecisionPausePatch(baseOrder, {
      decision: "cancel_failed",
      reason: `Smart repricing paused because the broker cancel request failed: ${error.message}`
    });
  }
}

function applyBrokerClosePrices(order, tradeFillMap) {
  const nextLegs = (order.legs ?? []).map((leg) => {
    if (leg?.kind !== "option") {
      return leg;
    }

    const fill = tradeFillMap.get(String(leg.brokerConid ?? "").trim()) ?? null;
    if (!fill || fill.avgPrice == null) {
      return leg;
    }

    const quantity = Math.max(Number(leg.quantity ?? 0) || 0, 0);
    const contractMultiplier = Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1);
    const units = quantity * contractMultiplier;
    const entryPrice = Number(leg.entryPrice ?? 0) || 0;
    const closedPrice = fill.avgPrice;
    const direction = String(leg.action ?? "LONG").toUpperCase() === "SHORT" ? -1 : 1;
    const closedExposure = Math.abs(closedPrice * units);
    const closedNetMarkedValue = direction * closedPrice * units;
    const realizedProfitLossValue =
      (String(leg.action ?? "LONG").toUpperCase() === "SHORT" ? entryPrice - closedPrice : closedPrice - entryPrice) *
      units;
    const entryExposure = Math.abs(entryPrice * units);

    return {
      ...leg,
      closedPrice,
      closedExposure,
      closedNetMarkedValue,
      realizedProfitLossValue,
      realizedProfitLossPercent: entryExposure > 0 ? (realizedProfitLossValue / entryExposure) * 100 : null
    };
  });

  const closeSummary = nextLegs.reduce(
    (totals, leg) => ({
      currentHoldingValue: totals.currentHoldingValue + Math.max(Number(leg.closedExposure ?? 0) || 0, 0),
      netMarkedValue: totals.netMarkedValue + (Number(leg.closedNetMarkedValue ?? 0) || 0),
      profitLossValue: totals.profitLossValue + (Number(leg.realizedProfitLossValue ?? 0) || 0),
      entryValue:
        totals.entryValue +
        Math.abs(
          (Number(leg.entryPrice ?? 0) || 0) *
            (leg.kind === "option"
              ? (Number(leg.quantity ?? 0) || 0) * Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1)
              : Number(leg.quantity ?? 0) || 0)
        )
    }),
    {
      currentHoldingValue: 0,
      netMarkedValue: 0,
      profitLossValue: 0,
      entryValue: 0
    }
  );

  return sanitizePaperOrderPayload(
    {
      ...order,
      closeSummary: {
        currentHoldingValue: closeSummary.currentHoldingValue,
        netMarkedValue: closeSummary.netMarkedValue,
        profitLossValue: closeSummary.profitLossValue,
        profitLossPercent:
          closeSummary.entryValue > 0 ? (closeSummary.profitLossValue / closeSummary.entryValue) * 100 : null
      },
      legs: nextLegs
    },
    order
  );
}

async function findLiveOrderForExecution(execution, orderBook, ibkrContext = null) {
  if (!execution) {
    return null;
  }

  const byOrderId = orderBook.liveOrdersById.get(String(execution.brokerOrderId ?? "").trim()) ?? null;
  if (byOrderId) {
    return byOrderId.raw;
  }

  const byOrderRef = orderBook.liveOrdersByRef.get(String(execution.orderRef ?? "").trim()) ?? null;
  if (byOrderRef) {
    return byOrderRef.raw;
  }

  if (execution.brokerOrderId && !isIbkrTerminalStatus(execution.status)) {
    try {
      return await fetchIbkrOrderStatus({
        accountId: execution.accountId,
        orderId: execution.brokerOrderId
      }, ibkrContext ?? {});
    } catch (_error) {
      return null;
    }
  }

  return null;
}

async function syncSingleBrokerOrder(record, orderBook, { applyEntryFills = false, ibkrContext = null } = {}) {
  const existingOrder = record.position;
  let nextOrder = existingOrder;
  let changed = false;

  if (isIbkrPaperRoute(existingOrder)) {
    const entryLiveOrder = await findLiveOrderForExecution(existingOrder.execution, orderBook, ibkrContext);
    const entryTrades = orderBook.tradesByOrderRef.get(String(existingOrder.execution?.orderRef ?? "").trim()) ?? [];
    const nextExecution = mergeExecutionState(existingOrder.execution, entryLiveOrder, entryTrades);
    const nextEntryOrder = applyEntryExecutionToOrder(
      sanitizePaperOrderPayload(
        {
          ...nextOrder,
          execution: nextExecution
        },
        nextOrder
      ),
      nextExecution,
      entryTrades,
      { applyFills: applyEntryFills }
    );

    if (JSON.stringify(nextEntryOrder) !== JSON.stringify(nextOrder)) {
      nextOrder = nextEntryOrder;
      changed = true;
    }

    const smartManagedOrder = await maybeManageSmartEntryExecution(record, nextOrder, ibkrContext);
    if (smartManagedOrder && JSON.stringify(smartManagedOrder) !== JSON.stringify(nextOrder)) {
      nextOrder = smartManagedOrder;
      changed = true;
    }
  }

  if (String(nextOrder?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper") {
    const exitLiveOrder = await findLiveOrderForExecution(nextOrder.closeExecution, orderBook, ibkrContext);
    const exitTrades =
      orderBook.tradesByOrderRef.get(String(nextOrder.closeExecution?.orderRef ?? "").trim()) ?? [];
    const nextCloseExecution = mergeExecutionState(nextOrder.closeExecution, exitLiveOrder, exitTrades);

    if (isIbkrFilledStatus(nextCloseExecution?.status)) {
      const valuation = buildPaperPortfolio({
        orders: [
          {
            ...record,
            position: nextOrder
          }
        ],
        quotes: liveState.quotes,
        polymarketMarkets: getPaperValuationPolymarketMarkets(),
        optionMatches: buildPaperValuationOptionMatches()
      });
      const valuedOrder = valuation.openOrders[0] ?? valuation.orders[0] ?? null;

      if (valuedOrder) {
        let closedOrder = closePaperOrderPayload(
          {
            ...nextOrder,
            closeExecution: mapCloseExecutionToRoute(nextCloseExecution, nextOrder)
          },
          valuedOrder,
          nextCloseExecution.filledAt || new Date().toISOString()
        );
        closedOrder = applyBrokerClosePrices(closedOrder, buildTradeFillMap(exitTrades));

        if (JSON.stringify(closedOrder) !== JSON.stringify(nextOrder)) {
          nextOrder = closedOrder;
          changed = true;
        }
      }
    } else {
      const pendingExitOrder = sanitizePaperOrderPayload(
        {
          ...nextOrder,
          closeExecution: mapCloseExecutionToRoute(nextCloseExecution, nextOrder)
        },
        nextOrder
      );

      if (JSON.stringify(pendingExitOrder) !== JSON.stringify(nextOrder)) {
        nextOrder = pendingExitOrder;
        changed = true;
      }
    }
  }

  return changed ? nextOrder : null;
}

function isIbkrTrackedOrder(order) {
  return (
    isIbkrPaperRoute(order) ||
    String(order?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper" ||
    String(order?.stockExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper"
  );
}

async function syncIbkrPaperOrdersForUser(userId, orderRecords = [], { applyEntryFills = false } = {}) {
  const brokerState = getIbkrBrokerState(userId);
  if (brokerState.syncing) {
    return false;
  }

  const records = Array.isArray(orderRecords) ? orderRecords : [];
  if (!records.length) {
    return false;
  }

  brokerState.syncing = true;

  try {
    const ibkrContext = getIbkrContextForUser(userId);
    const accountIdHint = String(
      records.find((record) => String(record?.position?.execution?.accountId ?? "").trim())?.position?.execution?.accountId ??
        records.find((record) => String(record?.position?.closeExecution?.accountId ?? "").trim())?.position?.closeExecution?.accountId ??
        ""
    ).trim();

    const orderBook = await fetchIbkrOrderBook({
      accountId: accountIdHint
    }, ibkrContext);
    const liveOrders = (orderBook.orders ?? []).map(normalizeIbkrLiveOrder);
    const orderBookIndexes = {
      ...orderBook,
      liveOrdersById: new Map(liveOrders.map((order) => [String(order.brokerOrderId), order])),
      liveOrdersByRef: new Map(liveOrders.map((order) => [String(order.orderRef), order])),
      tradesByOrderRef: groupTradesByOrderRef(orderBook.trades)
    };

    let changed = false;

    for (const record of records) {
      const nextOrder = await syncSingleBrokerOrder(record, orderBookIndexes, {
        applyEntryFills,
        ibkrContext
      });
      if (!nextOrder) {
        continue;
      }

      const storedOrder = updatePaperOrder(Number(record.id), nextOrder);
      const valuation = buildPaperPortfolio({
        orders: [storedOrder],
        quotes: liveState.quotes,
        polymarketMarkets: getPaperValuationPolymarketMarkets(),
        optionMatches: buildPaperValuationOptionMatches()
      });
      const valuedOrder =
        valuation.openOrders[0] ?? valuation.closedOrders[0] ?? valuation.orders[0] ?? null;

      if (valuedOrder) {
        recordPaperOrderSnapshots([
          buildPaperOrderSnapshot(
            valuedOrder,
            nextOrder.closedAt ||
              nextOrder.closeExecution?.filledAt ||
              nextOrder.execution?.lastSyncAt ||
              new Date().toISOString()
          )
        ]);
      }
      changed = true;
    }

    brokerState.lastSyncAt = new Date().toISOString();
    brokerState.lastSyncError = null;
    await refreshIbkrStatusCacheForUser(userId).catch(() => null);

    if (changed) {
      invalidateStrategyResponseCache();
      syncPaperOptionStreamSubscriptions();
      schedulePaperPortfolioBroadcast(0);
    }

    return changed;
  } catch (error) {
    brokerState.lastSyncAt = new Date().toISOString();
    brokerState.lastSyncError = error.message;
    await refreshIbkrStatusCacheForUser(userId).catch(() => null);
    return false;
  } finally {
    brokerState.syncing = false;
  }
}

async function syncIbkrPaperOrders({ userId = null, onlyOrderId = null, applyEntryFills = false } = {}) {
  const normalizedUserId = userId == null ? null : String(userId).trim();
  const targetOrderId = onlyOrderId == null ? null : Number(onlyOrderId);
  const candidateRecords = normalizedUserId ? listPaperOrders(null, normalizedUserId) : listPaperOrders();

  const orderRecords = candidateRecords.filter((record) => {
    const order = record.position;
    if (!isIbkrTrackedOrder(order)) {
      return false;
    }

    if (targetOrderId != null && Number(record.id) !== targetOrderId) {
      return false;
    }

    return String(order.status ?? "open").toLowerCase() !== "closed" || order.closeExecution;
  });

  if (!orderRecords.length) {
    return false;
  }

  if (normalizedUserId) {
    return await syncIbkrPaperOrdersForUser(normalizedUserId, orderRecords, { applyEntryFills });
  }

  const recordsByUserId = new Map();
  for (const record of orderRecords) {
    const recordUserId = String(record?.userId ?? "").trim() || "legacy";
    if (!recordsByUserId.has(recordUserId)) {
      recordsByUserId.set(recordUserId, []);
    }
    recordsByUserId.get(recordUserId).push(record);
  }

  let changed = false;

  for (const [recordUserId, records] of recordsByUserId.entries()) {
    const synced = await syncIbkrPaperOrdersForUser(recordUserId, records, { applyEntryFills });
    if (synced) {
      changed = true;
    }
  }

  return changed;
}

function formatDiagnosticTimestamp(value) {
  return value ? normalizeTimestamp(value) || null : null;
}

function getOptionStreamState() {
  if (!paperLiveState.desiredSymbols.size) {
    return "idle";
  }

  if (paperLiveState.authenticated && paperLiveState.socket?.readyState === WebSocket.OPEN) {
    return "live";
  }

  if (paperLiveState.socket?.readyState === WebSocket.CONNECTING) {
    return "connecting";
  }

  if (paperLiveState.reconnectTimer) {
    return "retrying";
  }

  return "disconnected";
}

function buildStreamDiagnosticsResponse(userId = null) {
  const baselineTrackedContracts = getAlwaysTrackedOptionContractSeeds().size;
  const paperTrackedContracts = [...getOpenPaperOptionContractSeeds().values()].filter(
    (contract) => contract.isLive === true && contract.contractSymbol
  ).length;
  const ibkrBrokerState = userId ? getIbkrBrokerState(userId) : null;
  const ibkrStatus = ibkrBrokerState?.status ?? null;

  return {
    generatedAt: new Date().toISOString(),
    options: {
      provider: "Polygon / Massive websocket",
      state: getOptionStreamState(),
      trackedContracts: paperLiveState.desiredSymbols.size,
      subscribedContracts: paperLiveState.subscribedSymbols.size,
      baselineTrackedContracts,
      paperTrackedContracts,
      lastAuthAt: formatDiagnosticTimestamp(paperLiveState.lastAuthAt),
      lastMessageAt: formatDiagnosticTimestamp(paperLiveState.lastMessageAt),
      lastQuoteAt: formatDiagnosticTimestamp(paperLiveState.lastQuoteAt),
      lastDisconnectAt: formatDiagnosticTimestamp(paperLiveState.lastDisconnectAt),
      lastError: paperLiveState.lastError ?? null
    },
    polymarket: {
      mode: "polling",
      refreshEverySeconds: Math.round(REFERENCE_REFRESH_MS / 1000),
      lastRefreshAt: formatDiagnosticTimestamp(liveState.lastUpdated)
    },
    ibkr: userId
      ? {
          provider: "IBKR Client Portal",
          configured: ibkrStatus?.configured === true,
          connected: ibkrStatus?.connected === true,
          authenticated: ibkrStatus?.authenticated === true,
          isPaper: ibkrStatus?.isPaper === true,
          selectedAccount: ibkrStatus?.selectedAccount ?? "",
          lastUpdated: formatDiagnosticTimestamp(ibkrStatus?.updatedAt),
          lastSyncAt: formatDiagnosticTimestamp(ibkrBrokerState?.lastSyncAt),
          lastSyncError: ibkrBrokerState?.lastSyncError ?? null,
          error: ibkrStatus?.error ?? null
        }
      : null,
    tws: {
      provider: "IBKR TWS",
      configured: paperBrokerState.tws.configured === true,
      connected: paperBrokerState.tws.connected === true,
      authenticated: paperBrokerState.tws.authenticated === true,
      ready: paperBrokerState.tws.ready === true,
      isPaper: paperBrokerState.tws.isPaper === true,
      selectedAccount: paperBrokerState.tws.selectedAccount ?? "",
      host: paperBrokerState.tws.host ?? "",
      port: paperBrokerState.tws.port ?? null,
      lastUpdated: formatDiagnosticTimestamp(paperBrokerState.tws.updatedAt),
      lastSyncAt: formatDiagnosticTimestamp(paperBrokerState.tws.lastSyncAt),
      lastSyncError: paperBrokerState.tws.lastSyncError ?? null,
      error: paperBrokerState.tws.error ?? null
    }
  };
}

function writeSseJson(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastPaperPortfolioNow() {
  if (!paperStreamClientsByUserId.size) {
    return;
  }

  const startedAt = process.hrtime.bigint();
  paperLiveState.broadcastInFlight = true;
  paperLiveState.lastBroadcastStartedAt = new Date().toISOString();

  try {
    const lastUpdated = new Date().toISOString();
    let totalClients = 0;

    for (const [userId, clients] of paperStreamClientsByUserId.entries()) {
      if (!clients?.size) {
        continue;
      }

      totalClients += clients.size;

      let paperPortfolio = null;
      try {
        paperPortfolio = buildPaperPortfolioResponse(userId);
      } catch (error) {
        logWarn("Paper portfolio broadcast build failed", {
          subsystem: "paper",
          userId,
          error
        });
        paperPortfolio = null;
      }

      const payload = {
        type: "paper-portfolio",
        lastUpdated,
        paperPortfolio
      };

      clients.forEach((client) => {
        writeSseJson(client, payload);
      });
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    paperLiveState.lastBroadcastCompletedAt = new Date().toISOString();
    const skippedQuoteBroadcasts = paperLiveState.skippedQuoteBroadcasts;
    paperLiveState.skippedQuoteBroadcasts = 0;
    if (durationMs >= PAPER_QUOTE_SLOW_PROCESS_MS) {
      logInfo("Paper portfolio broadcast completed", {
        subsystem: "paper",
        durationMs: Number(durationMs.toFixed(1)),
        userCount: paperStreamClientsByUserId.size,
        clientCount: totalClients,
        quoteCountSinceSeedRefresh: paperLiveState.quoteCountSinceSeedRefresh,
        skippedQuoteBroadcasts
      });
    }
  } catch (error) {
    logError("Unable to broadcast paper portfolio", {
      subsystem: "paper",
      error
    });
  } finally {
    paperLiveState.broadcastInFlight = false;
  }
}

function schedulePaperPortfolioBroadcast(
  delayMs = PAPER_STREAM_BROADCAST_DEBOUNCE_MS,
  reason = "generic"
) {
  if (paperLiveState.broadcastTimer || paperLiveState.broadcastInFlight) {
    if (reason === "quote") {
      paperLiveState.skippedQuoteBroadcasts += 1;
      const nowMs = Date.now();
      if (
        paperLiveState.skippedQuoteBroadcasts === 1 ||
        nowMs - paperLiveState.lastQuoteBroadcastSkipLoggedAt >= 10000
      ) {
        paperLiveState.lastQuoteBroadcastSkipLoggedAt = nowMs;
        logInfo("Paper portfolio quote broadcast coalesced", {
          subsystem: "paper",
          skippedQuoteBroadcasts: paperLiveState.skippedQuoteBroadcasts,
          delayMs,
          broadcastTimerActive: paperLiveState.broadcastTimer != null,
          broadcastInFlight: paperLiveState.broadcastInFlight
        });
      }
    }
    return;
  }

  paperLiveState.broadcastTimer = setTimeout(() => {
    paperLiveState.broadcastTimer = null;
    broadcastPaperPortfolioNow();
  }, delayMs);
}

function recordPaperPortfolioSnapshotsIfDue(capturedAt = new Date().toISOString(), force = false) {
  const capturedAtMs = new Date(capturedAt).getTime();
  if (!force && capturedAtMs - paperLiveState.lastSnapshotAt < PAPER_ORDER_SNAPSHOT_INTERVAL_MS) {
    return;
  }

  const paperPortfolio = buildPaperPortfolio({
    orders: listPaperOrders(),
    quotes: liveState.quotes,
    polymarketMarkets: getPaperValuationPolymarketMarkets(),
    optionMatches: buildPaperValuationOptionMatches()
  });
  const snapshots = paperPortfolio.openOrders
    .filter((order) => Number.isInteger(Number(order.id)) && Number(order.id) > 0)
    .map((order) => buildPaperOrderSnapshot(order, capturedAt));

  if (snapshots.length) {
    recordPaperOrderSnapshots(snapshots);
  }

  paperLiveState.lastSnapshotAt = capturedAtMs;
}

function clearPaperOptionReconnectTimer() {
  if (!paperLiveState.reconnectTimer) {
    return;
  }

  clearTimeout(paperLiveState.reconnectTimer);
  paperLiveState.reconnectTimer = null;
}

function schedulePaperOptionReconnect() {
  if (
    paperLiveState.reconnectTimer ||
    !process.env.POLYGON_API_KEY ||
    !paperLiveState.desiredSymbols.size
  ) {
    return;
  }

  paperLiveState.reconnectTimer = setTimeout(() => {
    paperLiveState.reconnectTimer = null;
    ensurePaperOptionStream();
  }, 3000);
}

function closePaperOptionStream() {
  clearPaperOptionReconnectTimer();

  if (paperLiveState.socket) {
    paperLiveState.socket.close();
  }

  paperLiveState.socket = null;
  paperLiveState.authenticated = false;
  paperLiveState.subscribedSymbols = new Set();
}

function sendPaperOptionStreamAction(action, symbols) {
  if (
    !paperLiveState.socket ||
    paperLiveState.socket.readyState !== WebSocket.OPEN ||
    !paperLiveState.authenticated ||
    !symbols.length
  ) {
    return;
  }

  const params = symbols.map((symbol) => `Q.${symbol}`).join(",");
  paperLiveState.socket.send(JSON.stringify({ action, params }));
}

function updatePaperOptionStreamSubscriptions() {
  if (
    !paperLiveState.socket ||
    paperLiveState.socket.readyState !== WebSocket.OPEN ||
    !paperLiveState.authenticated
  ) {
    return;
  }

  const desiredSymbols = [...paperLiveState.desiredSymbols];
  const subscribedSymbols = [...paperLiveState.subscribedSymbols];
  const toSubscribe = desiredSymbols.filter((symbol) => !paperLiveState.subscribedSymbols.has(symbol));
  const toUnsubscribe = subscribedSymbols.filter((symbol) => !paperLiveState.desiredSymbols.has(symbol));

  sendPaperOptionStreamAction("unsubscribe", toUnsubscribe);
  sendPaperOptionStreamAction("subscribe", toSubscribe);

  toUnsubscribe.forEach((symbol) => {
    paperLiveState.subscribedSymbols.delete(symbol);
  });
  toSubscribe.forEach((symbol) => {
    paperLiveState.subscribedSymbols.add(symbol);
  });
}

function handlePaperOptionQuote(message) {
  const startedAt = process.hrtime.bigint();
  const contractSymbol = String(message?.sym ?? "").trim();
  if (!contractSymbol || !paperLiveState.desiredSymbols.has(contractSymbol)) {
    return;
  }

  const bid = toNonNegativeNumber(message.bp, null);
  const ask = toNonNegativeNumber(message.ap, null);
  const bidSize = toNonNegativeNumber(message.bs, null);
  const askSize = toNonNegativeNumber(message.as, null);
  const hasBid = bid != null && bid > 0;
  const hasAsk = ask != null && ask > 0;
  const midpoint =
    hasBid && hasAsk ? (bid + ask) / 2
    : hasBid ? bid
    : hasAsk ? ask
    : null;
  const contractSeed = getPaperQuoteContractSeed(contractSymbol);

  livePaperOptionQuotes.set(contractSymbol, {
    ...contractSeed,
    contractSymbol,
    bid,
    ask,
    bidSize,
    askSize,
    mark: midpoint,
    lastPrice: midpoint,
    source: "polygon-websocket",
    sourceLabel: "Polygon.io WebSocket",
    isLive: true,
    hasRealBidAsk: hasBid && hasAsk,
    updatedAt:
      Number.isFinite(Number(message.t)) && Number(message.t) > 0
        ? new Date(Number(message.t)).toISOString()
        : new Date().toISOString()
  });
  paperLiveState.lastQuoteAt =
    Number.isFinite(Number(message.t)) && Number(message.t) > 0
      ? new Date(Number(message.t)).toISOString()
      : new Date().toISOString();
  paperLiveState.lastMessageAt = paperLiveState.lastQuoteAt;
  paperLiveState.quoteCountSinceSeedRefresh += 1;

  try {
    recordPaperPortfolioSnapshotsIfDue(
      Number.isFinite(Number(message.t)) && Number(message.t) > 0
        ? new Date(Number(message.t)).toISOString()
        : new Date().toISOString()
    );
  } catch (error) {
    liveState.warnings = [...liveState.warnings, `Paper-trade history unavailable: ${error.message}`].slice(-8);
  }

  schedulePaperPortfolioBroadcast(PAPER_QUOTE_BROADCAST_DEBOUNCE_MS, "quote");

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  if (durationMs >= PAPER_QUOTE_SLOW_PROCESS_MS) {
    logWarn("Paper quote processing was slow", {
      subsystem: "paper-options-stream",
      contractSymbol,
      durationMs: Number(durationMs.toFixed(1)),
      quoteCountSinceSeedRefresh: paperLiveState.quoteCountSinceSeedRefresh,
      cachedSeedCount: paperOrderSeedCache.seeds.size,
      cacheLastRefreshAt: paperOrderSeedCache.lastRefreshAt,
      cacheLastRefreshDurationMs: paperOrderSeedCache.lastRefreshDurationMs,
      cacheLastRefreshError: paperOrderSeedCache.lastRefreshError,
      broadcastTimerActive: paperLiveState.broadcastTimer != null,
      broadcastInFlight: paperLiveState.broadcastInFlight
    });
  }
}

function handlePaperOptionStreamMessage(event) {
  const rawData =
    typeof event.data === "string"
      ? event.data
      : Buffer.isBuffer(event.data)
        ? event.data.toString("utf8")
        : "";

  if (!rawData) {
    return;
  }

  let messages = [];

  try {
    messages = JSON.parse(rawData);
  } catch (error) {
    logError("Unable to parse Massive options websocket payload", {
      subsystem: "paper-options-stream",
      error
    });
    paperLiveState.lastError = error.message;
    return;
  }

  paperLiveState.lastMessageAt = new Date().toISOString();

  messages.forEach((message) => {
    if (message?.ev === "status") {
      if (message.status === "auth_success") {
        paperLiveState.authenticated = true;
        paperLiveState.subscribedSymbols = new Set();
        paperLiveState.lastAuthAt = new Date().toISOString();
        paperLiveState.lastError = null;
        updatePaperOptionStreamSubscriptions();
      }

      return;
    }

    if (message?.ev === "Q") {
      handlePaperOptionQuote(message);
    }
  });
}

function ensurePaperOptionStream() {
  if (!process.env.POLYGON_API_KEY || !paperLiveState.desiredSymbols.size) {
    closePaperOptionStream();
    return;
  }

  if (
    paperLiveState.socket &&
    (paperLiveState.socket.readyState === WebSocket.OPEN ||
      paperLiveState.socket.readyState === WebSocket.CONNECTING)
  ) {
    if (paperLiveState.authenticated) {
      updatePaperOptionStreamSubscriptions();
    }
    return;
  }

  clearPaperOptionReconnectTimer();
  const socket = new WebSocket(MASSIVE_OPTIONS_WS_URL);

  paperLiveState.socket = socket;
  paperLiveState.authenticated = false;
  paperLiveState.subscribedSymbols = new Set();

  socket.onopen = () => {
    paperLiveState.lastError = null;
    socket.send(JSON.stringify({ action: "auth", params: process.env.POLYGON_API_KEY }));
  };
  socket.onmessage = (event) => {
    handlePaperOptionStreamMessage(event);
  };
  socket.onerror = (error) => {
    paperLiveState.lastError = error?.message ?? "Unknown error";
    logError("Massive options websocket error", {
      subsystem: "paper-options-stream",
      error
    });
  };
  socket.onclose = () => {
    if (paperLiveState.socket === socket) {
      paperLiveState.socket = null;
      paperLiveState.authenticated = false;
      paperLiveState.subscribedSymbols = new Set();
      paperLiveState.lastDisconnectAt = new Date().toISOString();
      schedulePaperOptionReconnect();
    }
  };
}

function syncPaperOptionStreamSubscriptions() {
  invalidatePaperOrderSeedCache("stream-subscription-sync");
  const desiredSymbols = new Set(getDesiredPaperOptionSymbols());
  paperLiveState.desiredSymbols = desiredSymbols;

  livePaperOptionQuotes.forEach((_quote, contractSymbol) => {
    if (!desiredSymbols.has(contractSymbol)) {
      livePaperOptionQuotes.delete(contractSymbol);
    }
  });

  if (!desiredSymbols.size) {
    closePaperOptionStream();
    schedulePaperPortfolioBroadcast(0);
    return;
  }

  ensurePaperOptionStream();
  updatePaperOptionStreamSubscriptions();
}

function isFreshWithin(refreshTimestamp, maxAgeMs) {
  if (!refreshTimestamp) {
    return false;
  }

  const refreshedAtMs = new Date(refreshTimestamp).getTime();

  if (Number.isNaN(refreshedAtMs)) {
    return false;
  }

  return Date.now() - refreshedAtMs < maxAgeMs;
}

function createMacroDashboardSnapshot(refreshedAt = new Date().toISOString()) {
  const nextRefreshAt = new Date(new Date(refreshedAt).getTime() + MACRO_DASHBOARD_REFRESH_MS).toISOString();

  return {
    ...buildMacroDashboardPayload(),
    schemaVersion: MACRO_DASHBOARD_SCHEMA_VERSION,
    refreshedAt,
    nextRefreshAt,
    refreshCadence: "daily"
  };
}

function refreshMacroDashboard(force = false) {
  const latestSnapshot = getLatestMacroDashboardSnapshot();

  if (
    !force &&
    latestSnapshot &&
    latestSnapshot.schemaVersion === MACRO_DASHBOARD_SCHEMA_VERSION &&
    isFreshWithin(latestSnapshot.refreshedAt, MACRO_DASHBOARD_REFRESH_MS)
  ) {
    liveState.macroDashboard = latestSnapshot;
    return latestSnapshot;
  }

  const refreshedAt = new Date().toISOString();
  const snapshot = createMacroDashboardSnapshot(refreshedAt);
  saveMacroDashboardSnapshot(snapshot);
  liveState.macroDashboard = snapshot;
  return snapshot;
}

function getCalendarRange(daysForward = CALENDAR_WINDOW_DAYS) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + (daysForward * 24 * 60 * 60 * 1000) - 1000);

  return { from, to };
}

async function refreshCalendarState(force = false) {
  if (!force && isFreshWithin(liveState.calendarsRefreshedAt, CALENDAR_REFRESH_MS)) {
    return {
      economicCalendar: liveState.economicCalendar,
      companyEvents: liveState.companyEvents
    };
  }

  const { from, to } = getCalendarRange();
  const [economicResult, companyEventsResult] = await Promise.allSettled([
    fetchEconomicCalendar({ from, to, importance: 1 }),
    fetchCompanyEventsCalendar({ from, to, minMarketCapUsd: 30_000_000_000 })
  ]);
  const warnings = [];

  if (economicResult.status === "fulfilled") {
    liveState.economicCalendar = {
      source: "TradingView economic calendar",
      importanceLabel: "High importance",
      from: from.toISOString(),
      to: to.toISOString(),
      count: economicResult.value.length,
      events: economicResult.value
    };
  } else if (!liveState.economicCalendar) {
    liveState.economicCalendar = {
      source: "TradingView economic calendar",
      importanceLabel: "High importance",
      from: from.toISOString(),
      to: to.toISOString(),
      count: 0,
      events: []
    };
  }

  if (economicResult.status === "rejected") {
    warnings.push(`Economic calendar unavailable: ${economicResult.reason.message}`);
  }

  if (companyEventsResult.status === "fulfilled") {
    liveState.companyEvents = {
      source: "TradingView earnings calendar",
      from: from.toISOString(),
      to: to.toISOString(),
      minMarketCapUsd: 30_000_000_000,
      exchanges: ["NASDAQ", "NYSE", "AMEX"],
      count: companyEventsResult.value.length,
      events: companyEventsResult.value
    };
  } else if (!liveState.companyEvents) {
    liveState.companyEvents = {
      source: "TradingView earnings calendar",
      from: from.toISOString(),
      to: to.toISOString(),
      minMarketCapUsd: 30_000_000_000,
      exchanges: ["NASDAQ", "NYSE", "AMEX"],
      count: 0,
      events: []
    };
  }

  if (companyEventsResult.status === "rejected") {
    warnings.push(`Company events unavailable: ${companyEventsResult.reason.message}`);
  }

  liveState.calendarsRefreshedAt = new Date().toISOString();
  liveState.calendarWarnings = warnings;

  return {
    economicCalendar: liveState.economicCalendar,
    companyEvents: liveState.companyEvents
  };
}

function deduplicateBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return result;
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function marketQuestionMentionsSymbol(question, symbol) {
  const normalizedSymbol = String(symbol ?? "").trim();
  const normalizedQuestion = String(question ?? "").trim();
  if (!normalizedSymbol || !normalizedQuestion) {
    return false;
  }

  try {
    return new RegExp(`\\b${escapeRegExp(normalizedSymbol)}\\b`, "i").test(normalizedQuestion);
  } catch (_error) {
    return normalizedQuestion.toUpperCase().includes(normalizedSymbol.toUpperCase());
  }
}

function getStrategyAssetContext() {
  const mappingRecords = listStrategyAssetMappings();
  const { settingsAssets, finderAssets, screenerAssets } = buildEffectiveStrategyAssets(mappingRecords);

  return {
    settingsAssets,
    finderAssets,
    screenerAssets,
    quoteWatchlist: buildStrategyQuoteWatchlist(settingsAssets)
  };
}

function getDeltaHedgeScannerUniverse() {
  return buildDeltaHedgeStockUniverse(listDeltaHedgeScannerSymbols());
}

function matchesAsset(asset, market) {
  return strategyAssetMatchesMarket(asset, market);
}

function getFallbackPolymarketSeedMarkets(markets = [], finderAssets = [], screenerAssets = []) {
  return fallbackPolymarketMarkets.filter((fallbackMarket) => {
    if (!isTradablePolymarketMarket(fallbackMarket)) {
      return false;
    }

    const normalizedAssetId = String(fallbackMarket.assetId ?? "").trim();
    if (!normalizedAssetId) {
      return true;
    }

    const matchingAssets = [...finderAssets, ...screenerAssets].filter((asset) => {
      const assetId = String(asset.id ?? "").trim();
      return assetId === normalizedAssetId || assetId.startsWith(`${normalizedAssetId}-`);
    });

    if (!matchingAssets.length) {
      return true;
    }

    return !markets.some((market) => matchingAssets.some((asset) => matchesAsset(asset, market)));
  });
}

function addDaysIso(dateIso, days) {
  const value = new Date(`${dateIso}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function startOfMonthIso(dateIso) {
  const value = new Date(`${dateIso}T00:00:00.000Z`);
  value.setUTCDate(1);
  return value.toISOString().slice(0, 10);
}

function buildAssetOptionSearchWindow(assetMarkets, fallbackExpiry) {
  const expiries = assetMarkets
    .map((market) => market.endDate?.slice(0, 10))
    .filter(Boolean);
  const referenceDates = expiries.length ? expiries : [fallbackExpiry];

  return {
    from: referenceDates.map((value) => startOfMonthIso(value)).sort()[0],
    to: referenceDates.map((value) => addDaysIso(value, 5)).sort().slice(-1)[0]
  };
}

function withDerivedQuotes(quotes) {
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const glD = quoteMap.get("GLD");
  const xauUsd = quoteMap.get("XAU-USD");
  const spx = quoteMap.get("SPX");
  const spy = quoteMap.get("SPY");
  const spxIndexPrice = Number(
    spx?.regularMarketPrice ??
      (spy?.regularMarketPrice != null ? Number((spy.regularMarketPrice / 0.1).toFixed(2)) : 0)
  );

  return [
    ...quotes,
    !xauUsd && glD
      ? {
          ...glD,
          symbol: "XAU-USD",
          shortName: "Gold spot proxy",
          regularMarketPrice: Number((glD.regularMarketPrice / 0.1).toFixed(2))
        }
      : null,
    spxIndexPrice > 0
      ? {
          ...(spx ?? spy),
          symbol: "SPX-INDEX",
          shortName: "S&P 500 index proxy",
          regularMarketPrice: spxIndexPrice
        }
      : null,
    spxIndexPrice > 0
      ? {
          ...(spx ?? spy),
          symbol: "XSP",
          shortName: "Mini-SPX proxy",
          regularMarketPrice: Number((spxIndexPrice * 0.1).toFixed(2))
        }
      : null
  ].filter(Boolean);
}

async function refreshLiveState({ includeOptions = true } = {}) {
  const warnings = [];
  const { finderAssets, screenerAssets, quoteWatchlist } = getStrategyAssetContext();

  let quotes = liveState.quotes;
  try {
    quotes = withDerivedQuotes(await fetchQuotes(quoteWatchlist));
    const quotesBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
    const snapshots = quoteWatchlist
      .map((item) => {
        const quote = quotesBySymbol.get(item.symbol);
        if (!quote || quote.regularMarketPrice == null) {
          return null;
        }

        return {
          symbol: item.symbol,
          label: item.label,
          groupName: item.group,
          provider: item.provider,
          price: Number(quote.regularMarketPrice),
          changePercent: Number(quote.regularMarketChangePercent ?? 0),
          currency: quote.currency || "USD"
        };
      })
      .filter(Boolean);

    if (snapshots.length) {
      recordMarketSnapshots(snapshots);
    }
  } catch (error) {
    warnings.push(`Quotes unavailable: ${error.message}`);
    quotes = liveState.quotes;
  }

  let polymarketMarkets = liveState.polymarketMarkets;
  let polymarketValuationMarkets = liveState.polymarketValuationMarkets;
  try {
    const queries = deduplicateBy(
      [
        defaultStrategyConfig.yesLeg.query,
        ...collectStrategyPolymarketQueries([...finderAssets, ...screenerAssets])
      ],
      (value) => value
    ).filter(Boolean);

    const results = await Promise.allSettled(
      queries.map((query) => searchPolymarketMarkets(query, 12))
    );

    polymarketMarkets = deduplicateBy(
      results
        .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        .filter((market) => isTradablePolymarketMarket(market)),
      (market) => market.id
    ).slice(0, 30);

    const exactEventUrls = deduplicateBy(
      [
        ...fallbackPolymarketMarkets.map((market) => market.url),
        ...collectStrategyPolymarketEventUrls([...finderAssets, ...screenerAssets]),
        ...(shouldRunBackgroundPaperTasks()
          ? listPaperOrders().map((order) => order.position?.polymarketUrl ?? "")
          : [])
      ]
        .filter((url) => url?.startsWith("https://polymarket.com/event/")),
      (url) => url
    );
    const exactEventResults = await Promise.allSettled(
      exactEventUrls.map((url) => fetchPolymarketMarketsFromEventPage(url, { tradableOnly: false }))
    );
    const exactEventMarkets = exactEventResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    );

    polymarketValuationMarkets = deduplicateBy(
      [...exactEventMarkets, ...polymarketMarkets].filter(
        (market) => market.question && (market.yesPrice != null || market.noPrice != null)
      ),
      (market) => market.id
    );
    polymarketMarkets = deduplicateBy(
      [
        ...exactEventMarkets,
        ...polymarketMarkets
      ].filter((market) => isTradablePolymarketMarket(market)),
      (market) => market.id
    );
  } catch (error) {
    warnings.push(`Polymarket unavailable: ${error.message}`);
    polymarketMarkets = liveState.polymarketMarkets;
    polymarketValuationMarkets = liveState.polymarketValuationMarkets;
  }

  const fallbackSeedMarkets = getFallbackPolymarketSeedMarkets([
    ...(polymarketValuationMarkets ?? []),
    ...polymarketMarkets
  ], finderAssets, screenerAssets);

  polymarketMarkets = polymarketMarkets.filter((market) => isTradablePolymarketMarket(market));
  polymarketValuationMarkets = deduplicateBy(
    [
      ...fallbackSeedMarkets,
      ...(polymarketValuationMarkets ?? []),
      ...polymarketMarkets
    ].filter((market) => market.question && (market.yesPrice != null || market.noPrice != null)),
    (market) => market.id
  );
  polymarketMarkets = deduplicateBy(
    [
      ...fallbackSeedMarkets,
      ...polymarketMarkets
    ].filter((market) => isTradablePolymarketMarket(market)),
    (market) => market.id
  );

  let optionMatches = liveState.optionMatches;
  if (includeOptions) {
    try {
      const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
      const optionRefreshAssets = deduplicateBy(
        [...finderAssets, ...screenerAssets],
        (asset) => `${asset.optionSymbol}:${asset.underlyingSymbol}`
      );

      const optionResults = await Promise.allSettled(
        optionRefreshAssets.map(async (asset) => {
          const assetMarkets = getResolvedStrategyMarketsForAsset(asset, polymarketMarkets).slice(0, 8);
          const leadMarket = assetMarkets[0] ?? null;
          const optionSpot = Number(quoteMap.get(asset.optionSymbol)?.regularMarketPrice ?? 0);
          const underlyingSpot = Number(quoteMap.get(asset.underlyingSymbol)?.regularMarketPrice ?? optionSpot ?? 0);
          const ratio =
            underlyingSpot > 0 && optionSpot > 0
              ? optionSpot / underlyingSpot
              : Number(asset.conversionFallback ?? 1) || 1;
          const leadMarketTarget = parseTargetFromQuestion(leadMarket?.question ?? "");
          const leadStrikeHint =
            Number.isFinite(leadMarketTarget) && leadMarketTarget > 0
              ? marketQuestionMentionsSymbol(leadMarket?.question ?? "", asset.optionSymbol)
                ? leadMarketTarget
                : leadMarketTarget * ratio
              : null;
          const targetStrikes = assetMarkets
            .map((market) => {
              const targetValue = parseTargetFromQuestion(market.question);
              if (!Number.isFinite(targetValue) || targetValue <= 0) {
                return null;
              }

              const strikeHint = marketQuestionMentionsSymbol(market.question, asset.optionSymbol)
                ? targetValue
                : targetValue * ratio;
              return Number.isFinite(strikeHint) && strikeHint > 0 ? Math.max(Math.round(strikeHint), 1) : null;
            })
            .filter((value) => Number.isFinite(value) && value > 0);
          const targetStrike =
            asset.optionSymbol === defaultStrategyConfig.optionLeg.symbol
              ? defaultStrategyConfig.optionLeg.strike
              : Math.max(
                  Math.round((targetStrikes[0] ?? leadStrikeHint ?? underlyingSpot * ratio ?? optionSpot ?? 1) || 1),
                  1
                );
          const strikeFloor = Math.max(Math.min(...targetStrikes, targetStrike) * 0.85, 1);
          const strikeCeiling = Math.max(...targetStrikes, targetStrike) * 1.15;
          const desiredExpiry = leadMarket?.endDate?.slice(0, 10) || defaultStrategyConfig.optionLeg.expiry;
          const searchWindow = buildAssetOptionSearchWindow(assetMarkets, desiredExpiry);

          const [callsPayload, putsPayload] = await Promise.all([
            fetchOptionChain({
              symbol: asset.optionSymbol,
              expirationFrom: searchWindow.from,
              expirationTo: searchWindow.to,
              optionType: "call",
              currentSpot: optionSpot,
              strikeHint: targetStrike,
              strikeMin: strikeFloor,
              strikeMax: strikeCeiling,
              limit: 150
            }),
            fetchOptionChain({
              symbol: asset.optionSymbol,
              expirationFrom: searchWindow.from,
              expirationTo: searchWindow.to,
              optionType: "put",
              currentSpot: optionSpot,
              strikeHint: targetStrike,
              strikeMin: strikeFloor,
              strikeMax: strikeCeiling,
              limit: 150
            })
          ]);

          return [...callsPayload.contracts, ...putsPayload.contracts].map((contract) => ({
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
            exerciseStyle: contract.exerciseStyle ?? asset.exerciseStyle ?? null,
            settlementType: asset.settlementType ?? null,
            source: contract.source,
            sourceLabel: contract.sourceLabel,
            isLive: contract.isLive === true,
            hasRealBidAsk: contract.hasRealBidAsk === true,
            rootSymbol: asset.optionSymbol,
            assetId: asset.id,
            assetLabel: asset.label,
            underlyingSymbol: asset.underlyingSymbol,
            referenceSymbol: asset.referenceSymbol ?? ""
          }));
        })
      );

      optionMatches = optionResults
        .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        .filter(Boolean);
    } catch (error) {
      warnings.push(`Options unavailable: ${error.message}`);
      optionMatches = liveState.optionMatches;
    }
  }

  liveState.quotes = quotes;
  liveState.polymarketMarkets = polymarketMarkets;
  liveState.polymarketValuationMarkets = polymarketValuationMarkets;
  liveState.optionMatches = optionMatches;
  liveState.lastUpdated = new Date().toISOString();
  liveState.warnings = warnings;
  syncPaperOptionStreamSubscriptions();

  if (shouldRunBackgroundPaperTasks()) {
    try {
      recordPaperPortfolioSnapshotsIfDue(liveState.lastUpdated, true);
    } catch (error) {
      warnings.push(`Paper-trade history unavailable: ${error.message}`);
      liveState.warnings = warnings;
    }
  }

  schedulePaperPortfolioBroadcast(0);
  invalidateStrategyResponseCache();
}

async function buildStrategiesBaseResponse() {
  if (strategyResponseCache.response) {
    return strategyResponseCache.response;
  }

  if (strategyResponseCache.buildPromise) {
    return await strategyResponseCache.buildPromise;
  }

  const buildVersion = strategyResponseCache.version;
  strategyResponseCache.buildPromise = (async () => {
    const optionMatches = buildLiveOptionMatches();
    const { settingsAssets, finderAssets, screenerAssets } = getStrategyAssetContext();

    const [strategySummary, v2Screener] = await Promise.all([
      buildStrategySummary({
        quotes: liveState.quotes,
        polymarketMarkets: liveState.polymarketMarkets,
        optionMatches,
        assetUniverse: finderAssets
      }),
      buildStrategyScreenerV2({
        quotes: liveState.quotes,
        polymarketMarkets: liveState.polymarketMarkets,
        optionMatches,
        assetUniverse: screenerAssets
      })
    ]);
    const response = {
      lastUpdated: liveState.lastUpdated,
      warnings: liveState.warnings,
      strategies: getStrategies(),
      primaryStrategy: buildSlimPrimaryStrategy(strategySummary),
      v2Screener,
      strategySettings: {
        compareModes: STRATEGY_COMPARE_MODES,
        assets: settingsAssets
      }
    };

    if (buildVersion === strategyResponseCache.version) {
      strategyResponseCache.response = response;
      strategyResponseCache.finderRowDetails = new Map(
        (strategySummary.finder?.rows ?? []).map((row) => [String(row.id), row])
      );
    }

    return response;
  })();

  try {
    return await strategyResponseCache.buildPromise;
  } finally {
    strategyResponseCache.buildPromise = null;
  }
}

async function buildStrategiesResponse(userId) {
  const base = await buildStrategiesBaseResponse();

  return {
    ...base,
    recentRuns: getRecentRuns(8, userId),
    paperPortfolioPreview: buildPaperPortfolioPreviewResponse(userId),
    setupWatchlist: listSetupWatchlist(userId),
    strategyWatchlist: listStrategyWatchlist(userId)
  };
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    lastUpdated: liveState.lastUpdated,
    macroDashboardRefreshedAt: liveState.macroDashboard?.refreshedAt ?? null,
    calendarsRefreshedAt: liveState.calendarsRefreshedAt,
    warnings: [...liveState.warnings, ...liveState.calendarWarnings]
  });
});

app.get("/api/health/deep", (_request, response) => {
  response.json({
    ok: true,
    lastUpdated: liveState.lastUpdated,
    macroDashboardRefreshedAt: liveState.macroDashboard?.refreshedAt ?? null,
    calendarsRefreshedAt: liveState.calendarsRefreshedAt,
    warnings: [...liveState.warnings, ...liveState.calendarWarnings],
    streamDiagnostics: buildStreamDiagnosticsResponse()
  });
});

app.get("/api/stream-status", (request, response) => {
  response.json(buildStreamDiagnosticsResponse(request.user.id));
});

app.get("/api/market-status", async (_request, response) => {
  response.json(await getPolygonMarketStatusPayload());
});

app.get("/api/brokers/ibkr/status", async (request, response) => {
  const userId = request.user.id;
  const brokerState = getIbkrBrokerState(userId);

  if (!brokerState.status.updatedAt) {
    await refreshIbkrStatusCacheForUser(userId).catch(() => null);
  } else {
    refreshIbkrStatusCacheForUser(userId).catch((error) => {
      logWarn("Failed to refresh IBKR status cache after confirmation", {
        subsystem: "ibkr",
        userId,
        orderId,
        error
      });
      return null;
    });
  }

  response.json({
    ibkr: getIbkrStatusForUser(userId),
    lastSyncAt: brokerState.lastSyncAt,
    lastSyncError: brokerState.lastSyncError
  });
});

app.get("/api/brokers/tws/status", (_request, response) => {
  response.json({
    tws: paperBrokerState.tws
  });
});

app.post("/api/brokers/tws/connect", async (request, response) => {
  const host = String(request.body?.host ?? "").trim();
  const port = Number(request.body?.port ?? 0);

  if (!host || !Number.isFinite(port)) {
    response.status(400).json({
      error: "host and port are required",
      tws: paperBrokerState.tws
    });
    return;
  }

  try {
    const status = await twsPaperApi.connect({
      host,
      port
    });
    paperBrokerState.tws = {
      ...paperBrokerState.tws,
      ...status
    };
    syncStrategyCacheBrokerStatus();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      tws: paperBrokerState.tws
    });
  } catch (error) {
    paperBrokerState.tws = {
      ...paperBrokerState.tws,
      configured: true,
      host,
      port,
      connected: false,
      authenticated: false,
      ready: false,
      error: error.message,
      updatedAt: new Date().toISOString()
    };
    syncStrategyCacheBrokerStatus();
    schedulePaperPortfolioBroadcast(0);

    response.status(502).json({
      error: error.message,
      tws: paperBrokerState.tws
    });
  }
});

app.post("/api/refresh", async (_request, response) => {
  try {
    await refreshLiveState({ includeOptions: true });

    response.json({
      ok: true,
      lastUpdated: liveState.lastUpdated,
      warnings: liveState.warnings
    });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/dashboard", async (request, response) => {
  await ensureInitialLiveStateReady();
  const { quoteWatchlist } = getStrategyAssetContext();
  const watchlistOrder = new Map(quoteWatchlist.map((item, index) => [item.symbol, index]));
  const snapshots = getLatestSnapshots().sort(
    (left, right) => (watchlistOrder.get(left.symbol) ?? Number.MAX_SAFE_INTEGER) - (watchlistOrder.get(right.symbol) ?? Number.MAX_SAFE_INTEGER)
  );
  const macroDashboard = liveState.macroDashboard ?? refreshMacroDashboard();
  await refreshCalendarState();

  response.json({
    generatedAt: new Date().toISOString(),
    lastUpdated: liveState.lastUpdated,
    warnings: [...liveState.warnings, ...liveState.calendarWarnings],
    streamDiagnostics: buildStreamDiagnosticsResponse(request.user.id),
    heroStats: buildMacroHeroStats(macroDashboard),
    macroDashboard,
    economicCalendar: liveState.economicCalendar,
    companyEvents: liveState.companyEvents,
    watchlist: snapshots,
    marketSections,
    calendarWidgets,
    focusChart: {
      ...calendarWidgets.advancedChart,
      config: {
        ...calendarWidgets.advancedChart.config,
        symbol: "NASDAQ:IBIT"
      }
    }
  });
});

app.get("/api/dashboards", (_request, response) => {
  response.json({
    dashboards: listDashboardLayouts()
  });
});

app.get("/api/dashboards/:dashboardId", (request, response) => {
  const dashboard = readDashboardLayout(String(request.params.dashboardId ?? ""));

  if (!dashboard) {
    response.status(404).json({
      error: "Dashboard not found"
    });
    return;
  }

  response.json({
    dashboard
  });
});

app.post("/api/dashboards", (request, response) => {
  const { name, layout } = request.body ?? {};

  if (!name || !layout || typeof layout !== "object") {
    response.status(400).json({
      error: "name and layout are required"
    });
    return;
  }

  try {
    const dashboard = saveDashboardLayout(name, layout);

    response.status(201).json({
      dashboard
    });
  } catch (error) {
    response.status(400).json({
      error: error.message
    });
  }
});

app.get("/api/strategy-assets", (_request, response) => {
  const { settingsAssets } = getStrategyAssetContext();
  response.json({
    generatedAt: new Date().toISOString(),
    compareModes: STRATEGY_COMPARE_MODES,
    assets: settingsAssets
  });
});

app.put("/api/strategy-assets/:assetId", async (request, response) => {
  const assetId = resolveStrategySettingsAssetId(String(request.params.assetId ?? "").trim());
  if (!assetId) {
    response.status(400).json({
      error: "assetId is required"
    });
    return;
  }

  try {
    const { settingsAssets } = getStrategyAssetContext();
    const currentAsset = settingsAssets.find((asset) => asset.id === assetId) ?? null;
    const normalizedAsset = normalizeStrategyAssetMapping(
      {
        ...(request.body ?? {}),
        id: assetId
      },
      {
        ...(currentAsset ?? {}),
        id: assetId,
        isCustom: currentAsset?.isCustom ?? true
      }
    );

    if (!normalizedAsset.label || !normalizedAsset.optionSymbol) {
      response.status(400).json({
        error: "label and optionSymbol are required"
      });
      return;
    }

    upsertStrategyAssetMapping(normalizedAsset);
    await refreshLiveState({ includeOptions: true });
    invalidateStrategyResponseCache();

    response.json({
      ok: true,
      asset: normalizedAsset,
      strategyPayload: await buildStrategiesResponse(request.user.id)
    });
  } catch (error) {
    response.status(400).json({
      error: error.message
    });
  }
});

app.delete("/api/strategy-assets/:assetId", async (request, response) => {
  const assetId = resolveStrategySettingsAssetId(String(request.params.assetId ?? "").trim());
  if (!assetId) {
    response.status(400).json({
      error: "assetId is required"
    });
    return;
  }

  const deleted = deleteStrategyAssetMapping(assetId);
  if (!deleted) {
    response.status(404).json({
      error: "Strategy asset mapping not found"
    });
    return;
  }

  await refreshLiveState({ includeOptions: true });
  invalidateStrategyResponseCache();
  response.json({
    ok: true,
    strategyPayload: await buildStrategiesResponse(request.user.id)
  });
});

function normalizeSetupWatchlistItem(payload) {
  const sourceInput = String(payload?.source ?? "").trim().toLowerCase();
  const source =
    sourceInput === "finder"
      ? "finder"
      : sourceInput === "tv" || sourceInput === "tradingview"
        ? "tradingview"
        : "custom";

  return {
    id: String(payload?.id ?? "").trim(),
    source,
    strategyId: String(payload?.strategyId ?? "").trim(),
    combinationId: String(payload?.combinationId ?? "").trim(),
    title: String(payload?.title ?? "").trim(),
    payload: payload?.payload && typeof payload.payload === "object" ? payload.payload : {}
  };
}

function buildLiveQuoteMap() {
  return new Map(
    (liveState?.quotes ?? []).map((quote) => [
      String(quote.symbol ?? "").trim().toUpperCase(),
      Number(quote.regularMarketPrice ?? NaN)
    ])
  );
}

function normalizeScannerResearchSymbol(symbol) {
  const raw = String(symbol ?? "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  return raw.includes(":") ? raw.split(":").slice(-1)[0] : raw;
}

async function loadScannerSymbolResearch(symbols = []) {
  const uniqueSymbols = [...new Set((symbols ?? []).map((symbol) => normalizeScannerResearchSymbol(symbol)).filter(Boolean))];
  const entries = await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      const [fundamentalsResult, historyResult] = await Promise.allSettled([
        fetchStockFundamentals({ symbol }),
        fetchStockDailyOhlcHistory({ symbol, lookbackPoints: 320 })
      ]);

      return [
        symbol,
        {
          fundamentals: fundamentalsResult.status === "fulfilled" ? fundamentalsResult.value : null,
          historyPoints:
            historyResult.status === "fulfilled" && Array.isArray(historyResult.value?.points)
              ? historyResult.value.points
              : []
        }
      ];
    })
  );

  return new Map(entries);
}

async function loadScannerIvRankMetrics(symbolContexts = [], researchMap = new Map()) {
  const today = new Date().toISOString().slice(0, 10);
  const contextsBySymbol = new Map();

  (symbolContexts ?? []).forEach((context) => {
    const symbol = normalizeScannerResearchSymbol(context?.symbol);
    if (!symbol) {
      return;
    }

    const historyPoints = researchMap.get(symbol)?.historyPoints ?? [];
    const fallbackSpot = Number(historyPoints.at(-1)?.close ?? 0) || 0;
    const currentSpot = Number(context?.currentSpot ?? 0) || fallbackSpot;
    const existing = contextsBySymbol.get(symbol);

    if (!existing || currentSpot > (existing.currentSpot ?? 0)) {
      contextsBySymbol.set(symbol, {
        symbol,
        currentSpot
      });
    }
  });

  const entries = await Promise.all(
    [...contextsBySymbol.values()].map(async ({ symbol, currentSpot }) => {
      let latest = null;

      try {
        latest = getLatestIvRankDaily(symbol, today);
      } catch (_error) {
        latest = null;
      }

      if (latest?.date === today && latest.iv30 != null) {
        return [symbol, latest];
      }

      if (!(currentSpot > 0)) {
        return [symbol, latest];
      }

      try {
        const snapshot = await fetchPolygonAtmIv30Snapshot({
          symbol,
          currentSpot,
          asOfDate: today
        });

        if (!snapshot?.iv30) {
          return [symbol, latest];
        }

        upsertIv30History(snapshot);
        const ivHistory = listIv30History(symbol, 252);
        const historyPoints = researchMap.get(symbol)?.historyPoints ?? [];
        const rankMetrics = buildIvRankDailySnapshot({
          symbol,
          date: today,
          currentIv30: snapshot.iv30,
          ivHistory,
          historyPoints
        });

        if (rankMetrics) {
          upsertIvRankDaily(rankMetrics);
          return [symbol, rankMetrics];
        }
      } catch (_error) {
        return [symbol, latest];
      }

      return [symbol, latest];
    })
  );

  return new Map(entries.filter((entry) => entry?.[1]));
}

async function enrichCoveredIncomePayload(payload, userId) {
  const quoteMap = buildLiveQuoteMap();
  const researchMap = await loadScannerSymbolResearch((payload?.rows ?? []).map((row) => row.symbol));
  const ivMetricsMap = await loadScannerIvRankMetrics(
    (payload?.rows ?? []).map((row) => ({
      symbol: row.symbol,
      currentSpot: row?.stockPrice
    })),
    researchMap
  );
  const fundamentalsBySymbol = Object.fromEntries(
    [...researchMap.entries()].map(([symbol, value]) => [symbol, value.fundamentals])
  );
  const portfolioContext = buildPortfolioContext({
    paperOrders: listPaperOrders(null, userId),
    fundamentalsBySymbol
  });

  const rows = (payload?.rows ?? []).map((row) => {
    const research = researchMap.get(String(row.symbol ?? "").trim().toUpperCase()) ?? {};
    const fundamentals = research.fundamentals ?? null;
    const volatility = buildVolatilityMetrics({
      currentIv: row?.priceZones?.atmIv,
      historyPoints: research.historyPoints ?? [],
      nearTermIv: row?.put?.iv,
      farTermIv: row?.call?.iv,
      putIv: row?.put?.iv,
      callIv: row?.call?.iv,
      historicalIvMetrics: ivMetricsMap.get(String(row.symbol ?? "").trim().toUpperCase()) ?? null
    });
    const ev = buildCoveredIncomeEv(row);
    const portfolioImpact = buildPortfolioImpact({
      symbol: row.symbol,
      sector: fundamentals?.sector ?? "Unknown",
      beta: fundamentals?.beta1y ?? null,
      capital: row?.capital?.allocatedCashUsed,
      premium: row?.premium?.totalPremium,
      portfolioContext
    });
    const riskFlags = buildRiskFlags({
      earningsBeforeExpiry: row?.risk?.earningsBeforeExpiry === true,
      liquidityScore: row?.score?.liquidityScore,
      dividendYieldPct: fundamentals?.dividendYield,
      daysToExpiration: row?.dte,
      ivHvSpread: volatility.ivHvSpread
    });
    const rankHistory = listCandidateRankHistory("covered-income", row.symbol, row.strategyType, userId, 6);
    const rankDrift = buildRankDrift(rankHistory);
    const explanationData = buildExplainability({
      score: row?.score?.finalStrategyScore ?? null,
      liquidityScore: row?.score?.liquidityScore ?? null,
      ivRank52w: volatility.ivRank52w,
      evPerBuyingPower: ev.evPerBuyingPower,
      portfolioImpact,
      extraBreakdown: {
        yield_score: Number(row?.score?.yieldScore ?? 0) || null,
        diversification_score:
          portfolioImpact.correlationOverlap === "low" ? 72 : portfolioImpact.correlationOverlap === "medium" ? 54 : 34
      }
    });

    return {
      ...row,
      intelligence: {
        beta: fundamentals?.beta1y ?? null,
        sector: fundamentals?.sector ?? null,
        volatility,
        ev,
        portfolioImpact,
        riskFlags,
        rankDrift,
        explanationData
      }
    };
  });

  const marketRegime = buildMarketRegime({
    quoteMap,
    rowMetrics: rows.map((row) => row.intelligence?.volatility).filter(Boolean)
  });

  const persisted = saveScannerRun(
    {
      scannerType: "covered-income",
      strategyId: "strategy-5",
      config: payload?.config ?? {},
      summary: payload?.summary ?? {},
      marketRegime,
      rows: rows.map((row) => ({
        symbol: row.symbol,
        strategyType: row.strategyType,
        scoreValue: row?.score?.finalStrategyScore ?? null,
        payload: row,
        explanationData: row?.intelligence?.explanationData ?? {},
        riskFlags: row?.intelligence?.riskFlags ?? [],
        portfolioImpact: row?.intelligence?.portfolioImpact ?? {}
      }))
    },
    userId
  );

  const rowsWithIds = rows.map((row, index) => ({
    ...row,
    scannerCandidateId: persisted.rows[index]?.scannerCandidateId ?? null,
    scannerRunId: persisted.id
  }));

  return {
    ...payload,
    rows: rowsWithIds,
    scannerMeta: {
      scannerType: "covered-income",
      scannerRunId: persisted.id,
      latestRun: getLatestScannerRun("covered-income", userId, false),
      presets: listScannerPresets("covered-income", userId)
    },
    marketRegime
  };
}

async function enrichTradingViewPayload(payload, userId) {
  const quoteMap = buildLiveQuoteMap();
  const rows = payload?.rows ?? [];
  const warnings = Array.isArray(payload?.warnings) ? [...payload.warnings] : [];
  const researchMap = await loadScannerSymbolResearch(rows.map((row) => row.underlyingFamily || row.underlyingSymbol));
  const ivMetricsMap = await loadScannerIvRankMetrics(
    rows.map((row) => ({
      symbol: row.underlyingFamily || row.underlyingSymbol,
      currentSpot: row?.underlyingPrice
    })),
    researchMap
  );
  const fundamentalsBySymbol = Object.fromEntries(
    [...researchMap.entries()].map(([symbol, value]) => [symbol, value.fundamentals])
  );
  let portfolioContext;
  try {
    portfolioContext = buildPortfolioContext({
      paperOrders: listPaperOrders(null, userId),
      fundamentalsBySymbol
    });
  } catch (error) {
    portfolioContext = buildPortfolioContext({
      paperOrders: [],
      fundamentalsBySymbol
    });
    warnings.push(`Portfolio context unavailable: ${error.message}`);
  }

  const enrichedRows = rows.map((row) => {
    const baseSymbol = normalizeScannerResearchSymbol(row.underlyingFamily ?? row.underlyingSymbol);
    const research = researchMap.get(baseSymbol) ?? {};
    const fundamentals = research.fundamentals ?? null;
    const primaryIvRaw = row?.averageImpliedVolatility ?? row?.annualizedVolatility ?? null;
    const primaryIv =
      Number(primaryIvRaw ?? 0) > 1 ? Number(primaryIvRaw) / 100 : Number(primaryIvRaw ?? 0);
    const volatility = buildVolatilityMetrics({
      currentIv: primaryIv,
      historyPoints: research.historyPoints ?? [],
      nearTermIv: primaryIv,
      farTermIv: primaryIv * 0.97,
      putIv: primaryIv * 1.02,
      callIv: primaryIv * 0.98,
      historicalIvMetrics: ivMetricsMap.get(baseSymbol) ?? null
    });
    const ev = buildTradingViewEv(row);
    const portfolioImpact = buildPortfolioImpact({
      symbol: baseSymbol,
      sector: fundamentals?.sector ?? "Unknown",
      beta: fundamentals?.beta1y ?? null,
      capital: row?.maxLoss ?? null,
      premium: row?.theoreticalPrice ?? null,
      portfolioContext
    });
    const riskFlags = buildRiskFlags({
      liquidityScore: row?.normalizedOptionVolume ?? null,
      bidAskSpreadPct: row?.bidAskSpreadPercent ?? null,
      daysToExpiration: row?.daysToExpiration,
      ivHvSpread: volatility.ivHvSpread
    });
    let rankHistory = [];
    try {
      rankHistory = listCandidateRankHistory("tradingview-finder", baseSymbol, row.strategyTypeKey, userId, 6);
    } catch (_error) {
      rankHistory = [];
    }
    const rankDrift = buildRankDrift(rankHistory);
    const explanationData = buildExplainability({
      score: row?.score ?? null,
      liquidityScore: row?.normalizedOptionVolume ?? null,
      ivRank52w: volatility.ivRank52w,
      evPerBuyingPower: ev.evPerBuyingPower,
      portfolioImpact,
      extraBreakdown: {
        signal_freshness_score: rankDrift.appearances <= 1 ? 82 : 60,
        regime_fit_score: volatility.ivRank52w == null ? null : volatility.ivRank52w >= 60 ? 78 : 52
      }
    });

    return {
      ...row,
      intelligence: {
        symbol: baseSymbol,
        sector: fundamentals?.sector ?? null,
        beta: fundamentals?.beta1y ?? null,
        volatility,
        ev,
        portfolioImpact,
        riskFlags,
        rankDrift,
        signalFreshness: rankDrift.appearances <= 1 ? "fresh" : rankDrift.trend,
        explanationData
      }
    };
  });

  const marketRegime = buildMarketRegime({
    quoteMap,
    rowMetrics: enrichedRows.map((row) => row.intelligence?.volatility).filter(Boolean)
  });

  let persisted = null;
  try {
    persisted = saveScannerRun(
      {
        scannerType: "tradingview-finder",
        strategyId: "strategy-tv-finder",
        config: payload?.request ?? {},
        summary: payload?.summary ?? {},
        marketRegime,
        rows: enrichedRows.map((row) => ({
          symbol: row.intelligence?.symbol ?? row.underlyingSymbol,
          strategyType: row.strategyTypeKey,
          scoreValue: row?.score ?? null,
          payload: row,
          explanationData: row?.intelligence?.explanationData ?? {},
          riskFlags: row?.intelligence?.riskFlags ?? [],
          portfolioImpact: row?.intelligence?.portfolioImpact ?? {}
        }))
      },
      userId
    );
  } catch (error) {
    warnings.push(`Scanner persistence unavailable: ${error.message}`);
  }

  const rowsWithIds = enrichedRows.map((row, index) => ({
    ...row,
    scannerCandidateId: persisted?.rows?.[index]?.scannerCandidateId ?? null,
    scannerRunId: persisted?.id ?? null
  }));

  let latestRun = null;
  let presets = [];
  try {
    latestRun = getLatestScannerRun("tradingview-finder", userId, false);
    presets = listScannerPresets("tradingview-finder", userId);
  } catch (error) {
    warnings.push(`Scanner metadata unavailable: ${error.message}`);
  }

  return {
    ...payload,
    warnings,
    rows: rowsWithIds,
    scannerMeta: {
      scannerType: "tradingview-finder",
      scannerRunId: persisted?.id ?? null,
      latestRun,
      presets
    },
    marketRegime
  };
}

app.get("/api/strategy-watchlist", (request, response) => {
  response.json({
    watchlist: listStrategyWatchlist(request.user.id)
  });
});

app.post("/api/strategy-watchlist", (request, response) => {
  const userId = request.user.id;
  const strategyId = String(request.body?.strategyId ?? "").trim();
  if (!strategyId) {
    response.status(400).json({
      error: "strategyId is required"
    });
    return;
  }

  if (!getStrategies().some((strategy) => strategy.id === strategyId)) {
    response.status(404).json({
      error: "Strategy not found"
    });
    return;
  }

  const entry = addStrategyToWatchlist(strategyId, userId);
  response.status(201).json({
    ok: true,
    entry,
    watchlist: listStrategyWatchlist(userId)
  });
});

app.delete("/api/strategy-watchlist/:strategyId", (request, response) => {
  const userId = request.user.id;
  const strategyId = String(request.params.strategyId ?? "").trim();
  if (!strategyId) {
    response.status(400).json({
      error: "strategyId is required"
    });
    return;
  }

  const deleted = removeStrategyFromWatchlist(strategyId, userId);
  if (!deleted) {
    response.status(404).json({
      error: "Watchlist entry not found"
    });
    return;
  }

  response.json({
    ok: true,
    deleted: true,
    watchlist: listStrategyWatchlist(userId)
  });
});

app.get("/api/setup-watchlist", (request, response) => {
  response.json({
    watchlist: listSetupWatchlist(request.user.id)
  });
});

app.post("/api/setup-watchlist", (request, response) => {
  const userId = request.user.id;
  const item = normalizeSetupWatchlistItem(request.body);

  if (!item.id) {
    response.status(400).json({
      error: "id is required"
    });
    return;
  }

  if (!item.strategyId) {
    response.status(400).json({
      error: "strategyId is required"
    });
    return;
  }

  if (!getStrategies().some((strategy) => strategy.id === item.strategyId)) {
    response.status(404).json({
      error: "Strategy not found"
    });
    return;
  }

  if (!item.combinationId) {
    response.status(400).json({
      error: "combinationId is required"
    });
    return;
  }

  if (!item.title) {
    response.status(400).json({
      error: "title is required"
    });
    return;
  }

  if (!Array.isArray(item.payload?.legs) || item.payload.legs.length === 0) {
    response.status(400).json({
      error: "payload.legs is required"
    });
    return;
  }

  const persisted = upsertSetupWatchlistItem(item, userId);
  response.status(201).json({
    ok: true,
    item: persisted,
    watchlist: listSetupWatchlist(userId)
  });
});

app.delete("/api/setup-watchlist/:id", (request, response) => {
  const userId = request.user.id;
  const id = String(request.params.id ?? "").trim();
  if (!id) {
    response.status(400).json({
      error: "id is required"
    });
    return;
  }

  const deleted = deleteSetupWatchlistItem(id, userId);
  if (!deleted) {
    response.status(404).json({
      error: "Watchlist entry not found"
    });
    return;
  }

  response.json({
    ok: true,
    deleted: true,
    watchlist: listSetupWatchlist(userId)
  });
});

app.get("/api/scanners/:scannerType/context", (request, response) => {
  const scannerType = String(request.params.scannerType ?? "").trim().toLowerCase();
  response.json({
    scannerType,
    latestRun: getLatestScannerRun(scannerType, request.user.id, false),
    presets: listScannerPresets(scannerType, request.user.id)
  });
});

app.post("/api/scanners/:scannerType/presets", (request, response) => {
  const scannerType = String(request.params.scannerType ?? "").trim().toLowerCase();
  const name = String(request.body?.name ?? "").trim();
  if (!scannerType || !name) {
    response.status(400).json({
      error: "scannerType and name are required"
    });
    return;
  }

  const preset = upsertScannerPreset(
    {
      scannerType,
      name,
      config: request.body?.config ?? {},
      isDefault: request.body?.isDefault === true
    },
    request.user.id
  );

  response.status(201).json({
    ok: true,
    preset,
    presets: listScannerPresets(scannerType, request.user.id)
  });
});

app.post("/api/scanners/:scannerType/promotions", (request, response) => {
  const scannerType = String(request.params.scannerType ?? "").trim().toLowerCase();
  const symbol = String(request.body?.symbol ?? "").trim().toUpperCase();
  if (!scannerType || !symbol) {
    response.status(400).json({
      error: "scannerType and symbol are required"
    });
    return;
  }

  const promotion = createScannerPromotion(
    {
      scannerType,
      scannerRunId: request.body?.scannerRunId ?? null,
      scannerCandidateId: request.body?.scannerCandidateId ?? null,
      paperOrderId: request.body?.paperOrderId ?? null,
      symbol,
      strategyType: request.body?.strategyType ?? null,
      promotionStatus: request.body?.promotionStatus ?? "paper_trade",
      notes: request.body?.notes ?? {}
    },
    request.user.id
  );

  response.status(201).json({
    ok: true,
    promotion
  });
});

app.get("/api/strategies", async (request, response) => {
  await ensureInitialLiveStateReady();
  response.json(await buildStrategiesResponse(request.user.id));
});

app.get("/api/strategies/finder/:rowId/theo", async (request, response) => {
  await ensureInitialLiveStateReady();
  await buildStrategiesBaseResponse();
  const row = getCachedFinderRowDetail(request.params.rowId);

  if (!row) {
    response.status(404).json({
      error: "Strategy finder row not found"
    });
    return;
  }

  response.json({
    lastUpdated: liveState.lastUpdated,
    theoPrice: row.theoPrice ?? row.quickOverview?.theoPrice ?? null
  });
});

app.get("/api/strategies/finder/:rowId", async (request, response) => {
  await ensureInitialLiveStateReady();
  await buildStrategiesBaseResponse();
  const row = getCachedFinderRowDetail(request.params.rowId);

  if (!row) {
    response.status(404).json({
      error: "Strategy finder row not found"
    });
    return;
  }

  response.json({
    lastUpdated: liveState.lastUpdated,
    row
  });
});

app.get("/api/paper-portfolio", async (request, response) => {
  await ensureInitialLiveStateReady();
  response.json({
    lastUpdated: liveState.lastUpdated,
    paperPortfolio: buildPaperPortfolioResponse(request.user.id)
  });
});

app.post("/api/tradingview/strategy-finder", async (request, response) => {
  try {
    const payload = await scanTradingViewStrategyFinder(request.body ?? {});
    const enrichedPayload = await enrichTradingViewPayload(payload, request.user.id).catch((error) => ({
      ...payload,
      warnings: [
        ...(Array.isArray(payload?.warnings) ? payload.warnings : []),
        `Scanner intelligence degraded: ${error.message}`
      ]
    }));

    response.json(enrichedPayload);
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.post("/api/tradingview/theo-price", async (request, response) => {
  await ensureInitialLiveStateReady();

  const payload = request.body ?? {};
  const legs = Array.isArray(payload?.legs) ? payload.legs : [];

  if (!legs.length) {
    response.status(400).json({
      error: "legs are required"
    });
    return;
  }

  const quotedSymbol = String(payload?.symbol ?? "").trim();
  const normalizedSymbol = quotedSymbol.includes(":") ? quotedSymbol.split(":").slice(-1)[0] : quotedSymbol;
  const fallbackSpot = payload?.spot == null ? Number.NaN : Number(payload.spot);
  const quoteMap = new Map(
    (liveState.quotes ?? []).map((quote) => [
      String(quote.symbol ?? "").trim().toUpperCase(),
      Number(quote.regularMarketPrice ?? 0)
    ])
  );
  const quoteSpot = quoteMap.get(normalizedSymbol.toUpperCase()) ?? quoteMap.get(quotedSymbol.toUpperCase()) ?? null;
  const spot =
    Number.isFinite(quoteSpot) && quoteSpot > 0
      ? quoteSpot
      : Number.isFinite(fallbackSpot) && fallbackSpot > 0
        ? fallbackSpot
        : 0;
  const asOf = new Date().toISOString().slice(0, 10);
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

  const normalizeVolatility = (value, fallback = 0.24) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }

    return numericValue > 2 ? numericValue / 100 : numericValue;
  };

  const theoPrice = legs.reduce((sum, leg) => {
    const quantity = Math.max(Number(leg?.quantity ?? 0), 0);
    if (!(quantity > 0)) {
      return sum;
    }

    const expiry = String(leg?.expiry ?? leg?.expiration ?? "").trim();
    if (!expiry) {
      return sum;
    }

    const expiryDate = new Date(`${expiry}T00:00:00.000Z`);
    if (Number.isNaN(expiryDate.getTime())) {
      return sum;
    }

    const strike = Number(leg?.strike ?? 0);
    if (!(strike > 0)) {
      return sum;
    }

    const daysToExpiry = Math.max(
      Math.round((expiryDate.getTime() - asOfDate.getTime()) / (24 * 60 * 60 * 1000)),
      0
    );
    const timeToExpiryYears = daysToExpiry / 365;
    const volatility = normalizeVolatility(leg?.impliedVolatility, Number(payload?.annualizedVolatility ?? 0.24));
    const riskFreeRate = Number(leg?.riskFreeRate ?? payload?.riskFreeRate ?? 0.0425) || 0.0425;
    const optionType = String(leg?.optionType ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
    const action = String(leg?.action ?? "LONG").trim().toUpperCase();
    const direction = action === "SHORT" ? -1 : 1;
    const normalizedSpot = Math.max(Number(spot ?? 0), 0.01);

    const modelPrice =
      optionType === "put"
        ? blackScholesPut({
            spot: normalizedSpot,
            strike,
            timeToExpiryYears,
            volatility,
            riskFreeRate
          })
        : blackScholesCall({
            spot: normalizedSpot,
            strike,
            timeToExpiryYears,
            volatility,
            riskFreeRate
          });

    return sum + direction * modelPrice * quantity;
  }, 0);

  response.json({
    lastUpdated: liveState.lastUpdated,
    asOf,
    spot,
    theoPrice
  });
});

app.get("/api/paper-orders/stream", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();
  response.write("retry: 5000\n\n");

  const userId = request.user.id;
  const bucket = paperStreamClientsByUserId.get(userId) ?? new Set();
  bucket.add(response);
  paperStreamClientsByUserId.set(userId, bucket);

  writeSseJson(response, {
    type: "paper-portfolio",
    lastUpdated: new Date().toISOString(),
    paperPortfolio: buildPaperPortfolioResponse(userId)
  });

  request.on("close", () => {
    const currentBucket = paperStreamClientsByUserId.get(userId);
    if (currentBucket) {
      currentBucket.delete(response);
      if (currentBucket.size === 0) {
        paperStreamClientsByUserId.delete(userId);
      }
    }
    response.end();
  });
});

app.get("/api/options/chain", async (request, response) => {
  const symbol = String(request.query.symbol ?? "").trim().toUpperCase();
  const expiration = String(request.query.expiration ?? "").trim();
  const optionType = String(request.query.optionType ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
  const strikeHint = Number(request.query.strikeHint ?? 0);
  const strikeMin = Number(request.query.strikeMin ?? NaN);
  const strikeMax = Number(request.query.strikeMax ?? NaN);
  const requestedLimit = Number(request.query.limit ?? 60);

  if (!symbol || !expiration) {
    response.status(400).json({
      error: "symbol and expiration are required"
    });
    return;
  }

  try {
    const quoteMap = new Map(liveState.quotes.map((quote) => [quote.symbol, quote]));
    const currentSpot = Number(quoteMap.get(symbol)?.regularMarketPrice ?? 0);
    const chain = await fetchOptionChain({
      symbol,
      expiration,
      optionType,
      currentSpot,
      strikeHint,
      strikeMin: Number.isFinite(strikeMin) && strikeMin > 0 ? strikeMin : undefined,
      strikeMax: Number.isFinite(strikeMax) && strikeMax > 0 ? strikeMax : undefined,
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 60
    });

    response.json({
      generatedAt: new Date().toISOString(),
      ...chain
    });
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.get("/api/strategies/strategy-2/scan", async (request, response) => {
  const force = String(request.query.force ?? "").trim().toLowerCase() === "true";
  const requestedLimit = Number(request.query.limit ?? 12);

  try {
    await refreshCalendarState(force);

    const payload = await buildVolCrushEarningsScan({
      companyEvents: liveState.companyEvents?.events ?? [],
      fetchQuotes,
      fetchOptionChain,
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 12
    });

    response.json(payload);
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.get("/api/strategies/strategy-4/scan", async (request, response) => {
  const requestedLimit = Number(request.query.limit ?? 25);
  const volRealizedLookback = Number(request.query.volRealizedLookbackDays ?? NaN);
  const volBaselineLookback = Number(request.query.volBaselineLookbackDays ?? NaN);
  const volMovementLookback = Number(request.query.volMovementLookbackDays ?? NaN);
  const volMaxVolRatio = Number(request.query.volMaxVolatilityRatio ?? NaN);
  const volMaxMoveRatio = Number(request.query.volMaxMovementRatio ?? NaN);
  const volWeightVol = Number(request.query.volWeightVolatility ?? NaN);
  const volWeightMove = Number(request.query.volWeightMovement ?? NaN);
  const volWeightLiquidity = Number(request.query.volWeightLiquidity ?? NaN);
  const volWeightData = Number(request.query.volWeightDataQuality ?? NaN);

  try {
    const payload = await buildStockDeltaHedgeScan({
      fetchQuotes,
      fetchOptionChain,
      stockUniverse: getDeltaHedgeScannerUniverse(),
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 25
    });

    const volWeights = {
      ...(Number.isFinite(volWeightVol) ? { volatilityDivergence: volWeightVol } : {}),
      ...(Number.isFinite(volWeightMove) ? { movementDivergence: volWeightMove } : {}),
      ...(Number.isFinite(volWeightLiquidity) ? { liquidity: volWeightLiquidity } : {}),
      ...(Number.isFinite(volWeightData) ? { dataQuality: volWeightData } : {})
    };

    const volatilityOpportunity = await buildVolatilityOpportunityScan({
      stockUniverse: payload.stockUniverse,
      optionCandidates: payload.universeRows,
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 25,
      config: {
        ...(Number.isFinite(volRealizedLookback) ? { realizedVolLookbackDays: volRealizedLookback } : {}),
        ...(Number.isFinite(volBaselineLookback) ? { baselineVolLookbackDays: volBaselineLookback } : {}),
        ...(Number.isFinite(volMovementLookback) ? { movementLookbackDays: volMovementLookback } : {}),
        ...(Number.isFinite(volMaxVolRatio) ? { maxVolatilityRatio: volMaxVolRatio } : {}),
        ...(Number.isFinite(volMaxMoveRatio) ? { maxMovementRatio: volMaxMoveRatio } : {}),
        ...(Object.keys(volWeights).length ? { weights: volWeights } : {})
      }
    });

    response.json({
      ...payload,
      volatilityOpportunity
    });
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.get("/api/strategies/strategy-4/tickers", (_request, response) => {
  const stockUniverse = getDeltaHedgeScannerUniverse();
  response.json({
    generatedAt: new Date().toISOString(),
    stockUniverse
  });
});

app.post("/api/strategies/strategy-4/tickers", (request, response) => {
  const symbol = normalizeDeltaHedgeTicker(String(request.body?.symbol ?? ""));
  const label = String(request.body?.label ?? symbol).trim() || symbol;

  if (!symbol) {
    response.status(400).json({
      error: "symbol is required"
    });
    return;
  }

  if (getDeltaHedgeScannerUniverse().some((stock) => stock.symbol === symbol)) {
    response.status(409).json({
      error: `${symbol} is already tracked in the scanner universe`
    });
    return;
  }

  const normalizedStock = normalizeDeltaHedgeStock({
    symbol,
    label,
    isCustom: true
  });
  upsertDeltaHedgeScannerSymbol(normalizedStock);

  response.status(201).json({
    ok: true,
    stock: normalizedStock,
    stockUniverse: getDeltaHedgeScannerUniverse()
  });
});

app.delete("/api/strategies/strategy-4/tickers/:symbol", (request, response) => {
  const symbol = normalizeDeltaHedgeTicker(String(request.params.symbol ?? ""));

  if (!symbol) {
    response.status(400).json({
      error: "symbol is required"
    });
    return;
  }

  const deleted = deleteDeltaHedgeScannerSymbol(symbol);
  if (!deleted) {
    response.status(404).json({
      error: "Custom stock ticker not found"
    });
    return;
  }

  response.json({
    ok: true,
    stockUniverse: getDeltaHedgeScannerUniverse()
  });
});

app.post("/api/strategies/strategy-5/scan", async (request, response) => {
  const force = request.body?.force === true;

  try {
    await refreshCalendarState(force);

    const payload = await buildCoveredIncomeScan({
      input: request.body ?? {},
      fetchQuotes,
      fetchOptionChain,
      companyEvents: liveState.companyEvents?.events ?? []
    });

    response.json(
      await enrichCoveredIncomePayload(payload, request.user.id).catch((error) => ({
        ...payload,
        warnings: [
          ...(Array.isArray(payload?.warnings) ? payload.warnings : []),
          `Scanner intelligence degraded: ${error.message}`
        ]
      }))
    );
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.post("/api/gpt/strategy-query", requireApiKey, async (request, response) => {
  let query;

  try {
    query = sanitizeGptStrategyQueryRequest(request.body ?? {});
  } catch (error) {
    response.status(400).json({ error: error.message });
    return;
  }

  await ensureInitialLiveStateReady();
  await refreshCalendarState(false);

  const generatedAt = new Date().toISOString();
  const scannerTasks = {
    thresholdHedge: buildThresholdHedgeGptResults({
      ...query,
      userId: request.user.id
    }),
    tradingViewScanner: buildTradingViewGptResults({
      ...query,
      userId: request.user.id
    }),
    coveredIncome: buildCoveredIncomeGptResults({
      ...query,
      userId: request.user.id
    })
  };

  const [thresholdResult, tradingViewResult, coveredIncomeResult] = await Promise.allSettled([
    scannerTasks.thresholdHedge,
    scannerTasks.tradingViewScanner,
    scannerTasks.coveredIncome
  ]);
  const partialResults =
    thresholdResult.status === "rejected" || tradingViewResult.status === "rejected" || coveredIncomeResult.status === "rejected";
  const partialWarnings = [];
  const results = {
    thresholdHedge:
      thresholdResult.status === "fulfilled"
        ? thresholdResult.value
        : {
            count: 0,
            items: [],
            warnings: [thresholdResult.reason?.message ?? "Threshold Hedge query failed."]
          },
    tradingViewScanner:
      tradingViewResult.status === "fulfilled"
        ? tradingViewResult.value
        : {
            count: 0,
            items: [],
            warnings: [tradingViewResult.reason?.message ?? "TradingView query failed."]
          },
    coveredIncome:
      coveredIncomeResult.status === "fulfilled"
        ? coveredIncomeResult.value
        : {
            count: 0,
            items: [],
            warnings: [coveredIncomeResult.reason?.message ?? "Covered Income query failed."]
          }
  };

  for (const [key, result] of Object.entries(results)) {
    if (result.warnings?.length) {
      partialWarnings.push(...result.warnings.map((warning) => `${key}: ${warning}`));
    }
  }

  response.json({
    requestId: crypto.randomUUID(),
    generatedAt,
    request: {
      ticker: query.ticker,
      optionExpirationStartDate: query.optionExpirationStartDate,
      optionExpirationEndDate: query.optionExpirationEndDate,
      expectedPriceRangeLow: query.expectedPriceRangeLow,
      expectedPriceRangeHigh: query.expectedPriceRangeHigh
    },
    meta: {
      authenticatedUserId: request.user.id,
      authenticatedUsername: request.user.username,
      scannersQueried: ["threshold-hedge", "tradingview-finder", "covered-income"],
      partialResults,
      warnings: partialWarnings
    },
    results
  });
});

app.get("/api/stocks/:symbol/technicals", async (request, response) => {
  const symbol = normalizeDeltaHedgeTicker(String(request.params.symbol ?? ""));

  if (!symbol) {
    response.status(400).json({
      error: "symbol is required"
    });
    return;
  }

  try {
    const payload = await fetchStockTechnicals({ symbol });
    response.json(payload);
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.get("/api/stocks/:symbol/fundamentals", async (request, response) => {
  const symbol = normalizeDeltaHedgeTicker(String(request.params.symbol ?? ""));

  if (!symbol) {
    response.status(400).json({
      error: "symbol is required"
    });
    return;
  }

  try {
    const payload = await fetchStockFundamentals({ symbol });
    response.json(payload);
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.post("/api/strategies/strategy-1/runs", async (request, response) => {
  const optionMatches = buildLiveOptionMatches();
  const { finderAssets } = getStrategyAssetContext();
  const strategySummary = await buildStrategySummary({
    quotes: liveState.quotes,
    polymarketMarkets: liveState.polymarketMarkets,
    optionMatches,
    assetUniverse: finderAssets
  });

  saveStrategyRun("strategy-1", strategySummary, request.user.id);

  response.status(201).json({
    saved: true,
    createdAt: new Date().toISOString()
  });
});

app.post("/api/paper-orders", async (request, response) => {
  const userId = request.user.id;
  try {
    const order = sanitizePaperOrderPayload(request.body);
    if ((isIbkrPaperRoute(order) || isTwsPaperRoute(order)) && !hasOptionLegs(order)) {
      throw new Error("Broker paper routing requires at least one option leg");
    }

    const persistedOrder = isIbkrPaperRoute(order)
      ? prepareOrderForIbkrEntry(order)
      : isTwsPaperRoute(order)
        ? prepareOrderForTwsEntry(order)
        : order;
    let createdOrder = createPaperOrder({ ...persistedOrder, userId });
    let createMessage = isIbkrPaperRoute(order)
      ? "IBKR paper order saved locally and is waiting for broker submission."
      : isTwsPaperRoute(order)
        ? "TWS paper order saved locally and is waiting for broker submission."
        : "Paper order saved.";

    if (isIbkrPaperRoute(order)) {
      try {
        const submission = await submitIbkrOptionOrder({
          order: {
            ...createdOrder.position,
            id: Number(createdOrder.id)
          },
          purpose: "entry"
        }, getIbkrContextForUser(userId));

        createdOrder = updatePaperOrder(
          Number(createdOrder.id),
          sanitizePaperOrderPayload(
            {
              ...createdOrder.position,
              execution: submission
            },
            createdOrder.position
          )
        );
        createMessage = buildIbkrSubmissionMessage(submission, "entry");

        const stockHedgeLeg = getStockHedgeLeg(createdOrder.position);
        if (stockHedgeLeg) {
          const optionConfirmationPending =
            String(submission?.status ?? "").trim().toLowerCase() === "pending_confirmation" &&
            String(submission?.pendingReplyId ?? "").trim().length > 0;

          if (optionConfirmationPending) {
            createMessage = `${createMessage} Stock hedge will submit after the IBKR confirmation is resolved.`;
          } else {
            try {
              const stockSubmission = await submitIbkrStockOrder({
                order: {
                  ...createdOrder.position,
                  id: Number(createdOrder.id)
                },
                purpose: "entry"
              }, getIbkrContextForUser(userId));

              createdOrder = updatePaperOrder(
                Number(createdOrder.id),
                sanitizePaperOrderPayload(
                  {
                    ...createdOrder.position,
                    stockExecution: stockSubmission
                  },
                  createdOrder.position
                )
              );

              createMessage = `${createMessage} ${buildIbkrStockHedgeSubmissionMessage(stockSubmission)}`;
            } catch (stockError) {
              const nowIso = new Date().toISOString();
              const quantity = Math.max(Number(stockHedgeLeg.quantity ?? 0) || 0, 0);

              createdOrder = updatePaperOrder(
                Number(createdOrder.id),
                sanitizePaperOrderPayload(
                  {
                    ...createdOrder.position,
                    stockExecution: {
                      route: "ibkr-paper",
                      purpose: "entry",
                      status: "error",
                      statusText: "IBKR stock hedge submission failed",
                      statusDescription: "",
                      brokerOrderId: "",
                      orderRef: "",
                      orderType: "MKT",
                      tif: String(createdOrder.position?.execution?.tif ?? "DAY"),
                      outsideRth: createdOrder.position?.execution?.outsideRth === true,
                      limitPrice: null,
                      avgFillPrice: null,
                      combo: false,
                      totalQuantity: quantity,
                      filledQuantity: 0,
                      remainingQuantity: quantity,
                      submittedAt: nowIso,
                      lastSyncAt: nowIso,
                      filledAt: "",
                      cancelledAt: "",
                      lastError: stockError.message,
                      lastWarning: "",
                      warningMessages: [],
                      pendingReplyId: "",
                      pendingReplyMessages: [],
                      requestedLegs: []
                    }
                  },
                  createdOrder.position
                )
              );
              createMessage = `${createMessage} IBKR stock hedge submission failed: ${stockError.message}`;
            }
          }
        }
      } catch (error) {
        createdOrder = updatePaperOrder(
          Number(createdOrder.id),
          sanitizePaperOrderPayload(
            {
              ...createdOrder.position,
              execution: buildPendingIbkrExecution(createdOrder.position, {
                status: "error",
                statusText: "IBKR paper submission failed",
                lastError: error.message,
                lastSyncAt: new Date().toISOString()
              })
            },
            createdOrder.position
          )
        );
        createMessage = `Order saved locally, but IBKR submission failed: ${error.message}`;
      }
    }

    if (isTwsPaperRoute(order)) {
      try {
        const submission = await twsPaperApi.submitOptionOrder({
          order: {
            ...createdOrder.position,
            id: Number(createdOrder.id)
          },
          purpose: "entry"
        });

        let nextOrder = sanitizePaperOrderPayload(
          {
            ...createdOrder.position,
            execution: submission
          },
          createdOrder.position
        );
        nextOrder = applyEntryExecutionToOrder(nextOrder, nextOrder.execution, []);
        createdOrder = updatePaperOrder(Number(createdOrder.id), nextOrder);
        paperBrokerState.tws = {
          ...paperBrokerState.tws,
          lastSyncAt: new Date().toISOString(),
          lastSyncError: null
        };
        syncStrategyCacheBrokerStatus();
        createMessage = "TWS paper order submitted. You can monitor it from the paper-trading page.";

        const stockHedgeLeg = getStockHedgeLeg(createdOrder.position);
        if (stockHedgeLeg) {
          try {
            const stockSubmission = await twsPaperApi.submitStockOrder({
              order: {
                ...createdOrder.position,
                id: Number(createdOrder.id)
              },
              purpose: "entry"
            });

            createdOrder = updatePaperOrder(
              Number(createdOrder.id),
              sanitizePaperOrderPayload(
                {
                  ...createdOrder.position,
                  stockExecution: stockSubmission
                },
                createdOrder.position
              )
            );

            createMessage = `${createMessage} TWS stock hedge submitted.`;
          } catch (stockError) {
            const nowIso = new Date().toISOString();
            const quantity = Math.max(Number(stockHedgeLeg.quantity ?? 0) || 0, 0);

            createdOrder = updatePaperOrder(
              Number(createdOrder.id),
              sanitizePaperOrderPayload(
                {
                  ...createdOrder.position,
                  stockExecution: {
                    route: "tws-paper",
                    purpose: "entry",
                    status: "error",
                    statusText: "TWS stock hedge submission failed",
                    statusDescription: "",
                    brokerOrderId: "",
                    orderRef: "",
                    orderType: "MKT",
                    tif: String(createdOrder.position?.execution?.tif ?? "DAY"),
                    outsideRth: createdOrder.position?.execution?.outsideRth === true,
                    limitPrice: null,
                    avgFillPrice: null,
                    combo: false,
                    totalQuantity: quantity,
                    filledQuantity: 0,
                    remainingQuantity: quantity,
                    submittedAt: nowIso,
                    lastSyncAt: nowIso,
                    filledAt: "",
                    cancelledAt: "",
                    lastError: stockError.message,
                    lastWarning: "",
                    warningMessages: [],
                    pendingReplyId: "",
                    pendingReplyMessages: [],
                    requestedLegs: []
                  }
                },
                createdOrder.position
              )
            );

            createMessage = `${createMessage} TWS stock hedge submission failed: ${stockError.message}`;
          }
        }
      } catch (error) {
        createdOrder = updatePaperOrder(
          Number(createdOrder.id),
          sanitizePaperOrderPayload(
            {
              ...createdOrder.position,
              execution: {
                ...buildPendingTwsExecution(createdOrder.position, {
                  status: "error",
                  statusText: "TWS submission failed",
                  lastError: error.message
                }),
                lastSyncAt: new Date().toISOString()
              }
            },
            createdOrder.position
          )
        );
        createMessage = `Order saved locally, but TWS submission failed: ${error.message}`;
      }
    }
    const initialCalculatorSnapshotPayload = request.body?.initialCalculatorSnapshot?.payload;

    if (initialCalculatorSnapshotPayload && typeof initialCalculatorSnapshotPayload === "object") {
      const baseOrderSnapshot =
        initialCalculatorSnapshotPayload.orderSnapshot &&
        typeof initialCalculatorSnapshotPayload.orderSnapshot === "object"
          ? initialCalculatorSnapshotPayload.orderSnapshot
          : {};

      createPaperCalculatorSnapshot(
        Number(createdOrder.id),
        String(request.body?.initialCalculatorSnapshot?.snapshotName ?? "Order placed").trim() || "Order placed",
        {
          ...initialCalculatorSnapshotPayload,
          savedFromOrderId: Number(createdOrder.id),
          orderSnapshot: {
            ...baseOrderSnapshot,
            id: Number(createdOrder.id),
            purchaseDate: createdOrder.position?.purchaseDate ?? baseOrderSnapshot.purchaseDate ?? "",
            createdAt: normalizeTimestamp(createdOrder.createdAt) || new Date().toISOString(),
            closedAt: createdOrder.position?.closedAt ?? baseOrderSnapshot.closedAt ?? "",
            status: createdOrder.position?.status ?? baseOrderSnapshot.status ?? "open",
            polymarketResolutionDate:
              createdOrder.position?.polymarketResolutionDate ?? baseOrderSnapshot.polymarketResolutionDate ?? "",
            strategyCloseDate:
              createdOrder.position?.strategyCloseDate ?? baseOrderSnapshot.strategyCloseDate ?? "",
            marketReferenceYesPrice:
              createdOrder.position?.marketReferenceYesPrice ?? baseOrderSnapshot.marketReferenceYesPrice ?? 0.5,
            execution: createdOrder.position?.execution ?? baseOrderSnapshot.execution ?? null,
            closeExecution: createdOrder.position?.closeExecution ?? baseOrderSnapshot.closeExecution ?? null
          }
        }
      );
    }

    const valuedPaperPortfolio = buildPaperPortfolio({
      orders: [createdOrder],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const valuedOrder = valuedPaperPortfolio.openOrders[0] ?? valuedPaperPortfolio.orders[0] ?? null;

    if (valuedOrder) {
      recordPaperOrderSnapshots([
        buildPaperOrderSnapshot(valuedOrder, normalizeTimestamp(createdOrder.createdAt) || new Date().toISOString())
      ]);
    }

    const paperPortfolio = buildPaperPortfolioResponse(userId);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.status(201).json({
      order: createdOrder,
      paperPortfolio,
      message: createMessage
    });
  } catch (error) {
    response.status(400).json({
      error: error.message
    });
  }
});

app.post("/api/paper-orders/:id/execute", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  const purpose = String(request.body?.purpose ?? "entry").trim().toLowerCase() === "exit" ? "exit" : "entry";
  const isIbkrRoute = isIbkrPaperRoute(existingOrder.position);
  const isTwsRoute = isTwsPaperRoute(existingOrder.position);

  if (!isIbkrRoute && !isTwsRoute) {
    response.status(400).json({
      error: "This order is not configured for broker paper routing"
    });
    return;
  }

  try {
    let nextOrder = existingOrder.position;
    let message = "";

    if (isIbkrRoute) {
      if (purpose === "entry") {
        if (!hasOptionLegs(existingOrder.position)) {
          throw new Error("IBKR paper routing requires at least one option leg");
        }

        const preparedOrder = prepareOrderForIbkrEntry(
          sanitizePaperOrderPayload(
            {
              ...existingOrder.position,
              execution: buildPendingIbkrExecution(existingOrder.position, request.body?.execution ?? {})
            },
            existingOrder.position
          )
        );
        const submission = await submitIbkrOptionOrder({
          order: {
            ...preparedOrder,
            id: orderId
          },
          purpose: "entry"
        }, getIbkrContextForUser(userId));

        nextOrder = sanitizePaperOrderPayload(
          {
            ...preparedOrder,
            execution: submission
          },
          preparedOrder
        );
        message = buildIbkrSubmissionMessage(submission, "entry");

        const stockHedgeLeg = getStockHedgeLeg(nextOrder);
        if (stockHedgeLeg) {
          const optionConfirmationPending =
            String(submission?.status ?? "").trim().toLowerCase() === "pending_confirmation" &&
            String(submission?.pendingReplyId ?? "").trim().length > 0;

          if (optionConfirmationPending) {
            message = `${message} Stock hedge will submit after the IBKR confirmation is resolved.`;
          } else {
            try {
              const stockSubmission = await submitIbkrStockOrder({
                order: {
                  ...nextOrder,
                  id: orderId
                },
                purpose: "entry"
              }, getIbkrContextForUser(userId));

              nextOrder = sanitizePaperOrderPayload(
                {
                  ...nextOrder,
                  stockExecution: stockSubmission
                },
                nextOrder
              );
              message = `${message} ${buildIbkrStockHedgeSubmissionMessage(stockSubmission)}`;
            } catch (stockError) {
              const nowIso = new Date().toISOString();
              const quantity = Math.max(Number(stockHedgeLeg.quantity ?? 0) || 0, 0);

              nextOrder = sanitizePaperOrderPayload(
                {
                  ...nextOrder,
                  stockExecution: {
                    route: "ibkr-paper",
                    purpose: "entry",
                    status: "error",
                    statusText: "IBKR stock hedge submission failed",
                    statusDescription: "",
                    brokerOrderId: "",
                    orderRef: "",
                    orderType: "MKT",
                    tif: String(nextOrder.execution?.tif ?? "DAY"),
                    outsideRth: nextOrder.execution?.outsideRth === true,
                    limitPrice: null,
                    avgFillPrice: null,
                    combo: false,
                    totalQuantity: quantity,
                    filledQuantity: 0,
                    remainingQuantity: quantity,
                    submittedAt: nowIso,
                    lastSyncAt: nowIso,
                    filledAt: "",
                    cancelledAt: "",
                    lastError: stockError.message,
                    lastWarning: "",
                    warningMessages: [],
                    pendingReplyId: "",
                    pendingReplyMessages: [],
                    requestedLegs: []
                  }
                },
                nextOrder
              );
              message = `${message} IBKR stock hedge submission failed: ${stockError.message}`;
            }
          }
        }
      } else {
        const filledQuantity = Math.max(Number(existingOrder.position.execution?.filledQuantity ?? 0) || 0, 0);

        if (!(filledQuantity > 0)) {
          throw new Error("No filled option position is available to close through IBKR");
        }

        const submission = await submitIbkrOptionOrder({
          order: {
            ...existingOrder.position,
            id: orderId
          },
          purpose: "exit"
        }, getIbkrContextForUser(userId));

        nextOrder = sanitizePaperOrderPayload(
          {
            ...existingOrder.position,
            closeExecution: mapCloseExecutionToRoute(submission, existingOrder.position)
          },
          existingOrder.position
        );
        message = buildIbkrSubmissionMessage(submission, "exit");
      }
    } else if (isTwsRoute) {
      if (purpose !== "entry") {
        throw new Error(
          "TWS exit orders are managed manually inside TWS. Use the Close action in HedgeHub to move filled positions to history."
        );
      }

      if (!hasOptionLegs(existingOrder.position)) {
        throw new Error("TWS paper routing requires at least one option leg");
      }

      const preparedOrder = prepareOrderForTwsEntry(
        sanitizePaperOrderPayload(
          {
            ...existingOrder.position,
            execution: buildPendingTwsExecution(existingOrder.position, request.body?.execution ?? {})
          },
          existingOrder.position
        )
      );
      const submission = await twsPaperApi.submitOptionOrder({
        order: {
          ...preparedOrder,
          id: orderId
        },
        purpose: "entry"
      });

      nextOrder = sanitizePaperOrderPayload(
        {
          ...preparedOrder,
          execution: submission
        },
        preparedOrder
      );
      nextOrder = applyEntryExecutionToOrder(nextOrder, nextOrder.execution, []);
      paperBrokerState.tws = {
        ...paperBrokerState.tws,
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null
      };
      syncStrategyCacheBrokerStatus();
      message = "TWS paper order submitted. You can monitor it from the paper-trading page.";

      const stockHedgeLeg = getStockHedgeLeg(nextOrder);
      if (stockHedgeLeg) {
        try {
          const stockSubmission = await twsPaperApi.submitStockOrder({
            order: {
              ...nextOrder,
              id: orderId
            },
            purpose: "entry"
          });
          nextOrder = sanitizePaperOrderPayload(
            {
              ...nextOrder,
              stockExecution: stockSubmission
            },
            nextOrder
          );
          message = `${message} TWS stock hedge submitted.`;
        } catch (stockError) {
          const nowIso = new Date().toISOString();
          const quantity = Math.max(Number(stockHedgeLeg.quantity ?? 0) || 0, 0);

          nextOrder = sanitizePaperOrderPayload(
            {
              ...nextOrder,
              stockExecution: {
                route: "tws-paper",
                purpose: "entry",
                status: "error",
                statusText: "TWS stock hedge submission failed",
                statusDescription: "",
                brokerOrderId: "",
                orderRef: "",
                orderType: "MKT",
                tif: String(nextOrder.execution?.tif ?? "DAY"),
                outsideRth: nextOrder.execution?.outsideRth === true,
                limitPrice: null,
                avgFillPrice: null,
                combo: false,
                totalQuantity: quantity,
                filledQuantity: 0,
                remainingQuantity: quantity,
                submittedAt: nowIso,
                lastSyncAt: nowIso,
                filledAt: "",
                cancelledAt: "",
                lastError: stockError.message,
                lastWarning: "",
                warningMessages: [],
                pendingReplyId: "",
                pendingReplyMessages: [],
                requestedLegs: []
              }
            },
            nextOrder
          );
          message = `${message} TWS stock hedge submission failed: ${stockError.message}`;
        }
      }
    }

    const updatedOrder = updatePaperOrder(orderId, nextOrder);
    if (isIbkrRoute) {
      await refreshIbkrStatusCacheForUser(userId).catch(() => null);
    }
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio: buildPaperPortfolioResponse(userId),
      message
    });
  } catch (error) {
    if (isTwsRoute) {
      const failedOrder = sanitizePaperOrderPayload(
        {
          ...existingOrder.position,
          execution: {
            ...buildPendingTwsExecution(existingOrder.position, {
              status: "error",
              statusText: "TWS submission failed",
              lastError: error.message
            }),
            lastSyncAt: new Date().toISOString()
          }
        },
        existingOrder.position
      );

      updatePaperOrder(orderId, failedOrder);
    } else {
      const failedOrder =
        purpose === "exit"
          ? sanitizePaperOrderPayload(
              {
                ...existingOrder.position,
                closeExecution: mapCloseExecutionToRoute(
                  {
                    ...(existingOrder.position.closeExecution ?? {}),
                    route: "ibkr-paper",
                    purpose: "exit",
                    status: "error",
                    statusText: "IBKR exit submission failed",
                    lastError: error.message,
                    lastSyncAt: new Date().toISOString()
                  },
                  existingOrder.position
                )
              },
              existingOrder.position
            )
          : sanitizePaperOrderPayload(
              {
                ...prepareOrderForIbkrEntry(existingOrder.position),
                execution: buildPendingIbkrExecution(existingOrder.position, {
                  status: "error",
                  statusText: "IBKR paper submission failed",
                  lastError: error.message,
                  lastSyncAt: new Date().toISOString()
                })
              },
              existingOrder.position
            );

      updatePaperOrder(orderId, failedOrder);
    }

    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.status(502).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
  }
});

app.post("/api/paper-orders/:id/hedge", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  if (String(existingOrder.position?.status ?? "open").toLowerCase() === "closed") {
    response.status(400).json({
      error: "paper order is already closed",
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
    return;
  }

  try {
    const valuedBefore = buildPaperPortfolio({
      orders: [existingOrder],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const valuedBeforeOrder =
      valuedBefore.openOrders[0] ??
      valuedBefore.orders[0] ??
      valuedBefore.closedOrders?.[0] ??
      null;

    const rawRequestedShares = toNumber(request.body?.shares, null);
    const requestedShares =
      rawRequestedShares != null ? Math.round(rawRequestedShares) : Math.round(valuedBeforeOrder?.hedgeState?.recommendedSharesDeltaNeutral ?? 0);

    if (!Number.isFinite(requestedShares) || requestedShares === 0) {
      response.status(400).json({
        error: "No hedge action is currently available for this order.",
        paperPortfolio: buildPaperPortfolioResponseSafe(userId)
      });
      return;
    }

    const proxySymbol = String(existingOrder.position?.marketContext?.proxySymbol ?? "").trim();
    const hedgeSymbol = proxySymbol || String(existingOrder.position?.assetLabel ?? "").trim() || "STOCK";
    const hedgeSpot = toNumber(valuedBeforeOrder?.valuationContext?.currentProxySpot, null) ?? toNumber(existingOrder.position?.marketContext?.currentProxySpot, 0) ?? 0;
    const hedgePrice = hedgeSpot > 0 ? hedgeSpot : Math.max(toNumber(existingOrder.position?.marketContext?.currentUnderlyingSpot, 0) ?? 0, 0);

    if (!(hedgePrice > 0)) {
      response.status(400).json({
        error: "Unable to resolve a live spot price to price the hedge shares.",
        paperPortfolio: buildPaperPortfolioResponseSafe(userId)
      });
      return;
    }

    const legQuantity = Math.max(Math.abs(requestedShares), 0);
    const hedgeAction = requestedShares > 0 ? "LONG" : "SHORT";

    const nextLeg = {
      id: `paper-hedge-${Date.now()}`,
      label: `${hedgeSymbol} shares`,
      kind: "stock",
      action: hedgeAction,
      quantity: legQuantity,
      entryPrice: hedgePrice,
      rootSymbol: hedgeSymbol,
      quoteSource: "Stock"
    };

    const nextOrderPayload = sanitizePaperOrderPayload(
      {
        ...existingOrder.position,
        legs: [...(existingOrder.position?.legs ?? []), nextLeg]
      },
      existingOrder.position
    );

    const updatedOrder = updatePaperOrder(orderId, nextOrderPayload);
    const valuedPaperPortfolio = buildPaperPortfolio({
      orders: [updatedOrder],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const valuedOrder =
      valuedPaperPortfolio.openOrders[0] ??
      valuedPaperPortfolio.orders[0] ??
      valuedPaperPortfolio.closedOrders[0] ??
      null;

    if (valuedOrder && !valuedOrder.isClosed) {
      recordPaperOrderSnapshots([
        buildPaperOrderSnapshot(valuedOrder, normalizeTimestamp(updatedOrder.updatedAt) || new Date().toISOString())
      ]);
    }

    const paperPortfolio = buildPaperPortfolioResponse(userId);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio,
      message: `Hedge leg added: ${hedgeAction === "SHORT" ? "short" : "buy"} ${legQuantity} shares.`
    });
  } catch (error) {
    response.status(400).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
  }
});

app.post("/api/paper-orders/:id/confirm-execution", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  if (typeof request.body?.confirmed !== "boolean") {
    response.status(400).json({
      error: "confirmed must be true or false"
    });
    return;
  }

  const pendingExecution = findPendingConfirmationExecution(existingOrder.position);
  if (!pendingExecution) {
    const currentExecution =
      String(existingOrder.position?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper" &&
      String(existingOrder.position?.closeExecution?.status ?? "").trim()
        ? existingOrder.position.closeExecution
        : existingOrder.position?.execution ?? null;
    console.warn(
      `[IBKR] No pending confirmation for paper order ${orderId}. entry=${JSON.stringify({
        route: existingOrder.position?.execution?.route ?? "",
        status: existingOrder.position?.execution?.status ?? "",
        pendingReplyId: existingOrder.position?.execution?.pendingReplyId ?? "",
        brokerOrderId: existingOrder.position?.execution?.brokerOrderId ?? ""
      })} exit=${JSON.stringify({
        route: existingOrder.position?.closeExecution?.route ?? "",
        status: existingOrder.position?.closeExecution?.status ?? "",
        pendingReplyId: existingOrder.position?.closeExecution?.pendingReplyId ?? "",
        brokerOrderId: existingOrder.position?.closeExecution?.brokerOrderId ?? ""
      })}`
    );
    response.json({
      order: existingOrder,
      paperPortfolio: buildPaperPortfolioResponse(userId),
      message: currentExecution?.brokerOrderId
        ? `No IBKR confirmation is pending. Broker order ${currentExecution.brokerOrderId} is currently ${
            currentExecution.statusText || currentExecution.status || "active"
          }.`
        : "No IBKR confirmation is pending for this paper order."
    });
    return;
  }

  try {
    const nextExecution = await continueIbkrOrderConfirmation({
      execution: {
        ...pendingExecution.value,
        warningMessages: getExecutionWarningMessages(pendingExecution.value),
        pendingReplyMessages: getPendingReplyMessages(pendingExecution.value)
      },
      confirmed: request.body.confirmed
    }, getIbkrContextForUser(userId));
    let updatedOrder = updatePaperOrder(
      orderId,
      sanitizePaperOrderPayload(
        {
          ...existingOrder.position,
          [pendingExecution.key]:
            pendingExecution.key === "closeExecution"
              ? mapCloseExecutionToRoute(nextExecution, existingOrder.position)
              : nextExecution
        },
        existingOrder.position
      )
    );

    const messageParts = [];
    const pendingKey = String(pendingExecution.key ?? "");

    if (request.body.confirmed === true) {
      messageParts.push(
        pendingKey === "stockExecution"
          ? buildIbkrStockHedgeSubmissionMessage(nextExecution)
          : buildIbkrSubmissionMessage(nextExecution, pendingExecution.purpose)
      );
    } else {
      messageParts.push(
        pendingKey === "stockExecution"
          ? "IBKR stock hedge confirmation declined. Broker order was not submitted."
          : pendingExecution.purpose === "exit"
            ? "IBKR exit confirmation declined. Broker order was not submitted."
            : "IBKR confirmation declined. Broker order was not submitted."
      );
    }

    const normalizedStatus = String(nextExecution?.status ?? "").trim().toLowerCase();
    const followUpConfirmationPending =
      normalizedStatus === "pending_confirmation" && String(nextExecution?.pendingReplyId ?? "").trim().length > 0;
    const resolvedToError = ["inactive", "rejected", "error", "cancelled"].includes(normalizedStatus);

    if (request.body.confirmed === true && pendingKey === "execution" && !followUpConfirmationPending && !resolvedToError) {
      const stockHedgeLeg = getStockHedgeLeg(updatedOrder.position);
      const existingStockExecution = updatedOrder.position?.stockExecution ?? null;
      const existingStockBrokerOrderId = String(existingStockExecution?.brokerOrderId ?? "").trim();
      const existingStockStatus = String(existingStockExecution?.status ?? "").trim().toLowerCase();

      if (stockHedgeLeg && (!existingStockBrokerOrderId || ["", "error", "cancelled", "rejected", "inactive"].includes(existingStockStatus))) {
        try {
          const stockSubmission = await submitIbkrStockOrder({
            order: {
              ...updatedOrder.position,
              id: orderId
            },
            purpose: "entry"
          }, getIbkrContextForUser(userId));

          updatedOrder = updatePaperOrder(
            orderId,
            sanitizePaperOrderPayload(
              {
                ...updatedOrder.position,
                stockExecution: stockSubmission
              },
              updatedOrder.position
            )
          );
          messageParts.push(buildIbkrStockHedgeSubmissionMessage(stockSubmission));
        } catch (stockError) {
          const nowIso = new Date().toISOString();
          const quantity = Math.max(Number(stockHedgeLeg.quantity ?? 0) || 0, 0);

          updatedOrder = updatePaperOrder(
            orderId,
            sanitizePaperOrderPayload(
              {
                ...updatedOrder.position,
                stockExecution: {
                  route: "ibkr-paper",
                  purpose: "entry",
                  status: "error",
                  statusText: "IBKR stock hedge submission failed",
                  statusDescription: "",
                  brokerOrderId: "",
                  orderRef: "",
                  orderType: "MKT",
                  tif: String(updatedOrder.position?.execution?.tif ?? "DAY"),
                  outsideRth: updatedOrder.position?.execution?.outsideRth === true,
                  limitPrice: null,
                  avgFillPrice: null,
                  combo: false,
                  totalQuantity: quantity,
                  filledQuantity: 0,
                  remainingQuantity: quantity,
                  submittedAt: nowIso,
                  lastSyncAt: nowIso,
                  filledAt: "",
                  cancelledAt: "",
                  lastError: stockError.message,
                  lastWarning: "",
                  warningMessages: [],
                  pendingReplyId: "",
                  pendingReplyMessages: [],
                  requestedLegs: []
                }
              },
              updatedOrder.position
            )
          );
          messageParts.push(`IBKR stock hedge submission failed: ${stockError.message}`);
        }
      }
    }

    await refreshIbkrStatusCacheForUser(userId).catch(() => null);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    const message = messageParts.filter(Boolean).join(" ");

    response.json({
      order: updatedOrder,
      paperPortfolio: buildPaperPortfolioResponse(userId),
      message
    });
  } catch (error) {
    response.status(502).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
  }
});

app.post("/api/paper-orders/:id/sync-execution", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  if (!isBrokerTrackedOrder(existingOrder.position)) {
    response.status(400).json({
      error: "paper order is not broker-tracked"
    });
    return;
  }

  if (isTwsPaperRoute(existingOrder.position) || isTwsPaperExecution(existingOrder.position?.closeExecution)) {
    let updatedOrderRecord = existingOrder;

    try {
      await twsPaperApi.requestAllOpenOrders();
      paperBrokerState.tws = {
        ...paperBrokerState.tws,
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null
      };
      syncStrategyCacheBrokerStatus();
    } catch (error) {
      paperBrokerState.tws = {
        ...paperBrokerState.tws,
        lastSyncAt: new Date().toISOString(),
        lastSyncError: error.message
      };
      syncStrategyCacheBrokerStatus();
    }

    try {
      const refreshedOrder =
        listPaperOrders(null, userId).find((order) => Number(order.id) === orderId)?.position ?? existingOrder.position;
      const brokerOrderId = Number(refreshedOrder?.execution?.brokerOrderId ?? 0);

      if (Number.isInteger(brokerOrderId) && brokerOrderId > 0) {
        const trades = twsPaperApi
          .getTradesForOrder(brokerOrderId)
          .map((fill) => ({
            conid: String(fill?.contract?.conId ?? fill?.contract?.conid ?? "").trim(),
            quantity: Math.abs(Number(fill?.shares ?? 0) || 0),
            price: Number(fill?.price ?? 0) || 0,
            execution_time: String(fill?.time ?? "")
          }))
          .filter((fill) => fill.conid && fill.quantity > 0);

        const syncedOrder = applyEntryExecutionToOrder(refreshedOrder, refreshedOrder.execution, trades, {
          applyFills: true
        });

        if (JSON.stringify(syncedOrder) !== JSON.stringify(refreshedOrder)) {
          updatedOrderRecord = updatePaperOrder(orderId, syncedOrder);
          invalidateStrategyResponseCache();
          syncPaperOptionStreamSubscriptions();
          schedulePaperPortfolioBroadcast(0);
        }
      }
    } catch (error) {
      logWarn("Failed to apply TWS fills for paper order", {
        subsystem: "paper",
        userId,
        orderId,
        error
      });
    }

    response.json({
      order: listPaperOrders(null, userId).find((order) => Number(order.id) === orderId) ?? updatedOrderRecord,
      paperPortfolio: buildPaperPortfolioResponse(userId),
      message: "TWS order state synced."
    });
    return;
  }

  await tickleIbkrSession(getIbkrContextForUser(userId)).catch(() => null);
  await syncIbkrPaperOrders({
    userId,
    onlyOrderId: orderId,
    applyEntryFills: true
  });

  response.json({
    order: listPaperOrders(null, userId).find((order) => Number(order.id) === orderId) ?? existingOrder,
    paperPortfolio: buildPaperPortfolioResponse(userId),
    message: "IBKR order state synced."
  });
});

app.post("/api/paper-orders/:id/cancel-execution", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  if (isTwsPaperRoute(existingOrder.position) || isTwsPaperExecution(existingOrder.position?.closeExecution)) {
    response.status(400).json({
      error: "Cancel/update TWS orders manually inside TWS. HedgeHub only tracks status.",
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
    return;
  }

  const activeExecution =
    String(existingOrder.position?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper" &&
    existingOrder.position.closeExecution &&
    !isIbkrTerminalStatus(existingOrder.position.closeExecution.status)
      ? {
          key: "closeExecution",
          value: existingOrder.position.closeExecution
        }
      : isIbkrPaperRoute(existingOrder.position) &&
          existingOrder.position.execution &&
          !isIbkrTerminalStatus(existingOrder.position.execution.status)
        ? {
            key: "execution",
            value: existingOrder.position.execution
          }
        : null;

  if (!activeExecution?.value?.brokerOrderId) {
    response.status(400).json({
      error: "No active IBKR order is available to cancel"
    });
    return;
  }

  try {
    await cancelIbkrOrder({
      accountId: activeExecution.value.accountId,
      orderId: activeExecution.value.brokerOrderId
    }, getIbkrContextForUser(userId));

    const updatedOrder = updatePaperOrder(
      orderId,
      sanitizePaperOrderPayload(
        {
          ...existingOrder.position,
          [activeExecution.key]: {
            ...activeExecution.value,
            status: "pending_cancel",
            statusText: "Cancel requested",
            lastSyncAt: new Date().toISOString()
          }
        },
        existingOrder.position
      )
    );
    invalidateStrategyResponseCache();
    await syncIbkrPaperOrders({
      userId,
      onlyOrderId: orderId
    });

    response.json({
      order: listPaperOrders(null, userId).find((order) => Number(order.id) === orderId) ?? updatedOrder,
      paperPortfolio: buildPaperPortfolioResponse(userId),
      message: "Cancel request sent to IBKR."
    });
  } catch (error) {
    response.status(502).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
  }
});

app.patch("/api/paper-orders/:id", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  try {
    const nextOrder = reconcileSmartEntryExecution(applyPaperOrderPatch(existingOrder.position, request.body));
    const updatedOrder = updatePaperOrder(orderId, nextOrder);
    const valuedPaperPortfolio = buildPaperPortfolio({
      orders: [updatedOrder],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const valuedOrder =
      valuedPaperPortfolio.openOrders[0] ??
      valuedPaperPortfolio.orders[0] ??
      valuedPaperPortfolio.closedOrders[0] ??
      null;

    if (valuedOrder && !valuedOrder.isClosed) {
      recordPaperOrderSnapshots([
        buildPaperOrderSnapshot(valuedOrder, normalizeTimestamp(updatedOrder.updatedAt) || new Date().toISOString())
      ]);
    }

    const paperPortfolio = buildPaperPortfolioResponse(userId);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio
    });
  } catch (error) {
    response.status(400).json({
      error: error.message
    });
  }
});

app.post("/api/paper-orders/:id/legs/:legId/close", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);
  const legId = String(request.params.legId ?? "").trim();

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  if (!legId) {
    response.status(400).json({
      error: "leg id is required"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  const brokerRouted = isIbkrPaperRoute(existingOrder.position) || isTwsPaperRoute(existingOrder.position);
  // TODO(broker): Submit leg close via IBKR Gateway/TWS, then close locally on fill.

  if (String(existingOrder.position?.status ?? "open").toLowerCase() === "closed") {
    response.status(400).json({
      error: "paper order is already closed"
    });
    return;
  }

  const legs = Array.isArray(existingOrder.position?.legs) ? existingOrder.position.legs : [];
  const existingLeg = legs.find((leg) => String(leg?.id ?? "") === legId) ?? null;

  if (!existingLeg) {
    response.status(404).json({
      error: "paper order leg not found"
    });
    return;
  }

  if (String(existingLeg?.status ?? "open").trim().toLowerCase() === "closed") {
    response.status(400).json({
      error: "paper order leg is already closed"
    });
    return;
  }

  try {
    const valuation = buildPaperPortfolio({
      orders: [
        {
          ...existingOrder,
          position: existingOrder.position
        }
      ],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const valuedOrder = valuation.openOrders[0] ?? valuation.orders[0] ?? null;

    if (!valuedOrder) {
      throw new Error("Unable to value the paper order before closing the leg");
    }

    const valuedLeg = valuedOrder.legs.find((leg) => String(leg?.id ?? "") === legId) ?? null;
    if (!valuedLeg) {
      throw new Error("Unable to value the paper order leg before closing");
    }

    const hasClosedPrice = Object.prototype.hasOwnProperty.call(request.body ?? {}, "closedPrice");
    const requestedClosedPrice =
      hasClosedPrice && request.body?.closedPrice != null && String(request.body.closedPrice).trim() !== ""
        ? Number(request.body.closedPrice)
        : null;
    const defaultClosedPrice = valuedLeg.currentPrice != null ? Number(valuedLeg.currentPrice) : null;
    const closedPrice = Number.isFinite(requestedClosedPrice) ? requestedClosedPrice : defaultClosedPrice;

    if (closedPrice == null || Number.isNaN(Number(closedPrice))) {
      throw new Error("closedPrice must be a valid number");
    }

    const closedAt = normalizeTimestamp(request.body?.closedAt ?? new Date().toISOString()) || new Date().toISOString();
    const closedDate = closedAt.slice(0, 10);

    const nextOrder = sanitizePaperOrderPayload(
      {
        ...existingOrder.position,
        legs: legs.map((leg) =>
          String(leg?.id ?? "") === legId
            ? {
                ...leg,
                status: "closed",
                closedAt,
                closedDate,
                closedPrice,
                closedExposure: null,
                closedNetMarkedValue: null,
                realizedProfitLossValue: null,
                realizedProfitLossPercent: null
              }
            : leg
        )
      },
      existingOrder.position
    );

    const allLegsClosed = (nextOrder.legs ?? []).every(
      (leg) => String(leg?.status ?? "open").trim().toLowerCase() === "closed"
    );

    let updatedPayload = nextOrder;

    if (allLegsClosed) {
      const closeValuation = buildPaperPortfolio({
        orders: [
          {
            ...existingOrder,
            position: nextOrder
          }
        ],
        quotes: liveState.quotes,
        polymarketMarkets: getPaperValuationPolymarketMarkets(),
        optionMatches: buildPaperValuationOptionMatches()
      });
      const valuedCloseOrder =
        closeValuation.orders[0] ?? closeValuation.openOrders[0] ?? closeValuation.closedOrders[0] ?? null;

      if (!valuedCloseOrder) {
        throw new Error("Unable to value the paper order before closing");
      }

      updatedPayload = closePaperOrderPayload(updatedPayload, valuedCloseOrder, closedAt);
    }

    const updatedOrder = updatePaperOrder(orderId, updatedPayload);

    const updatedValuation = buildPaperPortfolio({
      orders: [updatedOrder],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const updatedValuedOrder =
      updatedValuation.openOrders[0] ?? updatedValuation.orders[0] ?? updatedValuation.closedOrders[0] ?? null;

    if (updatedValuedOrder) {
      recordPaperOrderSnapshots([
        buildPaperOrderSnapshot(
          updatedValuedOrder,
          allLegsClosed ? updatedPayload.closedAt : normalizeTimestamp(updatedOrder.updatedAt) || new Date().toISOString()
        )
      ]);
    }

    const paperPortfolio = buildPaperPortfolioResponse(userId);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio,
      message: allLegsClosed
        ? brokerRouted
          ? "Leg closed. Order moved to history (record only)."
          : "Leg closed. Order moved to history."
        : brokerRouted
          ? "Leg closed (record only)."
          : "Leg closed."
    });
  } catch (error) {
    response.status(400).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
  }
});

app.post("/api/paper-orders/:id/legs/:legId/revive", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);
  const legId = String(request.params.legId ?? "").trim();

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  if (!legId) {
    response.status(400).json({
      error: "leg id is required"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  const brokerRouted = isIbkrPaperRoute(existingOrder.position) || isTwsPaperRoute(existingOrder.position);
  // TODO(broker): Submit leg reopen via IBKR Gateway/TWS if needed.

  const legs = Array.isArray(existingOrder.position?.legs) ? existingOrder.position.legs : [];
  const existingLeg = legs.find((leg) => String(leg?.id ?? "") === legId) ?? null;

  if (!existingLeg) {
    response.status(404).json({
      error: "paper order leg not found"
    });
    return;
  }

  const legStatus = String(
    existingLeg?.status ??
      (existingLeg?.closedAt || existingLeg?.closedDate || existingLeg?.closedPrice != null ? "closed" : "open")
  )
    .trim()
    .toLowerCase();

  if (legStatus !== "closed") {
    response.status(400).json({
      error: "paper order leg is not closed"
    });
    return;
  }

  try {
    const orderStatus = String(existingOrder.position?.status ?? "open").trim().toLowerCase();
    const revivedOrder = sanitizePaperOrderPayload(
      {
        ...existingOrder.position,
        ...(orderStatus === "closed" ? { status: "open" } : {}),
        legs: legs.map((leg) =>
          String(leg?.id ?? "") === legId
            ? {
                ...leg,
                status: "open",
                closedAt: null,
                closedDate: null,
                closedPrice: null,
                closedExposure: null,
                closedNetMarkedValue: null,
                realizedProfitLossValue: null,
                realizedProfitLossPercent: null
              }
            : leg
        )
      },
      existingOrder.position
    );

    const updatedOrder = updatePaperOrder(orderId, revivedOrder);

    const updatedValuation = buildPaperPortfolio({
      orders: [updatedOrder],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const updatedValuedOrder =
      updatedValuation.openOrders[0] ?? updatedValuation.orders[0] ?? updatedValuation.closedOrders[0] ?? null;

    if (updatedValuedOrder && !updatedValuedOrder.isClosed) {
      recordPaperOrderSnapshots([
        buildPaperOrderSnapshot(updatedValuedOrder, normalizeTimestamp(updatedOrder.updatedAt) || new Date().toISOString())
      ]);
    }

    const paperPortfolio = buildPaperPortfolioResponse(userId);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio,
      message: brokerRouted ? "Leg revived (record only)." : "Leg revived."
    });
  } catch (error) {
    response.status(400).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe(userId)
    });
  }
});

app.post("/api/paper-orders/:id/close", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  if (String(existingOrder.position?.status ?? "open").toLowerCase() === "closed") {
    response.status(400).json({
      error: "paper order is already closed"
    });
    return;
  }

  try {
    const patchedOrder = applyPaperOrderPatch(existingOrder.position, request.body);

    if (isIbkrPaperRoute(patchedOrder)) {
      const filledQuantity = Math.max(Number(patchedOrder.execution?.filledQuantity ?? 0) || 0, 0);

      if (!(filledQuantity > 0)) {
        const valuation = buildPaperPortfolio({
          orders: [
            {
              ...existingOrder,
              position: patchedOrder
            }
          ],
          quotes: liveState.quotes,
          polymarketMarkets: getPaperValuationPolymarketMarkets(),
          optionMatches: buildPaperValuationOptionMatches()
        });
        const valuedOrder = valuation.openOrders[0] ?? valuation.orders[0];

        if (!valuedOrder) {
          throw new Error("Unable to value the paper order before closing");
        }

        const closedOrder = closePaperOrderPayload(
          {
            ...patchedOrder,
            closeExecution: null
          },
          valuedOrder
        );
        const updatedOrder = updatePaperOrder(orderId, closedOrder);
        recordPaperOrderSnapshots([
          buildPaperOrderSnapshot(
            {
              ...valuedOrder,
              status: "closed"
            },
            closedOrder.closedAt
          )
        ]);
        const paperPortfolio = buildPaperPortfolioResponse(userId);
        invalidateStrategyResponseCache();
        syncPaperOptionStreamSubscriptions();
        schedulePaperPortfolioBroadcast(0);

        response.json({
          order: updatedOrder,
          paperPortfolio,
          message: "No IBKR option position to close. Order closed locally."
        });
        return;
      }

      const submission = await submitIbkrOptionOrder({
        order: {
          ...patchedOrder,
          id: orderId
        },
        purpose: "exit"
      }, getIbkrContextForUser(userId));
      const updatedOrder = updatePaperOrder(
        orderId,
        sanitizePaperOrderPayload(
          {
            ...patchedOrder,
            closeExecution: mapCloseExecutionToRoute(submission, patchedOrder)
          },
          patchedOrder
        )
      );
      await refreshIbkrStatusCacheForUser(userId).catch(() => null);
      invalidateStrategyResponseCache();
      syncPaperOptionStreamSubscriptions();
      schedulePaperPortfolioBroadcast(0);

      response.json({
        order: updatedOrder,
        paperPortfolio: buildPaperPortfolioResponse(userId),
        message: buildIbkrSubmissionMessage(submission, "exit")
      });
      return;
    }

    if (isTwsPaperRoute(patchedOrder)) {
      const entryStatus = String(patchedOrder.execution?.status ?? "").trim().toLowerCase();
      const forceClose = request.body?.forceClose === true;

      if (entryStatus !== "filled") {
        if (!forceClose) {
          throw new Error("TWS entry order is not filled yet. Wait for the fill before moving it to closed history.");
        }

        const valuation = buildPaperPortfolio({
          orders: [
            {
              ...existingOrder,
              position: patchedOrder
            }
          ],
          quotes: liveState.quotes,
          polymarketMarkets: getPaperValuationPolymarketMarkets(),
          optionMatches: buildPaperValuationOptionMatches()
        });
        const valuedOrder = valuation.openOrders[0] ?? valuation.orders[0];

        if (!valuedOrder) {
          throw new Error("Unable to value the paper order before closing");
        }

        const closedOrder = closePaperOrderPayload(
          {
            ...patchedOrder,
            closeExecution: null
          },
          valuedOrder
        );
        const updatedOrder = updatePaperOrder(orderId, closedOrder);
        recordPaperOrderSnapshots([buildPaperOrderSnapshot({ ...valuedOrder, status: "closed" }, closedOrder.closedAt)]);
        const paperPortfolio = buildPaperPortfolioResponse(userId);
        invalidateStrategyResponseCache();
        syncPaperOptionStreamSubscriptions();
        schedulePaperPortfolioBroadcast(0);

        response.json({
          order: updatedOrder,
          paperPortfolio,
          message: "Order moved to closed history (manual override)."
        });
        return;
      }

      if (paperBrokerState.tws.connected !== true || paperBrokerState.tws.ready !== true) {
        const valuation = buildPaperPortfolio({
          orders: [
            {
              ...existingOrder,
              position: patchedOrder
            }
          ],
          quotes: liveState.quotes,
          polymarketMarkets: getPaperValuationPolymarketMarkets(),
          optionMatches: buildPaperValuationOptionMatches()
        });
        const valuedOrder = valuation.openOrders[0] ?? valuation.orders[0];

        if (!valuedOrder) {
          throw new Error("Unable to value the paper order before closing");
        }

        const closedOrder = closePaperOrderPayload(
          {
            ...patchedOrder,
            closeExecution: null
          },
          valuedOrder
        );
        const updatedOrder = updatePaperOrder(orderId, closedOrder);
        recordPaperOrderSnapshots([buildPaperOrderSnapshot({ ...valuedOrder, status: "closed" }, closedOrder.closedAt)]);
        const paperPortfolio = buildPaperPortfolioResponse(userId);
        invalidateStrategyResponseCache();
        syncPaperOptionStreamSubscriptions();
        schedulePaperPortfolioBroadcast(0);

        response.json({
          order: updatedOrder,
          paperPortfolio,
          message: "Order moved to closed history (TWS disconnected)."
        });
        return;
      }

      const optionLegs = (patchedOrder.legs ?? []).filter(
        (leg) =>
          leg?.kind === "option" &&
          String(leg?.status ?? "open").trim().toLowerCase() !== "closed"
      );
      const closeSideByConid = new Map();
      const closeQuantityByConid = new Map();

      optionLegs.forEach((leg) => {
        const conid = String(leg?.brokerConid ?? "").trim();
        if (!conid) {
          return;
        }

        const quantity = Math.max(Number(leg.quantity ?? 0) || 0, 0);
        if (!(quantity > 0)) {
          return;
        }

        closeSideByConid.set(
          conid,
          String(leg.action ?? "LONG").trim().toUpperCase() === "SHORT" ? "BUY" : "SELL"
        );
        closeQuantityByConid.set(conid, quantity);
      });

      if (!closeSideByConid.size) {
        throw new Error("No filled option position is available to close for this TWS-routed order.");
      }

      const since =
        patchedOrder.execution?.filledAt ||
        patchedOrder.execution?.submittedAt ||
        normalizeTimestamp(existingOrder.createdAt) ||
        new Date().toISOString();
      const executions = await twsPaperApi.fetchExecutions({
        since
      });

      const closeTrades = (executions ?? [])
        .map((item) => {
          const conid = String(item?.contract?.conId ?? item?.contract?.conid ?? "").trim();
          if (!conid || !closeSideByConid.has(conid)) {
            return null;
          }

          const rawSide = String(item?.exec?.side ?? "").trim().toUpperCase();
          const side = rawSide === "BOT" ? "BUY" : rawSide === "SLD" ? "SELL" : rawSide;
          if (side !== closeSideByConid.get(conid)) {
            return null;
          }

          return {
            conid,
            quantity: Math.abs(Number(item?.exec?.shares ?? 0) || 0),
            price: Number(item?.exec?.price ?? 0) || 0,
            execution_time: String(item?.time ?? normalizeTimestamp(item?.exec?.time ?? "") ?? "")
          };
        })
        .filter((trade) => trade && trade.conid && trade.quantity > 0);

      const tradeFillMap = buildTradeFillMap(closeTrades);
      const missingCloseFills = [];

      closeQuantityByConid.forEach((requiredQuantity, conid) => {
        const fill = tradeFillMap.get(String(conid));
        if (!fill || !(fill.quantity > 0)) {
          missingCloseFills.push(conid);
          return;
        }

        if (fill.quantity + 0.000001 < requiredQuantity) {
          missingCloseFills.push(conid);
        }
      });

      if (missingCloseFills.length) {
        throw new Error(
          `No TWS close fills found for ${missingCloseFills.length} leg(s). Close the position(s) in TWS first, then try again.`
        );
      }

      const latestTradeTimestamp = [...tradeFillMap.values()]
        .map((fill) => fill.latestAt)
        .filter(Boolean)
        .sort()
        .slice(-1)[0];
      const closedAt = latestTradeTimestamp || new Date().toISOString();

      const valuation = buildPaperPortfolio({
        orders: [
          {
            ...existingOrder,
            position: patchedOrder
          }
        ],
        quotes: liveState.quotes,
        polymarketMarkets: getPaperValuationPolymarketMarkets(),
        optionMatches: buildPaperValuationOptionMatches()
      });
      const valuedOrder = valuation.openOrders[0] ?? valuation.orders[0];

      if (!valuedOrder) {
        throw new Error("Unable to value the paper order before closing");
      }

      let closedOrder = closePaperOrderPayload(
        {
          ...patchedOrder,
          closeExecution: {
            route: "tws-paper",
            purpose: "exit",
            status: "filled",
            statusText: "Closed in TWS",
            accountId: paperBrokerState.tws.selectedAccount ?? patchedOrder.execution?.accountId ?? "",
            isPaper: paperBrokerState.tws.isPaper === true,
            orderType: "MKT",
            tif: "DAY",
            outsideRth: false,
            limitPrice: null,
            avgFillPrice: null,
            combo: patchedOrder.execution?.combo === true,
            filledAt: closedAt,
            lastSyncAt: new Date().toISOString(),
            requestedLegs:
              patchedOrder.execution?.requestedLegs && Array.isArray(patchedOrder.execution.requestedLegs)
                ? patchedOrder.execution.requestedLegs
                : buildRequestedExecutionLegs(patchedOrder)
          }
        },
        valuedOrder,
        closedAt
      );
      closedOrder = applyBrokerClosePrices(closedOrder, tradeFillMap);

      const updatedOrder = updatePaperOrder(orderId, closedOrder);
      const closedValuation = buildPaperPortfolio({
        orders: [updatedOrder],
        quotes: liveState.quotes,
        polymarketMarkets: getPaperValuationPolymarketMarkets(),
        optionMatches: buildPaperValuationOptionMatches()
      });
      const valuedClosedOrder =
        closedValuation.closedOrders[0] ?? closedValuation.orders[0] ?? closedValuation.openOrders[0] ?? null;

      if (valuedClosedOrder) {
        recordPaperOrderSnapshots([buildPaperOrderSnapshot(valuedClosedOrder, closedOrder.closedAt)]);
      }
      const paperPortfolio = buildPaperPortfolioResponse(userId);
      paperBrokerState.tws = {
        ...paperBrokerState.tws,
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null
      };
      syncStrategyCacheBrokerStatus();
      invalidateStrategyResponseCache();
      syncPaperOptionStreamSubscriptions();
      schedulePaperPortfolioBroadcast(0);

      response.json({
        order: updatedOrder,
        paperPortfolio,
        message: "TWS order moved to closed history."
      });
      return;
    }

    const valuation = buildPaperPortfolio({
      orders: [
        {
          ...existingOrder,
          position: patchedOrder
        }
      ],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const valuedOrder = valuation.openOrders[0] ?? valuation.orders[0];

    if (!valuedOrder) {
      throw new Error("Unable to value the paper order before closing");
    }

    const closedOrder = closePaperOrderPayload(patchedOrder, valuedOrder);
    const updatedOrder = updatePaperOrder(orderId, closedOrder);
    const closedValuation = buildPaperPortfolio({
      orders: [updatedOrder],
      quotes: liveState.quotes,
      polymarketMarkets: getPaperValuationPolymarketMarkets(),
      optionMatches: buildPaperValuationOptionMatches()
    });
    const valuedClosedOrder =
      closedValuation.closedOrders[0] ??
      closedValuation.orders[0] ??
      closedValuation.openOrders[0] ??
      null;

    if (valuedClosedOrder) {
      recordPaperOrderSnapshots([buildPaperOrderSnapshot(valuedClosedOrder, closedOrder.closedAt)]);
    } else {
      recordPaperOrderSnapshots([buildPaperOrderSnapshot({ ...valuedOrder, status: "closed" }, closedOrder.closedAt)]);
    }
    const paperPortfolio = buildPaperPortfolioResponse(userId);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio
    });
  } catch (error) {
    response.status(400).json({
      error: error.message
    });
  }
});

app.post("/api/paper-orders/:id/calculator-snapshots", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  const payload = request.body?.payload;

  if (!payload || typeof payload !== "object") {
    response.status(400).json({
      error: "snapshot payload is required"
    });
    return;
  }

  try {
    const snapshot = createPaperCalculatorSnapshot(
      orderId,
      String(request.body?.snapshotName ?? existingOrder.position?.combinationLabel ?? "Calculator snapshot").trim() ||
        "Calculator snapshot",
      payload
    );
    const paperPortfolio = buildPaperPortfolioResponse(userId);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.status(201).json({
      snapshot,
      paperPortfolio
    });
  } catch (error) {
    response.status(400).json({
      error: error.message
    });
  }
});

app.delete("/api/paper-orders/:id", async (request, response) => {
  const userId = request.user.id;
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders(null, userId).find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  const deleted = deletePaperOrder(orderId);

  if (!deleted) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  deletePaperOrderSnapshots(orderId);
  deletePaperCalculatorSnapshots(orderId);
  const paperPortfolio = buildPaperPortfolioResponse(userId);
  invalidateStrategyResponseCache();
  syncPaperOptionStreamSubscriptions();
  schedulePaperPortfolioBroadcast(0);

  response.json({
    deleted: true,
    paperPortfolio
  });
});

const distPath = path.join(process.cwd(), "dist");
app.use(express.static(distPath));

app.get("*", (request, response, next) => {
  if (request.path.startsWith("/api/")) {
    next();
    return;
  }

  response.sendFile(path.join(distPath, "index.html"), (error) => {
    if (error) {
      next();
    }
  });
});

app.use((error, request, response, next) => {
  logError("Unhandled request error", {
    error,
    request: buildRequestLogContext(request)
  });

  if (response.headersSent) {
    next(error);
    return;
  }

  const statusCode = Number(error?.statusCode ?? error?.status ?? 500);
  response.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
    error:
      process.env.NODE_ENV === "production" && statusCode >= 500
        ? "Internal server error"
        : error?.message ?? "Internal server error"
  });
});

function startBackgroundJobs() {
  let previousEventLoopTickMs = Date.now();
  setInterval(() => {
    const nowMs = Date.now();
    const driftMs = nowMs - previousEventLoopTickMs - EVENT_LOOP_MONITOR_INTERVAL_MS;
    previousEventLoopTickMs = nowMs;

    if (driftMs >= EVENT_LOOP_LAG_WARN_MS) {
      logWarn("Event loop lag detected", {
        subsystem: "runtime",
        driftMs: Number(driftMs.toFixed(1)),
        monitorIntervalMs: EVENT_LOOP_MONITOR_INTERVAL_MS,
        paperDesiredSymbols: paperLiveState.desiredSymbols.size,
        paperSubscribedSymbols: paperLiveState.subscribedSymbols.size,
        quoteCountSinceSeedRefresh: paperLiveState.quoteCountSinceSeedRefresh,
        broadcastTimerActive: paperLiveState.broadcastTimer != null,
        broadcastInFlight: paperLiveState.broadcastInFlight,
        lastBroadcastStartedAt: paperLiveState.lastBroadcastStartedAt,
        lastBroadcastCompletedAt: paperLiveState.lastBroadcastCompletedAt,
        cacheLastRefreshAt: paperOrderSeedCache.lastRefreshAt,
        cacheLastRefreshDurationMs: paperOrderSeedCache.lastRefreshDurationMs,
        cacheLastRefreshError: paperOrderSeedCache.lastRefreshError,
        liveOptionIndexSize: liveOptionContractIndexCache.size,
        liveOptionIndexLastBuildAt: liveOptionContractIndexCache.lastBuildAt,
        liveOptionIndexLastBuildDurationMs: liveOptionContractIndexCache.lastBuildDurationMs
      });
    }
  }, EVENT_LOOP_MONITOR_INTERVAL_MS);

  if (shouldRunBackgroundMarketRefresh()) {
    initialLiveStateReadyPromise = refreshLiveState({ includeOptions: true })
      .catch((error) => {
        logError("Initial market refresh failed", {
          subsystem: "background-market-refresh",
          error
        });
        liveState.warnings = [`Initial refresh failed: ${error.message}`];
      })
      .finally(() => {
        initialLiveStateReadyPromise = null;
      });

    setInterval(() => {
      refreshLiveState({ includeOptions: true }).catch((error) => {
        logError("Background market refresh failed", {
          subsystem: "background-market-refresh",
          error
        });
        liveState.warnings = [`Refresh failed: ${error.message}`];
      });
    }, REFERENCE_REFRESH_MS);
  }

  if (shouldRunBackgroundMacroRefresh()) {
    try {
      refreshMacroDashboard();
    } catch (error) {
      logError("Macro dashboard refresh failed", {
        subsystem: "background-macro-refresh",
        error
      });
      liveState.warnings = [...liveState.warnings, `Macro dashboard refresh failed: ${error.message}`];
    }

    setInterval(() => {
      try {
        refreshMacroDashboard();
      } catch (error) {
        logError("Scheduled macro dashboard refresh failed", {
          subsystem: "background-macro-refresh",
          error
        });
        liveState.warnings = [...liveState.warnings, `Macro dashboard refresh failed: ${error.message}`].slice(-8);
      }
    }, MACRO_DASHBOARD_CHECK_MS);
  }

  if (shouldRunBackgroundCalendarRefresh()) {
    refreshCalendarState().catch((error) => {
      logError("Calendar refresh failed", {
        subsystem: "background-calendar-refresh",
        error
      });
      liveState.calendarWarnings = [`Calendar refresh failed: ${error.message}`];
    });

    setInterval(() => {
      refreshCalendarState().catch((error) => {
        logError("Scheduled calendar refresh failed", {
          subsystem: "background-calendar-refresh",
          error
        });
        liveState.calendarWarnings = [`Calendar refresh failed: ${error.message}`];
      });
    }, CALENDAR_REFRESH_MS);
  }

  if (shouldRunBackgroundPaperHeartbeat()) {
    setInterval(() => {
      for (const clients of paperStreamClientsByUserId.values()) {
        clients.forEach((client) => {
          client.write(": heartbeat\n\n");
        });
      }

      if (paperStreamClientsByUserId.size) {
        schedulePaperPortfolioBroadcast(0);
      }
    }, PAPER_STREAM_HEARTBEAT_MS);
  }

  if (shouldRunBackgroundIbkrSync()) {
    setInterval(() => {
      refreshIbkrStatusCacheForActiveUsers().catch((error) => {
        logWarn("Active-user IBKR status refresh failed", {
          subsystem: "background-ibkr-sync",
          error
        });
        return null;
      });
      syncIbkrPaperOrders().catch((error) => {
        logWarn("Background IBKR paper-order sync failed", {
          subsystem: "background-ibkr-sync",
          error
        });
        return null;
      });
    }, IBKR_SYNC_INTERVAL_MS);
  }

  if (shouldRunBackgroundTwsSync()) {
    setInterval(() => {
      if (paperBrokerState.tws.connected !== true) {
        return;
      }

      twsPaperApi
        .requestAllOpenOrders()
        .then(() => {
          paperBrokerState.tws = {
            ...paperBrokerState.tws,
            lastSyncAt: new Date().toISOString(),
            lastSyncError: null
          };
          syncStrategyCacheBrokerStatus();
          schedulePaperPortfolioBroadcast(0);
        })
        .catch((error) => {
          paperBrokerState.tws = {
            ...paperBrokerState.tws,
            lastSyncAt: new Date().toISOString(),
            lastSyncError: error.message
          };
          syncStrategyCacheBrokerStatus();
          schedulePaperPortfolioBroadcast(0);
        });
    }, TWS_SYNC_INTERVAL_MS);
  }
}

app.listen(port, host, () => {
  logInfo("HedgeHub server started", {
    host,
    port,
    nodeEnv: process.env.NODE_ENV || "development"
  });
  if (
    shouldStartBackgroundJobs() ||
    shouldRunBackgroundMarketRefresh() ||
    shouldRunBackgroundMacroRefresh() ||
    shouldRunBackgroundCalendarRefresh() ||
    shouldRunBackgroundPaperHeartbeat() ||
    shouldRunBackgroundIbkrSync() ||
    shouldRunBackgroundTwsSync()
  ) {
    setTimeout(() => {
      startBackgroundJobs();
    }, 250);
  } else {
    logInfo("HedgeHub background jobs are disabled", {
      hint:
        "Enable specific jobs with HEDGEHUB_BACKGROUND_* flags or set HEDGEHUB_BACKGROUND_JOBS=true."
    });
  }
});
