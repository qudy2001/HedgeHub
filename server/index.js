import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import {
  calendarWidgets,
  defaultStrategyConfig,
  fallbackPolymarketMarkets,
  marketSections,
  quoteWatchlist,
  strategyAssetUniverse,
  strategyScreenerV2AssetUniverse
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
  getRecentRuns,
  getStrategies,
  recordMarketSnapshots,
  recordPaperOrderSnapshots,
  saveMacroDashboardSnapshot,
  saveStrategyRun,
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
import { fetchOptionChain, fetchQuotes } from "./providers/yahooFinance.js";
import {
  buildStrategySummary,
  parseTargetFromQuestion
} from "./strategyEngine.js";
import { buildStrategyScreenerV2 } from "./strategyScreenerV2.js";
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
const PAPER_STREAM_HEARTBEAT_MS = 20 * 1000;
const PAPER_STREAM_BROADCAST_DEBOUNCE_MS = 750;
const PAPER_ORDER_SNAPSHOT_INTERVAL_MS = 60 * 1000;
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

function getDesiredPaperOptionSymbols() {
  return [...getOpenPaperOptionContractSeeds().values()]
    .filter((contract) => contract.isLive === true && contract.contractSymbol)
    .map((contract) => contract.contractSymbol);
}

function buildPaperValuationOptionMatches() {
  const mergedContracts = new Map(
    liveState.optionMatches.map((contract) => [contract.contractSymbol, contract])
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

function buildPaperPortfolioResponse() {
  const portfolio = buildPaperPortfolio({
    orders: listPaperOrders(),
    quotes: liveState.quotes,
    polymarketMarkets: getPaperValuationPolymarketMarkets(),
    optionMatches: buildPaperValuationOptionMatches()
  });

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
    closedOrders
  };
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
  return {
    generatedAt: new Date().toISOString(),
    options: {
      provider: "Polygon / Massive websocket",
      state: getOptionStreamState(),
      trackedContracts: paperLiveState.desiredSymbols.size,
      subscribedContracts: paperLiveState.subscribedSymbols.size,
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

function matchesAsset(asset, market) {
  const question = market.question.toLowerCase();
  return asset.polymarketQueries.some((query) => question.includes(query.split(" ")[0]));
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
        ...strategyAssetUniverse.flatMap((asset) => asset.polymarketQueries)
      ],
      (value) => value
    );

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

  polymarketMarkets = polymarketMarkets.filter((market) => isTradablePolymarketMarket(market));
  polymarketValuationMarkets = deduplicateBy(
    [
      ...(polymarketValuationMarkets ?? []),
      ...polymarketMarkets
    ].filter((market) => market.question && (market.yesPrice != null || market.noPrice != null)),
    (market) => market.id
  );

  let optionMatches = liveState.optionMatches;
  if (includeOptions) {
    try {
      const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
      const optionRefreshAssets = deduplicateBy(
        [...strategyAssetUniverse, ...strategyScreenerV2AssetUniverse],
        (asset) => `${asset.optionSymbol}:${asset.underlyingSymbol}`
      );

      const optionResults = await Promise.allSettled(
        optionRefreshAssets.map(async (asset) => {
          const assetMarkets = polymarketMarkets.filter((market) => matchesAsset(asset, market));
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
}

async function buildStrategiesResponse() {
  const [strategySummary, v2Screener] = await Promise.all([
    buildStrategySummary({
      quotes: liveState.quotes,
      polymarketMarkets: liveState.polymarketMarkets,
      optionMatches: liveState.optionMatches
    }),
    buildStrategyScreenerV2({
      quotes: liveState.quotes,
      polymarketMarkets: liveState.polymarketMarkets,
      optionMatches: liveState.optionMatches
    })
  ]);
  const paperPortfolio = buildPaperPortfolioResponse();

  return {
    lastUpdated: liveState.lastUpdated,
    warnings: liveState.warnings,
    strategies: getStrategies(),
    recentRuns: getRecentRuns(),
    primaryStrategy: strategySummary,
    v2Screener,
    paperPortfolio
  };
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

app.get("/api/strategies", async (_request, response) => {
  response.json(await buildStrategiesResponse());
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

app.post("/api/strategies/strategy-1/runs", async (_request, response) => {
  const strategySummary = await buildStrategySummary({
    quotes: liveState.quotes,
    polymarketMarkets: liveState.polymarketMarkets,
    optionMatches: liveState.optionMatches
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
    const createdOrder = createPaperOrder(order);
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
              createdOrder.position?.marketReferenceYesPrice ?? baseOrderSnapshot.marketReferenceYesPrice ?? 0.5
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
    syncPaperOptionStreamSubscriptions();
    schedulePaperPortfolioBroadcast(0);

    response.status(201).json({
      order: createdOrder,
      paperPortfolio
    });
  } catch (error) {
    response.status(400).json({
      error: error.message
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

refreshLiveState({ includeOptions: true }).catch((error) => {
  liveState.warnings = [`Initial refresh failed: ${error.message}`];
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
  refreshLiveState({ includeOptions: false }).catch((error) => {
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

app.listen(port, () => {
  console.log(`HedgeHub listening on http://localhost:${port}`);
});
