import { useEffect, useMemo, useRef, useState } from "react";
import { getScenarioHeatmapCellStyle } from "../theme.js";
import {
  buildProbabilityWeightedMatrix,
  buildTouchProbabilityMatrix,
  validateTouchProbabilityMatrix
} from "../scenarioMonteCarlo.js";
import {
  buildTradingDateColumns,
  countTradingDaysBetween,
  isTradingDay,
  tradingDaysToYears
} from "../tradingCalendar.js";

const DEFAULT_RANGE_MULTIPLIER = 1;
const RANGE_OPTIONS = [1, 2, 3];
const DEFAULT_ROW_COUNT = 13;
const DEFAULT_COLUMN_COUNT = 10;
const MIN_COLUMN_COUNT = 2;
const MAX_COLUMN_COUNT = 31;
const MIN_ROW_COUNT = 7;
const MAX_ROW_COUNT = 61;
const DEFAULT_RANGE_SLIDER_MIN = 0.5;
const DEFAULT_RANGE_SLIDER_MAX = 5;
const MAX_HORIZON_DAYS = 252;
const MAX_MC_WORKERS = 6;
const MIN_PATHS_PER_WORKER = 6000;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function splitMonteCarloPaths(totalPaths, shardCount) {
  const total = Math.max(Math.floor(Number(totalPaths) || 0), 0);
  const shards = Math.max(Math.floor(Number(shardCount) || 1), 1);

  if (!total) {
    return [];
  }

  const base = Math.floor(total / shards);
  const remainder = total % shards;

  return Array.from({ length: shards }, (_value, index) => base + (index < remainder ? 1 : 0)).filter(
    (count) => count > 0
  );
}

function getMonteCarloWorkerCount(totalPaths) {
  if (typeof navigator === "undefined") {
    return 1;
  }

  const cores = Math.max(Math.floor(Number(navigator.hardwareConcurrency) || 0), 0);

  if (cores <= 1) {
    return 1;
  }

  const maxByPaths = Math.max(1, Math.floor((Number(totalPaths) || 0) / MIN_PATHS_PER_WORKER));
  return clamp(Math.min(cores, MAX_MC_WORKERS, maxByPaths), 1, MAX_MC_WORKERS);
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCurrency(value, currency = "USD", digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(Number(value));
}

function formatCellCurrency(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(Number(value));
}

function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return Number(value).toFixed(digits);
}

function formatPercent(value, digits = 0) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  const numericValue = Number(value);
  return `${(numericValue * 100).toFixed(digits)}%`;
}

function getProbabilityTone(value) {
  const probability = Number(value);

  if (!Number.isFinite(probability)) {
    return "pending";
  }

  if (probability >= 0.75) {
    return "very-high";
  }

  if (probability >= 0.5) {
    return "high";
  }

  if (probability >= 0.25) {
    return "mid";
  }

  if (probability >= 0.1) {
    return "low";
  }

  return "very-low";
}

function validateTouchProbabilityAcrossLevels(probMatrix, priceLevels, currentPrice, columnCount) {
  const matrix = probMatrix instanceof Float32Array ? probMatrix : null;
  const levels = Array.isArray(priceLevels) ? priceLevels.map((value) => Number(value) || 0) : [];
  const spot = Number(currentPrice);
  const cols = Math.max(Number(columnCount) || 0, 0);

  if (!matrix || !levels.length || !(spot > 0) || !cols || matrix.length !== levels.length * cols) {
    return [];
  }

  const epsilon = Math.max(spot, 1) * 1e-9;
  const anchorIndex =
    levels.findIndex((level) => Math.abs(level - spot) <= epsilon) >= 0
      ? levels.findIndex((level) => Math.abs(level - spot) <= epsilon)
      : Math.floor(levels.length / 2);
  const issues = [];
  const tolerance = 1e-7;

  for (let colIndex = 0; colIndex < cols; colIndex += 1) {
    let last = matrix[anchorIndex * cols + colIndex];

    for (let rowIndex = anchorIndex - 1; rowIndex >= 0; rowIndex -= 1) {
      const value = matrix[rowIndex * cols + colIndex];
      if (value > last + tolerance) {
        issues.push(`Column ${colIndex + 1} has higher touch-prob further above spot.`);
        break;
      }
      last = value;
    }

    last = matrix[anchorIndex * cols + colIndex];
    for (let rowIndex = anchorIndex + 1; rowIndex < levels.length; rowIndex += 1) {
      const value = matrix[rowIndex * cols + colIndex];
      if (value > last + tolerance) {
        issues.push(`Column ${colIndex + 1} has higher touch-prob further below spot.`);
        break;
      }
      last = value;
    }

    if (issues.length) {
      break;
    }
  }

  return issues;
}

