export const ACTION_SIGNAL_STATES = Object.freeze({
  NO_ACTION: "NO_ACTION",
  HEDGE_SHORT: "HEDGE_SHORT",
  HEDGE_LONG: "HEDGE_LONG",
  RECHECK: "RECHECK",
  EXIT_SIGNAL: "EXIT_SIGNAL"
});

export const DEFAULT_DYNAMIC_HEDGE_PLAN = Object.freeze({
  initialHedge: "none",
  type: "dynamic",
  deltaThreshold: 0.1,
  deltaThresholdSharesPerContract: 10,
  priceMoveThresholdPct: 0.01,
  exitDteDays: 3,
  rules: [
    "rebalance when absolute delta exceeds threshold",
    "rebalance when price moves beyond threshold"
  ]
});

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function buildDynamicHedgePlan(overrides = {}) {
  const source = overrides ?? {};
  const deltaThreshold = clamp(toNumber(source.deltaThreshold, DEFAULT_DYNAMIC_HEDGE_PLAN.deltaThreshold) ?? 0.1, 0.01, 1);
  const deltaThresholdSharesPerContract = clamp(
    toNumber(source.deltaThresholdSharesPerContract, DEFAULT_DYNAMIC_HEDGE_PLAN.deltaThresholdSharesPerContract) ?? 10,
    1,
    1000
  );
  const priceMoveThresholdPct = clamp(
    toNumber(source.priceMoveThresholdPct, DEFAULT_DYNAMIC_HEDGE_PLAN.priceMoveThresholdPct) ?? 0.01,
    0.001,
    0.5
  );
  const exitDteDaysRaw = toNumber(source.exitDteDays, DEFAULT_DYNAMIC_HEDGE_PLAN.exitDteDays);
  const exitDteDays =
    exitDteDaysRaw == null
      ? DEFAULT_DYNAMIC_HEDGE_PLAN.exitDteDays
      : clamp(Math.round(exitDteDaysRaw), 0, 365);

  return {
    initialHedge: "none",
    type: "dynamic",
    deltaThreshold,
    deltaThresholdSharesPerContract,
    priceMoveThresholdPct,
    exitDteDays,
    rules: Array.isArray(source.rules) && source.rules.length ? [...source.rules] : [...DEFAULT_DYNAMIC_HEDGE_PLAN.rules]
  };
}

export function inferStraddleContractCount(optionLegs) {
  const legs = Array.isArray(optionLegs) ? optionLegs : [];
  const quantities = legs
    .filter((leg) => leg && (leg.kind === "option" || leg.optionType))
    .map((leg) => Math.max(Math.round(toNumber(leg.quantity, 0) ?? 0), 0))
    .filter((value) => value > 0);

  if (!quantities.length) {
    return 0;
  }

  return Math.min(...quantities);
}

export function evaluateDynamicHedgeSignal({
  netDeltaShares,
  currentSpot,
  referenceSpot,
  optionContracts = 1,
  hedgePlan = DEFAULT_DYNAMIC_HEDGE_PLAN,
  daysToExpiry = null
}) {
  const plan = buildDynamicHedgePlan(hedgePlan);
  const contracts = Math.max(Math.round(toNumber(optionContracts, 1) ?? 1), 1);
  const deltaShares = toNumber(netDeltaShares, 0) ?? 0;
  const spot = toNumber(currentSpot, null);
  const anchorSpot = toNumber(referenceSpot, spot);
  const thresholdShares = plan.deltaThresholdSharesPerContract * contracts;
  const absDelta = Math.abs(deltaShares);
  const priceMovePct =
    anchorSpot && anchorSpot > 0 && spot != null
      ? Math.abs(spot - anchorSpot) / anchorSpot
      : 0;
  const dte = daysToExpiry == null ? null : Math.max(Math.round(toNumber(daysToExpiry, 0) ?? 0), 0);

  if (dte != null && plan.exitDteDays != null && dte <= plan.exitDteDays) {
    return {
      actionSignal: ACTION_SIGNAL_STATES.EXIT_SIGNAL,
      netDeltaShares: deltaShares,
      deltaThresholdShares: thresholdShares,
      priceMovePct,
      priceMoveThresholdPct: plan.priceMoveThresholdPct,
      recommendedSharesDeltaNeutral: 0
    };
  }

  if (absDelta >= thresholdShares) {
    const actionSignal = deltaShares > 0 ? ACTION_SIGNAL_STATES.HEDGE_SHORT : ACTION_SIGNAL_STATES.HEDGE_LONG;
    const recommendedSignedShares = -deltaShares;
    const recommendedSharesDeltaNeutral =
      recommendedSignedShares === 0 ? 0 : Math.round(Math.abs(recommendedSignedShares)) * (recommendedSignedShares > 0 ? 1 : -1);

    return {
      actionSignal,
      netDeltaShares: deltaShares,
      deltaThresholdShares: thresholdShares,
      priceMovePct,
      priceMoveThresholdPct: plan.priceMoveThresholdPct,
      recommendedSharesDeltaNeutral
    };
  }

  if (priceMovePct >= plan.priceMoveThresholdPct) {
    return {
      actionSignal: ACTION_SIGNAL_STATES.RECHECK,
      netDeltaShares: deltaShares,
      deltaThresholdShares: thresholdShares,
      priceMovePct,
      priceMoveThresholdPct: plan.priceMoveThresholdPct,
      recommendedSharesDeltaNeutral: 0
    };
  }

  return {
    actionSignal: ACTION_SIGNAL_STATES.NO_ACTION,
    netDeltaShares: deltaShares,
    deltaThresholdShares: thresholdShares,
    priceMovePct,
    priceMoveThresholdPct: plan.priceMoveThresholdPct,
    recommendedSharesDeltaNeutral: 0
  };
}

