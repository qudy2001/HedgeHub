function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

export function hasUsableBidAsk(contract) {
  const bid = toNumber(contract?.bid);
  const ask = toNumber(contract?.ask);
  return bid != null && ask != null && bid > 0 && ask > 0;
}

export function pickOptionReferencePrice(contract, fallback = 0) {
  const bid = toNumber(contract?.bid);
  const ask = toNumber(contract?.ask);

  if (hasUsableBidAsk(contract)) {
    return (bid + ask) / 2;
  }

  const mark = toNumber(contract?.mark);
  if (mark > 0) {
    return mark;
  }

  const lastPrice = toNumber(contract?.lastPrice);
  if (lastPrice > 0) {
    return lastPrice;
  }

  if (ask > 0) {
    return ask;
  }

  if (bid > 0) {
    return bid;
  }

  return fallback;
}
