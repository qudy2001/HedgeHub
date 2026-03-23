import { useState } from "react";
import { getScenarioHeatmapCellStyle } from "../theme.js";
import {
  buildTradingDateColumns,
  countTradingDaysBetween,
  tradingDaysToYears
} from "../tradingCalendar.js";

const DEFAULT_RANGE_MULTIPLIER = 1;
const RANGE_OPTIONS = [1, 2, 3];
const DEFAULT_ROW_COUNT = 13;
const DEFAULT_COLUMN_COUNT = 10;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
  spotLabel = "Price",
  priceDigits = 2,
  secondarySpotLabel = "",
  secondaryPriceDigits = 2,
  getSecondarySpot = null,
  rowCount = DEFAULT_ROW_COUNT,
  columnCount = DEFAULT_COLUMN_COUNT,
  getCellPnL,
  theme = "dark",
  rangeMultiplier = null,
  onRangeMultiplierChange = null,
  snapshot = null
}) {
  const [internalRangeMultiplier, setInternalRangeMultiplier] = useState(DEFAULT_RANGE_MULTIPLIER);
  const resolvedRangeMultiplier =
    snapshot?.rangeMultiplier ??
    (Number.isFinite(Number(rangeMultiplier)) && Number(rangeMultiplier) > 0
      ? Number(rangeMultiplier)
      : internalRangeMultiplier);
  const heatmapSnapshot =
    snapshot ??
    buildScenarioHeatmapSnapshot({
      startDate,
      endDate,
      currentPrice,
      volatility,
      spotLabel,
      priceDigits,
      secondarySpotLabel,
      secondaryPriceDigits,
      getSecondarySpot,
      rowCount,
      columnCount,
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
          {!snapshot ? (
            <div className="chart-toggle-group">
              {RANGE_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`chart-toggle ${resolvedSnapshotRangeMultiplier === option ? "chart-toggle--active" : ""}`}
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
        <span>Volatility {formatNumber(resolvedVolatility * 100, 2)}%</span>
        <span>
          {formatDateLabel(resolvedStartDate)} to {formatDateLabel(resolvedEndDate)}
        </span>
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
                    <small>{column.isStart ? "Today" : column.isEnd ? "Earliest end" : `+${column.offsetDays}d`}</small>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row) => (
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
                {row.cells.map((cell) => (
                  <td
                    key={`${row.id}-${cell.date}`}
                    className="scenario-heatmap__cell"
                    style={buildCellStyle(cell.pnl, maxAbsPnl, theme)}
                    title={`${formatDateLabel(cell.date)} · ${resolvedSpotLabel} ${formatCurrency(row.spot, "USD", resolvedPriceDigits)} · P/L ${formatCurrency(cell.pnl)}`}
                  >
                    <span>{formatCellCurrency(cell.pnl)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
