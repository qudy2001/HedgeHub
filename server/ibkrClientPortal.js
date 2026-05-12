import http from "node:http";
import https from "node:https";
import { logInfo, logWarn } from "./logger.js";

const DEFAULT_IBKR_CONFIG = Object.freeze({
  baseUrl: String(process.env.IBKR_CP_BASE_URL || "https://127.0.0.1:5000/v1/api")
    .trim()
    .replace(/\/+$/, ""),
  timeoutMs: Math.max(Number(process.env.IBKR_CP_TIMEOUT_MS ?? 15000) || 15000, 5000),
  allowSelfSigned: String(process.env.IBKR_CP_ALLOW_SELF_SIGNED ?? "true").trim().toLowerCase() !== "false",
  accountId: String(process.env.IBKR_CP_ACCOUNT_ID ?? "").trim(),
  requirePaper: String(process.env.IBKR_CP_REQUIRE_PAPER ?? "true").trim().toLowerCase() !== "false",
  extOperator: String(process.env.IBKR_CP_EXT_OPERATOR ?? "").trim(),
  manualIndicator: String(process.env.IBKR_CP_MANUAL_INDICATOR ?? "false").trim().toLowerCase() === "true"
});
const IBKR_DEFAULT_USD_COMBO_SPREAD_CONID = "28812380";

const SESSION_COOKIES_BY_KEY = new Map();
const OPTION_CONTRACT_CACHE = new Map();
const STOCK_CONTRACT_CACHE = new Map();

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeIbkrBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}

function resolveIbkrConfig(overrides = null) {
  const patch = overrides && typeof overrides === "object" ? overrides : {};
  const baseUrl = normalizeIbkrBaseUrl(patch.baseUrl ?? patch.IBKR_CP_BASE_URL ?? DEFAULT_IBKR_CONFIG.baseUrl);

  return {
    baseUrl,
    timeoutMs: Math.max(Number(patch.timeoutMs ?? patch.IBKR_CP_TIMEOUT_MS ?? DEFAULT_IBKR_CONFIG.timeoutMs) || DEFAULT_IBKR_CONFIG.timeoutMs, 5000),
    allowSelfSigned:
      typeof patch.allowSelfSigned === "boolean"
        ? patch.allowSelfSigned
        : patch.IBKR_CP_ALLOW_SELF_SIGNED != null
          ? String(patch.IBKR_CP_ALLOW_SELF_SIGNED).trim().toLowerCase() !== "false"
          : DEFAULT_IBKR_CONFIG.allowSelfSigned,
    accountId: String(patch.accountId ?? patch.IBKR_CP_ACCOUNT_ID ?? DEFAULT_IBKR_CONFIG.accountId ?? "").trim(),
    requirePaper:
      typeof patch.requirePaper === "boolean"
        ? patch.requirePaper
        : patch.IBKR_CP_REQUIRE_PAPER != null
          ? String(patch.IBKR_CP_REQUIRE_PAPER).trim().toLowerCase() !== "false"
          : DEFAULT_IBKR_CONFIG.requirePaper,
    extOperator: String(patch.extOperator ?? patch.IBKR_CP_EXT_OPERATOR ?? DEFAULT_IBKR_CONFIG.extOperator ?? "").trim(),
    manualIndicator:
      typeof patch.manualIndicator === "boolean"
        ? patch.manualIndicator
        : patch.IBKR_CP_MANUAL_INDICATOR != null
          ? String(patch.IBKR_CP_MANUAL_INDICATOR).trim().toLowerCase() === "true"
          : DEFAULT_IBKR_CONFIG.manualIndicator
  };
}

function getCookieJar(cookieJarKey) {
  const normalizedKey = String(cookieJarKey ?? "default").trim() || "default";
  const existing = SESSION_COOKIES_BY_KEY.get(normalizedKey);
  if (existing) {
    return existing;
  }

  const created = new Map();
  SESSION_COOKIES_BY_KEY.set(normalizedKey, created);
  return created;
}

