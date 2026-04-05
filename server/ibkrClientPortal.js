import http from "node:http";
import https from "node:https";

const IBKR_CP_BASE_URL = String(
  process.env.IBKR_CP_BASE_URL || "https://127.0.0.1:5000/v1/api"
)
  .trim()
  .replace(/\/+$/, "");
const IBKR_CP_TIMEOUT_MS = Math.max(Number(process.env.IBKR_CP_TIMEOUT_MS ?? 15000) || 15000, 5000);
const IBKR_CP_ALLOW_SELF_SIGNED =
  String(process.env.IBKR_CP_ALLOW_SELF_SIGNED ?? "true").trim().toLowerCase() !== "false";
const IBKR_CP_ACCOUNT_ID = String(process.env.IBKR_CP_ACCOUNT_ID ?? "").trim();
const IBKR_CP_REQUIRE_PAPER =
  String(process.env.IBKR_CP_REQUIRE_PAPER ?? "true").trim().toLowerCase() !== "false";
const IBKR_CP_EXT_OPERATOR = String(process.env.IBKR_CP_EXT_OPERATOR ?? "").trim();
const IBKR_CP_MANUAL_INDICATOR =
  String(process.env.IBKR_CP_MANUAL_INDICATOR ?? "false").trim().toLowerCase() === "true";
const IBKR_DEFAULT_USD_COMBO_SPREAD_CONID = "28812380";

const SESSION_COOKIES = new Map();
const OPTION_CONTRACT_CACHE = new Map();

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
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

function deriveIbkrPaperSession(accountsPayload) {
  if (typeof accountsPayload?.isPaper === "boolean") {
    return accountsPayload.isPaper;
  }

  const availableAccounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
  const selectedAccount = normalizeAccountId(accountsPayload?.selectedAccount);
  const configuredAccount = normalizeAccountId(IBKR_CP_ACCOUNT_ID);
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

function storeCookies(setCookieHeader) {
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

    SESSION_COOKIES.set(parsed.name, parsed.value);
  });
}

