function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hashStringToUint32(value) {
  const text = String(value ?? "");
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createXorshift32(seed) {
  let state = (Number(seed) || 0) >>> 0;

  if (!state) {
    state = 0x6d2b79f5;
  }

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function createNormalGenerator(uniformRandom) {
  let hasSpare = false;
  let spare = 0;

  return () => {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }

    // Marsaglia polar method (avoids sin/cos, typically faster than Box-Muller).
    let u = 0;
    let v = 0;
    let s = 0;

    while (s === 0 || s >= 1) {
      u = uniformRandom() * 2 - 1;
      v = uniformRandom() * 2 - 1;
      s = u * u + v * v;
    }

    const multiplier = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * multiplier;
    hasSpare = true;

    return u * multiplier;
  };
}

function resolveSeed({
  currentPrice,
  ivAtm,
  ivPut,
  ivCall,
  maxDays,
  numPaths,
  priceLevelCount,
  dayOffsetsKey
}) {
  return hashStringToUint32(
    `${currentPrice}|${ivAtm}|${ivPut}|${ivCall}|${maxDays}|${numPaths}|${priceLevelCount}|${dayOffsetsKey}`
  );
}

function normalizeDayOffsets(dayOffsets) {
  if (!Array.isArray(dayOffsets) || !dayOffsets.length) {
    return [];
  }

  return dayOffsets.map((value) => Math.max(0, Math.floor(Number(value) || 0)));
}

function normalizeVolatility(value) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }

  return clamp(Number(value), 0.01, 3);
}

export function buildTouchProbabilityMatrix({
  currentPrice,
  ivAtm,
  ivPut,
  ivCall,
  priceLevels,
  dayOffsets,
  numPaths = 50000,
  dt = 1 / 252,
  seed = null
}) {
  const spot = Number(currentPrice);
  const levels = Array.isArray(priceLevels)
    ? priceLevels.map((value) => Math.max(Number(value) || 0, 0.01))
    : [];
  const days = normalizeDayOffsets(dayOffsets);

  if (!(spot > 0) || !levels.length || !days.length || !(numPaths > 0) || !(dt > 0)) {
    return {
      prob_matrix: new Float32Array(levels.length * days.length),
      meta: {
        numPaths: Math.max(Number(numPaths) || 0, 0),
        maxDays: Math.max(...days, 0),
        rowCount: levels.length,
        columnCount: days.length,
        dayOffsets: days
      }
    };
  }

  const rows = levels.length;
  const cols = days.length;
  const maxDays = Math.max(...days, 0);
  const counts = new Uint32Array(rows * cols);
  const epsilon = Math.max(spot, 1) * 1e-12;

  const atm = normalizeVolatility(ivAtm) ?? normalizeVolatility(ivPut) ?? normalizeVolatility(ivCall) ?? 0.24;
  const put = normalizeVolatility(ivPut) ?? clamp(atm * 1.2, 0.01, 3);
  const call = normalizeVolatility(ivCall) ?? clamp(atm * 0.9, 0.01, 3);

  const driftAtm = -0.5 * atm * atm * dt;
  const driftPut = -0.5 * put * put * dt;
  const driftCall = -0.5 * call * call * dt;
  const sqrtDt = Math.sqrt(dt);
  const stepAtm = atm * sqrtDt;
  const stepPut = put * sqrtDt;
  const stepCall = call * sqrtDt;

  const levelSides = levels.map((level) => level >= spot);
  const targets = days
    .map((day, colIndex) => ({ day, colIndex }))
    .filter((target) => target.day > 0)
    .sort((a, b) => a.day - b.day);

  for (let colIndex = 0; colIndex < cols; colIndex += 1) {
    if (days[colIndex] !== 0) {
      continue;
    }

    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      if (Math.abs(levels[rowIndex] - spot) <= epsilon) {
        counts[rowIndex * cols + colIndex] = numPaths;
      }
    }
  }

  if (!targets.length || maxDays <= 0) {
    const prob_matrix = new Float32Array(counts.length);
    for (let index = 0; index < counts.length; index += 1) {
      prob_matrix[index] = counts[index] / numPaths;
    }

    return {
      prob_matrix,
      meta: {
        numPaths,
        maxDays,
        rowCount: rows,
        columnCount: cols,
        dayOffsets: days,
        ivAtm: atm,
        ivPut: put,
        ivCall: call,
        seed: Number(seed) || null
      }
    };
  }

  const resolvedSeed =
    seed == null
      ? resolveSeed({
          currentPrice: spot,
          ivAtm: atm,
          ivPut: put,
          ivCall: call,
          maxDays,
          numPaths,
          priceLevelCount: rows,
          dayOffsetsKey: days.join(",")
        })
      : hashStringToUint32(seed);
  const random = createXorshift32(resolvedSeed);
  const randn = createNormalGenerator(random);
  const logSpot = Math.log(spot);
  const logLevels = new Float64Array(rows);

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    logLevels[rowIndex] = Math.log(levels[rowIndex]);
  }

  for (let pathIndex = 0; pathIndex < numPaths; pathIndex += 1) {
    let logS = logSpot;
    let maxLog = logS;
    let minLog = logS;
    let targetIndex = 0;

    for (let day = 1; day <= maxDays; day += 1) {
      let drift = driftAtm;
      let stepVol = stepAtm;

      if (logS < logSpot) {
        drift = driftPut;
        stepVol = stepPut;
      } else if (logS > logSpot) {
        drift = driftCall;
        stepVol = stepCall;
      }

      logS += drift + stepVol * randn();

      if (logS > maxLog) {
        maxLog = logS;
      } else if (logS < minLog) {
        minLog = logS;
      }

      while (targetIndex < targets.length && targets[targetIndex].day === day) {
        const colIndex = targets[targetIndex].colIndex;
        const colOffset = colIndex;

        for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
          const touched = levelSides[rowIndex]
            ? maxLog >= logLevels[rowIndex]
            : minLog <= logLevels[rowIndex];

          if (touched) {
            counts[rowIndex * cols + colOffset] += 1;
          }
        }

        targetIndex += 1;
      }

      if (targetIndex >= targets.length) {
        break;
      }
    }
  }

  const prob_matrix = new Float32Array(counts.length);
  for (let index = 0; index < counts.length; index += 1) {
    prob_matrix[index] = counts[index] / numPaths;
  }

  return {
    prob_matrix,
    meta: {
      numPaths,
      maxDays,
      rowCount: rows,
      columnCount: cols,
      dayOffsets: days,
      ivAtm: atm,
      ivPut: put,
      ivCall: call,
      seed: resolvedSeed
    }
  };
}

