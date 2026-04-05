function parseScaledPrice(rawValue, rawScale = "") {
  const numericValue = Number(String(rawValue ?? "").replace(/,/g, ""));
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const normalizedScale = String(rawScale ?? "").toLowerCase();
  if (normalizedScale === "m") {
    return numericValue * 1_000_000;
  }

  if (normalizedScale === "k") {
    return numericValue * 1_000;
  }

  return numericValue;
}

function buildSignal(match, direction, triggerType) {
  const targetValue = parseScaledPrice(match?.[1], match?.[2]);
  if (!(targetValue > 0)) {
    return null;
  }

  return {
    targetValue,
    direction: direction === "down" ? "down" : "up",
    triggerType: triggerType === "close" ? "close" : "touch",
    comparator: direction === "down" ? "lte" : "gte"
  };
}

const CLOSE_UP_PATTERNS = [
  /(?:close(?:s|d)?|settle(?:s|d)?|finish(?:es|ed)?|end(?:s|ed)?(?:\s+the\s+(?:final\s+)?trading\s+day)?)\s+(?:above|over|at least)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i
];

const CLOSE_DOWN_PATTERNS = [
  /(?:close(?:s|d)?|settle(?:s|d)?|finish(?:es|ed)?|end(?:s|ed)?(?:\s+the\s+(?:final\s+)?trading\s+day)?)\s+(?:below|under|at most|no more than)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i
];

const TOUCH_UP_PATTERNS = [
  /(?:hit|touch)(?:es|ed)?\s*\(\s*high\s*\)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i,
  /(?:above|over|reach(?:es|ed)?|hit(?:s)?|touch(?:es|ed)?|at least)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i
];

const TOUCH_DOWN_PATTERNS = [
  /(?:hit|touch)(?:es|ed)?\s*\(\s*low\s*\)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i,
  /(?:dip(?:s|ped)?\s+(?:to|below)|drop(?:s|ped)?\s+(?:to|below)|fall(?:s|fell|fallen)?\s+(?:to|below)|below|under|at most|no more than)\s*\$?\s*([\d,.]+)\s*([kKmM])?/i
];

export function parsePolymarketQuestionSignal(question) {
  const normalizedQuestion = String(question ?? "").trim();
  if (!normalizedQuestion) {
    return null;
  }

  for (const pattern of CLOSE_UP_PATTERNS) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      return buildSignal(match, "up", "close");
    }
  }

  for (const pattern of CLOSE_DOWN_PATTERNS) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      return buildSignal(match, "down", "close");
    }
  }

  for (const pattern of TOUCH_UP_PATTERNS) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      return buildSignal(match, "up", "touch");
    }
  }

  for (const pattern of TOUCH_DOWN_PATTERNS) {
    const match = normalizedQuestion.match(pattern);
    if (match) {
      return buildSignal(match, "down", "touch");
    }
  }

  return null;
}

export function resolvePolymarketSignal({
  question,
  targetValue = null,
  direction = "",
  triggerType = ""
} = {}) {
  const parsedSignal = parsePolymarketQuestionSignal(question);
  if (parsedSignal) {
    return parsedSignal;
  }

  const numericTarget = Number(targetValue);
  if (!(numericTarget > 0)) {
    return null;
  }

  const normalizedDirection = String(direction ?? "").trim().toLowerCase() === "down" ? "down" : "up";
  const normalizedTriggerType = String(triggerType ?? "").trim().toLowerCase() === "close" ? "close" : "touch";

  return {
    targetValue: numericTarget,
    direction: normalizedDirection,
    triggerType: normalizedTriggerType,
    comparator: normalizedDirection === "down" ? "lte" : "gte"
  };
}

export function parseTargetFromQuestion(question) {
  return parsePolymarketQuestionSignal(question)?.targetValue ?? null;
}

export function evaluatePolymarketSignalHit(spot, signalOrQuestion) {
  const signal =
    typeof signalOrQuestion === "string"
      ? parsePolymarketQuestionSignal(signalOrQuestion)
      : resolvePolymarketSignal(signalOrQuestion);

  const numericSpot = Number(spot);
  if (!signal || !Number.isFinite(numericSpot)) {
    return false;
  }

  return signal.direction === "down"
    ? numericSpot <= signal.targetValue
    : numericSpot >= signal.targetValue;
}

export function projectPolymarketTargetProxySpot({
  targetValue,
  direction = "up",
  conversionRatio = 1,
  currentProxySpot = 0
} = {}) {
  const numericTargetValue = Number(targetValue);
  const numericConversionRatio = Number(conversionRatio);
  const numericCurrentProxySpot = Number(currentProxySpot);
  const projectedTarget =
    numericTargetValue > 0 && numericConversionRatio > 0
      ? numericTargetValue * numericConversionRatio
      : numericCurrentProxySpot;

  if (!(projectedTarget > 0)) {
    return numericCurrentProxySpot > 0 ? numericCurrentProxySpot : 0;
  }

  return String(direction ?? "").trim().toLowerCase() === "down"
    ? projectedTarget
    : Math.max(projectedTarget, numericCurrentProxySpot || projectedTarget);
}