function resolveIbkrContext({ config, cookieJarKey } = {}) {
  const resolvedConfig = resolveIbkrConfig(config);
  const baseKey = String(cookieJarKey ?? "default").trim() || "default";
  const jarKey = `${baseKey}:${resolvedConfig.baseUrl || "unset"}`;

  return {
    config: resolvedConfig,
    cookieJar: getCookieJar(jarKey),
    jarKey
  };
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

function normalizeOccSymbol(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizeOptionType(value) {
  return String(value ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
}

function normalizeIbkrOrderType(value) {
  return String(value ?? "LMT").trim().toUpperCase() === "MKT" ? "MKT" : "LMT";
}

function normalizeTif(value) {
  return String(value ?? "DAY").trim().toUpperCase() === "GTC" ? "GTC" : "DAY";
}

function normalizeRoute(value) {
  return String(value ?? "local-paper").trim().toLowerCase() === "ibkr-paper"
    ? "ibkr-paper"
    : "local-paper";
}

function normalizeAccountId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function isPaperAccountId(value) {
  const accountId = normalizeAccountId(value);
  return accountId.startsWith("D");
}

function deriveIbkrPaperSession(accountsPayload, configuredAccountId = "") {
  if (typeof accountsPayload?.isPaper === "boolean") {
    return accountsPayload.isPaper;
  }

  const availableAccounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
  const selectedAccount = normalizeAccountId(accountsPayload?.selectedAccount);
  const configuredAccount = normalizeAccountId(configuredAccountId);
  const normalizedAvailableAccounts = availableAccounts.map((accountId) => normalizeAccountId(accountId)).filter(Boolean);

  if (selectedAccount) {
    return isPaperAccountId(selectedAccount);
  }

  if (configuredAccount && normalizedAvailableAccounts.includes(configuredAccount)) {
    return isPaperAccountId(configuredAccount);
  }

  if (normalizedAvailableAccounts.length) {
    return normalizedAvailableAccounts.every((accountId) => isPaperAccountId(accountId));
  }

  return false;
}

function parseSetCookie(setCookieValue) {
  if (!setCookieValue) {
    return null;
  }

  const firstSegment = String(setCookieValue).split(";")[0];
  const separatorIndex = firstSegment.indexOf("=");

  if (separatorIndex <= 0) {
    return null;
  }

  return {
    name: firstSegment.slice(0, separatorIndex).trim(),
    value: firstSegment.slice(separatorIndex + 1).trim()
  };
}

function storeCookies(cookieJar, setCookieHeader) {
  const cookieValues = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];

  cookieValues.forEach((cookieValue) => {
    const parsed = parseSetCookie(cookieValue);
    if (!parsed?.name) {
      return;
    }

    cookieJar.set(parsed.name, parsed.value);
  });
}

function buildCookieHeader(cookieJar) {
  return [...cookieJar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function clearCookies(cookieJar) {
  cookieJar.clear();
}

function extractIbkrError(payload) {
  if (!payload) {
    return "";
  }

  if (typeof payload === "string") {
    return payload.trim();
  }

  if (Array.isArray(payload)) {
    return payload
      .flatMap((item) => [
        extractIbkrError(item?.error),
        ...(Array.isArray(item?.message) ? item.message : []),
        extractIbkrError(item?.message)
      ])
      .filter(Boolean)
      .join(" | ");
  }

  return [
    extractIbkrError(payload.error),
    extractIbkrError(payload.fail),
    extractIbkrError(payload.message)
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildUrl(baseUrl, pathname, query = {}) {
  const url = new URL(pathname.startsWith("http") ? pathname : `${baseUrl}${pathname}`);

  Object.entries(query).forEach(([key, value]) => {
    if (value == null || value === "") {
      return;
    }

    url.searchParams.set(key, String(value));
  });

  return url;
}

function getTransport(url) {
  return url.protocol === "https:" ? https : http;
}

async function ibkrRequestOnce(context, method, pathname, { query, body, includeCookies = true } = {}) {
  const resolvedContext =
    context && typeof context === "object" && context.config && context.cookieJar
      ? context
      : resolveIbkrContext(context && typeof context === "object" ? context : {});
  const baseUrl = String(resolvedContext.config?.baseUrl ?? "").trim();
  if (!baseUrl) {
    throw new Error("IBKR baseUrl is not configured");
  }

  const url = buildUrl(baseUrl, pathname, query);
  const transport = getTransport(url);
  const payload = body == null ? null : JSON.stringify(body);
  const cookieHeader = includeCookies ? buildCookieHeader(resolvedContext.cookieJar) : "";

  const headers = {
    Accept: "application/json",
    "User-Agent": "undici",
    ...(payload
      ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {})
  };

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers,
        timeout: resolvedContext.config.timeoutMs,
        rejectUnauthorized: !(url.protocol === "https:" && resolvedContext.config.allowSelfSigned)
      },
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          storeCookies(resolvedContext.cookieJar, response.headers["set-cookie"]);
          const rawBody = chunks.join("").trim();
          let parsedBody = rawBody;

          if (rawBody) {
            try {
              parsedBody = JSON.parse(rawBody);
            } catch (_error) {
              parsedBody = rawBody;
            }
          } else {
            parsedBody = null;
          }

          const errorMessage = extractIbkrError(parsedBody);
          if ((response.statusCode ?? 500) >= 400) {
            const error = new Error(errorMessage || `IBKR request failed with status ${response.statusCode}`);
            error.statusCode = response.statusCode ?? 500;
            error.responseBody = parsedBody;
            reject(error);
            return;
          }

          if (errorMessage && typeof parsedBody === "object" && !Array.isArray(parsedBody) && parsedBody?.error) {
            reject(new Error(errorMessage));
            return;
          }

          resolve(parsedBody);
        });
      }
    );

    request.on("error", (error) => {
      reject(error);
    });

    request.on("timeout", () => {
      request.destroy(new Error(`IBKR request timed out after ${resolvedContext.config.timeoutMs}ms`));
    });

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

async function ibkrRequest(context, method, pathname, options = {}) {
  const resolvedContext =
    context && typeof context === "object" && context.config && context.cookieJar
      ? context
      : resolveIbkrContext(context && typeof context === "object" ? context : {});

  try {
    return await ibkrRequestOnce(resolvedContext, method, pathname, options);
  } catch (error) {
    if ((error?.statusCode === 401 || error?.statusCode === 403) && resolvedContext.cookieJar.size) {
      clearCookies(resolvedContext.cookieJar);
      return ibkrRequestOnce(resolvedContext, method, pathname, { ...options, includeCookies: false });
    }

    throw error;
  }
}

function gcd(left, right) {
  const a = Math.abs(Math.round(left));
  const b = Math.abs(Math.round(right));

  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  let currentLeft = a;
  let currentRight = b;
  while (currentRight) {
    const remainder = currentLeft % currentRight;
    currentLeft = currentRight;
    currentRight = remainder;
  }

  return currentLeft;
}

function greatestCommonDivisor(values) {
  return (values ?? []).reduce((current, value) => gcd(current, value), 0) || 1;
}

function getMonthAbbreviation(monthNumber) {
  return ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][
    Math.max(Math.min(monthNumber - 1, 11), 0)
  ];
}

function toIbkrMonth(expiry) {
  const normalized = toCompactIsoDate(expiry);
  if (normalized.length !== 8) {
    return "";
  }

  const year = normalized.slice(0, 4);
  const month = Number(normalized.slice(4, 6));
  if (!year || !(month >= 1 && month <= 12)) {
    return "";
  }

  return `${getMonthAbbreviation(month)}${year.slice(-2)}`;
}

function toCompactIsoDate(expiry) {
  const digits = String(expiry ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : "";
}

function normalizeDateToken(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 8);
}

function matchesExpiry(contract, expiry) {
  const target = toCompactIsoDate(expiry);
  if (!target) {
    return true;
  }

  return [
    contract?.maturityDate,
    contract?.maturity_date,
    contract?.expiry,
    contract?.expiry_full,
    contract?.lastTradingDay,
    contract?.contract_month,
    contract?.contractMonth
  ].some((candidate) => normalizeDateToken(candidate) === target);
}

function matchesStrike(contract, strike) {
  const targetStrike = Number(strike);
  const candidateStrike = toNumber(
    contract?.strike ?? contract?.strikePrice ?? contract?.exercise_price ?? null,
    null
  );

  if (candidateStrike == null || !Number.isFinite(targetStrike)) {
    return false;
  }

  return Math.abs(candidateStrike - targetStrike) < 0.0001;
}

function matchesOptionRight(contract, optionType) {
  const desiredRight = normalizeOptionType(optionType) === "put" ? "P" : "C";
  const candidateRight = String(
    contract?.right ?? contract?.call_or_put ?? contract?.putCall ?? contract?.option_type ?? ""
  )
    .trim()
    .toUpperCase();

  if (candidateRight) {
    return candidateRight.startsWith(desiredRight);
  }

  const normalizedLocalSymbol = normalizeOccSymbol(
    contract?.local_symbol ?? contract?.localSymbol ?? contract?.contract_description_1 ?? ""
  );
  return normalizedLocalSymbol.includes(desiredRight);
}

function scoreSecdefCandidate(contract, leg) {
  let score = 0;

  if (matchesExpiry(contract, leg.expiry)) {
    score += 10;
  }

  if (matchesStrike(contract, leg.strike)) {
    score += 6;
  }

  if (matchesOptionRight(contract, leg.optionType)) {
    score += 4;
  }

  if (
    leg.contractSymbol &&
    normalizeOccSymbol(contract?.local_symbol ?? contract?.localSymbol ?? "") ===
      normalizeOccSymbol(leg.contractSymbol)
  ) {
    score += 20;
  }

  return score;
}

function buildMonthCandidates(expiry) {
  return [...new Set([toIbkrMonth(expiry), toCompactIsoDate(expiry).slice(0, 6), toCompactIsoDate(expiry)])].filter(
    Boolean
  );
}

function normalizeIbkrOrderStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const mappedStatuses = {
    pendingsubmit: "pending_submit",
    presubmitted: "pre_submitted",
    pendingcancel: "pending_cancel",
    precancelled: "pre_cancelled",
    cancelled: "cancelled",
    filled: "filled",
    submitted: "submitted",
    inactive: "inactive",
    warnstate: "warn_state"
  };

  return mappedStatuses[normalized] ?? normalized ?? "unknown";
}

