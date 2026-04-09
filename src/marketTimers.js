const ET_TIME_ZONE = "America/New_York";
const INDEX_OPTION_SYMBOLS = new Set(["SPX", "XSP", "RUT", "MRUT", "VIX"]);
const PM_SETTLED_INDEX_SYMBOLS = new Set(["SPX", "XSP", "RUT", "MRUT"]);
const CRYPTO_UNDERLYINGS = new Set(["BTC-USD", "ETH-USD"]);
const COMMODITY_UNDERLYINGS = new Set(["XAU-USD", "WTI-USD"]);

function normalizeSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeIsoDate(value) {
  const normalizedValue = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalizedValue) ? normalizedValue : "";
}

function sortIsoDates(values = []) {
  return [...new Set(
    values
      .map((value) => normalizeIsoDate(value))
      .filter(Boolean)
  )].sort();
}

export function createMarketTimerContext({
  source = "",
  label = "",
  optionSymbol = "",
  underlyingSymbol = "",
  referenceSymbol = "",
  optionExpiries = [],
  settlementType = "",
  exerciseStyle = ""
} = {}) {
  const normalizedOptionExpiries = sortIsoDates(optionExpiries);

  return {
    source: String(source ?? "").trim(),
    label: String(label ?? "").trim(),
    optionSymbol: normalizeSymbol(optionSymbol),
    underlyingSymbol: normalizeSymbol(underlyingSymbol),
    referenceSymbol: String(referenceSymbol ?? "").trim().toUpperCase(),
    optionExpiries: normalizedOptionExpiries,
    optionExpiry: normalizedOptionExpiries[0] ?? "",
    settlementType: String(settlementType ?? "").trim().toLowerCase(),
    exerciseStyle: String(exerciseStyle ?? "").trim().toLowerCase()
  };
}

