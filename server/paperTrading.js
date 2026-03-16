function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function scoreQuestionMatch(referenceQuestion, candidateQuestion) {
  const stopWords = new Set(["the", "a", "an", "on", "of", "for", "to", "in", "by", "at", "will"]);
  const referenceTokens = normalizeText(referenceQuestion)
    .split(" ")
    .map((token) => token.replace(/[^a-z0-9$]/g, ""))
    .filter((token) => token && !stopWords.has(token));
  const candidate = normalizeText(candidateQuestion);

  return referenceTokens.reduce((score, token) => (candidate.includes(token) ? score + 1 : score), 0);
}

function parseTargetFromQuestion(question) {
  const match = String(question ?? "").match(
    /(?:above|over|reach(?:es)?|hits?|at least)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i
  );

  if (!match) {
    return null;
  }

  const rawValue = Number(match[1].replace(/,/g, ""));
  const scale = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;

  return rawValue * scale;
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

function normalizeVolatility(value, fallback = 0.24) {
  const numericValue = toNumber(value, fallback);
  if (!(numericValue > 0)) {
    return fallback;
  }

  return numericValue > 2 ? numericValue / 100 : numericValue;
}

function normalizePaperOrderStatus(value) {
  return String(value ?? "open").toLowerCase() === "closed" ? "closed" : "open";
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

function addHours(timestamp, hours) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized) {
    return "";
  }

  const date = new Date(normalized);
  date.setUTCHours(date.getUTCHours() + hours, 0, 0, 0);
  return date.toISOString();
}

function floorToHourTimestamp(timestamp) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized) {
    return "";
  }

  const date = new Date(normalized);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
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

function pickOptionMark(contract, fallback = 0) {
  const lastPrice = toNumber(contract?.lastPrice);
  if (lastPrice > 0) {
    return lastPrice;
  }

  const mark = toNumber(contract?.mark);
  if (mark > 0) {
    return mark;
  }

  const bid = toNumber(contract?.bid);
  const ask = toNumber(contract?.ask);
  if (bid != null && ask != null && bid >= 0 && ask >= 0) {
    return (bid + ask) / 2;
  }

  if (ask > 0) {
    return ask;
  }

  if (bid > 0) {
    return bid;
  }

  return fallback;
}

function quoteLookup(quotes) {
  return new Map((quotes ?? []).map((quote) => [quote.symbol, quote]));
}

function resolveQuotePrice(quotesBySymbol, symbol, fallback = 0) {
  return toNumber(quotesBySymbol.get(symbol)?.regularMarketPrice, fallback) ?? fallback;
}

function findMatchingMarket(order, polymarketMarkets) {
  const markets = polymarketMarkets ?? [];
  const orderUrl = String(order.polymarketUrl ?? "").trim();
  const normalizedQuestion = normalizeText(order.polymarketQuestion);
  const parsedQuestionTarget = parseTargetFromQuestion(order.polymarketQuestion);
  const targetUnderlyingValue =
    toNumber(order.marketContext?.targetUnderlyingValue, null) ??
    toNumber(order.valuationContext?.targetUnderlyingValue, null) ??
    parsedQuestionTarget;
  const exactTargetMatch = (candidates) =>
    candidates.find((market) => {
      const marketTarget = parseTargetFromQuestion(market.question);
      return marketTarget != null && targetUnderlyingValue != null && Math.abs(marketTarget - targetUnderlyingValue) < 0.5;
    }) ?? null;
  const questionRank = (candidates) =>
    [...candidates].sort(
      (left, right) =>
        scoreQuestionMatch(order.polymarketQuestion, right.question) -
        scoreQuestionMatch(order.polymarketQuestion, left.question)
    )[0] ?? null;
  const scopedMarkets = orderUrl ? markets.filter((market) => market.url === orderUrl) : markets;

  if (!normalizedQuestion && targetUnderlyingValue == null) {
    return scopedMarkets[0] ?? null;
  }

  const exactQuestionMatch = scopedMarkets.find(
    (market) => normalizeText(market.question) === normalizedQuestion
  ) ?? markets.find((market) => normalizeText(market.question) === normalizedQuestion);
  if (exactQuestionMatch) {
    return exactQuestionMatch;
  }

  const scopedTargetMatch = exactTargetMatch(scopedMarkets);
  if (scopedTargetMatch) {
    return scopedTargetMatch;
  }

  const globalTargetMatch = exactTargetMatch(markets);
  if (globalTargetMatch) {
    return globalTargetMatch;
  }

  if (normalizedQuestion) {
    const scopedQuestionMatch = questionRank(scopedMarkets);
    if (scopedQuestionMatch) {
      return scopedQuestionMatch;
    }

    return questionRank(markets);
  }

  return scopedMarkets[0] ?? null;
}

