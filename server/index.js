import { createResearchStore } from "./researchStore.js";
import { registerBuilderRoutes } from "./builder/service.js";
import { createResearchService, registerResearchRoutes } from "./researchService.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
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
  createUser,
  createPaperCalculatorSnapshot,
  createPaperOrder,
  deleteSetupWatchlistItem,
  deletePaperCalculatorSnapshots,
  deletePaperOrderSnapshots,
  deletePaperOrder,
  getLatestMacroDashboardSnapshot,
  listPaperCalculatorSnapshots,
  listDeltaHedgeScannerSymbols,
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
  saveStrategyRun,
  upsertSetupWatchlistItem,
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
import { fetchOptionChain, fetchQuotes } from "./providers/marketData.js";
import {
  blackScholesCall,
  blackScholesPut,
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
const PAPER_STREAM_HEARTBEAT_MS = Math.max(
  Number(process.env.PAPER_STREAM_HEARTBEAT_MS ?? 10000) || 10000,
  5000
);
const PAPER_STREAM_BROADCAST_DEBOUNCE_MS = 750;
const PAPER_ORDER_SNAPSHOT_INTERVAL_MS = 60 * 1000;

app.use(cors());
app.use(express.json());
app.set("trust proxy", 1);
initializeDashboardLayoutsDirectory();

registerAuthRoutes(app);

app.use((request, response, next) => {
  if (!request.path.startsWith("/api/")) {
    next();
    return;
  }

  if (request.path === "/api/health" || request.path.startsWith("/api/auth/")) {
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

const researchStore = createResearchStore();
const researchService = createResearchService(researchStore);
registerResearchRoutes(app, researchStore, researchService);
registerBuilderRoutes(app, { researchService });
const researchTimer = setInterval(() => { researchService.tick().catch(() => {}); }, 15 * 60_000);
researchTimer.unref();

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
  broadcastTimer: null,
  lastSnapshotAt: 0
};
const livePaperOptionQuotes = new Map();

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
    summary: portfolio.summary ?? null
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
    closedOrders
  };
}

function buildPaperPortfolioResponseSafe(userId = null) {
  try {
    return buildPaperPortfolioResponse(userId);
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


async function ensureInitialLiveStateReady() {
  if (!initialLiveStateReadyPromise) {
    return;
  }

  await initialLiveStateReadyPromise;
}

function formatDiagnosticTimestamp(value) {
  return value ? normalizeTimestamp(value) || null : null;
}

function buildStreamDiagnosticsResponse() {
  return {
    generatedAt: new Date().toISOString(),
    polymarket: {
      mode: "polling",
      refreshEverySeconds: Math.round(REFERENCE_REFRESH_MS / 1000),
      lastRefreshAt: formatDiagnosticTimestamp(liveState.lastUpdated)
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

  try {
    const lastUpdated = new Date().toISOString();

    for (const [userId, clients] of paperStreamClientsByUserId.entries()) {
      if (!clients?.size) {
        continue;
      }

      let paperPortfolio = null;
      try {
        paperPortfolio = buildPaperPortfolioResponse(userId);
      } catch (error) {
        console.warn(`[paper] Broadcast build failed for user ${userId}: ${error.message}`);
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

function syncPaperOptionStreamSubscriptions() {
  const desiredSymbols = new Set(getDesiredPaperOptionSymbols());

  livePaperOptionQuotes.forEach((_quote, contractSymbol) => {
    if (!desiredSymbols.has(contractSymbol)) {
      livePaperOptionQuotes.delete(contractSymbol);
    }
  });
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

  if (economicResult.status === "fulfilled" && companyEventsResult.status === "fulfilled") {
    liveState.calendarsRefreshedAt = new Date().toISOString();
  }
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

let liveRefreshPromise = null;
function refreshLiveState(options = {}) {
  if (liveRefreshPromise) return liveRefreshPromise;
  liveRefreshPromise = refreshLiveStateOnce(options).finally(() => { liveRefreshPromise = null; });
  return liveRefreshPromise;
}
async function refreshLiveStateOnce({ includeOptions = true } = {}) {
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
  liveState.lastAttempt = new Date().toISOString();
  if (!warnings.length) liveState.lastUpdated = liveState.lastAttempt;
  liveState.warnings = warnings;
  syncPaperOptionStreamSubscriptions();

  try {
    recordPaperPortfolioSnapshotsIfDue(liveState.lastAttempt, true);
  } catch (error) {
    warnings.push(`Paper-trade history unavailable: ${error.message}`);
    liveState.warnings = warnings;
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
    research: { provider: researchService.status().provider, running: researchService.status().running },
    macroDashboardRefreshedAt: liveState.macroDashboard?.refreshedAt ?? null,
    calendarsRefreshedAt: liveState.calendarsRefreshedAt,
    warnings: [...liveState.warnings, ...liveState.calendarWarnings],
    streamDiagnostics: buildStreamDiagnosticsResponse()
  });
});

app.get("/api/stream-status", (request, response) => {
  response.json(buildStreamDiagnosticsResponse(request.user.id));
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

    response.json(payload);
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
      companyEvents: liveState.companyEvents?.events ?? [],
      earningsCoverageBySymbol: await researchService.earningsCoverage((request.body?.symbols ?? []).filter(s => typeof s === "string").map(s => s.toUpperCase()).slice(0, 20))
    });

    response.json(payload);
  } catch (error) {
    response.status(502).json({
      error: error.message
    });
  }
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
    let createdOrder = createPaperOrder({ ...order, userId });
    let createMessage = "Paper order saved.";
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
    const nextOrder = applyPaperOrderPatch(existingOrder.position, request.body);
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
      message: allLegsClosed ? "Leg closed. Order moved to history." : "Leg closed."
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
      message: "Leg revived."
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
  for (const clients of paperStreamClientsByUserId.values()) {
    clients.forEach((client) => {
      client.write(": heartbeat\n\n");
    });
  }

  if (paperStreamClientsByUserId.size) {
    schedulePaperPortfolioBroadcast(0);
  }
}, PAPER_STREAM_HEARTBEAT_MS);
app.listen(port, () => {
  console.log(`HedgeHub listening on http://localhost:${port}`);
});
