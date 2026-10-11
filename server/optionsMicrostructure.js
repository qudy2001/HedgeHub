function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

export function normalizeContractSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function normalizeOptionType(value) {
  return String(value ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
}

export function getObservationSpreadPct(observation) {
  const bid = toNumber(observation?.bid, null);
  const ask = toNumber(observation?.ask, null);
  if (!(bid >= 0) || !(ask > 0) || ask < bid) {
    return null;
  }

  const midpoint = (bid + ask) / 2;
  if (!(midpoint > 0)) {
    return null;
  }

  return ((ask - bid) / midpoint) * 100;
}

export function getObservationDisplayedSize(observation) {
  const bidSize = toNumber(observation?.bidSize, null);
  const askSize = toNumber(observation?.askSize, null);

  if (bidSize == null && askSize == null) {
    return null;
  }

  if (bidSize == null) {
    return askSize;
  }

  if (askSize == null) {
    return bidSize;
  }

  return Math.min(bidSize, askSize);
}

function computeMedian(values) {
  const numericValues = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (!numericValues.length) {
    return null;
  }

  const middleIndex = Math.floor(numericValues.length / 2);
  if (numericValues.length % 2 === 0) {
    return (numericValues[middleIndex - 1] + numericValues[middleIndex]) / 2;
  }

  return numericValues[middleIndex];
}

function computeMean(values) {
  const numericValues = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!numericValues.length) {
    return null;
  }

  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
}

function computeStandardDeviation(values) {
  const numericValues = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (numericValues.length < 2) {
    return null;
  }

  const mean = computeMean(numericValues);
  if (mean == null) {
    return null;
  }

  const variance =
    numericValues.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) /
    (numericValues.length - 1);

  return Math.sqrt(Math.max(variance, 0));
}

function toIsoMinuteBucket(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  parsed.setUTCSeconds(0, 0);
  return parsed.toISOString();
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function buildOptionObservationSeries(observations = []) {
  const buckets = new Map();

  [...observations]
    .filter((observation) => observation?.observedAt)
    .sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime())
    .forEach((observation) => {
      const bucketKey = toIsoMinuteBucket(observation.observedAt);
      if (!bucketKey) {
        return;
      }

      buckets.set(bucketKey, {
        time: bucketKey,
        spreadPct: formatNumber(getObservationSpreadPct(observation), 2),
        mark: formatNumber(toNumber(observation.mark, null), 4),
        bid: formatNumber(toNumber(observation.bid, null), 4),
        ask: formatNumber(toNumber(observation.ask, null), 4),
        bidSize: toNumber(observation.bidSize, null),
        askSize: toNumber(observation.askSize, null),
        displayedSize: toNumber(getObservationDisplayedSize(observation), null),
        lastTradePrice: formatNumber(toNumber(observation.lastTradePrice, null), 4)
      });
    });

  return [...buckets.values()];
}

