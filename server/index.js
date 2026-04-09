import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import {
  calendarWidgets,
  defaultStrategyConfig,
  fallbackPolymarketMarkets,
  marketSections
} from "./marketCatalog.js";
import { buildMacroDashboardPayload, buildMacroHeroStats } from "./macroDashboard.js";
import {
  createPaperCalculatorSnapshot,
  createPaperOrder,
  deletePaperCalculatorSnapshots,
  deletePaperOrderSnapshots,
  deletePaperOrder,
  getLatestMacroDashboardSnapshot,
  listPaperCalculatorSnapshots,
  listDeltaHedgeScannerSymbols,
  getLatestSnapshots,
  listPaperOrderSnapshots,
  listPaperOrders,
  listStrategyAssetMappings,
  getRecentRuns,
  getStrategies,
  recordMarketSnapshots,
  recordPaperOrderSnapshots,
  saveMacroDashboardSnapshot,
  saveStrategyRun,
  upsertDeltaHedgeScannerSymbol,
  upsertStrategyAssetMapping,
  deleteDeltaHedgeScannerSymbol,
  deleteStrategyAssetMapping,
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
import { fetchOptionChain, fetchQuotes } from "./providers/yahooFinance.js";
import {
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
import { buildVolCrushEarningsScan } from "./earningsVolCrush.js";
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

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(process.cwd(), ".env.local"));
loadEnvFile(path.join(process.cwd(), ".env"));

const app = express();
const port = Number(process.env.PORT || 8787);
const MACRO_DASHBOARD_REFRESH_MS = 24 * 60 * 60 * 1000;
const MACRO_DASHBOARD_CHECK_MS = 60 * 60 * 1000;
const MACRO_DASHBOARD_SCHEMA_VERSION = 3;
const CALENDAR_REFRESH_MS = 60 * 60 * 1000;
const CALENDAR_WINDOW_DAYS = 30;
const REFERENCE_REFRESH_MS = 5 * 60 * 1000;
const ALWAYS_TRACKED_OPTION_CONTRACTS_PER_SIDE = 6;
const PAPER_STREAM_HEARTBEAT_MS = 20 * 1000;
const PAPER_STREAM_BROADCAST_DEBOUNCE_MS = 750;
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

app.use(cors());
app.use(express.json());
initializeDashboardLayoutsDirectory();

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
const paperStreamClients = new Set();
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
  lastError: null
};
const paperBrokerState = {
  ibkr: {
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
  },
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
  },
  syncTimer: null,
  syncing: false,
  lastSyncAt: null,
  lastSyncError: null
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
              quantity: 0,
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
              quantity: 0,
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

function getOpenPaperOrders() {
  return listPaperOrders().filter(
    (order) => String(order.position?.status ?? "open").toLowerCase() !== "closed"
  );
}