function buildCookieHeader() {
  return [...SESSION_COOKIES.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function clearCookies() {
  SESSION_COOKIES.clear();
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

function buildUrl(pathname, query = {}) {
  const url = new URL(pathname.startsWith("http") ? pathname : `${IBKR_CP_BASE_URL}${pathname}`);

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

async function ibkrRequestOnce(method, pathname, { query, body, includeCookies = true } = {}) {
  const url = buildUrl(pathname, query);
  const transport = getTransport(url);
  const payload = body == null ? null : JSON.stringify(body);
  const cookieHeader = includeCookies ? buildCookieHeader() : "";

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
        timeout: IBKR_CP_TIMEOUT_MS,
        rejectUnauthorized: !(url.protocol === "https:" && IBKR_CP_ALLOW_SELF_SIGNED)
      },
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          storeCookies(response.headers["set-cookie"]);
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
      request.destroy(new Error(`IBKR request timed out after ${IBKR_CP_TIMEOUT_MS}ms`));
    });

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

async function ibkrRequest(method, pathname, options = {}) {
  try {
    return await ibkrRequestOnce(method, pathname, options);
  } catch (error) {
    if ((error?.statusCode === 401 || error?.statusCode === 403) && SESSION_COOKIES.size) {
      clearCookies();
      return ibkrRequestOnce(method, pathname, { ...options, includeCookies: false });
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
  const parts = String(expiry ?? "").split("-");
  if (parts.length !== 3) {
    return "";
  }

  const year = parts[0];
  const month = Number(parts[1]);
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

async function getAuthStatus() {
  const authStatus = await ibkrRequest("POST", "/iserver/auth/status", {
    body: {}
  });

  if (!authStatus?.authenticated && authStatus?.connected !== false) {
    const initialized = await ibkrRequest("POST", "/iserver/auth/ssodh/init", {
      body: {
        publish: true,
        compete: true
      }
    });

    return initialized;
  }

  return authStatus;
}

async function getAccountsPayload() {
  return ibkrRequest("GET", "/iserver/accounts");
}

async function selectAccount(accountId) {
  if (!accountId) {
    return null;
  }

  return ibkrRequest("POST", "/iserver/account", {
    body: {
      acctId: accountId
    }
  });
}

export async function tickleIbkrSession() {
  if (!IBKR_CP_BASE_URL) {
    return null;
  }

  try {
    return await ibkrRequest("POST", "/tickle", { body: {} });
  } catch (_error) {
    return null;
  }
}

export async function getIbkrStatus() {
  if (!IBKR_CP_BASE_URL) {
    return {
      configured: false,
      connected: false,
      authenticated: false,
      isPaper: false,
      selectedAccount: "",
      accounts: [],
      aliases: {},
      allowedAssetTypes: "",
      error: "IBKR_CP_BASE_URL is not configured"
    };
  }

  try {
    const authStatus = await getAuthStatus();
    const accounts = authStatus?.connected ? await getAccountsPayload() : null;
    const isPaper = deriveIbkrPaperSession(accounts);

    return {
      configured: true,
      connected: authStatus?.connected === true,
      authenticated: authStatus?.authenticated === true,
      isPaper,
      selectedAccount: String(accounts?.selectedAccount ?? IBKR_CP_ACCOUNT_ID ?? "").trim(),
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

export async function ensureIbkrPaperSession(accountIdHint = "") {
  if (!IBKR_CP_BASE_URL) {
    throw new Error("IBKR_CP_BASE_URL is not configured");
  }

  const authStatus = await getAuthStatus();
  if (authStatus?.connected !== true || authStatus?.authenticated !== true) {
    throw new Error("IBKR Client Portal Gateway is not authenticated");
  }

  const accountsPayload = await getAccountsPayload();
  const isPaper = deriveIbkrPaperSession(accountsPayload);
  if (IBKR_CP_REQUIRE_PAPER && isPaper !== true) {
    throw new Error("IBKR Gateway session is not in paper mode");
  }

  const availableAccounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
  const requestedAccountId = String(accountIdHint || IBKR_CP_ACCOUNT_ID || accountsPayload?.selectedAccount || "")
    .trim();
  const accountId = requestedAccountId || availableAccounts[0] || "";

  if (!accountId) {
    throw new Error("No IBKR account is available for order routing");
  }

  const selectedAccount = String(accountsPayload?.selectedAccount ?? "").trim();
  if (selectedAccount && selectedAccount !== accountId) {
    if (availableAccounts.includes(accountId)) {
      await selectAccount(accountId);
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

async function searchUnderlyingContract(symbol) {
  const results = await ibkrRequest("GET", "/iserver/secdef/search", {
    query: {
      symbol: String(symbol ?? "").trim().toUpperCase(),
      secType: "OPT",
      name: true
    }
  });

  const matches = Array.isArray(results)
    ? results.filter(
        (candidate) =>
          String(candidate?.symbol ?? "").trim().toUpperCase() === String(symbol ?? "").trim().toUpperCase() &&
          Array.isArray(candidate?.sections) &&
          candidate.sections.some((section) => String(section?.secType ?? "").trim().toUpperCase() === "OPT")
      )
    : [];

  const selectedMatch =
    matches.find((candidate) =>
      candidate.sections.some((section) => String(section?.exchange ?? "").trim().toUpperCase() === "SMART")
    ) ??
    matches[0] ??
    null;

  if (!selectedMatch) {
    throw new Error(`IBKR could not find option permissions for ${symbol}`);
  }

  return selectedMatch;
}

export async function resolveIbkrOptionContract(leg) {
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

  const searchMatch = await searchUnderlyingContract(rootSymbol);
  const monthCandidates = buildMonthCandidates(leg?.expiry);
  const matchingContracts = [];

  for (const monthCandidate of monthCandidates) {
    const contracts = await ibkrRequest("GET", "/iserver/secdef/info", {
      query: {
        conid: searchMatch.conid,
        sectype: "OPT",
        month: monthCandidate,
        strike: Number(leg?.strike ?? 0),
        right: normalizeOptionType(leg?.optionType) === "put" ? "P" : "C",
        exchange: "SMART"
      }
    });

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

async function resolveRequestedLegConids(legs) {
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
        : await resolveIbkrOptionContract(leg);

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

async function submitOrderWarnings(replyPayload, warnings = []) {
  if (!Array.isArray(replyPayload) || !replyPayload.length) {
    return {
      response: replyPayload,
      warnings
    };
  }

  if (extractOrderId(replyPayload[0])) {
    return {
      response: replyPayload,
      warnings
    };
  }

  const replyMessage = replyPayload[0];
  if (!replyMessage?.id) {
    return {
      response: replyPayload,
      warnings
    };
  }

  const nextWarnings = [
    ...warnings,
    ...(Array.isArray(replyMessage.message) ? replyMessage.message : [String(replyMessage.message ?? "")]).filter(Boolean)
  ];
  const confirmedReply = await ibkrRequest("POST", `/iserver/reply/${encodeURIComponent(replyMessage.id)}`, {
    body: {
      confirmed: true
    }
  });

  return submitOrderWarnings(confirmedReply, nextWarnings);
}

export async function submitIbkrOptionOrder({ order, purpose = "entry" }) {
  const session = await ensureIbkrPaperSession(order?.execution?.accountId);
  const requestedLegs = buildRequestedOptionLegs(order, purpose).filter(
    (leg) => Number(leg.requestedQuantity ?? 0) > 0
  );

  if (!requestedLegs.length) {
    throw new Error(`No option legs are available to ${purpose === "exit" ? "close" : "route"} through IBKR`);
  }

  const resolvedLegs = await resolveRequestedLegConids(requestedLegs);
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
    ...(IBKR_CP_EXT_OPERATOR ? { extOperator: IBKR_CP_EXT_OPERATOR } : {}),
    ...(IBKR_CP_MANUAL_INDICATOR ? { manualIndicator: true } : {})
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
    "POST",
    `/iserver/account/${encodeURIComponent(session.accountId)}/orders`,
    {
      body: {
        orders: [orderPayload]
      }
    }
  );
  const submission = await submitOrderWarnings(placeOrderResponse);
  const orderReply = Array.isArray(submission.response) ? submission.response[0] ?? null : submission.response;
  const brokerOrderId = extractOrderId(orderReply);
  const brokerStatus = normalizeIbkrOrderStatus(orderReply?.order_status ?? orderReply?.status ?? "submitted");
  const submittedAt = new Date().toISOString();

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
    lastWarning: submission.warnings.join(" | "),
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

export async function cancelIbkrOrder({ accountId, orderId }) {
  if (!accountId || !orderId) {
    throw new Error("IBKR accountId and orderId are required to cancel an order");
  }

  await ensureIbkrPaperSession(accountId);

  return ibkrRequest(
    "DELETE",
    `/iserver/account/${encodeURIComponent(accountId)}/order/${encodeURIComponent(orderId)}`,
    {
      query: {
        ...(IBKR_CP_MANUAL_INDICATOR ? { manualIndicator: true } : {}),
        ...(IBKR_CP_EXT_OPERATOR ? { extOperator: IBKR_CP_EXT_OPERATOR } : {})
      }
    }
  );
}

export async function fetchIbkrOrderBook({ accountId, tradeDays = 7 } = {}) {
  const session = await ensureIbkrPaperSession(accountId);
  await tickleIbkrSession();

  const [ordersPayload, tradesPayload] = await Promise.all([
    ibkrRequest("GET", "/iserver/account/orders"),
    ibkrRequest("GET", "/iserver/account/trades", {
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

export async function fetchIbkrOrderStatus({ accountId, orderId }) {
  if (!orderId) {
    return null;
  }

  await ensureIbkrPaperSession(accountId);
  return ibkrRequest("GET", `/iserver/account/order/status/${encodeURIComponent(orderId)}`);
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