export function buildOptionObservationSummary(observations = [], { anchorAt = null, now = new Date() } = {}) {
  const sorted = [...observations].sort(
    (left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime()
  );

  if (!sorted.length) {
    return {
      observationCount: 0,
      currentSpreadPct: null,
      bestSpreadPct: null,
      medianSpreadPct: null,
      currentDisplayedSize: null,
      currentBidSize: null,
      currentAskSize: null,
      spreadCompressionPct: null,
      quoteSizeStabilityScore: null,
      staleQuoteDurationMs: null,
      lastTradeAgeMs: null,
      bestWindowAt: null
    };
  }

  const latest = sorted[sorted.length - 1];
  const spreads = sorted.map((observation) => getObservationSpreadPct(observation)).filter((value) => value != null);
  const sizes = sorted.map((observation) => getObservationDisplayedSize(observation)).filter((value) => value != null);
  const latestObservedAtMs = new Date(latest.observedAt).getTime();
  const nowMs = now.getTime();
  const anchorMs = anchorAt ? new Date(anchorAt).getTime() : Number.NaN;
  const anchorObservation =
    Number.isFinite(anchorMs)
      ? sorted.find((observation) => new Date(observation.observedAt).getTime() >= anchorMs) ?? sorted[0]
      : sorted[0];
  const anchorSpreadPct = getObservationSpreadPct(anchorObservation);
  const currentSpreadPct = getObservationSpreadPct(latest);
  const bestObservation = [...sorted]
    .filter((observation) => getObservationSpreadPct(observation) != null)
    .sort((left, right) => getObservationSpreadPct(left) - getObservationSpreadPct(right))[0] ?? null;
  const latestTradeObservation =
    [...sorted]
      .reverse()
      .find((observation) => toNumber(observation.lastTradePrice, null) != null) ?? null;

  const meanSize = computeMean(sizes);
  const stdDevSize = computeStandardDeviation(sizes);
  const quoteSizeStabilityScore =
    meanSize != null && meanSize > 0 && stdDevSize != null
      ? Math.max(0, Math.min(100, 100 - (stdDevSize / meanSize) * 100))
      : sizes.length
        ? 100
        : null;

  return {
    observationCount: sorted.length,
    currentSpreadPct: formatNumber(currentSpreadPct, 2),
    bestSpreadPct: bestObservation ? formatNumber(getObservationSpreadPct(bestObservation), 2) : null,
    medianSpreadPct: formatNumber(computeMedian(spreads), 2),
    currentDisplayedSize: toNumber(getObservationDisplayedSize(latest), null),
    currentBidSize: toNumber(latest.bidSize, null),
    currentAskSize: toNumber(latest.askSize, null),
    spreadCompressionPct:
      currentSpreadPct != null && anchorSpreadPct != null
        ? formatNumber(currentSpreadPct - anchorSpreadPct, 2)
        : null,
    quoteSizeStabilityScore: formatNumber(quoteSizeStabilityScore, 1),
    staleQuoteDurationMs:
      Number.isFinite(latestObservedAtMs) && Number.isFinite(nowMs) ? Math.max(nowMs - latestObservedAtMs, 0) : null,
    lastTradeAgeMs:
      latestTradeObservation?.observedAt
        ? Math.max(nowMs - new Date(latestTradeObservation.observedAt).getTime(), 0)
        : null,
    bestWindowAt: bestObservation?.observedAt ?? null
  };
}

export function buildOptionObservationDiagnostics(summary = {}) {
  const staleMs = Number(summary.staleQuoteDurationMs ?? NaN);
  const spreadCompressionPct = Number(summary.spreadCompressionPct ?? NaN);
  const currentSpreadPct = Number(summary.currentSpreadPct ?? NaN);
  const medianSpreadPct = Number(summary.medianSpreadPct ?? NaN);

  if (Number.isFinite(staleMs) && staleMs >= 5 * 60 * 1000) {
    return {
      status: "Stale",
      tone: "warning",
      reason: "Quote observations are older than 5 minutes."
    };
  }

  if (Number.isFinite(spreadCompressionPct) && spreadCompressionPct <= -0.1) {
    return {
      status: "Improving",
      tone: "positive",
      reason: "Current spread is tighter than the anchor observation."
    };
  }

  if (
    Number.isFinite(currentSpreadPct) &&
    Number.isFinite(medianSpreadPct) &&
    currentSpreadPct >= medianSpreadPct * 1.15
  ) {
    return {
      status: "Deteriorating",
      tone: "negative",
      reason: "Current spread is materially wider than the recent median."
    };
  }

  return {
    status: "Stable",
    tone: "",
    reason: "Recent spread and size conditions are broadly stable."
  };
}

export function buildOptionObservationPayload(observations = [], options = {}) {
  const summary = buildOptionObservationSummary(observations, options);
  return {
    summary,
    series: buildOptionObservationSeries(observations),
    observations,
    diagnostics: buildOptionObservationDiagnostics(summary)
  };
}