export function isIbkrWorkingStatus(value) {
  return new Set(["pending_submit", "pre_submitted", "submitted", "pending_cancel", "pre_cancelled"]).has(
    normalizeIbkrOrderStatus(value)
  );
}

export function isIbkrFilledStatus(value) {
  return normalizeIbkrOrderStatus(value) === "filled";
}

export function isIbkrTerminalStatus(value) {
  return new Set(["filled", "cancelled", "inactive", "rejected", "error"]).has(
    normalizeIbkrOrderStatus(value)
  );
}

function extractOrderId(payload) {
  if (!payload) {
    return "";
  }

  return String(payload.order_id ?? payload.orderId ?? "").trim();
}

function extractReplyMessages(payload) {
  if (!payload) {
    return [];
  }

  const message =
    Array.isArray(payload?.message)
      ? payload.message
      : payload?.message != null
        ? [payload.message]
        : [];

  return message.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function readIbkrOrderStatusText(payload, fallback = "") {
  return String(
    payload?.order_status_description ??
      payload?.statusDescription ??
      payload?.text ??
      payload?.message ??
      fallback
  ).trim();
}

async function getAuthStatus(context) {
  const authStatus = await ibkrRequest(context, "POST", "/iserver/auth/status", {
    body: {}
  });

  if (!authStatus?.authenticated && authStatus?.connected !== false) {
    const initialized = await ibkrRequest(context, "POST", "/iserver/auth/ssodh/init", {
      body: {
        publish: true,
        compete: true
      }
    });

    return initialized;
  }

  return authStatus;
}

async function getAccountsPayload(context) {
  return ibkrRequest(context, "GET", "/iserver/accounts");
}

async function selectAccount(context, accountId) {
  if (!accountId) {
    return null;
  }

  return ibkrRequest(context, "POST", "/iserver/account", {
    body: {
      acctId: accountId
    }
  });
}

export async function tickleIbkrSession(contextOptions = {}) {
  const context = resolveIbkrContext(contextOptions);
  if (!context.config.baseUrl) {
    return null;
  }

  try {
    return await ibkrRequest(context, "POST", "/tickle", { body: {} });
  } catch (_error) {
    return null;
  }
}

export async function getIbkrStatus(contextOptions = {}) {
  const context = resolveIbkrContext(contextOptions);

  if (!context.config.baseUrl) {
    return {
      configured: false,
      connected: false,
      authenticated: false,
      isPaper: false,
      selectedAccount: "",
      accounts: [],
      aliases: {},
      allowedAssetTypes: "",
      error: "IBKR baseUrl is not configured"
    };
  }

  try {
    const authStatus = await getAuthStatus(context);
    const accounts = authStatus?.connected ? await getAccountsPayload(context) : null;
    const isPaper = deriveIbkrPaperSession(accounts, context.config.accountId);

    return {
      configured: true,
      connected: authStatus?.connected === true,
      authenticated: authStatus?.authenticated === true,
      isPaper,
      selectedAccount: String(accounts?.selectedAccount ?? context.config.accountId ?? "").trim(),
      accounts: Array.isArray(accounts?.accounts) ? accounts.accounts : [],
      aliases: accounts?.aliases ?? {},
      allowedAssetTypes: String(accounts?.allowFeatures?.allowedAssetTypes ?? "").trim(),
      message: String(authStatus?.message ?? "").trim(),
      error: ""
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      authenticated: false,
      isPaper: false,
      selectedAccount: "",
      accounts: [],
      aliases: {},
      allowedAssetTypes: "",
      error: error.message
    };
  }
}

export async function ensureIbkrPaperSession(accountIdHint = "", contextOptions = {}) {
  const context = resolveIbkrContext(contextOptions);

  if (!context.config.baseUrl) {
    throw new Error("IBKR baseUrl is not configured");
  }

  const authStatus = await getAuthStatus(context);
  if (authStatus?.connected !== true || authStatus?.authenticated !== true) {
    throw new Error("IBKR Client Portal Gateway is not authenticated");
  }

  const accountsPayload = await getAccountsPayload(context);
  const isPaper = deriveIbkrPaperSession(accountsPayload, context.config.accountId);
  if (context.config.requirePaper && isPaper !== true) {
    throw new Error("IBKR Gateway session is not in paper mode");
  }

  const availableAccounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
  const requestedAccountId = String(accountIdHint || context.config.accountId || accountsPayload?.selectedAccount || "")
    .trim();
  const accountId = requestedAccountId || availableAccounts[0] || "";

  if (!accountId) {
    throw new Error("No IBKR account is available for order routing");
  }

  const selectedAccount = String(accountsPayload?.selectedAccount ?? "").trim();
  if (selectedAccount && selectedAccount !== accountId) {
    if (availableAccounts.includes(accountId)) {
      await selectAccount(context, accountId);
    } else {
      throw new Error(`Requested IBKR account ${accountId} is not available in the current session`);
    }
  }

  return {
    accountId,
    accountAlias: String(accountsPayload?.aliases?.[accountId] ?? accountId).trim(),
    isPaper,
    accounts: availableAccounts,
    allowedAssetTypes: String(accountsPayload?.allowFeatures?.allowedAssetTypes ?? "").trim()
  };
}

function findOptionSearchMatches(results, symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();

  return Array.isArray(results)
    ? results.filter(
        (candidate) =>
          String(candidate?.symbol ?? "").trim().toUpperCase() === normalizedSymbol &&
          Array.isArray(candidate?.sections) &&
          candidate.sections.some((section) => String(section?.secType ?? "").trim().toUpperCase() === "OPT")
      )
    : [];
}

function findStockSearchMatches(results, symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();

  return Array.isArray(results)
    ? results.filter((candidate) => String(candidate?.symbol ?? "").trim().toUpperCase() === normalizedSymbol)
    : [];
}

async function resolveIbkrStockContract(context, symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();

  if (!normalizedSymbol) {
    throw new Error("Stock symbol is required for IBKR routing");
  }

  if (STOCK_CONTRACT_CACHE.has(normalizedSymbol)) {
    return STOCK_CONTRACT_CACHE.get(normalizedSymbol);
  }

  const primaryResults = await ibkrRequest(context, "GET", "/iserver/secdef/search", {
    query: {
      symbol: normalizedSymbol,
      secType: "STK",
      name: true
    }
  });

  let matches = findStockSearchMatches(primaryResults, normalizedSymbol);

  if (!matches.length) {
    const fallbackResults = await ibkrRequest(context, "GET", "/iserver/secdef/search", {
      query: {
        symbol: normalizedSymbol,
        secType: "STK"
      }
    });
    matches = findStockSearchMatches(fallbackResults, normalizedSymbol);
  }

  const selectedMatch =
    matches.find((candidate) =>
      Array.isArray(candidate?.sections) &&
      candidate.sections.some(
        (section) =>
          String(section?.secType ?? "").trim().toUpperCase() === "STK" &&
          String(section?.exchange ?? "").trim().toUpperCase() === "SMART"
      )
    ) ??
    matches.find((candidate) =>
      Array.isArray(candidate?.sections) &&
      candidate.sections.some((section) => String(section?.secType ?? "").trim().toUpperCase() === "STK")
    ) ??
    matches[0] ??
    null;

  const rawConid = String(selectedMatch?.conid ?? "").trim();
  if (!selectedMatch || !rawConid || !/^\d+$/.test(rawConid)) {
    throw new Error(`IBKR could not resolve stock contract for ${normalizedSymbol}`);
  }

  const resolved = {
    conid: rawConid,
    symbol: normalizedSymbol,
    description: String(selectedMatch?.name ?? selectedMatch?.companyName ?? selectedMatch?.description ?? "").trim()
  };

  STOCK_CONTRACT_CACHE.set(normalizedSymbol, resolved);
  return resolved;
}

async function searchUnderlyingContract(context, symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const primaryResults = await ibkrRequest(context, "GET", "/iserver/secdef/search", {
    query: {
      symbol: normalizedSymbol,
      secType: "OPT",
      name: true
    }
  });

  let matches = findOptionSearchMatches(primaryResults, normalizedSymbol);
  if (!matches.length) {
    // Newer Client Portal Gateway builds can return empty `sections` when `name=true`.
    const fallbackResults = await ibkrRequest(context, "GET", "/iserver/secdef/search", {
      query: {
        symbol: normalizedSymbol,
        secType: "OPT"
      }
    });
    matches = findOptionSearchMatches(fallbackResults, normalizedSymbol);
  }

  const selectedMatch =
    matches.find((candidate) =>
      candidate.sections.some((section) => String(section?.exchange ?? "").trim().toUpperCase() === "SMART")
    ) ??
    matches[0] ??
    null;

  if (!selectedMatch) {
    throw new Error(`IBKR could not find option permissions for ${normalizedSymbol}`);
  }

  return selectedMatch;
}

export async function resolveIbkrOptionContract(leg, contextOptions = {}) {
  const context = resolveIbkrContext(contextOptions);
  const cacheKey = [
    String(leg?.rootSymbol ?? "").trim().toUpperCase(),
    String(leg?.expiry ?? "").trim(),
    normalizeOptionType(leg?.optionType),
    Number(leg?.strike ?? 0).toFixed(4),
    normalizeOccSymbol(leg?.contractSymbol)
  ].join("|");

  if (OPTION_CONTRACT_CACHE.has(cacheKey)) {
    return OPTION_CONTRACT_CACHE.get(cacheKey);
  }

  const rootSymbol = String(leg?.rootSymbol ?? "").trim().toUpperCase();
  if (!rootSymbol) {
    throw new Error("Option root symbol is required for IBKR routing");
  }

  const searchMatch = await searchUnderlyingContract(context, rootSymbol);
  const monthCandidates = buildMonthCandidates(leg?.expiry);
  const matchingContracts = [];

  for (const monthCandidate of monthCandidates) {
    let contracts = null;
    try {
      contracts = await ibkrRequest(context, "GET", "/iserver/secdef/info", {
        query: {
          conid: searchMatch.conid,
          sectype: "OPT",
          month: monthCandidate,
          strike: Number(leg?.strike ?? 0),
          right: normalizeOptionType(leg?.optionType) === "put" ? "P" : "C",
          exchange: "SMART"
        }
      });
    } catch (error) {
      if (String(error?.message ?? "").trim() === "No Contracts retrieved") {
        continue;
      }
      throw error;
    }

    if (Array.isArray(contracts) && contracts.length) {
      matchingContracts.push(...contracts);
    }
  }

  const bestMatch =
    [...matchingContracts]
      .sort((left, right) => scoreSecdefCandidate(right, leg) - scoreSecdefCandidate(left, leg))
      .find((candidate) => scoreSecdefCandidate(candidate, leg) > 0) ?? null;

  if (!bestMatch) {
    throw new Error(
      `IBKR could not resolve ${rootSymbol} ${String(leg?.expiry ?? "")} ${normalizeOptionType(
        leg?.optionType
      ).toUpperCase()} ${Number(leg?.strike ?? 0)}`
    );
  }

  const resolvedContract = {
    conid: String(bestMatch.conid ?? bestMatch.con_id ?? "").trim(),
    localSymbol: String(bestMatch.local_symbol ?? bestMatch.localSymbol ?? "").trim(),
    currency: String(bestMatch.currency ?? "USD").trim() || "USD",
    exchange: String(bestMatch.exchange ?? "SMART").trim() || "SMART",
    multiplier: Math.max(Number(bestMatch.multiplier ?? leg?.contractMultiplier ?? 100) || 100, 1),
    rootSymbol,
    raw: bestMatch
  };

  if (!resolvedContract.conid) {
    throw new Error(`IBKR returned an incomplete contract for ${rootSymbol}`);
  }

  OPTION_CONTRACT_CACHE.set(cacheKey, resolvedContract);
  return resolvedContract;
}

function buildRequestedOptionLegs(order, purpose = "entry") {
  if (purpose === "entry") {
    const requestedLegs =
      Array.isArray(order?.execution?.requestedLegs) && order.execution.requestedLegs.length
        ? order.execution.requestedLegs
        : (order?.legs ?? [])
            .filter((leg) => leg?.kind === "option")
            .map((leg) => ({
              legId: String(leg.id),
              label: String(leg.label ?? leg.id ?? "Option"),
              rootSymbol: String(leg.rootSymbol ?? order?.marketContext?.proxySymbol ?? "").trim(),
              contractSymbol: String(leg.contractSymbol ?? "").trim(),
              optionType: normalizeOptionType(leg.optionType),
              action: String(leg.action ?? "LONG").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG",
              expiry: String(leg.expiry ?? "").trim(),
              strike: Number(leg.strike ?? 0) || 0,
              requestedQuantity: Math.max(Number(leg.quantity ?? 0) || 0, 0),
              entryPrice: Number(leg.entryPrice ?? 0) || 0,
              contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
              brokerConid: String(leg.brokerConid ?? "").trim()
            }));

    const gcdQuantity = greatestCommonDivisor(
      requestedLegs.map((leg) => Math.max(Math.round(Number(leg.requestedQuantity ?? 0) || 0), 0)).filter(Boolean)
    );

    return requestedLegs.map((leg) => ({
      ...leg,
      ratio: Math.max(Math.round(Number(leg.requestedQuantity ?? 0) || 0), 0) / gcdQuantity || 1
    }));
  }

  return (order?.legs ?? [])
    .filter((leg) => leg?.kind === "option" && Number(leg.quantity ?? 0) > 0)
    .map((leg) => ({
      legId: String(leg.id),
      label: String(leg.label ?? leg.id ?? "Option"),
      rootSymbol: String(leg.rootSymbol ?? order?.marketContext?.proxySymbol ?? "").trim(),
      contractSymbol: String(leg.contractSymbol ?? "").trim(),
      optionType: normalizeOptionType(leg.optionType),
      action: String(leg.action ?? "LONG").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG",
      expiry: String(leg.expiry ?? "").trim(),
      strike: Number(leg.strike ?? 0) || 0,
      requestedQuantity: Math.max(Number(leg.quantity ?? 0) || 0, 0),
      entryPrice: Number(leg.currentPrice ?? leg.entryPrice ?? 0) || 0,
      contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
      brokerConid: String(leg.brokerConid ?? "").trim(),
      ratio: 1
    }));
}

export function calculateIbkrLimitPrice(order) {
  const requestedLegs = buildRequestedOptionLegs(order, "entry").filter(
    (leg) => Number(leg.requestedQuantity ?? 0) > 0
  );

  if (!requestedLegs.length) {
    return null;
  }

  if (requestedLegs.length === 1) {
    return Number(requestedLegs[0].entryPrice ?? 0) || 0;
  }

  return requestedLegs.reduce((sum, leg) => {
    const signedPrice = leg.action === "SHORT" ? -Number(leg.entryPrice ?? 0) || 0 : Number(leg.entryPrice ?? 0) || 0;
    return sum + (signedPrice * (Number(leg.ratio ?? 1) || 1));
  }, 0);
}

async function resolveRequestedLegConids(_context, legs, contextOptions = {}) {
  const resolvedLegs = [];

  for (const leg of legs) {
    const resolvedContract =
      leg.brokerConid && /^\d+$/.test(String(leg.brokerConid))
        ? {
            conid: String(leg.brokerConid),
            currency: "USD",
            exchange: "SMART",
            multiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
            rootSymbol: String(leg.rootSymbol ?? "").trim().toUpperCase(),
            localSymbol: String(leg.contractSymbol ?? "").trim()
          }
        : await resolveIbkrOptionContract(leg, contextOptions);

    resolvedLegs.push({
      ...leg,
      brokerConid: String(resolvedContract.conid),
      currency: resolvedContract.currency,
      exchange: resolvedContract.exchange,
      localSymbol: resolvedContract.localSymbol,
      contractMultiplier: resolvedContract.multiplier
    });
  }

  return resolvedLegs;
}

function buildComboConidex(resolvedLegs) {
  const currency = String(resolvedLegs[0]?.currency ?? "USD").trim().toUpperCase() || "USD";
  if (currency !== "USD") {
    throw new Error(`IBKR combo routing currently supports USD option combinations only, received ${currency}`);
  }

  const legDescriptor = resolvedLegs
    .map((leg) => {
      const ratio = Number(leg.ratio ?? 1) || 1;
      const signedRatio = leg.action === "SHORT" ? -ratio : ratio;
      return `${leg.brokerConid}/${signedRatio}`;
    })
    .join(",");

  return `${IBKR_DEFAULT_USD_COMBO_SPREAD_CONID};;;${legDescriptor}`;
}

function parseIbkrOrderSubmission(replyPayload, warningMessages = []) {
  const payloadItems = Array.isArray(replyPayload)
    ? replyPayload
    : replyPayload
      ? [replyPayload]
      : [];

  if (!payloadItems.length) {
    return {
      response: replyPayload,
      warningMessages,
      pendingReply: null
    };
  }

  const acceptedOrder = payloadItems.find((item) => Boolean(extractOrderId(item)));
  if (acceptedOrder) {
    return {
      response: replyPayload,
      warningMessages,
      pendingReply: null
    };
  }

  const replyMessage = payloadItems.find(
    (item) => item && typeof item === "object" && !Array.isArray(item) && String(item.id ?? "").trim()
  );

  if (replyMessage) {
    return {
      response: replyPayload,
      warningMessages,
      pendingReply: {
        id: String(replyMessage.id).trim(),
        messages: extractReplyMessages(replyMessage)
      }
    };
  }

  const extractedMessages = payloadItems.flatMap((item) => extractReplyMessages(item));
  if (extractedMessages.length) {
    return {
      response: replyPayload,
      warningMessages: [...warningMessages, ...extractedMessages],
      pendingReply: null
    };
  }

  return {
    response: replyPayload,
    warningMessages,
    pendingReply: null
  };
}

export async function respondToIbkrOrderReply({ replyId, confirmed = true, warningMessages = [] }, contextOptions = {}) {
  if (!replyId) {
    throw new Error("IBKR reply id is required");
  }

  const context = resolveIbkrContext(contextOptions);
  const replyPayload = await ibkrRequest(context, "POST", `/iserver/reply/${encodeURIComponent(replyId)}`, {
    body: {
      confirmed: confirmed === true
    }
  });
  console.info(
    `[IBKR] Reply ${replyId} confirmed=${confirmed === true ? "true" : "false"} payload=${JSON.stringify(replyPayload)}`
  );

  return parseIbkrOrderSubmission(replyPayload, warningMessages);
}

export async function continueIbkrOrderConfirmation({ execution, confirmed = true }, contextOptions = {}) {
  const existingExecution = execution && typeof execution === "object" ? execution : null;
  if (!existingExecution?.pendingReplyId) {
    throw new Error("IBKR confirmation is not pending for this execution");
  }

  const previousWarnings = Array.isArray(existingExecution.warningMessages)
    ? existingExecution.warningMessages
    : [];
  const pendingMessages = Array.isArray(existingExecution.pendingReplyMessages)
    ? existingExecution.pendingReplyMessages
    : [];
  const combinedWarnings = [...previousWarnings, ...pendingMessages].filter(Boolean);
  const now = new Date().toISOString();
  const replyResult = await respondToIbkrOrderReply({
    replyId: existingExecution.pendingReplyId,
    confirmed,
    warningMessages: combinedWarnings
  }, contextOptions);

  if (confirmed !== true) {
    return {
      ...existingExecution,
      status: "cancelled",
      statusText: "Broker confirmation declined",
      statusDescription: pendingMessages.join(" | "),
      lastError: "",
      lastWarning: combinedWarnings.join(" | "),
      warningMessages: combinedWarnings,
      pendingReplyId: "",
      pendingReplyMessages: [],
      lastSyncAt: now,
      cancelledAt: now
    };
  }

  if (replyResult.pendingReply) {
    console.info(
      `[IBKR] Confirmation reply ${String(existingExecution.pendingReplyId ?? "").trim() || "n/a"} requires follow-up ${
        replyResult.pendingReply.id
      }: ${replyResult.pendingReply.messages.join(" | ")}`
    );
    return {
      ...existingExecution,
      status: "pending_confirmation",
      statusText: "Broker confirmation required",
      statusDescription: replyResult.pendingReply.messages.join(" | "),
      lastError: "",
      lastWarning: replyResult.warningMessages.join(" | "),
      warningMessages: replyResult.warningMessages,
      pendingReplyId: replyResult.pendingReply.id,
      pendingReplyMessages: replyResult.pendingReply.messages,
      lastSyncAt: now,
    };
  }

  const orderReply = Array.isArray(replyResult.response) ? replyResult.response[0] ?? null : replyResult.response;
  const brokerOrderId = extractOrderId(orderReply) || String(existingExecution.brokerOrderId ?? "");
  let brokerStatusPayload = orderReply;

  if (brokerOrderId && existingExecution.accountId) {
    try {
      brokerStatusPayload = await fetchIbkrOrderStatus({
        accountId: existingExecution.accountId,
        orderId: brokerOrderId
      }, contextOptions);
    } catch (_error) {
      brokerStatusPayload = orderReply;
    }
  }

  const brokerStatus = normalizeIbkrOrderStatus(
    brokerStatusPayload?.order_status ?? brokerStatusPayload?.status ?? orderReply?.order_status ?? orderReply?.status ?? "submitted"
  );
  const statusText = String(
    brokerStatusPayload?.order_status ??
      brokerStatusPayload?.status ??
      orderReply?.order_status ??
      orderReply?.status ??
      existingExecution.statusText ??
      "Submitted"
  ).trim();
  const statusDescription = readIbkrOrderStatusText(
    brokerStatusPayload,
    readIbkrOrderStatusText(orderReply, existingExecution.statusDescription ?? "")
  );
  const replyId = String(existingExecution.pendingReplyId ?? "").trim();

  if (["inactive", "rejected", "error"].includes(brokerStatus)) {
    logWarn("IBKR confirmation reply resolved", {
      subsystem: "ibkr",
      replyId: replyId || "n/a",
      brokerStatus,
      brokerOrderId: brokerOrderId || "n/a",
      statusDescription: statusDescription || statusText || "No broker description"
    });
  } else {
    logInfo("IBKR confirmation reply resolved", {
      subsystem: "ibkr",
      replyId: replyId || "n/a",
      brokerStatus,
      brokerOrderId: brokerOrderId || "n/a",
      statusDescription: statusDescription || statusText || "No broker description"
    });
  }

  return {
    ...existingExecution,
    status: brokerStatus || "submitted",
    statusText,
    statusDescription,
    brokerOrderId,
    avgFillPrice:
      toNumber(
        brokerStatusPayload?.avgPrice ??
          brokerStatusPayload?.average_price ??
          orderReply?.avgPrice ??
          orderReply?.average_price ??
          existingExecution.avgFillPrice,
        existingExecution.avgFillPrice
      ),
    filledQuantity:
      toNumber(
        brokerStatusPayload?.filledQuantity ??
          brokerStatusPayload?.filled_qty ??
          brokerStatusPayload?.cum_fill ??
          orderReply?.filledQuantity ??
          orderReply?.filled_qty ??
          orderReply?.cum_fill ??
          existingExecution.filledQuantity,
        existingExecution.filledQuantity
      ),
    totalQuantity:
      toNumber(
        brokerStatusPayload?.totalSize ??
          brokerStatusPayload?.total_size ??
          brokerStatusPayload?.quantity ??
          brokerStatusPayload?.size ??
          orderReply?.totalSize ??
          orderReply?.total_size ??
          orderReply?.quantity ??
          orderReply?.size ??
          existingExecution.totalQuantity,
        existingExecution.totalQuantity
      ),
    remainingQuantity:
      toNumber(
        brokerStatusPayload?.remainingQuantity ??
          brokerStatusPayload?.remaining_qty ??
          orderReply?.remainingQuantity ??
          orderReply?.remaining_qty ??
          existingExecution.remainingQuantity,
        existingExecution.remainingQuantity
      ),
    submittedAt: existingExecution.submittedAt || now,
    lastSyncAt: now,
    lastError: ["inactive", "rejected", "error"].includes(brokerStatus) ? statusDescription : "",
    lastWarning: replyResult.warningMessages.join(" | "),
    warningMessages: replyResult.warningMessages,
    pendingReplyId: "",
    pendingReplyMessages: []
  };
}

export async function submitIbkrStockOrder({ order, purpose = "entry" }, contextOptions = {}) {
  const context = resolveIbkrContext(contextOptions);
  const normalizedPurpose = String(purpose ?? "entry").trim().toLowerCase() === "exit" ? "exit" : "entry";
  const requestedLeg = (order?.legs ?? []).find((leg) => leg?.kind === "stock") ?? null;
  const requestedQuantity = Math.max(Math.round(Number(requestedLeg?.quantity ?? 0) || 0), 0);

  if (!(requestedQuantity > 0)) {
    throw new Error(`No stock hedge leg is available to ${normalizedPurpose === "exit" ? "close" : "route"} through IBKR`);
  }

  const session = await ensureIbkrPaperSession(order?.execution?.accountId ?? order?.stockExecution?.accountId, contextOptions);
  const symbol = String(
    requestedLeg?.rootSymbol ?? order?.marketContext?.underlyingSymbol ?? order?.marketContext?.proxySymbol ?? ""
  )
    .trim()
    .toUpperCase();

  const contract = await resolveIbkrStockContract(context, symbol);
  const orderType = "MKT";
  const tif = normalizeTif(order?.execution?.tif);
  const outsideRth = order?.execution?.outsideRth === true;
  const orderRef = `hedgehub-${order.id}-${normalizedPurpose}-stock-${Date.now()}`;
  const rawAction = String(requestedLeg?.action ?? "LONG").trim().toUpperCase();
  const isShort = rawAction === "SHORT";
  const side =
    normalizedPurpose === "exit"
      ? isShort
        ? "BUY"
        : "SELL"
      : isShort
        ? "SELL"
        : "BUY";

  const orderPayload = {
    acctId: session.accountId,
    cOID: orderRef,
    orderType,
    tif,
    outsideRTH: outsideRth,
    outsideRth: outsideRth,
    ticker: symbol,
    conid: Number(contract.conid),
    quantity: requestedQuantity,
    side,
    referrer: "HedgeHub",
    ...(context.config.extOperator ? { extOperator: context.config.extOperator } : {}),
    ...(context.config.manualIndicator ? { manualIndicator: true } : {})
  };

  const placeOrderResponse = await ibkrRequest(
    context,
    "POST",
    `/iserver/account/${encodeURIComponent(session.accountId)}/orders`,
    {
      body: {
        orders: [orderPayload]
      }
    }
  );
  const submittedAt = new Date().toISOString();
  const submission = parseIbkrOrderSubmission(placeOrderResponse);

  if (submission.pendingReply) {
    console.info(
      `[IBKR] Stock order ${orderRef} requires confirmation ${submission.pendingReply.id}: ${submission.pendingReply.messages.join(" | ")}`
    );
    return {
      route: "ibkr-paper",
      accountId: session.accountId,
      accountAlias: session.accountAlias,
      isPaper: session.isPaper === true,
      status: "pending_confirmation",
      statusText: "Broker confirmation required",
      statusDescription: submission.pendingReply.messages.join(" | "),
      brokerOrderId: "",
      orderRef,
      orderType,
      tif,
      outsideRth,
      limitPrice: null,
      avgFillPrice: null,
      combo: false,
      purpose: normalizedPurpose,
      totalQuantity: requestedQuantity,
      filledQuantity: 0,
      remainingQuantity: requestedQuantity,
      submittedAt,
      lastSyncAt: submittedAt,
      filledAt: "",
      cancelledAt: "",
      lastError: "",
      lastWarning: submission.warningMessages.join(" | "),
      warningMessages: submission.warningMessages,
      pendingReplyId: submission.pendingReply.id,
      pendingReplyMessages: submission.pendingReply.messages,
      requestedLegs: []
    };
  }

  const orderReply = Array.isArray(submission.response) ? submission.response[0] ?? null : submission.response;
  const brokerOrderId = extractOrderId(orderReply);
  const brokerStatus = normalizeIbkrOrderStatus(orderReply?.order_status ?? orderReply?.status ?? "submitted");
  console.info(
    `[IBKR] Stock order ${orderRef} accepted as ${brokerStatus || "submitted"} with broker order ${brokerOrderId || "n/a"}`
  );

  return {
    route: "ibkr-paper",
    accountId: session.accountId,
    accountAlias: session.accountAlias,
    isPaper: session.isPaper === true,
    status: brokerStatus || "submitted",
    statusText: String(orderReply?.order_status ?? orderReply?.status ?? "Submitted"),
    statusDescription: String(orderReply?.text ?? orderReply?.message ?? ""),
    brokerOrderId,
    orderRef,
    orderType,
    tif,
    outsideRth,
    limitPrice: null,
    avgFillPrice: null,
    combo: false,
    purpose: normalizedPurpose,
    totalQuantity: requestedQuantity,
    filledQuantity: 0,
    remainingQuantity: requestedQuantity,
    submittedAt,
    lastSyncAt: submittedAt,
    filledAt: "",
    cancelledAt: "",
    lastError: "",
    lastWarning: submission.warningMessages.join(" | "),
    warningMessages: submission.warningMessages,
    pendingReplyId: "",
    pendingReplyMessages: [],
    requestedLegs: []
  };
}

export async function submitIbkrOptionOrder({ order, purpose = "entry" }, contextOptions = {}) {
  const context = resolveIbkrContext(contextOptions);
  const session = await ensureIbkrPaperSession(order?.execution?.accountId, contextOptions);
  const requestedLegs = buildRequestedOptionLegs(order, purpose).filter(
    (leg) => Number(leg.requestedQuantity ?? 0) > 0
  );

  if (!requestedLegs.length) {
    throw new Error(`No option legs are available to ${purpose === "exit" ? "close" : "route"} through IBKR`);
  }

  const resolvedLegs = await resolveRequestedLegConids(context, requestedLegs, contextOptions);
  const isComboOrder = resolvedLegs.length > 1;
  const orderQuantity = isComboOrder
    ? greatestCommonDivisor(
        resolvedLegs.map((leg) => Math.max(Math.round(Number(leg.requestedQuantity ?? 0) || 0), 0)).filter(Boolean)
      )
    : Math.max(Math.round(Number(resolvedLegs[0]?.requestedQuantity ?? 0) || 0), 0);

  if (!(orderQuantity > 0)) {
    throw new Error("IBKR order quantity must be greater than zero");
  }

  const orderType = purpose === "exit" ? "MKT" : normalizeIbkrOrderType(order?.execution?.orderType);
  const tif = purpose === "exit" ? "DAY" : normalizeTif(order?.execution?.tif);
  const outsideRth = purpose === "exit" ? false : order?.execution?.outsideRth === true;
  const limitPrice =
    orderType === "LMT"
      ? toNumber(order?.execution?.limitPrice, calculateIbkrLimitPrice({ ...order, execution: { requestedLegs: resolvedLegs } }))
      : null;

  if (orderType === "LMT" && limitPrice == null) {
    throw new Error("IBKR limit orders require a limit price");
  }

  const orderRef = `hedgehub-${order.id}-${purpose}-${Date.now()}`;
  const baseOrder = {
    acctId: session.accountId,
    cOID: orderRef,
    orderType,
    tif,
    outsideRTH: outsideRth,
    outsideRth: outsideRth,
    ticker: String(resolvedLegs[0]?.rootSymbol ?? order?.marketContext?.proxySymbol ?? "").trim().toUpperCase(),
    quantity: orderQuantity,
    referrer: "HedgeHub",
    ...(orderType === "LMT" ? { price: limitPrice } : {}),
    ...(context.config.extOperator ? { extOperator: context.config.extOperator } : {}),
    ...(context.config.manualIndicator ? { manualIndicator: true } : {})
  };

  const orderPayload =
    isComboOrder
      ? {
          ...baseOrder,
          conidex: buildComboConidex(resolvedLegs),
          side: purpose === "exit" ? "SELL" : "BUY"
        }
      : {
          ...baseOrder,
          conid: Number(resolvedLegs[0].brokerConid),
          side:
            purpose === "exit"
              ? resolvedLegs[0].action === "SHORT"
                ? "BUY"
                : "SELL"
              : resolvedLegs[0].action === "SHORT"
                ? "SELL"
                : "BUY"
        };

  const placeOrderResponse = await ibkrRequest(
    context,
    "POST",
    `/iserver/account/${encodeURIComponent(session.accountId)}/orders`,
    {
      body: {
        orders: [orderPayload]
      }
    }
  );
  const submittedAt = new Date().toISOString();
  const submission = parseIbkrOrderSubmission(placeOrderResponse);

  if (submission.pendingReply) {
    console.info(
      `[IBKR] Order ${orderRef} requires confirmation ${submission.pendingReply.id}: ${submission.pendingReply.messages.join(" | ")}`
    );
    return {
      accountId: session.accountId,
      accountAlias: session.accountAlias,
      isPaper: session.isPaper === true,
      status: "pending_confirmation",
      statusText: "Broker confirmation required",
      statusDescription: submission.pendingReply.messages.join(" | "),
      brokerOrderId: "",
      orderRef,
      orderType,
      tif,
      outsideRth,
      limitPrice,
      avgFillPrice: null,
      combo: isComboOrder,
      purpose,
      totalQuantity: orderQuantity,
      filledQuantity: 0,
      remainingQuantity: orderQuantity,
      submittedAt,
      lastSyncAt: submittedAt,
      lastError: "",
      lastWarning: submission.warningMessages.join(" | "),
      warningMessages: submission.warningMessages,
      pendingReplyId: submission.pendingReply.id,
      pendingReplyMessages: submission.pendingReply.messages,
      requestedLegs: resolvedLegs.map((leg) => ({
        legId: leg.legId,
        label: leg.label,
        rootSymbol: leg.rootSymbol,
        contractSymbol: leg.contractSymbol,
        optionType: normalizeOptionType(leg.optionType),
        action: leg.action,
        expiry: leg.expiry,
        strike: leg.strike,
        requestedQuantity: Math.max(Number(leg.requestedQuantity ?? 0) || 0, 0),
        ratio: Number(leg.ratio ?? 1) || 1,
        entryPrice: Number(leg.entryPrice ?? 0) || 0,
        contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
        brokerConid: String(leg.brokerConid),
        localSymbol: String(leg.localSymbol ?? "")
      }))
    };
  }

  const orderReply = Array.isArray(submission.response) ? submission.response[0] ?? null : submission.response;
  const brokerOrderId = extractOrderId(orderReply);
  const brokerStatus = normalizeIbkrOrderStatus(orderReply?.order_status ?? orderReply?.status ?? "submitted");
  console.info(
    `[IBKR] Order ${orderRef} accepted as ${brokerStatus || "submitted"} with broker order ${brokerOrderId || "n/a"}`
  );

  return {
    accountId: session.accountId,
    accountAlias: session.accountAlias,
    isPaper: session.isPaper === true,
    status: brokerStatus || "submitted",
    statusText: String(orderReply?.order_status ?? orderReply?.status ?? "Submitted"),
    statusDescription: String(orderReply?.text ?? orderReply?.message ?? ""),
    brokerOrderId,
    orderRef,
    orderType,
    tif,
    outsideRth,
    limitPrice,
    avgFillPrice: null,
    combo: isComboOrder,
    purpose,
    totalQuantity: orderQuantity,
    filledQuantity: 0,
    remainingQuantity: orderQuantity,
    submittedAt,
    lastSyncAt: submittedAt,
    lastError: "",
    lastWarning: submission.warningMessages.join(" | "),
    warningMessages: submission.warningMessages,
    pendingReplyId: "",
    pendingReplyMessages: [],
    requestedLegs: resolvedLegs.map((leg) => ({
      legId: leg.legId,
      label: leg.label,
      rootSymbol: leg.rootSymbol,
      contractSymbol: leg.contractSymbol,
      optionType: normalizeOptionType(leg.optionType),
      action: leg.action,
      expiry: leg.expiry,
      strike: leg.strike,
      requestedQuantity: Math.max(Number(leg.requestedQuantity ?? 0) || 0, 0),
      ratio: Number(leg.ratio ?? 1) || 1,
      entryPrice: Number(leg.entryPrice ?? 0) || 0,
      contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
      brokerConid: String(leg.brokerConid),
      localSymbol: String(leg.localSymbol ?? "")
    }))
  };
}

export async function cancelIbkrOrder({ accountId, orderId }, contextOptions = {}) {
  if (!accountId || !orderId) {
    throw new Error("IBKR accountId and orderId are required to cancel an order");
  }

  const context = resolveIbkrContext(contextOptions);
  await ensureIbkrPaperSession(accountId, contextOptions);

  return ibkrRequest(
    context,
    "DELETE",
    `/iserver/account/${encodeURIComponent(accountId)}/order/${encodeURIComponent(orderId)}`,
    {
      query: {
        ...(context.config.manualIndicator ? { manualIndicator: true } : {}),
        ...(context.config.extOperator ? { extOperator: context.config.extOperator } : {})
      }
    }
  );
}

export async function fetchIbkrOrderBook({ accountId, tradeDays = 7 } = {}, contextOptions = {}) {
  const context = resolveIbkrContext(contextOptions);
  const session = await ensureIbkrPaperSession(accountId, contextOptions);
  await tickleIbkrSession(contextOptions);

  const [ordersPayload, tradesPayload] = await Promise.all([
    ibkrRequest(context, "GET", "/iserver/account/orders"),
    ibkrRequest(context, "GET", "/iserver/account/trades", {
      query: {
        days: Math.max(Math.min(Number(tradeDays) || 7, 7), 1)
      }
    })
  ]);

  return {
    accountId: session.accountId,
    accountAlias: session.accountAlias,
    isPaper: session.isPaper === true,
    orders: Array.isArray(ordersPayload?.orders) ? ordersPayload.orders : [],
    trades: Array.isArray(tradesPayload) ? tradesPayload : [],
    snapshot: ordersPayload?.snapshot === true
  };
}

export async function fetchIbkrOrderStatus({ accountId, orderId }, contextOptions = {}) {
  if (!orderId) {
    return null;
  }

  const context = resolveIbkrContext(contextOptions);
  await ensureIbkrPaperSession(accountId, contextOptions);
  return ibkrRequest(context, "GET", `/iserver/account/order/status/${encodeURIComponent(orderId)}`);
}

export function normalizeIbkrLiveOrder(order = {}) {
  const status = normalizeIbkrOrderStatus(order.order_status ?? order.status);

  return {
    brokerOrderId: String(order.orderId ?? order.order_id ?? "").trim(),
    orderRef: String(order.order_ref ?? order.orderRef ?? "").trim(),
    status,
    statusText: String(order.order_status ?? order.status ?? "").trim(),
    statusDescription: String(order.order_status_description ?? order.statusDescription ?? "").trim(),
    avgFillPrice: toNumber(order.avgPrice ?? order.average_price ?? null, null),
    filledQuantity: toNumber(order.filledQuantity ?? order.filled_qty ?? order.cum_fill ?? null, null),
    totalQuantity: toNumber(order.totalSize ?? order.total_size ?? order.quantity ?? order.size ?? null, null),
    remainingQuantity: toNumber(order.remainingQuantity ?? order.remaining_qty ?? order.remainingQuantity ?? null, null),
    lastExecutionAt:
      normalizeTimestamp(order.lastExecutionTime_r) ||
      normalizeTimestamp(order.lastExecutionTime) ||
      normalizeTimestamp(order.last_execution_time_r) ||
      normalizeTimestamp(order.last_execution_time),
    raw: order
  };
}

export function groupTradesByOrderRef(trades = []) {
  return (trades ?? []).reduce((groups, trade) => {
    const orderRef = String(trade?.order_ref ?? trade?.orderRef ?? "").trim();
    if (!orderRef) {
      return groups;
    }

    if (!groups.has(orderRef)) {
      groups.set(orderRef, []);
    }

    groups.get(orderRef).push(trade);
    return groups;
  }, new Map());
}