function getOpenPaperOptionContractSeeds() {
  const seeds = new Map();

  getOpenPaperOrders().forEach((order) => {
    const proxySymbol = String(order.position?.marketContext?.proxySymbol ?? "").trim();

    (order.position?.legs ?? []).forEach((leg) => {
      if (leg?.kind !== "option") {
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

function getDesiredPaperOptionSymbols() {
  const desiredSymbols = new Set();

  getAlwaysTrackedOptionContractSeeds().forEach((contract, contractSymbol) => {
    if (contract?.isLive === true && contractSymbol) {
      desiredSymbols.add(contractSymbol);
    }
  });

  getOpenPaperOptionContractSeeds().forEach((contract, contractSymbol) => {
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
  const orderSeeds = getOpenPaperOptionContractSeeds();

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

function buildValuedPaperPortfolio() {
  return buildPaperPortfolio({
    orders: listPaperOrders(),
    quotes: liveState.quotes,
    polymarketMarkets: getPaperValuationPolymarketMarkets(),
    optionMatches: buildPaperValuationOptionMatches()
  });
}

function buildPaperPortfolioPreviewResponse() {
  const portfolio = buildValuedPaperPortfolio();

  return {
    summary: portfolio.summary ?? null,
    brokerStatus: {
      ibkr: paperBrokerState.ibkr,
      tws: paperBrokerState.tws
    }
  };
}

function buildPaperPortfolioResponse() {
  const portfolio = buildValuedPaperPortfolio();

  const withHistory = attachPaperOrderHistory(
    portfolio,
    listPaperOrderSnapshots(),
    liveState.lastUpdated ?? new Date().toISOString()
  );
  const calculatorSnapshotsByOrderId = new Map();

  for (const snapshot of listPaperCalculatorSnapshots()) {
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
      ibkr: paperBrokerState.ibkr,
      tws: paperBrokerState.tws
    }
  };
}

function buildPaperPortfolioResponseSafe() {
  try {
    return buildPaperPortfolioResponse();
  } catch (error) {
    console.warn(`[paper] Failed to build paper portfolio response: ${error.message}`);
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
  if (!strategyResponseCache.response?.paperPortfolioPreview) {
    return;
  }

  strategyResponseCache.response = {
    ...strategyResponseCache.response,
    paperPortfolioPreview: {
      ...strategyResponseCache.response.paperPortfolioPreview,
      brokerStatus: {
        ...(strategyResponseCache.response.paperPortfolioPreview.brokerStatus ?? {}),
        ibkr: paperBrokerState.ibkr,
        tws: paperBrokerState.tws
      }
    }
  };
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

async function refreshIbkrStatusCache() {
  const previousComparableStatus = JSON.stringify(buildComparableIbkrStatus(paperBrokerState.ibkr));
  const ibkrStatus = await getIbkrStatus();
  paperBrokerState.ibkr = {
    ...ibkrStatus,
    updatedAt: new Date().toISOString()
  };
  syncStrategyCacheBrokerStatus();
  const nextComparableStatus = JSON.stringify(buildComparableIbkrStatus(paperBrokerState.ibkr));
  if (previousComparableStatus !== nextComparableStatus) {
    schedulePaperPortfolioBroadcast(0);
  }
  return paperBrokerState.ibkr;
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

function applyEntryExecutionToOrder(order, execution, trades = []) {
  if (!execution) {
    return order;
  }

  const fillMap = buildTradeFillMap(trades);

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
          execution.filledQuantity != null
            ? Math.max(
                Math.round((Number(requestedLeg.ratio ?? 1) || 1) * Number(execution.filledQuantity ?? 0)),
                0
              )
            : Number(leg.quantity ?? 0) || 0;
        const fill = fillMap.get(String(requestedLeg.brokerConid ?? leg.brokerConid ?? "").trim()) ?? null;

        return {
          ...leg,
          quantity: fillQuantity,
          entryPrice: fill?.avgPrice != null ? fill.avgPrice : leg.entryPrice,
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

async function maybeManageSmartEntryExecution(record, order) {
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
        });

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
    });

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

async function findLiveOrderForExecution(execution, orderBook) {
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
      });
    } catch (_error) {
      return null;
    }
  }

  return null;
}

async function syncSingleBrokerOrder(record, orderBook) {
  const existingOrder = record.position;
  let nextOrder = existingOrder;
  let changed = false;

  if (isIbkrPaperRoute(existingOrder)) {
    const entryLiveOrder = await findLiveOrderForExecution(existingOrder.execution, orderBook);
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
      entryTrades
    );

    if (JSON.stringify(nextEntryOrder) !== JSON.stringify(nextOrder)) {
      nextOrder = nextEntryOrder;
      changed = true;
    }

    const smartManagedOrder = await maybeManageSmartEntryExecution(record, nextOrder);
    if (smartManagedOrder && JSON.stringify(smartManagedOrder) !== JSON.stringify(nextOrder)) {
      nextOrder = smartManagedOrder;
      changed = true;
    }
  }

  if (String(nextOrder?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper") {
    const exitLiveOrder = await findLiveOrderForExecution(nextOrder.closeExecution, orderBook);
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

async function syncIbkrPaperOrders({ onlyOrderId = null } = {}) {
  if (paperBrokerState.syncing) {
    return false;
  }

  const orderRecords = listPaperOrders().filter((record) => {
    const order = record.position;
    if (!isBrokerTrackedOrder(order)) {
      return false;
    }

    if (onlyOrderId != null && Number(record.id) !== Number(onlyOrderId)) {
      return false;
    }

    return String(order.status ?? "open").toLowerCase() !== "closed" || order.closeExecution;
  });

  if (!orderRecords.length) {
    return false;
  }

  paperBrokerState.syncing = true;

  try {
    const orderBook = await fetchIbkrOrderBook({
      accountId: String(orderRecords[0]?.position?.execution?.accountId ?? "").trim()
    });
    const liveOrders = (orderBook.orders ?? []).map(normalizeIbkrLiveOrder);
    const orderBookIndexes = {
      ...orderBook,
      liveOrdersById: new Map(liveOrders.map((order) => [String(order.brokerOrderId), order])),
      liveOrdersByRef: new Map(liveOrders.map((order) => [String(order.orderRef), order])),
      tradesByOrderRef: groupTradesByOrderRef(orderBook.trades)
    };

    let changed = false;

    for (const record of orderRecords) {
      const nextOrder = await syncSingleBrokerOrder(record, orderBookIndexes);
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
            nextOrder.closedAt || nextOrder.closeExecution?.filledAt || nextOrder.execution?.lastSyncAt || new Date().toISOString()
          )
        ]);
      }
      changed = true;
    }

    paperBrokerState.lastSyncAt = new Date().toISOString();
    paperBrokerState.lastSyncError = null;
    await refreshIbkrStatusCache();

    if (changed) {
      invalidateStrategyResponseCache();
      syncPaperOptionStreamSubscriptions();
      schedulePaperPortfolioBroadcast(0);
    }

    return changed;
  } catch (error) {
    paperBrokerState.lastSyncError = error.message;
    await refreshIbkrStatusCache().catch(() => null);
    return false;
  } finally {
    paperBrokerState.syncing = false;
  }
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

function buildStreamDiagnosticsResponse() {
  const baselineTrackedContracts = getAlwaysTrackedOptionContractSeeds().size;
  const paperTrackedContracts = [...getOpenPaperOptionContractSeeds().values()].filter(
    (contract) => contract.isLive === true && contract.contractSymbol
  ).length;

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
    ibkr: {
      provider: "IBKR Client Portal",
      configured: paperBrokerState.ibkr.configured === true,
      connected: paperBrokerState.ibkr.connected === true,
      authenticated: paperBrokerState.ibkr.authenticated === true,
      isPaper: paperBrokerState.ibkr.isPaper === true,
      selectedAccount: paperBrokerState.ibkr.selectedAccount ?? "",
      lastUpdated: formatDiagnosticTimestamp(paperBrokerState.ibkr.updatedAt),
      lastSyncAt: formatDiagnosticTimestamp(paperBrokerState.lastSyncAt),
      lastSyncError: paperBrokerState.lastSyncError ?? null,
      error: paperBrokerState.ibkr.error ?? null
    },
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
  if (!paperStreamClients.size) {
    return;
  }

  try {
    const payload = {
      type: "paper-portfolio",
      lastUpdated: new Date().toISOString(),
      paperPortfolio: buildPaperPortfolioResponse()
    };

    paperStreamClients.forEach((client) => {
      writeSseJson(client, payload);
    });
  } catch (error) {
    console.error("Unable to broadcast paper portfolio:", error.message);
  }
}

function schedulePaperPortfolioBroadcast(delayMs = PAPER_STREAM_BROADCAST_DEBOUNCE_MS) {
  if (paperLiveState.broadcastTimer) {
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
  const contractSeed =
    buildPaperValuationOptionMatches().find((contract) => contract.contractSymbol === contractSymbol) ??
    getOpenPaperOptionContractSeeds().get(contractSymbol) ??
    { contractSymbol };

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

  try {
    recordPaperPortfolioSnapshotsIfDue(
      Number.isFinite(Number(message.t)) && Number(message.t) > 0
        ? new Date(Number(message.t)).toISOString()
        : new Date().toISOString()
    );
  } catch (error) {
    liveState.warnings = [...liveState.warnings, `Paper-trade history unavailable: ${error.message}`].slice(-8);
  }

  schedulePaperPortfolioBroadcast();
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
    console.error("Unable to parse Massive options websocket payload:", error.message);
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
    console.error("Massive options websocket error:", error?.message ?? "Unknown error");
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
  const uso = quoteMap.get("USO");
  const spx = quoteMap.get("SPX");
  const spy = quoteMap.get("SPY");
  const spxIndexPrice = Number(
    spx?.regularMarketPrice ??
      (spy?.regularMarketPrice != null ? Number((spy.regularMarketPrice / 0.1).toFixed(2)) : 0)
  );

  return [
    ...quotes,
    glD
      ? {
          ...glD,
          symbol: "XAU-USD",
          shortName: "Gold spot proxy",
          regularMarketPrice: Number((glD.regularMarketPrice / 0.1).toFixed(2))
        }
      : null,
    uso
      ? {
          ...uso,
          symbol: "WTI-USD",
          shortName: "WTI proxy",
          regularMarketPrice: Number(uso.regularMarketPrice.toFixed(2))
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
        ...listPaperOrders().map((order) => order.position?.polymarketUrl ?? "")
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
          const targetUnderlyings = assetMarkets
            .map((market) => parseTargetFromQuestion(market.question))
            .filter((value) => Number.isFinite(value) && value > 0);
          const targetUnderlying =
            targetUnderlyings[0] ||
            parseTargetFromQuestion(leadMarket?.question ?? "") ||
            underlyingSpot ||
            optionSpot;
          const ratio =
            underlyingSpot > 0 && optionSpot > 0 ? optionSpot / underlyingSpot : Number(asset.conversionFallback ?? 1) || 1;
          const targetStrikes = (targetUnderlyings.length ? targetUnderlyings : [targetUnderlying]).map((value) =>
            Math.max(Math.round(value * ratio), 1)
          );
          const targetStrike =
            asset.optionSymbol === defaultStrategyConfig.optionLeg.symbol
              ? defaultStrategyConfig.optionLeg.strike
              : Math.max(Math.round(targetUnderlying * ratio), 1);
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

  try {
    recordPaperPortfolioSnapshotsIfDue(liveState.lastUpdated, true);
  } catch (error) {
    warnings.push(`Paper-trade history unavailable: ${error.message}`);
    liveState.warnings = warnings;
  }

  schedulePaperPortfolioBroadcast(0);
  invalidateStrategyResponseCache();
}

async function buildStrategiesResponse() {
  if (strategyResponseCache.response) {
    return strategyResponseCache.response;
  }

  if (strategyResponseCache.buildPromise) {
    return strategyResponseCache.buildPromise;
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
      recentRuns: getRecentRuns(),
      primaryStrategy: buildSlimPrimaryStrategy(strategySummary),
      v2Screener,
      paperPortfolioPreview: buildPaperPortfolioPreviewResponse(),
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

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    lastUpdated: liveState.lastUpdated,
    macroDashboardRefreshedAt: liveState.macroDashboard?.refreshedAt ?? null,
    calendarsRefreshedAt: liveState.calendarsRefreshedAt,
    warnings: [...liveState.warnings, ...liveState.calendarWarnings],
    streamDiagnostics: buildStreamDiagnosticsResponse()
  });
});

app.get("/api/stream-status", (_request, response) => {
  response.json(buildStreamDiagnosticsResponse());
});

app.get("/api/market-status", async (_request, response) => {
  response.json(await getPolygonMarketStatusPayload());
});

app.get("/api/brokers/ibkr/status", async (_request, response) => {
  if (!paperBrokerState.ibkr.updatedAt) {
    await refreshIbkrStatusCache().catch(() => null);
  } else {
    refreshIbkrStatusCache().catch(() => null);
  }

  response.json({
    ibkr: paperBrokerState.ibkr
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

app.get("/api/dashboard", async (_request, response) => {
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
    streamDiagnostics: buildStreamDiagnosticsResponse(),
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
      strategyPayload: await buildStrategiesResponse()
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
    strategyPayload: await buildStrategiesResponse()
  });
});

app.get("/api/strategies", async (_request, response) => {
  await ensureInitialLiveStateReady();
  response.json(await buildStrategiesResponse());
});

app.get("/api/strategies/finder/:rowId", async (request, response) => {
  await ensureInitialLiveStateReady();
  await buildStrategiesResponse();
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

app.get("/api/paper-portfolio", async (_request, response) => {
  await ensureInitialLiveStateReady();
  response.json({
    lastUpdated: liveState.lastUpdated,
    paperPortfolio: buildPaperPortfolioResponse()
  });
});

app.post("/api/tradingview/strategy-finder", async (request, response) => {
  try {
    const payload = await scanTradingViewStrategyFinder(request.body ?? {});

    response.json(payload);
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
});

app.get("/api/paper-orders/stream", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();
  response.write("retry: 5000\n\n");

  paperStreamClients.add(response);
  writeSseJson(response, {
    type: "paper-portfolio",
    lastUpdated: new Date().toISOString(),
    paperPortfolio: buildPaperPortfolioResponse()
  });

  request.on("close", () => {
    paperStreamClients.delete(response);
    response.end();
  });
});

app.get("/api/options/chain", async (request, response) => {
  const symbol = String(request.query.symbol ?? "").trim().toUpperCase();
  const expiration = String(request.query.expiration ?? "").trim();
  const optionType = String(request.query.optionType ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
  const strikeHint = Number(request.query.strikeHint ?? 0);
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

  try {
    const payload = await buildStockDeltaHedgeScan({
      fetchQuotes,
      fetchOptionChain,
      stockUniverse: getDeltaHedgeScannerUniverse(),
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 25
    });

    response.json(payload);
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

app.post("/api/strategies/strategy-1/runs", async (_request, response) => {
  const optionMatches = buildLiveOptionMatches();
  const { finderAssets } = getStrategyAssetContext();
  const strategySummary = await buildStrategySummary({
    quotes: liveState.quotes,
    polymarketMarkets: liveState.polymarketMarkets,
    optionMatches,
    assetUniverse: finderAssets
  });

  saveStrategyRun("strategy-1", strategySummary);

  response.status(201).json({
    saved: true,
    createdAt: new Date().toISOString()
  });
});

app.post("/api/paper-orders", async (request, response) => {
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
    let createdOrder = createPaperOrder(persistedOrder);
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
        });

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

    const paperPortfolio = buildPaperPortfolioResponse();
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
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders().find((order) => Number(order.id) === orderId);
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
        });

        nextOrder = sanitizePaperOrderPayload(
          {
            ...preparedOrder,
            execution: submission
          },
          preparedOrder
        );
        message = buildIbkrSubmissionMessage(submission, "entry");
      } else {
        const optionQuantity = (existingOrder.position.legs ?? [])
          .filter((leg) => leg?.kind === "option")
          .reduce((sum, leg) => sum + Math.max(Number(leg.quantity ?? 0) || 0, 0), 0);

        if (!(optionQuantity > 0)) {
          throw new Error("No filled option position is available to close through IBKR");
        }

        const submission = await submitIbkrOptionOrder({
          order: {
            ...existingOrder.position,
            id: orderId
          },
          purpose: "exit"
        });

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
    }

    const updatedOrder = updatePaperOrder(orderId, nextOrder);
    if (isIbkrRoute) {
      await refreshIbkrStatusCache().catch(() => null);
    }
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio: buildPaperPortfolioResponse(),
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
      paperPortfolio: buildPaperPortfolioResponseSafe()
    });
  }
});

app.post("/api/paper-orders/:id/confirm-execution", async (request, response) => {
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders().find((order) => Number(order.id) === orderId);
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
      paperPortfolio: buildPaperPortfolioResponse(),
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
    });
    const updatedOrder = updatePaperOrder(
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
    await refreshIbkrStatusCache().catch(() => null);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    const message =
      request.body.confirmed === true
        ? buildIbkrSubmissionMessage(nextExecution, pendingExecution.purpose)
        : pendingExecution.purpose === "exit"
          ? "IBKR exit confirmation declined. Broker order was not submitted."
          : "IBKR confirmation declined. Broker order was not submitted.";

    response.json({
      order: updatedOrder,
      paperPortfolio: buildPaperPortfolioResponse(),
      message
    });
  } catch (error) {
    response.status(502).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe()
    });
  }
});

app.post("/api/paper-orders/:id/sync-execution", async (request, response) => {
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders().find((order) => Number(order.id) === orderId);
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

    response.json({
      order: listPaperOrders().find((order) => Number(order.id) === orderId) ?? existingOrder,
      paperPortfolio: buildPaperPortfolioResponse(),
      message: "TWS order state synced."
    });
    return;
  }

  await tickleIbkrSession().catch(() => null);
  await syncIbkrPaperOrders({
    onlyOrderId: orderId
  });

  response.json({
    order: listPaperOrders().find((order) => Number(order.id) === orderId) ?? existingOrder,
    paperPortfolio: buildPaperPortfolioResponse(),
    message: "IBKR order state synced."
  });
});

app.post("/api/paper-orders/:id/cancel-execution", async (request, response) => {
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders().find((order) => Number(order.id) === orderId);
  if (!existingOrder) {
    response.status(404).json({
      error: "paper order not found"
    });
    return;
  }

  if (isTwsPaperRoute(existingOrder.position) || isTwsPaperExecution(existingOrder.position?.closeExecution)) {
    response.status(400).json({
      error: "Cancel/update TWS orders manually inside TWS. HedgeHub only tracks status.",
      paperPortfolio: buildPaperPortfolioResponseSafe()
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
    });

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
      onlyOrderId: orderId
    });

    response.json({
      order: listPaperOrders().find((order) => Number(order.id) === orderId) ?? updatedOrder,
      paperPortfolio: buildPaperPortfolioResponse(),
      message: "Cancel request sent to IBKR."
    });
  } catch (error) {
    response.status(502).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponseSafe()
    });
  }
});