function findMatchingOption(leg, optionMatches, proxySymbol) {
  const contractSymbol = String(leg.contractSymbol ?? "").trim();
  if (contractSymbol) {
    const exactMatch = (optionMatches ?? []).find((contract) => contract.contractSymbol === contractSymbol);
    if (exactMatch) {
      return exactMatch;
    }
  }

  const normalizedStrike = toNumber(leg.strike);
  return (
    (optionMatches ?? []).find((contract) => {
      if (contract.rootSymbol !== proxySymbol) {
        return false;
      }

      if (String(contract.optionType ?? "call") !== String(leg.optionType ?? "call")) {
        return false;
      }

      if (String(contract.expiration ?? "") !== String(leg.expiry ?? "")) {
        return false;
      }

      if (normalizedStrike == null) {
        return false;
      }

      return Math.abs(Number(contract.strike) - normalizedStrike) < 0.01;
    }) ?? null
  );
}

function resolveBinaryYesPrice({
  order,
  liveMarket,
  currentUnderlyingSpot,
  targetUnderlyingValue,
  referenceYesPrice
}) {
  const liveYesPrice = toNumber(liveMarket?.yesPrice);
  if (liveYesPrice != null) {
    return clamp(liveYesPrice, 0.001, 0.999);
  }

  const resolutionDate = String(order.polymarketResolutionDate ?? "");
  const todayIso = new Date().toISOString().slice(0, 10);

  if (
    resolutionDate &&
    todayIso >= resolutionDate &&
    targetUnderlyingValue > 0 &&
    currentUnderlyingSpot > 0
  ) {
    return currentUnderlyingSpot >= targetUnderlyingValue ? 1 : 0;
  }

  return clamp(referenceYesPrice, 0.001, 0.999);
}

