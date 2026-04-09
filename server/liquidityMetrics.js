function toNonNegativeNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
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

function resolveQuantity(leg) {
  const normalizedQuantity = Math.abs(Math.round(Number(leg?.quantity ?? 1) || 1));
  return normalizedQuantity > 0 ? normalizedQuantity : 1;
}

function harmonicMean(values) {
  const normalizedValues = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (!normalizedValues.length) {
    return 0;
  }

  if (normalizedValues.some((value) => value <= 0)) {
    return 0;
  }

  return normalizedValues.length / normalizedValues.reduce((sum, value) => sum + 1 / value, 0);
}

export function getOptionEntryQuoteSize(leg) {
  return String(leg?.action ?? "LONG").trim().toUpperCase() === "SHORT"
    ? toNonNegativeNumber(leg?.bidSize, 0)
    : toNonNegativeNumber(leg?.askSize, 0);
}

export function getOptionExitQuoteSize(leg) {
  return String(leg?.action ?? "LONG").trim().toUpperCase() === "SHORT"
    ? toNonNegativeNumber(leg?.askSize, 0)
    : toNonNegativeNumber(leg?.bidSize, 0);
}

export function summarizeOptionStrategyLiquidity(optionLegs, { side = "entry" } = {}) {
  const normalizedLegs = (optionLegs ?? []).filter((leg) => {
    if (!leg) {
      return false;
    }

    return leg.kind == null || leg.kind === "option";
  });

  if (!normalizedLegs.length) {
    return {
      comboQuantity: 1,
      normalizedVolume: 0,
      normalizedOpenInterest: 0,
      entryQuoteSize: 0,
      exitQuoteSize: 0,
      rawVolume: 0,
      rawOpenInterest: 0,
      perLeg: []
    };
  }

  const comboQuantity =
    normalizedLegs.reduce((current, leg) => gcd(current, resolveQuantity(leg)), 0) || 1;
  const perLeg = normalizedLegs.map((leg) => {
    const quantity = resolveQuantity(leg);
    const ratio = Math.max(quantity / comboQuantity, 1);
    const volume = toNonNegativeNumber(leg?.volume, 0);
    const openInterest = toNonNegativeNumber(leg?.openInterest, 0);
    const entryQuoteSize = getOptionEntryQuoteSize(leg);
    const exitQuoteSize = getOptionExitQuoteSize(leg);
    const visibleSize = side === "exit" ? exitQuoteSize : entryQuoteSize;

    return {
      id: String(leg?.id ?? leg?.contractSymbol ?? ""),
      quantity,
      ratio,
      volume,
      openInterest,
      entryQuoteSize,
      exitQuoteSize,
      normalizedVolume: Math.max(volume, visibleSize) / ratio,
      normalizedOpenInterest: openInterest / ratio
    };
  });

  return {
    comboQuantity,
    normalizedVolume: harmonicMean(perLeg.map((leg) => leg.normalizedVolume)),
    normalizedOpenInterest: harmonicMean(perLeg.map((leg) => leg.normalizedOpenInterest)),
    entryQuoteSize: perLeg.length ? Math.min(...perLeg.map((leg) => leg.entryQuoteSize / leg.ratio)) : 0,
    exitQuoteSize: perLeg.length ? Math.min(...perLeg.map((leg) => leg.exitQuoteSize / leg.ratio)) : 0,
    rawVolume: perLeg.reduce((sum, leg) => sum + leg.volume, 0),
    rawOpenInterest: perLeg.reduce((sum, leg) => sum + leg.openInterest, 0),
    perLeg
  };
}

export { harmonicMean };