app.patch("/api/paper-orders/:id", async (request, response) => {
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders().find((order) => Number(order.id) === orderId);
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

    const paperPortfolio = buildPaperPortfolioResponse();
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

app.post("/api/paper-orders/:id/close", async (request, response) => {
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders().find((order) => Number(order.id) === orderId);
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
      const optionQuantity = (patchedOrder.legs ?? [])
        .filter((leg) => leg?.kind === "option")
        .reduce((sum, leg) => sum + Math.max(Number(leg.quantity ?? 0) || 0, 0), 0);

      if (!(optionQuantity > 0)) {
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
        const paperPortfolio = buildPaperPortfolioResponse();
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
      });
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
      await refreshIbkrStatusCache().catch(() => null);
      invalidateStrategyResponseCache();
      syncPaperOptionStreamSubscriptions();
      schedulePaperPortfolioBroadcast(0);

      response.json({
        order: updatedOrder,
        paperPortfolio: buildPaperPortfolioResponse(),
        message: buildIbkrSubmissionMessage(submission, "exit")
      });
      return;
    }

    if (isTwsPaperRoute(patchedOrder)) {
      const entryStatus = String(patchedOrder.execution?.status ?? "").trim().toLowerCase();

      if (entryStatus !== "filled") {
        throw new Error("TWS entry order is not filled yet. Wait for the fill before moving it to closed history.");
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
        const paperPortfolio = buildPaperPortfolioResponse();
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

      const optionLegs = (patchedOrder.legs ?? []).filter((leg) => leg?.kind === "option");
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
      const paperPortfolio = buildPaperPortfolioResponse();
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
    recordPaperOrderSnapshots([
      buildPaperOrderSnapshot(
        {
          ...valuedOrder,
          status: "closed"
        },
        closedOrder.closedAt
      )
    ]);
    const paperPortfolio = buildPaperPortfolioResponse();
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
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
    });
    return;
  }

  const existingOrder = listPaperOrders().find((order) => Number(order.id) === orderId);
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
    const paperPortfolio = buildPaperPortfolioResponse();
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
  const orderId = Number(request.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    response.status(400).json({
      error: "paper order id must be a positive integer"
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
  const paperPortfolio = buildPaperPortfolioResponse();
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

initialLiveStateReadyPromise = refreshLiveState({ includeOptions: true })
  .catch((error) => {
    liveState.warnings = [`Initial refresh failed: ${error.message}`];
  })
  .finally(() => {
    initialLiveStateReadyPromise = null;
  });
try {
  refreshMacroDashboard();
} catch (error) {
  liveState.warnings = [...liveState.warnings, `Macro dashboard refresh failed: ${error.message}`];
}
refreshCalendarState().catch((error) => {
  liveState.calendarWarnings = [`Calendar refresh failed: ${error.message}`];
});
refreshIbkrStatusCache().catch((error) => {
  paperBrokerState.ibkr = {
    ...paperBrokerState.ibkr,
    configured: true,
    error: error.message,
    updatedAt: new Date().toISOString()
  };
});
setInterval(() => {
  refreshLiveState({ includeOptions: true }).catch((error) => {
    liveState.warnings = [`Refresh failed: ${error.message}`];
  });
}, REFERENCE_REFRESH_MS);
setInterval(() => {
  try {
    refreshMacroDashboard();
  } catch (error) {
    liveState.warnings = [...liveState.warnings, `Macro dashboard refresh failed: ${error.message}`].slice(-8);
  }
}, MACRO_DASHBOARD_CHECK_MS);
setInterval(() => {
  refreshCalendarState().catch((error) => {
    liveState.calendarWarnings = [`Calendar refresh failed: ${error.message}`];
  });
}, CALENDAR_REFRESH_MS);
setInterval(() => {
  paperStreamClients.forEach((client) => {
    client.write(": heartbeat\n\n");
  });
}, PAPER_STREAM_HEARTBEAT_MS);
setInterval(() => {
  refreshIbkrStatusCache().catch(() => null);
  syncIbkrPaperOrders().catch(() => null);
}, IBKR_SYNC_INTERVAL_MS);
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

app.listen(port, () => {
  console.log(`HedgeHub listening on http://localhost:${port}`);
});