function sanitizePaperLeg(leg, index, proxySymbol, orderStatus = "open") {
  const kind = leg?.kind === "binary" ? "binary" : "option";
  const action = String(leg?.action ?? "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const quantity = Math.max(Math.round(toNumber(leg?.quantity, 0) ?? 0), 0);
  const rawEntryPrice = Math.max(toNumber(leg?.entryPrice, 0) ?? 0, 0);
  const entryPrice = kind === "binary" ? clamp(rawEntryPrice, 0, 1) : rawEntryPrice;
  const rawClosedPrice = toNumber(leg?.closedPrice, null);
  const closedPrice =
    orderStatus === "closed"
      ? kind === "binary"
        ? rawClosedPrice == null
          ? null
          : clamp(rawClosedPrice, 0, 1)
        : rawClosedPrice == null
          ? null
          : Math.max(rawClosedPrice, 0)
      : null;

  return {
    id: String(leg?.id ?? `paper-leg-${index + 1}`),
    label: String(leg?.label ?? `${kind === "binary" ? "Polymarket" : "Option"} ${index + 1}`),
    kind,
    action,
    quantity,
    entryPrice,
    contractMultiplier:
      kind === "option" ? Math.max(toNumber(leg?.contractMultiplier, 100) ?? 100, 1) : 1,
    optionType: kind === "option" ? (String(leg?.optionType ?? "call").toLowerCase() === "put" ? "put" : "call") : null,
    expiry: kind === "option" ? String(leg?.expiry ?? "") : null,
    strike: kind === "option" ? toNumber(leg?.strike, 0) ?? 0 : null,
    contractSymbol: kind === "option" ? String(leg?.contractSymbol ?? "") : "",
    rootSymbol: kind === "option" ? String(leg?.rootSymbol ?? proxySymbol ?? "") : "",
    impliedVolatility: kind === "option" ? normalizeVolatility(leg?.impliedVolatility, 0.24) : null,
    riskFreeRate: kind === "option" ? toNumber(leg?.riskFreeRate, 0.0425) ?? 0.0425 : null,
    quoteSource: kind === "option" ? String(leg?.quoteSource ?? "seed") : String(leg?.quoteSource ?? "Polymarket"),
    isLive: leg?.isLive === true,
    outcome: kind === "binary" ? (String(leg?.outcome ?? "YES").toUpperCase() === "NO" ? "NO" : "YES") : null,
    closedPrice,
    closedExposure:
      orderStatus === "closed" ? Math.max(toNumber(leg?.closedExposure, 0) ?? 0, 0) : null,
    closedNetMarkedValue:
      orderStatus === "closed" ? toNumber(leg?.closedNetMarkedValue, null) : null,
    realizedProfitLossValue:
      orderStatus === "closed" ? toNumber(leg?.realizedProfitLossValue, 0) ?? 0 : null,
    realizedProfitLossPercent:
      orderStatus === "closed" ? toNumber(leg?.realizedProfitLossPercent, null) : null
  };
}

export function sanitizePaperOrderPayload(payload, defaults = {}) {
  const source = {
    ...defaults,
    ...(payload ?? {})
  };
  const purchaseDate = String(
    source.purchaseDate ?? defaults.purchaseDate ?? new Date().toISOString().slice(0, 10)
  ).trim();

  if (!parseIsoDate(purchaseDate)) {
    throw new Error("purchaseDate must be a valid YYYY-MM-DD value");
  }

  const status = normalizePaperOrderStatus(source.status ?? defaults.status ?? "open");
  const closedAt = status === "closed" ? normalizeTimestamp(source.closedAt ?? defaults.closedAt ?? "") : "";
  const closedDateInput =
    source.closedDate ?? defaults.closedDate ?? (closedAt ? closedAt.slice(0, 10) : "");
  const closedDate = status === "closed" ? String(closedDateInput ?? "").trim() : "";

  if (status === "closed" && closedDate && !parseIsoDate(closedDate)) {
    throw new Error("closedDate must be a valid YYYY-MM-DD value");
  }

  const marketContext = {
    proxySymbol: String(source.marketContext?.proxySymbol ?? defaults.marketContext?.proxySymbol ?? ""),
    underlyingSymbol: String(source.marketContext?.underlyingSymbol ?? defaults.marketContext?.underlyingSymbol ?? ""),
    currentProxySpot:
      toNumber(source.marketContext?.currentProxySpot, defaults.marketContext?.currentProxySpot ?? 0) ?? 0,
    currentUnderlyingSpot:
      toNumber(source.marketContext?.currentUnderlyingSpot, defaults.marketContext?.currentUnderlyingSpot ?? 0) ?? 0,
    conversionRatio:
      toNumber(source.marketContext?.conversionRatio, defaults.marketContext?.conversionRatio ?? 0) ?? 0,
    targetUnderlyingValue:
      toNumber(source.marketContext?.targetUnderlyingValue, defaults.marketContext?.targetUnderlyingValue ?? 0) ?? 0,
    impliedVolatility: normalizeVolatility(
      source.marketContext?.impliedVolatility,
      defaults.marketContext?.impliedVolatility ?? 0.24
    ),
    riskFreeRate: toNumber(source.marketContext?.riskFreeRate, defaults.marketContext?.riskFreeRate ?? 0.0425) ?? 0.0425
  };

  const legsInput = Array.isArray(source.legs) ? source.legs : defaults.legs;
  const legs = Array.isArray(legsInput)
    ? legsInput.map((leg, index) => sanitizePaperLeg(leg, index, marketContext.proxySymbol, status))
    : [];

  if (!legs.length) {
    throw new Error("At least one paper-trade leg is required");
  }

  const referenceYesPrice = clamp(
    toNumber(source.marketReferenceYesPrice, defaults.marketReferenceYesPrice ?? 0.5) ?? 0.5,
    0.001,
    0.999
  );
  const closeSummary =
    status === "closed"
      ? {
          currentHoldingValue:
            Math.max(toNumber(source.closeSummary?.currentHoldingValue, defaults.closeSummary?.currentHoldingValue ?? 0) ?? 0, 0),
          netMarkedValue:
            toNumber(source.closeSummary?.netMarkedValue, defaults.closeSummary?.netMarkedValue ?? 0) ?? 0,
          profitLossValue:
            toNumber(source.closeSummary?.profitLossValue, defaults.closeSummary?.profitLossValue ?? 0) ?? 0,
          profitLossPercent:
            toNumber(source.closeSummary?.profitLossPercent, defaults.closeSummary?.profitLossPercent ?? null)
        }
      : null;

  return {
    strategyId: String(source.strategyId ?? defaults.strategyId ?? "strategy-1"),
    strategyName: String(source.strategyName ?? defaults.strategyName ?? "Strategy"),
    combinationId: String(source.combinationId ?? defaults.combinationId ?? `paper-${Date.now()}`),
    combinationLabel: String(source.combinationLabel ?? defaults.combinationLabel ?? "Paper trade"),
    assetLabel: String(source.assetLabel ?? defaults.assetLabel ?? ""),
    strategyType: String(source.strategyType ?? defaults.strategyType ?? ""),
    purchaseDate,
    polymarketQuestion: String(source.polymarketQuestion ?? defaults.polymarketQuestion ?? ""),
    polymarketUrl: String(source.polymarketUrl ?? defaults.polymarketUrl ?? ""),
    polymarketSource: String(source.polymarketSource ?? defaults.polymarketSource ?? "Polymarket"),
    polymarketResolutionDate: String(
      source.polymarketResolutionDate ?? defaults.polymarketResolutionDate ?? ""
    ),
    strategyCloseDate: String(source.strategyCloseDate ?? defaults.strategyCloseDate ?? ""),
    status,
    closedAt,
    closedDate,
    closeSummary,
    marketReferenceYesPrice: referenceYesPrice,
    marketContext,
    legs
  };
}

export function applyPaperOrderPatch(order, patch) {
  const patchLegs = new Map(
    Array.isArray(patch?.legs)
      ? patch.legs.map((leg) => [String(leg?.id ?? ""), leg])
      : []
  );

  const mergedLegs = order.legs.map((leg) =>
    patchLegs.has(String(leg.id))
      ? {
          ...leg,
          entryPrice: patchLegs.get(String(leg.id))?.entryPrice ?? leg.entryPrice,
          quantity: patchLegs.get(String(leg.id))?.quantity ?? leg.quantity
        }
      : leg
  );

  return sanitizePaperOrderPayload(
    {
      ...order,
      purchaseDate: patch?.purchaseDate ?? order.purchaseDate,
      status: patch?.status ?? order.status,
      closedAt: patch?.closedAt ?? order.closedAt,
      closedDate: patch?.closedDate ?? order.closedDate,
      closeSummary: patch?.closeSummary ?? order.closeSummary,
      legs: mergedLegs
    },
    order
  );
}

export function closePaperOrderPayload(order, valuedOrder, closedAt = new Date().toISOString()) {
  const closedTimestamp = normalizeTimestamp(closedAt) || new Date().toISOString();
  const closedDate = closedTimestamp.slice(0, 10);

  return sanitizePaperOrderPayload(
    {
      ...order,
      status: "closed",
      closedAt: closedTimestamp,
      closedDate,
      closeSummary: {
        currentHoldingValue: valuedOrder.currentHoldingValue,
        netMarkedValue: valuedOrder.netMarkedValue,
        profitLossValue: valuedOrder.profitLossValue,
        profitLossPercent: valuedOrder.profitLossPercent
      },
      legs: order.legs.map((leg) => {
        const valuedLeg = valuedOrder.legs.find((item) => String(item.id) === String(leg.id));

        return {
          ...leg,
          closedPrice: valuedLeg?.currentPrice ?? null,
          closedExposure: valuedLeg?.currentExposure ?? 0,
          closedNetMarkedValue: valuedLeg?.netMarkedValue ?? 0,
          realizedProfitLossValue: valuedLeg?.profitLossValue ?? 0,
          realizedProfitLossPercent: valuedLeg?.profitLossPercent ?? null
        };
      })
    },
    order
  );
}

export function buildPaperOrderSnapshot(order, capturedAt = new Date().toISOString()) {
  const timestamp = normalizeTimestamp(capturedAt) || new Date().toISOString();

  return {
    orderId: Number(order.id),
    status: String(order.status ?? "open"),
    currentHoldingValue: Math.max(toNumber(order.currentHoldingValue, 0) ?? 0, 0),
    netMarkedValue: toNumber(order.netMarkedValue, 0) ?? 0,
    profitLossValue: toNumber(order.profitLossValue, 0) ?? 0,
    profitLossPercent: toNumber(order.profitLossPercent, null),
    capturedAt: timestamp
  };
}

function buildFallbackHistoryPoints(order, startAt, endAt) {
  if (!startAt) {
    return [];
  }

  const currentPoint = {
    capturedAt: endAt || startAt,
    profitLossValue: toNumber(order.profitLossValue, 0) ?? 0,
    currentHoldingValue: Math.max(toNumber(order.currentHoldingValue, 0) ?? 0, 0),
    netMarkedValue: toNumber(order.netMarkedValue, 0) ?? 0,
    profitLossPercent: toNumber(order.profitLossPercent, null)
  };

  if (!endAt || endAt === startAt) {
    return [currentPoint];
  }

  return [
    {
      ...currentPoint,
      capturedAt: startAt,
      profitLossValue: 0,
      netMarkedValue: 0,
      profitLossPercent: 0
    },
    currentPoint
  ];
}

function buildHourlyCandles(points) {
  const buckets = new Map();

  for (const point of points) {
    const bucketStart = floorToHourTimestamp(point.capturedAt);
    if (!bucketStart) {
      continue;
    }

    const currentProfitLoss = toNumber(point.profitLossValue, 0) ?? 0;
    const existingBucket = buckets.get(bucketStart);

    if (!existingBucket) {
      buckets.set(bucketStart, {
        bucketStart,
        bucketEnd: addHours(bucketStart, 1),
        open: currentProfitLoss,
        high: currentProfitLoss,
        low: currentProfitLoss,
        close: currentProfitLoss,
        firstCapturedAt: point.capturedAt,
        lastCapturedAt: point.capturedAt,
        sampleCount: 1
      });
      continue;
    }

    existingBucket.high = Math.max(existingBucket.high, currentProfitLoss);
    existingBucket.low = Math.min(existingBucket.low, currentProfitLoss);
    existingBucket.close = currentProfitLoss;
    existingBucket.lastCapturedAt = point.capturedAt;
    existingBucket.sampleCount += 1;
  }

  return [...buckets.values()].sort((left, right) => left.bucketStart.localeCompare(right.bucketStart));
}

function buildPaperOrderHistory(order, snapshots, asOf = new Date().toISOString()) {
  const startAt = normalizeTimestamp(order.createdAt);
  const endAt = order.isClosed
    ? normalizeTimestamp(order.closedAt) || startAt
    : normalizeTimestamp(asOf) || startAt;
  const normalizedSnapshots = (snapshots ?? [])
    .map((snapshot) => ({
      capturedAt: normalizeTimestamp(snapshot.capturedAt),
      profitLossValue: toNumber(snapshot.profitLossValue, 0) ?? 0,
      currentHoldingValue: Math.max(toNumber(snapshot.currentHoldingValue, 0) ?? 0, 0),
      netMarkedValue: toNumber(snapshot.netMarkedValue, 0) ?? 0,
      profitLossPercent: toNumber(snapshot.profitLossPercent, null)
    }))
    .filter((snapshot) => snapshot.capturedAt)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  const points = normalizedSnapshots.length
    ? normalizedSnapshots
    : buildFallbackHistoryPoints(order, startAt, endAt);

  if (startAt && points.length && points[0].capturedAt > startAt) {
    points.unshift({
      ...points[0],
      capturedAt: startAt,
      profitLossValue: 0,
      netMarkedValue: 0,
      profitLossPercent: 0
    });
  }

  if (endAt && points.length && points[points.length - 1].capturedAt < endAt) {
    points.push({
      capturedAt: endAt,
      profitLossValue: toNumber(order.profitLossValue, 0) ?? 0,
      currentHoldingValue: Math.max(toNumber(order.currentHoldingValue, 0) ?? 0, 0),
      netMarkedValue: toNumber(order.netMarkedValue, 0) ?? 0,
      profitLossPercent: toNumber(order.profitLossPercent, null)
    });
  }

  return {
    interval: "1h",
    live: !order.isClosed,
    startAt,
    endAt: points[points.length - 1]?.capturedAt ?? endAt ?? startAt,
    lastCapturedAt: points[points.length - 1]?.capturedAt ?? "",
    sampleCount: points.length,
    candles: buildHourlyCandles(points)
  };
}

export function attachPaperOrderHistory(paperPortfolio, historySnapshots, asOf = new Date().toISOString()) {
  const snapshotsByOrderId = new Map();

  for (const snapshot of historySnapshots ?? []) {
    const orderId = Number(snapshot.orderId);
    if (!snapshotsByOrderId.has(orderId)) {
      snapshotsByOrderId.set(orderId, []);
    }
    snapshotsByOrderId.get(orderId).push(snapshot);
  }

  const openOrders = (paperPortfolio?.openOrders ?? []).map((order) => ({
    ...order,
    history: buildPaperOrderHistory(order, snapshotsByOrderId.get(Number(order.id)) ?? [], asOf)
  }));
  const closedOrders = (paperPortfolio?.closedOrders ?? []).map((order) => ({
    ...order,
    history: buildPaperOrderHistory(order, snapshotsByOrderId.get(Number(order.id)) ?? [], asOf)
  }));

  return {
    ...paperPortfolio,
    orders: openOrders,
    openOrders,
    closedOrders
  };
}

export function buildPaperPortfolio({
  orders,
  quotes,
  polymarketMarkets,
  optionMatches
}) {
  const quotesBySymbol = quoteLookup(quotes);
  const valuedOrders = (orders ?? []).map((record) => {
    const order = record.position ?? record;
    const status = normalizePaperOrderStatus(order.status ?? "open");
    const isClosed = status === "closed";
    const proxySymbol = String(order.marketContext?.proxySymbol ?? "");
    const underlyingSymbol = String(order.marketContext?.underlyingSymbol ?? "");
    const fallbackProxySpot = toNumber(order.marketContext?.currentProxySpot, 0) ?? 0;
    const fallbackUnderlyingSpot = toNumber(order.marketContext?.currentUnderlyingSpot, 0) ?? 0;
    const currentProxySpot = resolveQuotePrice(quotesBySymbol, proxySymbol, fallbackProxySpot);
    const currentUnderlyingSpot = resolveQuotePrice(quotesBySymbol, underlyingSymbol, fallbackUnderlyingSpot);
    const conversionRatio =
      currentUnderlyingSpot > 0 && currentProxySpot > 0
        ? currentProxySpot / currentUnderlyingSpot
        : toNumber(order.marketContext?.conversionRatio, 0) ?? 0;
    const targetUnderlyingValue = toNumber(order.marketContext?.targetUnderlyingValue, 0) ?? 0;
    const impliedVolatility = normalizeVolatility(order.marketContext?.impliedVolatility, 0.24);
    const riskFreeRate = toNumber(order.marketContext?.riskFreeRate, 0.0425) ?? 0.0425;
    const liveMarket = findMatchingMarket(order, polymarketMarkets);
    const currentYesPrice = resolveBinaryYesPrice({
      order,
      liveMarket,
      currentUnderlyingSpot,
      targetUnderlyingValue,
      referenceYesPrice: order.marketReferenceYesPrice
    });
    const currentNoPrice =
      toNumber(liveMarket?.noPrice, null) != null
        ? clamp(toNumber(liveMarket?.noPrice, 0) ?? 0, 0.001, 0.999)
        : clamp(1 - currentYesPrice, 0.001, 0.999);

    const valuedLegs = order.legs.map((leg) => {
      const quantity = Math.max(Math.round(toNumber(leg.quantity, 0) ?? 0), 0);
      const direction = leg.action === "SHORT" ? -1 : 1;

      if (isClosed) {
        const units =
          leg.kind === "binary"
            ? quantity
            : quantity * Math.max(toNumber(leg.contractMultiplier, 100) ?? 100, 1);
        const entryPrice = toNumber(leg.entryPrice, 0) ?? 0;
        const entryExposure = Math.abs(entryPrice * units);
        const closedPrice =
          leg.closedPrice != null
            ? toNumber(leg.closedPrice, 0) ?? 0
            : entryPrice;
        const currentExposure =
          Math.max(toNumber(leg.closedExposure, entryExposure) ?? entryExposure, 0);
        const netMarkedValue =
          toNumber(leg.closedNetMarkedValue, direction * closedPrice * units) ??
          direction * closedPrice * units;
        const profitLossValue =
          toNumber(
            leg.realizedProfitLossValue,
            (leg.action === "SHORT" ? entryPrice - closedPrice : closedPrice - entryPrice) * units
          ) ??
          0;
        const profitLossPercent =
          toNumber(
            leg.realizedProfitLossPercent,
            entryExposure > 0 ? (profitLossValue / entryExposure) * 100 : null
          );

        return {
          ...leg,
          quantity,
          contractUnits: leg.kind === "option" ? units : undefined,
          currentPrice: closedPrice,
          entryExposure,
          currentExposure,
          netEntryValue: direction * entryPrice * units,
          netMarkedValue,
          profitLossValue,
          profitLossPercent,
          priceSource: "closed"
        };
      }

      if (leg.kind === "binary") {
        const markPrice = leg.outcome === "NO" ? currentNoPrice : currentYesPrice;
        const entryExposure = Math.abs((toNumber(leg.entryPrice, 0) ?? 0) * quantity);
        const currentExposure = Math.abs(markPrice * quantity);
        const profitLossValue =
          (leg.action === "SHORT"
            ? (toNumber(leg.entryPrice, 0) ?? 0) - markPrice
            : markPrice - (toNumber(leg.entryPrice, 0) ?? 0)) * quantity;

        return {
          ...leg,
          quantity,
          currentPrice: markPrice,
          entryExposure,
          currentExposure,
          netEntryValue: direction * (toNumber(leg.entryPrice, 0) ?? 0) * quantity,
          netMarkedValue: direction * markPrice * quantity,
          profitLossValue,
          profitLossPercent: entryExposure > 0 ? (profitLossValue / entryExposure) * 100 : null,
          priceSource:
            leg.outcome === "NO"
              ? liveMarket?.noPrice != null
                ? "live-market"
                : "reference"
              : liveMarket?.yesPrice != null
                ? "live-market"
                : "reference"
        };
      }

      const contractMultiplier = Math.max(toNumber(leg.contractMultiplier, 100) ?? 100, 1);
      const contractUnits = quantity * contractMultiplier;
      const liveOption = findMatchingOption(leg, optionMatches, proxySymbol);
      const liveMarkPrice = pickOptionMark(liveOption);
      const strike = toNumber(leg.strike, 0) ?? 0;
      const daysToExpiry = Math.max(differenceInDays(new Date().toISOString().slice(0, 10), leg.expiry), 0);
      const modeledMarkPrice =
        liveMarkPrice > 0
          ? liveMarkPrice
          : blackScholesPrice({
              type: String(leg.optionType ?? "call") === "put" ? "put" : "call",
              spot: Math.max(currentProxySpot, 0.01),
              strike,
              timeYears: Math.max(daysToExpiry / 365, 0),
              volatility: normalizeVolatility(leg.impliedVolatility, impliedVolatility),
              riskFreeRate: toNumber(leg.riskFreeRate, riskFreeRate) ?? riskFreeRate
            });
      const markPrice = Math.max(modeledMarkPrice, 0);
      const entryPrice = toNumber(leg.entryPrice, 0) ?? 0;
      const entryExposure = Math.abs(entryPrice * contractUnits);
      const currentExposure = Math.abs(markPrice * contractUnits);
      const profitLossValue =
        (leg.action === "SHORT" ? entryPrice - markPrice : markPrice - entryPrice) * contractUnits;

      return {
        ...leg,
        quantity,
        contractUnits,
        currentPrice: markPrice,
        entryExposure,
        currentExposure,
        netEntryValue: direction * entryPrice * contractUnits,
        netMarkedValue: direction * markPrice * contractUnits,
        profitLossValue,
        profitLossPercent: entryExposure > 0 ? (profitLossValue / entryExposure) * 100 : null,
        priceSource: liveOption ? (liveOption.isLive === true ? "live-option" : "modeled-option") : "black-scholes"
      };
    });

    const initialPurchaseValue = valuedLegs.reduce((sum, leg) => sum + leg.entryExposure, 0);
    const derivedCurrentHoldingValue = valuedLegs.reduce((sum, leg) => sum + leg.currentExposure, 0);
    const derivedProfitLossValue = valuedLegs.reduce((sum, leg) => sum + leg.profitLossValue, 0);
    const netEntryValue = valuedLegs.reduce((sum, leg) => sum + leg.netEntryValue, 0);
    const derivedNetMarkedValue = valuedLegs.reduce((sum, leg) => sum + leg.netMarkedValue, 0);
    const currentHoldingValue = isClosed
      ? Math.max(toNumber(order.closeSummary?.currentHoldingValue, derivedCurrentHoldingValue) ?? 0, 0)
      : derivedCurrentHoldingValue;
    const profitLossValue = isClosed
      ? toNumber(order.closeSummary?.profitLossValue, derivedProfitLossValue) ?? 0
      : derivedProfitLossValue;
    const netMarkedValue = isClosed
      ? toNumber(order.closeSummary?.netMarkedValue, derivedNetMarkedValue) ?? 0
      : derivedNetMarkedValue;
    const profitLossPercent = isClosed
      ? toNumber(order.closeSummary?.profitLossPercent, initialPurchaseValue > 0 ? (profitLossValue / initialPurchaseValue) * 100 : null)
      : initialPurchaseValue > 0
        ? (profitLossValue / initialPurchaseValue) * 100
        : null;

    return {
      id: record.id ?? null,
      strategyId: order.strategyId,
      strategyName: order.strategyName,
      combinationId: order.combinationId,
      combinationLabel: order.combinationLabel,
      assetLabel: order.assetLabel,
      strategyType: order.strategyType,
      purchaseDate: order.purchaseDate,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      status,
      isClosed,
      closedAt: order.closedAt ?? "",
      closedDate: order.closedDate ?? "",
      polymarketQuestion: order.polymarketQuestion,
      polymarketUrl: order.polymarketUrl,
      polymarketSource: order.polymarketSource,
      strategyCloseDate: order.strategyCloseDate,
      polymarketResolutionDate: order.polymarketResolutionDate,
      valuationContext: {
        proxySymbol,
        underlyingSymbol,
        currentProxySpot,
        currentUnderlyingSpot,
        conversionRatio,
        targetUnderlyingValue,
        currentYesPrice
      },
      initialPurchaseValue,
      currentHoldingValue,
      profitLossValue,
      profitLossPercent,
      netEntryValue,
      netMarkedValue,
      closeSummary: isClosed
        ? {
            currentHoldingValue,
            netMarkedValue,
            profitLossValue,
            profitLossPercent
          }
        : null,
      legs: valuedLegs
    };
  });

  const openOrders = valuedOrders.filter((order) => !order.isClosed);
  const closedOrders = valuedOrders.filter((order) => order.isClosed);
  const summary = openOrders.reduce(
    (totals, order) => ({
      orderCount: totals.orderCount + 1,
      initialPurchaseValue: totals.initialPurchaseValue + order.initialPurchaseValue,
      currentHoldingValue: totals.currentHoldingValue + order.currentHoldingValue,
      profitLossValue: totals.profitLossValue + order.profitLossValue,
      netEntryValue: totals.netEntryValue + order.netEntryValue,
      netMarkedValue: totals.netMarkedValue + order.netMarkedValue
    }),
    {
      orderCount: 0,
      initialPurchaseValue: 0,
      currentHoldingValue: 0,
      profitLossValue: 0,
      netEntryValue: 0,
      netMarkedValue: 0
    }
  );
  const closedProfitLossValue = closedOrders.reduce((sum, order) => sum + order.profitLossValue, 0);

  return {
    summary: {
      ...summary,
      openOrderCount: openOrders.length,
      closedOrderCount: closedOrders.length,
      closedProfitLossValue,
      totalClosedProfitLossValue: closedProfitLossValue,
      profitLossPercent:
        summary.initialPurchaseValue > 0
          ? (summary.profitLossValue / summary.initialPurchaseValue) * 100
          : null
    },
    orders: openOrders,
    openOrders,
    closedOrders
  };
}