function formatShortDate(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short"
  }).format(date);
}

function formatDateLabel(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function buildDateColumns(startDate, endDate, columnCount) {
  return buildTradingDateColumns(startDate, endDate, columnCount);
}

function addTradingDaysToDate(startValue, tradingDays) {
  const start = parseIsoDate(startValue);
  const steps = Math.max(Math.floor(Number(tradingDays) || 0), 0);

  if (!start || !steps) {
    return startValue || "";
  }

  const cursor = new Date(start);
  let remaining = steps;
  let safety = 0;

  while (remaining > 0 && safety < 2000) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const isoDate = cursor.toISOString().slice(0, 10);

    if (isTradingDay(isoDate)) {
      remaining -= 1;
    }

    safety += 1;
  }

  return cursor.toISOString().slice(0, 10);
}

function buildPriceRows({ centerPrice, volatility, totalDays, rangeMultiplier, rowCount }) {
  const halfSteps = Math.floor(rowCount / 2);
  const timeYears = Math.max(tradingDaysToYears(totalDays), 1 / 252);
  const sigmaMove = Math.max(centerPrice * volatility * Math.sqrt(timeYears), Math.max(centerPrice * 0.04, 1));

  return Array.from({ length: rowCount }, (_value, index) => {
    const relativePosition = halfSteps === 0 ? 0 : (halfSteps - index) / halfSteps;
    const spot = Math.max(centerPrice + relativePosition * rangeMultiplier * sigmaMove, 0.01);
    const sigmaOffset = sigmaMove > 0 ? (spot - centerPrice) / sigmaMove : 0;

    return {
      id: `${rangeMultiplier}-${index}`,
      spot,
      sigmaOffset,
      isCurrentPrice: index === halfSteps
    };
  });
}

function buildCellStyle(value, maxAbsValue, theme) {
  return getScenarioHeatmapCellStyle(value, maxAbsValue, theme);
}

export function buildScenarioHeatmapSnapshot({
  startDate,
  endDate,
  currentPrice,
  volatility,
  ivAtm = null,
  ivPut = null,
  ivCall = null,
  spotLabel = "Price",
  priceDigits = 2,
  secondarySpotLabel = "",
  secondaryPriceDigits = 2,
  getSecondarySpot = null,
  rowCount = DEFAULT_ROW_COUNT,
  columnCount = DEFAULT_COLUMN_COUNT,
  getCellPnL,
  rangeMultiplier = DEFAULT_RANGE_MULTIPLIER
}) {
  const numericCurrentPrice = Number(currentPrice);
  const numericVolatility = Math.max(Number(volatility) || 0, 0.01);
  const resolvedIvAtm = Math.max(Number(ivAtm ?? numericVolatility) || numericVolatility, 0.01);
  const resolvedIvPut = Math.max(Number(ivPut ?? resolvedIvAtm * 1.2) || resolvedIvAtm * 1.2, 0.01);
  const resolvedIvCall = Math.max(Number(ivCall ?? resolvedIvAtm * 0.9) || resolvedIvAtm * 0.9, 0.01);

  if (
    !startDate ||
    !endDate ||
    typeof getCellPnL !== "function" ||
    !Number.isFinite(numericCurrentPrice) ||
    numericCurrentPrice <= 0
  ) {
    return null;
  }

  const totalDays = countTradingDaysBetween(startDate, endDate, {
    includeStart: false,
    includeEnd: true
  });
  const columns = buildDateColumns(startDate, endDate, columnCount);
  const rows = buildPriceRows({
    centerPrice: numericCurrentPrice,
    volatility: numericVolatility,
    totalDays,
    rangeMultiplier,
    rowCount
  });
  const grid = rows.map((row) => ({
    ...row,
    secondarySpot:
      typeof getSecondarySpot === "function" ? Number(getSecondarySpot(row.spot)) : null,
    cells: columns.map((column) => ({
      ...column,
      pnl: Number(getCellPnL({ spot: row.spot, date: column.date }))
    }))
  }));
  const pnlValues = grid.flatMap((row) => row.cells.map((cell) => cell.pnl)).filter(Number.isFinite);
  const maxAbsPnl = pnlValues.length ? Math.max(...pnlValues.map((value) => Math.abs(value))) : 0;
  const topRowPrice = rows[0]?.spot ?? numericCurrentPrice;
  const bottomRowPrice = rows[rows.length - 1]?.spot ?? numericCurrentPrice;

  return {
    startDate,
    endDate,
    currentPrice: numericCurrentPrice,
    volatility: numericVolatility,
    ivAtm: resolvedIvAtm,
    ivPut: resolvedIvPut,
    ivCall: resolvedIvCall,
    iv_atm: resolvedIvAtm,
    iv_put: resolvedIvPut,
    iv_call: resolvedIvCall,
    spotLabel,
    priceDigits,
    secondarySpotLabel,
    secondaryPriceDigits,
    rowCount,
    columnCount,
    rangeMultiplier,
    totalDays,
    topRowPrice,
    bottomRowPrice,
    maxAbsPnl,
    columns,
    rows: grid
  };
}