function getZonedParts(date, timeZone = ET_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function getTimeZoneOffsetMs(date, timeZone = ET_TIME_ZONE) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function makeDateInTimeZone(dateIso, hour = 0, minute = 0, second = 0, timeZone = ET_TIME_ZONE) {
  const [year, month, day] = String(dateIso)
    .split("-")
    .map((part) => Number(part));

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let zonedDate = new Date(utcGuess - getTimeZoneOffsetMs(new Date(utcGuess), timeZone));
  const offsetAfterShift = getTimeZoneOffsetMs(zonedDate, timeZone);
  zonedDate = new Date(utcGuess - offsetAfterShift);
  return zonedDate;
}

function toEtIsoDate(date) {
  const parts = getZonedParts(date, ET_TIME_ZONE);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addCalendarDaysIso(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getWeekday(dateIso) {
  return new Date(`${dateIso}T00:00:00.000Z`).getUTCDay();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function capitalize(value) {
  const raw = String(value ?? "").trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
}

function formatCountdown(ms) {
  const remainingMs = Math.max(Number(ms) || 0, 0);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function buildUpcomingExchangeMap(upcoming = []) {
  const entriesByExchange = new Map();

  for (const entry of upcoming) {
    const exchange = normalizeSymbol(entry?.exchange);
    const dateIso = normalizeIsoDate(entry?.date);

    if (!exchange || !dateIso) {
      continue;
    }

    const exchangeEntries = entriesByExchange.get(exchange) ?? new Map();
    exchangeEntries.set(dateIso, {
      date: dateIso,
      exchange,
      name: String(entry?.name ?? "").trim(),
      status: String(entry?.status ?? "").trim().toLowerCase(),
      open: entry?.open ? new Date(entry.open) : null,
      close: entry?.close ? new Date(entry.close) : null
    });
    entriesByExchange.set(exchange, exchangeEntries);
  }

  return entriesByExchange;
}

function resolveUsCalendarExchange(referenceSymbol = "", optionSymbol = "", underlyingSymbol = "") {
  const exchangePrefix = String(referenceSymbol ?? "").split(":")[0]?.trim().toUpperCase() ?? "";
  const normalizedOptionSymbol = normalizeSymbol(optionSymbol);
  const normalizedUnderlyingSymbol = normalizeSymbol(underlyingSymbol);

  if (exchangePrefix === "NASDAQ") {
    return "NASDAQ";
  }

  if (exchangePrefix === "NYSE") {
    return "NYSE";
  }

  if (exchangePrefix === "AMEX" || exchangePrefix === "ARCA" || exchangePrefix === "CBOE" || exchangePrefix === "SP") {
    return "NYSE";
  }

  if (normalizedOptionSymbol === "QQQ" || normalizedOptionSymbol === "IBIT" || normalizedOptionSymbol === "ETHA") {
    return "NASDAQ";
  }

  if (normalizedUnderlyingSymbol === "QQQ" || normalizedUnderlyingSymbol === "IBIT" || normalizedUnderlyingSymbol === "ETHA") {
    return "NASDAQ";
  }

  return "NYSE";
}

function getUpcomingEntry(entriesByExchange, exchange, dateIso) {
  return entriesByExchange.get(exchange)?.get(dateIso) ?? null;
}

function isUsExchangeClosed(entriesByExchange, exchange, dateIso) {
  const weekday = getWeekday(dateIso);
  if (weekday === 0 || weekday === 6) {
    return true;
  }

  return getUpcomingEntry(entriesByExchange, exchange, dateIso)?.status === "closed";
}

function findNextUsTradingDay(entriesByExchange, exchange, startDateIso) {
  for (let offset = 0; offset < 14; offset += 1) {
    const candidateDate = addCalendarDaysIso(startDateIso, offset);
    if (!isUsExchangeClosed(entriesByExchange, exchange, candidateDate)) {
      return candidateDate;
    }
  }

  return "";
}

function findPreviousUsTradingDay(entriesByExchange, exchange, startDateIso) {
  for (let offset = 0; offset < 14; offset += 1) {
    const candidateDate = addCalendarDaysIso(startDateIso, -offset);
    if (!isUsExchangeClosed(entriesByExchange, exchange, candidateDate)) {
      return candidateDate;
    }
  }

  return "";
}

function getUsRegularSession(entriesByExchange, exchange, dateIso) {
  if (!dateIso || isUsExchangeClosed(entriesByExchange, exchange, dateIso)) {
    return null;
  }

  const entry = getUpcomingEntry(entriesByExchange, exchange, dateIso);

  return {
    open: entry?.open ?? makeDateInTimeZone(dateIso, 9, 30),
    close: entry?.close ?? makeDateInTimeZone(dateIso, 16, 0),
    isEarlyClose: entry?.status === "early-close"
  };
}

function findNextTimedEtEvent(now, matcher, hour, minute = 0) {
  const todayEt = toEtIsoDate(now);

  for (let offset = -1; offset < 10; offset += 1) {
    const dateIso = addCalendarDaysIso(todayEt, offset);
    if (!matcher(getWeekday(dateIso))) {
      continue;
    }

    const eventDate = makeDateInTimeZone(dateIso, hour, minute);
    if (eventDate.getTime() > now.getTime()) {
      return eventDate;
    }
  }

  return null;
}

function classifyUnderlyingMarket(context) {
  const underlyingSymbol = normalizeSymbol(context?.underlyingSymbol);
  const referenceSymbol = String(context?.referenceSymbol ?? "").toUpperCase();

  if (CRYPTO_UNDERLYINGS.has(underlyingSymbol) || referenceSymbol.startsWith("BINANCE:")) {
    return "crypto";
  }

  if (
    COMMODITY_UNDERLYINGS.has(underlyingSymbol) ||
    referenceSymbol.startsWith("COMEX:") ||
    referenceSymbol.startsWith("NYMEX:") ||
    referenceSymbol.startsWith("CME:")
  ) {
    return "futures";
  }

  if (referenceSymbol.startsWith("FX:")) {
    return "fx";
  }

  return "us-equity";
}

function classifyOptionMarket(context) {
  const optionSymbol = normalizeSymbol(context?.optionSymbol);

  if (!optionSymbol) {
    return "";
  }

  if (INDEX_OPTION_SYMBOLS.has(optionSymbol)) {
    return "index-option";
  }

  return "equity-option";
}

function resolveUnderlyingStatus(context, marketStatusPayload, now) {
  const underlyingMarket = classifyUnderlyingMarket(context);
  const statusNow = marketStatusPayload?.statusNow ?? null;

  if (underlyingMarket === "crypto") {
    const state = statusNow?.currencies?.crypto;
    return {
      label: state === "open" ? "Open" : state ? capitalize(state) : "24/7",
      tone: "live"
    };
  }

  if (underlyingMarket === "fx") {
    const state = statusNow?.currencies?.fx;
    return {
      label: state === "open" ? "Open" : state ? capitalize(state) : "Open",
      tone: "live"
    };
  }

  if (underlyingMarket === "us-equity") {
    if (statusNow?.market === "open") {
      return {
        label: "Open",
        tone: "live"
      };
    }

    if (statusNow?.market === "extended-hours") {
      return {
        label: statusNow.earlyHours ? "Pre" : statusNow.afterHours ? "Post" : "Extended",
        tone: "warning"
      };
    }

    return {
      label: "Closed",
      tone: "ghost"
    };
  }

  const nextFuturesClose = findNextTimedEtEvent(now, (weekday) => weekday >= 1 && weekday <= 5, 17, 0);
  const nextFuturesOpen = findNextTimedEtEvent(now, (weekday) => weekday >= 0 && weekday <= 4, 18, 0);

  return {
    label:
      nextFuturesClose && nextFuturesOpen && nextFuturesClose.getTime() < nextFuturesOpen.getTime()
        ? "Open"
        : "Closed",
    tone:
      nextFuturesClose && nextFuturesOpen && nextFuturesClose.getTime() < nextFuturesOpen.getTime()
        ? "live"
        : "ghost"
  };
}

function buildFixedEntry(key, label, countdown, detail, tone = "ghost") {
  return {
    key,
    label,
    countdown,
    detail,
    tone
  };
}

function buildCountdownEntry(key, label, targetDate, now, detail, tone = "ghost") {
  if (!(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) {
    return buildFixedEntry(key, label, "n/a", "Unavailable", "ghost");
  }

  return {
    key,
    label,
    countdown: formatCountdown(targetDate.getTime() - now.getTime()),
    detail,
    tone
  };
}

function buildSessionEntry(key, label, occurrence, now, activeTone = "live") {
  if (!occurrence?.start || !occurrence?.end) {
    return buildFixedEntry(key, label, "n/a", "Unavailable", "ghost");
  }

  const isActive = now.getTime() >= occurrence.start.getTime() && now.getTime() < occurrence.end.getTime();
  const countdownTarget = isActive ? occurrence.end : occurrence.start;
  const countdownTone = isActive ? activeTone : countdownTarget.getTime() - now.getTime() <= 60 * 60 * 1000 ? "warning" : "ghost";

  return {
    key,
    label,
    countdown: formatCountdown(countdownTarget.getTime() - now.getTime()),
    detail: isActive ? "live" : "starts in",
    tone: countdownTone
  };
}

function buildUsEquityOptionSessions(entriesByExchange, exchange, dateIso) {
  const regularSession = getUsRegularSession(entriesByExchange, exchange, dateIso);
  if (!regularSession) {
    return null;
  }

  return {
    pre: {
      start: makeDateInTimeZone(dateIso, 7, 30),
      end: makeDateInTimeZone(dateIso, 9, 25)
    },
    open: {
      start: makeDateInTimeZone(dateIso, 9, 30),
      end: regularSession.close
    },
    post: {
      start: regularSession.close,
      end: addMinutes(regularSession.close, 15)
    }
  };
}

function buildUsIndexOptionSessions(entriesByExchange, exchange, dateIso) {
  const regularSession = getUsRegularSession(entriesByExchange, exchange, dateIso);
  if (!regularSession) {
    return null;
  }

  const regularClose = addMinutes(regularSession.close, 15);

  return {
    pre: {
      start: makeDateInTimeZone(addCalendarDaysIso(dateIso, -1), 20, 15),
      end: makeDateInTimeZone(dateIso, 9, 25)
    },
    open: {
      start: makeDateInTimeZone(dateIso, 9, 30),
      end: regularClose
    },
    post: {
      start: regularClose,
      end: addMinutes(regularClose, 45)
    }
  };
}

function findNextOptionSession(now, entriesByExchange, exchange, optionMarketClass, sessionKey) {
  const todayEt = toEtIsoDate(now);
  const sessionBuilder =
    optionMarketClass === "index-option"
      ? buildUsIndexOptionSessions
      : buildUsEquityOptionSessions;

  for (let offset = 0; offset < 10; offset += 1) {
    const dateIso = addCalendarDaysIso(todayEt, offset);
    const sessions = sessionBuilder(entriesByExchange, exchange, dateIso);
    const occurrence = sessions?.[sessionKey] ?? null;

    if (!occurrence?.start || !occurrence?.end || occurrence.end.getTime() <= now.getTime()) {
      continue;
    }

    return occurrence;
  }

  return null;
}

function buildUnderlyingEntries(context, entriesByExchange, now) {
  const underlyingMarket = classifyUnderlyingMarket(context);

  if (underlyingMarket === "crypto") {
    return [];
  }

  if (underlyingMarket === "fx") {
    const nextOpen = findNextTimedEtEvent(now, (weekday) => weekday === 0, 17, 0);
    const nextClose = findNextTimedEtEvent(now, (weekday) => weekday === 5, 17, 0);

    return [
      buildCountdownEntry("underlying-open", "Underlying open", nextOpen, now, "next session", "ghost"),
      buildCountdownEntry("underlying-close", "Underlying close", nextClose, now, "next close", "warning")
    ];
  }

  if (underlyingMarket === "futures") {
    const nextOpen = findNextTimedEtEvent(now, (weekday) => weekday >= 0 && weekday <= 4, 18, 0);
    const nextClose = findNextTimedEtEvent(now, (weekday) => weekday >= 1 && weekday <= 5, 17, 0);

    return [
      buildCountdownEntry("underlying-open", "Underlying open", nextOpen, now, "next session", "ghost"),
      buildCountdownEntry("underlying-close", "Underlying close", nextClose, now, "next break", "warning")
    ];
  }

  const exchange = resolveUsCalendarExchange(context.referenceSymbol, context.optionSymbol, context.underlyingSymbol);
  const todayEt = toEtIsoDate(now);
  const todaySession = getUsRegularSession(entriesByExchange, exchange, todayEt);
  const nextTradingDate = findNextUsTradingDay(
    entriesByExchange,
    exchange,
    todaySession && now.getTime() < todaySession.open.getTime() ? todayEt : addCalendarDaysIso(todayEt, 1)
  );
  const nextCloseDate =
    todaySession && now.getTime() < todaySession.close.getTime()
      ? todayEt
      : findNextUsTradingDay(entriesByExchange, exchange, addCalendarDaysIso(todayEt, 1));
  const nextOpen = nextTradingDate ? getUsRegularSession(entriesByExchange, exchange, nextTradingDate)?.open ?? null : null;
  const nextClose = nextCloseDate ? getUsRegularSession(entriesByExchange, exchange, nextCloseDate)?.close ?? null : null;

  return [
    buildCountdownEntry("underlying-open", "Underlying open", nextOpen, now, "regular session", "ghost"),
    buildCountdownEntry("underlying-close", "Underlying close", nextClose, now, "regular close", "warning")
  ];
}

function buildOptionEntries(context, entriesByExchange, now) {
  const optionMarketClass = classifyOptionMarket(context);
  if (!optionMarketClass) {
    return [];
  }

  const exchange = resolveUsCalendarExchange(context.referenceSymbol, context.optionSymbol, context.underlyingSymbol);

  return [
    buildSessionEntry(
      "option-pre",
      "Option pre",
      findNextOptionSession(now, entriesByExchange, exchange, optionMarketClass, "pre"),
      now,
      "warning"
    ),
    buildSessionEntry(
      "option-open",
      "Option open",
      findNextOptionSession(now, entriesByExchange, exchange, optionMarketClass, "open"),
      now,
      "live"
    ),
    buildSessionEntry(
      "option-post",
      "Option post",
      findNextOptionSession(now, entriesByExchange, exchange, optionMarketClass, "post"),
      now,
      "warning"
    )
  ];
}

function buildExpiryEntry(context, entriesByExchange, now) {
  if (!context?.optionExpiry) {
    return buildFixedEntry("option-expiry", "Expiry", "n/a", "No contract", "ghost");
  }

  const exchange = resolveUsCalendarExchange(context.referenceSymbol, context.optionSymbol, context.underlyingSymbol);
  const optionMarketClass = classifyOptionMarket(context);
  const expiryTradingDate = findPreviousUsTradingDay(entriesByExchange, exchange, context.optionExpiry);
  const regularSession = getUsRegularSession(entriesByExchange, exchange, expiryTradingDate);

  if (!regularSession) {
    return buildFixedEntry("option-expiry", "Expiry", "n/a", "Unavailable", "ghost");
  }

  let expiryClose = addMinutes(regularSession.close, 15);

  if (optionMarketClass === "index-option" && PM_SETTLED_INDEX_SYMBOLS.has(normalizeSymbol(context.optionSymbol))) {
    expiryClose = regularSession.close;
  }

  if (now.getTime() >= expiryClose.getTime()) {
    return buildFixedEntry("option-expiry", "Expiry", "Closed", "expired", "ghost");
  }

  return {
    key: "option-expiry",
    label: "Expiry",
    countdown: formatCountdown(expiryClose.getTime() - now.getTime()),
    detail: toEtIsoDate(now) === expiryTradingDate ? "cuts off in" : "ends in",
    tone: expiryClose.getTime() - now.getTime() <= 24 * 60 * 60 * 1000 ? "warning" : "ghost"
  };
}

function buildSubtitle(context) {
  return [
    context.optionSymbol ? `${context.optionSymbol} options` : "",
    context.underlyingSymbol ? `${context.underlyingSymbol} underlying` : ""
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildMarketTimerModel(context, marketStatusPayload, nowMs = Date.now()) {
  if (!context?.label && !context?.optionSymbol && !context?.underlyingSymbol) {
    return null;
  }

  const now = new Date(nowMs);
  const entriesByExchange = buildUpcomingExchangeMap(marketStatusPayload?.upcoming ?? []);

  return {
    title: context.label || context.optionSymbol || context.underlyingSymbol,
    subtitle: buildSubtitle(context),
    status: resolveUnderlyingStatus(context, marketStatusPayload, now),
    entries: [
      ...buildOptionEntries(context, entriesByExchange, now),
      buildExpiryEntry(context, entriesByExchange, now),
      ...buildUnderlyingEntries(context, entriesByExchange, now)
    ]
  };
}

export function buildUnderlyingMarketMonitorModels(
  contexts = [],
  marketStatusPayload,
  nowMs = Date.now()
) {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    return [];
  }

  const now = new Date(nowMs);
  const entriesByExchange = buildUpcomingExchangeMap(marketStatusPayload?.upcoming ?? []);

  return contexts
    .map((context) => createMarketTimerContext(context))
    .map((context) => {
      const entries = buildUnderlyingEntries(context, entriesByExchange, now);

      if (!entries.length) {
        return null;
      }

      return {
        key:
          context.source ||
          context.label ||
          context.underlyingSymbol ||
          context.referenceSymbol,
        title: context.label || context.underlyingSymbol || context.referenceSymbol,
        status: resolveUnderlyingStatus(context, marketStatusPayload, now),
        open: entries.find((entry) => entry.key === "underlying-open") ?? null,
        close: entries.find((entry) => entry.key === "underlying-close") ?? null
      };
    })
    .filter(Boolean);
}
