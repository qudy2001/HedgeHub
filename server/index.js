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
  upsertStrategyAssetMapping,
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
import { fetchOptionChain, fetchQuotes } from "./providers/yahooFinance.js";
import {
  buildStrategySummary,
  getResolvedStrategyMarketsForAsset,
  parseTargetFromQuestion
} from "./strategyEngine.js";
import { buildStrategyScreenerV2 } from "./strategyScreenerV2.js";
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
const MASSIVE_OPTIONS_WS_URL = process.env.POLYGON_WS_URL || "wss://socket.massive.com/options";

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
  syncTimer: null,
  syncing: false,
  lastSyncAt: null,
  lastSyncError: null
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

function isIbkrPaperRoute(order) {
  return String(order?.execution?.route ?? "").trim().toLowerCase() === "ibkr-paper";
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

  return {
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
    lastError: String(overrides.lastError ?? order?.execution?.lastError ?? ""),
    lastWarning: String(overrides.lastWarning ?? order?.execution?.lastWarning ?? "")
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
      ibkr: paperBrokerState.ibkr
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
      ibkr: paperBrokerState.ibkr
    }
  };
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
        ibkr: paperBrokerState.ibkr
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

async function ensureInitialLiveStateReady() {
  if (!initialLiveStateReadyPromise) {
    return;
  }

  await initialLiveStateReadyPromise;
}

function isBrokerTrackedOrder(order) {
  return isIbkrPaperRoute(order) || String(order?.closeExecution?.route ?? "").trim().toLowerCase() === "ibkr-paper";
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
  const status = normalizedLiveOrder?.status ?? String(existingExecution.status ?? "submitted");
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
    status,
    statusText: normalizedLiveOrder?.statusText ?? existingExecution.statusText,
    statusDescription: normalizedLiveOrder?.statusDescription ?? existingExecution.statusDescription ?? "",
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
      isIbkrFilledStatus(status)
        ? existingExecution.filledAt || normalizedLiveOrder?.lastExecutionAt || latestTradeTimestamp || new Date().toISOString()
        : existingExecution.filledAt,
    cancelledAt:
      status === "cancelled"
        ? existingExecution.cancelledAt || normalizedLiveOrder?.lastExecutionAt || latestTradeTimestamp || new Date().toISOString()
        : existingExecution.cancelledAt,
    lastSyncAt: new Date().toISOString(),
    lastError:
      status === "rejected" || status === "error"
        ? normalizedLiveOrder?.statusDescription || existingExecution.lastError
        : existingExecution.lastError,
    lastWarning: existingExecution.lastWarning || ""
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
    if (isIbkrPaperRoute(order) && !hasOptionLegs(order)) {
      throw new Error("IBKR paper routing requires at least one option leg");
    }

    const persistedOrder = isIbkrPaperRoute(order) ? prepareOrderForIbkrEntry(order) : order;
    let createdOrder = createPaperOrder(persistedOrder);
    let createMessage = isIbkrPaperRoute(order)
      ? "IBKR paper order saved locally and is waiting for broker submission."
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
        createMessage = submission.lastWarning
          ? `IBKR paper order submitted with warnings: ${submission.lastWarning}`
          : "IBKR paper order submitted.";
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

  try {
    if (!isIbkrPaperRoute(existingOrder.position)) {
      throw new Error("This order is not configured for IBKR paper routing");
    }

    let nextOrder = existingOrder.position;
    let message = "";

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
      message = submission.lastWarning
        ? `IBKR paper order submitted with warnings: ${submission.lastWarning}`
        : "IBKR paper order submitted.";
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
      message = submission.lastWarning
        ? `IBKR paper exit order submitted with warnings: ${submission.lastWarning}`
        : "IBKR paper exit order submitted.";
    }

    const updatedOrder = updatePaperOrder(orderId, nextOrder);
    await refreshIbkrStatusCache().catch(() => null);
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.json({
      order: updatedOrder,
      paperPortfolio: buildPaperPortfolioResponse(),
      message
    });
  } catch (error) {
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
    invalidateStrategyResponseCache();
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.status(502).json({
      error: error.message,
      paperPortfolio: buildPaperPortfolioResponse()
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

  const activeExecution =
    isIbkrPaperRoute(existingOrder.position) &&
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
      paperPortfolio: buildPaperPortfolioResponse()
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
        throw new Error("No filled option position is available to close through IBKR");
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
        message: submission.lastWarning
          ? `IBKR paper exit order submitted with warnings: ${submission.lastWarning}`
          : "IBKR paper exit order submitted."
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

app.listen(port, () => {
  console.log(`HedgeHub listening on http://localhost:${port}`);
});