export default function ScenarioHeatmap({
  className = "",
  title = "Time series heat map",
  description = "P/L across dates and price levels, centered on the current price.",
  startDate,
  endDate,
  currentPrice,
  volatility,
  ivAtm = null,
  ivPut = null,
  ivCall = null,
  spotLabel = "Price",
  priceDigits = 2,
  secondarySpotLabel = "",
  secondaryPriceDigits = 2,
  getSecondarySpot = null,
  rowCount = null,
  onRowCountChange = null,
  columnCount = null,
  onColumnCountChange = null,
  getCellPnL,
  getCellSignal = null,
  theme = "dark",
  rangeMultiplier = null,
  onRangeMultiplierChange = null,
  snapshot = null,
  defaultView = "pnl"
}) {
  const [internalRangeMultiplier, setInternalRangeMultiplier] = useState(DEFAULT_RANGE_MULTIPLIER);
  const [internalRowCount, setInternalRowCount] = useState(DEFAULT_ROW_COUNT);
  const [internalColumnCount, setInternalColumnCount] = useState(DEFAULT_COLUMN_COUNT);
  const baselineHorizonDays = useMemo(() => {
    if (!startDate || !endDate) {
      return 0;
    }

    return countTradingDaysBetween(startDate, endDate, {
      includeStart: false,
      includeEnd: true
    });
  }, [startDate, endDate]);
  const [internalHorizonDays, setInternalHorizonDays] = useState(() => baselineHorizonDays);
  const [viewMode, setViewMode] = useState(defaultView === "ev" ? "ev" : "pnl");
  const [showProbability, setShowProbability] = useState(true);
  const [probabilityState, setProbabilityState] = useState({
    status: "idle",
    prob_matrix: null,
    ev_matrix: null,
    meta: null,
    validation: null,
    error: ""
  });
  const probabilityCacheRef = useRef(new Map());
  const monteCarloWorkersRef = useRef([]);

  useEffect(() => {
    if (snapshot) {
      return;
    }

    setInternalHorizonDays(baselineHorizonDays);
  }, [baselineHorizonDays, snapshot]);

  const resolvedRowCount =
    snapshot?.rowCount ??
    (Number.isFinite(Number(rowCount)) && Number(rowCount) >= MIN_ROW_COUNT ? Number(rowCount) : internalRowCount);
  const resolvedColumnCount =
    snapshot?.columnCount ??
    (Number.isFinite(Number(columnCount)) && Number(columnCount) >= MIN_COLUMN_COUNT
      ? Number(columnCount)
      : internalColumnCount);
  const resolvedHorizonDays = snapshot?.totalDays ?? internalHorizonDays;
  const computedEndDate = snapshot?.endDate ?? addTradingDaysToDate(startDate, resolvedHorizonDays);
  const resolvedRangeMultiplier =
    snapshot?.rangeMultiplier ??
    (Number.isFinite(Number(rangeMultiplier)) && Number(rangeMultiplier) > 0
      ? Number(rangeMultiplier)
      : internalRangeMultiplier);
  const heatmapSnapshot =
    snapshot ??
    buildScenarioHeatmapSnapshot({
      startDate,
      endDate: computedEndDate,
      currentPrice,
      volatility,
      ivAtm,
      ivPut,
      ivCall,
      spotLabel,
      priceDigits,
      secondarySpotLabel,
      secondaryPriceDigits,
      getSecondarySpot,
      rowCount: resolvedRowCount,
      columnCount: resolvedColumnCount,
      getCellPnL,
      rangeMultiplier: resolvedRangeMultiplier
    });

  if (!heatmapSnapshot) {
    return null;
  }

  const {
    startDate: resolvedStartDate,
    endDate: resolvedEndDate,
    currentPrice: resolvedCurrentPrice,
    volatility: resolvedVolatility,
    ivAtm: resolvedIvAtmRaw,
    ivPut: resolvedIvPutRaw,
    ivCall: resolvedIvCallRaw,
    spotLabel: resolvedSpotLabel,
    priceDigits: resolvedPriceDigits,
    secondarySpotLabel: resolvedSecondarySpotLabel,
    secondaryPriceDigits: resolvedSecondaryPriceDigits,
    rangeMultiplier: resolvedSnapshotRangeMultiplier,
    topRowPrice,
    bottomRowPrice,
    maxAbsPnl,
    columns,
    rows: grid
  } = heatmapSnapshot;

  const resolvedIvAtm = Number.isFinite(Number(resolvedIvAtmRaw))
    ? Number(resolvedIvAtmRaw)
    : Number.isFinite(Number(heatmapSnapshot?.iv_atm))
      ? Number(heatmapSnapshot.iv_atm)
      : resolvedVolatility;
  const resolvedIvPut = Number.isFinite(Number(resolvedIvPutRaw))
    ? Number(resolvedIvPutRaw)
    : Number.isFinite(Number(heatmapSnapshot?.iv_put))
      ? Number(heatmapSnapshot.iv_put)
      : resolvedIvAtm * 1.2;
  const resolvedIvCall = Number.isFinite(Number(resolvedIvCallRaw))
    ? Number(resolvedIvCallRaw)
    : Number.isFinite(Number(heatmapSnapshot?.iv_call))
      ? Number(heatmapSnapshot.iv_call)
      : resolvedIvAtm * 0.9;

  const { pnlMatrix, maxAbsValue: maxAbsPnlMatrix } = useMemo(() => {
    const rows = grid.length;
    const cols = columns.length;
    const matrix = new Float32Array(rows * cols);
    let maxAbs = 0;

    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const cells = grid[rowIndex]?.cells ?? [];

      for (let colIndex = 0; colIndex < cols; colIndex += 1) {
        const value = Number(cells[colIndex]?.pnl);
        const numericValue = Number.isFinite(value) ? value : NaN;
        matrix[rowIndex * cols + colIndex] = Number.isFinite(numericValue) ? numericValue : NaN;

        if (Number.isFinite(numericValue)) {
          maxAbs = Math.max(maxAbs, Math.abs(numericValue));
        }
      }
    }

    return { pnlMatrix: matrix, maxAbsValue: maxAbs };
  }, [grid, columns]);

  const { maxAbsEv, highEvThreshold, bigLossThreshold } = useMemo(() => {
    const ev = probabilityState.ev_matrix;
    const values = [];
    const losses = [];
    let maxAbs = 0;

    if (ev instanceof Float32Array && ev.length) {
      for (const value of ev) {
        if (Number.isFinite(value)) {
          maxAbs = Math.max(maxAbs, Math.abs(value));
          if (value > 0) {
            values.push(value);
          }
        }
      }
    }

    for (const pnl of pnlMatrix) {
      if (Number.isFinite(pnl) && pnl < 0) {
        losses.push(Math.abs(pnl));
      }
    }

    values.sort((a, b) => a - b);
    losses.sort((a, b) => a - b);

    const evCut =
      values.length > 0 ? values[Math.floor(values.length * 0.9)] : Number.POSITIVE_INFINITY;
    const lossCut =
      losses.length > 0 ? losses[Math.floor(losses.length * 0.9)] : Number.POSITIVE_INFINITY;

    return {
      maxAbsEv: maxAbs,
      highEvThreshold: evCut,
      bigLossThreshold: lossCut
    };
  }, [probabilityState.ev_matrix, pnlMatrix]);

  function handleRangeChange(nextRangeMultiplier) {
    if (snapshot) {
      return;
    }

    if (typeof onRangeMultiplierChange === "function") {
      onRangeMultiplierChange(nextRangeMultiplier);
      return;
    }

    setInternalRangeMultiplier(nextRangeMultiplier);
  }

  function handleRowCountChange(nextRowCount) {
    if (snapshot) {
      return;
    }

    const normalizedRowCount = clamp(Math.round(Number(nextRowCount) || DEFAULT_ROW_COUNT), MIN_ROW_COUNT, MAX_ROW_COUNT);
    const oddRowCount = normalizedRowCount % 2 === 0 ? normalizedRowCount + 1 : normalizedRowCount;

    if (typeof onRowCountChange === "function") {
      onRowCountChange(oddRowCount);
      return;
    }

    setInternalRowCount(oddRowCount);
  }

  function handleColumnCountChange(nextColumnCount) {
    if (snapshot) {
      return;
    }

    const normalizedColumnCount = clamp(
      Math.round(Number(nextColumnCount) || DEFAULT_COLUMN_COUNT),
      MIN_COLUMN_COUNT,
      MAX_COLUMN_COUNT
    );

    if (typeof onColumnCountChange === "function") {
      onColumnCountChange(normalizedColumnCount);
      return;
    }

    setInternalColumnCount(normalizedColumnCount);
  }

  function handleHorizonDaysChange(nextHorizonDays) {
    if (snapshot) {
      return;
    }

    const normalizedDays = clamp(Math.round(Number(nextHorizonDays) || 0), 0, MAX_HORIZON_DAYS);
    setInternalHorizonDays(normalizedDays);
  }

  const simulationKey = useMemo(() => {
    const priceKey = grid.map((row) => Number(row.spot).toFixed(4)).join(",");
    const dayKey = columns.map((column) => column.offsetDays).join(",");

    return `${resolvedCurrentPrice.toFixed(4)}|${resolvedIvAtm.toFixed(4)}|${resolvedIvPut.toFixed(4)}|${resolvedIvCall.toFixed(4)}|${priceKey}|${dayKey}|50000`;
  }, [grid, columns, resolvedCurrentPrice, resolvedIvAtm, resolvedIvPut, resolvedIvCall]);

  useEffect(() => {
    if (!showProbability && viewMode !== "ev") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const cached = probabilityCacheRef.current.get(simulationKey);
    if (cached) {
      const ev_matrix = buildProbabilityWeightedMatrix(cached.prob_matrix, pnlMatrix);
      setProbabilityState((current) => ({
        ...current,
        status: "ready",
        prob_matrix: cached.prob_matrix,
        ev_matrix,
        meta: cached.meta,
        validation: cached.validation ?? null,
        error: ""
      }));
      return;
    }

    let cancelled = false;
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startTime =
      typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

    setProbabilityState((current) => ({
      ...current,
      status: "computing",
      error: ""
    }));

    const priceLevels = grid.map((row) => row.spot);
    const dayOffsets = columns.map((column) => column.offsetDays);
    const payload = {
      currentPrice: resolvedCurrentPrice,
      ivAtm: resolvedIvAtm,
      ivPut: resolvedIvPut,
      ivCall: resolvedIvCall,
      priceLevels,
      dayOffsets,
      numPaths: 50000,
      dt: 1 / 252
    };

    const finalize = ({ prob_matrix, meta }) => {
      const ev_matrix = buildProbabilityWeightedMatrix(prob_matrix, pnlMatrix);
      const baseValidation = validateTouchProbabilityMatrix(prob_matrix, grid.length, columns.length);
      const levelIssues = validateTouchProbabilityAcrossLevels(
        prob_matrix,
        priceLevels,
        resolvedCurrentPrice,
        columns.length
      );
      const validation = levelIssues.length
        ? {
            ...baseValidation,
            issues: [...(baseValidation.issues ?? []), ...levelIssues]
          }
        : baseValidation;
      const elapsedMs =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now() - startTime
          : Date.now() - startTime;
      const patchedMeta = meta ? { ...meta, elapsedMs } : { elapsedMs };

      const cachePayload = { prob_matrix, meta: patchedMeta, validation };

      probabilityCacheRef.current.set(simulationKey, cachePayload);
      if (probabilityCacheRef.current.size > 12) {
        const oldestKey = probabilityCacheRef.current.keys().next().value;
        probabilityCacheRef.current.delete(oldestKey);
      }

      setProbabilityState((current) => ({
        ...current,
        status: "ready",
        prob_matrix,
        ev_matrix,
        meta: patchedMeta,
        validation,
        error: ""
      }));
    };

    const fail = (message) => {
      setProbabilityState((current) => ({
        ...current,
        status: "error",
        error: message || "Monte Carlo simulation failed."
      }));
    };

    const computeOnMainThread = () => {
      try {
        const { prob_matrix, meta } = buildTouchProbabilityMatrix(payload);
        if (!cancelled) {
          finalize({ prob_matrix, meta });
        }
      } catch (error) {
        if (!cancelled) {
          fail(error?.message);
        }
      }
    };

    const terminateActiveWorkers = () => {
      for (const activeWorker of monteCarloWorkersRef.current) {
        activeWorker?.terminate?.();
      }
      monteCarloWorkersRef.current = [];
    };

    try {
      terminateActiveWorkers();

      const totalPaths = payload.numPaths;
      const desiredWorkers = getMonteCarloWorkerCount(totalPaths);
      const shardPaths = splitMonteCarloPaths(totalPaths, desiredWorkers);
      const workerCount = shardPaths.length;
      const matrixLength = grid.length * columns.length;

      const spawnWorker = ({ shardIndex, shardPayload, requestId, onResult, onError }) => {
        const worker = new Worker(new URL("../workers/scenarioMonteCarloWorker.js", import.meta.url), {
          type: "module"
        });

        worker.onmessage = (event) => {
          if (cancelled) {
            return;
          }

          const message = event?.data ?? null;
          if (!message || message.requestId !== requestId) {
            return;
          }

          if (message.type === "error") {
            onError(message.error);
            return;
          }

          if (message.type !== "result") {
            return;
          }

          try {
            const probBuffer = message.probBuffer;
            const prob_matrix = probBuffer ? new Float32Array(probBuffer) : new Float32Array(0);
            const meta = message.meta ?? null;
            onResult({ prob_matrix, meta, shardIndex });
          } catch (error) {
            onError(error?.message);
          }
        };

        worker.onerror = (event) => {
          if (cancelled) {
            return;
          }

          onError(event?.message ?? "Monte Carlo worker failed.");
        };

        worker.postMessage({
          type: "compute",
          requestId,
          payload: shardPayload
        });

        return worker;
      };

      const computeUsingSingleWorker = () => {
        const singleRequestId = `${requestId}-single`;
        const worker = spawnWorker({
          shardIndex: 0,
          shardPayload: {
            ...payload,
            seed: `${simulationKey}|single`
          },
          requestId: singleRequestId,
          onResult: ({ prob_matrix, meta }) => finalize({ prob_matrix, meta }),
          onError: (message) => fail(message)
        });

        monteCarloWorkersRef.current = [worker];
      };

      if (workerCount <= 1) {
        computeUsingSingleWorker();
      } else {
        const accumulator = new Float64Array(matrixLength);
        let completed = 0;
        let completedPaths = 0;
        let baseMeta = null;
        let failed = false;

        const finishSharded = () => {
          const combined = new Float32Array(matrixLength);
          const divisor = totalPaths > 0 ? totalPaths : 1;

          for (let index = 0; index < matrixLength; index += 1) {
            combined[index] = accumulator[index] / divisor;
          }

          const combinedMeta = baseMeta
            ? {
                ...baseMeta,
                numPaths: totalPaths,
                seed: null,
                shards: workerCount,
                shardPaths
              }
            : {
                numPaths: totalPaths,
                maxDays: Math.max(...dayOffsets, 0),
                rowCount: grid.length,
                columnCount: columns.length,
                dayOffsets,
                shards: workerCount,
                shardPaths,
                seed: null,
                ivAtm: resolvedIvAtm,
                ivPut: resolvedIvPut,
                ivCall: resolvedIvCall
              };

          finalize({ prob_matrix: combined, meta: combinedMeta });
        };

        const handleShardError = (message) => {
          if (failed || cancelled) {
            return;
          }

          failed = true;
          terminateActiveWorkers();
          // Fall back to a single worker for reliability.
          try {
            computeUsingSingleWorker();
          } catch (_error) {
            computeOnMainThread();
          }
        };

        const workers = shardPaths.map((pathsForShard, shardIndex) => {
          const shardRequestId = `${requestId}-shard-${shardIndex}`;
          const shardPayload = {
            ...payload,
            numPaths: pathsForShard,
            seed: `${simulationKey}|shard-${shardIndex}`
          };

          return spawnWorker({
            shardIndex,
            shardPayload,
            requestId: shardRequestId,
            onResult: ({ prob_matrix, meta }) => {
              if (failed || cancelled) {
                return;
              }

              if (!(prob_matrix instanceof Float32Array) || prob_matrix.length !== matrixLength) {
                handleShardError("Monte Carlo worker returned unexpected data.");
                return;
              }

              if (!baseMeta && meta) {
                baseMeta = meta;
              }

              completed += 1;
              completedPaths += pathsForShard;

              for (let index = 0; index < matrixLength; index += 1) {
                const value = prob_matrix[index];
                accumulator[index] += (Number.isFinite(value) ? value : 0) * pathsForShard;
              }

              if (completed === workerCount && completedPaths === totalPaths) {
                finishSharded();
              }
            },
            onError: handleShardError
          });
        });

        monteCarloWorkersRef.current = workers;
      }
    } catch (_error) {
      computeOnMainThread();
    }

    return () => {
      cancelled = true;
      for (const activeWorker of monteCarloWorkersRef.current) {
        activeWorker?.terminate?.();
      }
      monteCarloWorkersRef.current = [];
    };
  }, [
    showProbability,
    viewMode,
    simulationKey,
    pnlMatrix
  ]);

  const activeMaxAbs = viewMode === "ev" ? maxAbsEv : maxAbsPnlMatrix || maxAbsPnl;

  return (
    <section className={`detail-chart scenario-heatmap ${className}`.trim()}>
      <div className="detail-chart__header scenario-heatmap__header">
        <div>
          <span className="brand__eyebrow">{title}</span>
          <p className="detail-chart__copy">{description}</p>
        </div>
        <div className="scenario-heatmap__controls">
          <span className="scenario-heatmap__controls-label">
            {snapshot ? `Snapshot range ${resolvedSnapshotRangeMultiplier}x` : "Current Vol range"}
          </span>
          <div className="chart-toggle-group">
            <button
              type="button"
              className={`chart-toggle chart-toggle--compact ${viewMode === "pnl" ? "chart-toggle--active" : ""}`}
              onClick={() => setViewMode("pnl")}
            >
              P&amp;L
            </button>
            <button
              type="button"
              className={`chart-toggle chart-toggle--compact ${viewMode === "ev" ? "chart-toggle--active" : ""}`}
              onClick={() => setViewMode("ev")}
            >
              EV
            </button>
            <button
              type="button"
              className={`chart-toggle chart-toggle--compact ${showProbability ? "chart-toggle--active" : ""}`}
              onClick={() => setShowProbability((current) => !current)}
            >
              Prob
            </button>
          </div>
          {!snapshot ? (
            <div className="chart-toggle-group">
              {RANGE_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`chart-toggle chart-toggle--compact ${resolvedSnapshotRangeMultiplier === option ? "chart-toggle--active" : ""}`}
                  onClick={() => handleRangeChange(option)}
                >
                  {option}x
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="scenario-heatmap__meta">
        <span>
          Center {resolvedSpotLabel} {formatCurrency(resolvedCurrentPrice, "USD", resolvedPriceDigits)}
        </span>
        <span>
          Band {formatCurrency(bottomRowPrice, "USD", resolvedPriceDigits)} to{" "}
          {formatCurrency(topRowPrice, "USD", resolvedPriceDigits)}
        </span>
        <span>
          IV atm/put/call {formatNumber(resolvedIvAtm * 100, 2)}% / {formatNumber(resolvedIvPut * 100, 2)}% /{" "}
          {formatNumber(resolvedIvCall * 100, 2)}%
        </span>
        <span>
          Touch prob {probabilityState.status === "computing" ? "Simulating..." : probabilityState.status === "error" ? "Error" : "Ready"}
        </span>
        <span>
          {formatDateLabel(resolvedStartDate)} to {formatDateLabel(resolvedEndDate)}
        </span>
        {probabilityState.validation?.issues?.length ? (
          <span>Prob check {probabilityState.validation.issues.length} issue(s)</span>
        ) : null}
      </div>

      <div className="scenario-heatmap__frame">
        <table
          className="scenario-heatmap__table"
          aria-label={`${title} showing profit and loss by date and ${resolvedSpotLabel.toLowerCase()}`}
        >
          <thead>
            <tr>
              <th scope="col" className="scenario-heatmap__axis">
                <div className="scenario-heatmap__axis-label">
                  <strong>{resolvedSpotLabel}</strong>
                  <small>
                    {resolvedSecondarySpotLabel ? `${resolvedSpotLabel} / ${resolvedSecondarySpotLabel}` : "Date"}
                  </small>
                </div>
              </th>
              {columns.map((column) => (
                <th key={column.date} scope="col">
                  <div className="scenario-heatmap__date-label">
                    <strong>{formatShortDate(column.date)}</strong>
                    <small>{column.isStart ? "Today" : column.isEnd ? "End" : `+${column.offsetDays}d`}</small>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, rowIndex) => (
              <tr key={row.id} className={row.isCurrentPrice ? "scenario-heatmap__row--current" : ""}>
                <th scope="row">
                  <div className="scenario-heatmap__row-label">
                    <div className="scenario-heatmap__row-price-stack">
                      <strong className="scenario-heatmap__row-price scenario-heatmap__row-price--primary">
                        {formatCurrency(row.spot, "USD", resolvedPriceDigits)}
                      </strong>
                      {resolvedSecondarySpotLabel && Number.isFinite(row.secondarySpot) ? (
                        <span className="scenario-heatmap__row-price scenario-heatmap__row-price--secondary">
                          {formatCurrency(row.secondarySpot, "USD", resolvedSecondaryPriceDigits)}
                        </span>
                      ) : null}
                    </div>
                    <small>
                      {row.isCurrentPrice
                        ? "Current price"
                        : `${row.sigmaOffset > 0 ? "+" : ""}${formatNumber(row.sigmaOffset, 1)} sigma`}
                    </small>
                  </div>
                </th>
                {row.cells.map((cell, colIndex) => {
                  const flatIndex = rowIndex * columns.length + colIndex;
                  const prob =
                    probabilityState.prob_matrix instanceof Float32Array
                      ? probabilityState.prob_matrix[flatIndex]
                      : NaN;
                  const probTone = getProbabilityTone(prob);
                  const ev =
                    probabilityState.ev_matrix instanceof Float32Array ? probabilityState.ev_matrix[flatIndex] : NaN;
                  const pnl = pnlMatrix[flatIndex];
                  const displayValue = viewMode === "ev" ? ev : pnl;
                  const hedgeSignalRaw =
                    typeof getCellSignal === "function"
                      ? String(getCellSignal({ spot: row.spot, date: cell.date }) ?? "").trim().toUpperCase()
                      : "";
                  const hedgeSignalClass =
                    hedgeSignalRaw === "HEDGE_SHORT"
                      ? " scenario-heatmap__cell--hedge-short"
                      : hedgeSignalRaw === "HEDGE_LONG"
                        ? " scenario-heatmap__cell--hedge-long"
                        : hedgeSignalRaw === "RECHECK"
                          ? " scenario-heatmap__cell--hedge-recheck"
                          : hedgeSignalRaw === "EXIT_SIGNAL"
                            ? " scenario-heatmap__cell--hedge-exit"
                            : "";
                  const isEdge = Number.isFinite(ev) && ev > 0 && ev >= highEvThreshold;
                  const isRisk =
                    Number.isFinite(prob) &&
                    Number.isFinite(pnl) &&
                    pnl < 0 &&
                    Math.abs(pnl) >= bigLossThreshold &&
                    prob <= 0.12;

                  return (
                    <td
                      key={`${row.id}-${cell.date}`}
                      className={`scenario-heatmap__cell${isEdge ? " scenario-heatmap__cell--edge" : ""}${
                        isRisk ? " scenario-heatmap__cell--risk" : ""
                      }${hedgeSignalClass}`}
                      style={buildCellStyle(displayValue, activeMaxAbs, theme)}
                      title={`${formatDateLabel(cell.date)} · ${resolvedSpotLabel} ${formatCurrency(row.spot, "USD", resolvedPriceDigits)} · P/L ${formatCurrency(pnl)} · Touch ${Number.isFinite(prob) ? formatPercent(prob, 0) : "n/a"} · EV ${Number.isFinite(ev) ? formatCurrency(ev) : "n/a"}${hedgeSignalRaw ? ` · Hedge ${hedgeSignalRaw}` : ""}`}
                    >
                      <div className="scenario-heatmap__cell-inner">
                        <span className="scenario-heatmap__cell-value">
                          {formatCellCurrency(displayValue)}
                        </span>
                        {showProbability ? (
                          <span
                            className={`scenario-heatmap__cell-prob scenario-heatmap__cell-prob--${probTone}`}
                          >
                            {Number.isFinite(prob) ? formatPercent(prob, 0) : "…"}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!snapshot ? (
        <div className="scenario-heatmap__settings">
          <div className="scenario-heatmap__setting">
            <div className="scenario-heatmap__setting-header">
              <span>Price gap (range)</span>
              <strong>{formatNumber(resolvedSnapshotRangeMultiplier, 2)}x</strong>
            </div>
            <input
              className="scenario-heatmap__setting-range"
              type="range"
              min={DEFAULT_RANGE_SLIDER_MIN}
              max={DEFAULT_RANGE_SLIDER_MAX}
              step="0.05"
              value={clamp(resolvedSnapshotRangeMultiplier, DEFAULT_RANGE_SLIDER_MIN, DEFAULT_RANGE_SLIDER_MAX)}
              onChange={(event) => handleRangeChange(Number(event.target.value))}
            />
          </div>
          <div className="scenario-heatmap__setting">
            <div className="scenario-heatmap__setting-header">
              <span>Rows</span>
              <strong>{resolvedRowCount}</strong>
            </div>
            <input
              className="scenario-heatmap__setting-range"
              type="range"
              min={MIN_ROW_COUNT}
              max={MAX_ROW_COUNT}
              step="2"
              value={clamp(resolvedRowCount, MIN_ROW_COUNT, MAX_ROW_COUNT)}
              onChange={(event) => handleRowCountChange(event.target.value)}
            />
          </div>
          <div className="scenario-heatmap__setting">
            <div className="scenario-heatmap__setting-header">
              <span>Date columns</span>
              <strong>{resolvedColumnCount}</strong>
            </div>
            <input
              className="scenario-heatmap__setting-range"
              type="range"
              min={MIN_COLUMN_COUNT}
              max={MAX_COLUMN_COUNT}
              step="1"
              value={clamp(resolvedColumnCount, MIN_COLUMN_COUNT, MAX_COLUMN_COUNT)}
              onChange={(event) => handleColumnCountChange(event.target.value)}
            />
            <div className="scenario-heatmap__setting-meta">
              <span>Showing {columns.length} trading date{columns.length === 1 ? "" : "s"}</span>
            </div>
          </div>
          <div className="scenario-heatmap__setting">
            <div className="scenario-heatmap__setting-header">
              <span>Horizon</span>
              <strong>{resolvedHorizonDays}d</strong>
            </div>
            <input
              className="scenario-heatmap__setting-range"
              type="range"
              min={Math.min(baselineHorizonDays, MAX_HORIZON_DAYS)}
              max={MAX_HORIZON_DAYS}
              step="1"
              value={clamp(resolvedHorizonDays, 0, MAX_HORIZON_DAYS)}
              onChange={(event) => handleHorizonDaysChange(event.target.value)}
            />
            <div className="scenario-heatmap__setting-meta">
              <span>{formatShortDate(resolvedStartDate)} → {formatShortDate(resolvedEndDate)}</span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