export function buildProbabilityWeightedMatrix(probMatrix, pnlMatrix) {
  const probability = probMatrix instanceof Float32Array ? probMatrix : null;
  const pnl = pnlMatrix instanceof Float32Array ? pnlMatrix : null;

  if (!probability || !pnl || probability.length !== pnl.length) {
    return new Float32Array(0);
  }

  const ev = new Float32Array(probability.length);
  for (let index = 0; index < probability.length; index += 1) {
    ev[index] = probability[index] * pnl[index];
  }

  return ev;
}

export function buildTouchProbabilityAndEvMatrix({
  currentPrice,
  ivAtm,
  ivPut,
  ivCall,
  priceLevels,
  dayOffsets,
  pnlMatrix,
  numPaths = 50000,
  dt = 1 / 252,
  seed = null
}) {
  const { prob_matrix, meta } = buildTouchProbabilityMatrix({
    currentPrice,
    ivAtm,
    ivPut,
    ivCall,
    priceLevels,
    dayOffsets,
    numPaths,
    dt,
    seed
  });

  const ev_matrix = buildProbabilityWeightedMatrix(prob_matrix, pnlMatrix);

  return { prob_matrix, ev_matrix, meta };
}

export function validateTouchProbabilityMatrix(probMatrix, rowCount, columnCount) {
  const matrix = probMatrix instanceof Float32Array ? probMatrix : null;
  const rows = Math.max(Number(rowCount) || 0, 0);
  const cols = Math.max(Number(columnCount) || 0, 0);

  if (!matrix || !rows || !cols || matrix.length !== rows * cols) {
    return {
      monotonic: true,
      extremes: true,
      issues: []
    };
  }

  const issues = [];
  let monotonic = true;

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    let last = -1;
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      const value = matrix[rowIndex * cols + colIndex];
      if (value + 1e-7 < last) {
        monotonic = false;
        issues.push(`Row ${rowIndex + 1} probability decreases at column ${colIndex + 1}.`);
        break;
      }
      last = value;
    }

    if (!monotonic) {
      break;
    }
  }

  let extremes = true;

  for (let colIndex = 0; colIndex < cols; colIndex += 1) {
    const top = matrix[colIndex];
    const bottom = matrix[(rows - 1) * cols + colIndex];

    if (top > 0.98 && bottom > 0.98) {
      extremes = false;
      issues.push("Extreme levels look fully touched; check the price range or IV inputs.");
      break;
    }
  }

  return {
    monotonic,
    extremes,
    issues
  };
}
