import { useState } from "react";
import { getScenarioHeatmapCellStyle } from "../theme.js";

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

function differenceInDays(startValue, endValue) {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);

  if (!start || !end) {
    return 0;
  }

  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function addDays(dateValue, days) {
  const date = parseIsoDate(dateValue);
  if (!date) {
    return "";
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
  const totalDays = Math.max(differenceInDays(startDate, endDate), 0);

  if (totalDays === 0) {
    return [
      {
        date: startDate,
        offsetDays: 0,
        isStart: true,
        isEnd: true
      }
    ];
  }

  const targetCount = Math.min(totalDays + 1, Math.max(columnCount, 2));
  const offsets = Array.from({ length: targetCount }, (_value, index) =>
    Math.round((totalDays * index) / (targetCount - 1))
  );
  const uniqueOffsets = offsets.filter((offset, index, array) => array.indexOf(offset) === index);

  if (uniqueOffsets[0] !== 0) {
    uniqueOffsets.unshift(0);
  }

  if (uniqueOffsets[uniqueOffsets.length - 1] !== totalDays) {
    uniqueOffsets.push(totalDays);
  }

  return uniqueOffsets.map((offsetDays, index, array) => ({
    date: addDays(startDate, offsetDays),
    offsetDays,
    isStart: offsetDays === 0,
    isEnd: offsetDays === totalDays,
    index,
    size: array.length
  }));
}

function buildPriceRows({ centerPrice, volatility, totalDays, rangeMultiplier, rowCount }) {
  const halfSteps = Math.floor(rowCount / 2);
  const timeYears = Math.max(totalDays, 1) / 365;
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
  theme = "dark"
}) {
  const [rangeMultiplier, setRangeMultiplier] = useState(DEFAULT_RANGE_MULTIPLIER);
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

  const totalDays = Math.max(differenceInDays(startDate, endDate), 0);
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

  return (
    <section className={`detail-chart scenario-heatmap ${className}`.trim()}>
      <div className="detail-chart__header scenario-heatmap__header">
        <div>
          <span className="brand__eyebrow">{title}</span>
          <p className="detail-chart__copy">{description}</p>
        </div>
        <div className="scenario-heatmap__controls">
          <span className="scenario-heatmap__controls-label">Current Vol range</span>
          <div className="chart-toggle-group">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={`chart-toggle ${rangeMultiplier === option ? "chart-toggle--active" : ""}`}
                onClick={() => setRangeMultiplier(option)}
              >
                {option}x
              </button>
            ))}
          </div>
        </div>
      </div>

	      <div className="scenario-heatmap__meta">
        <span>
          Center {spotLabel} {formatCurrency(numericCurrentPrice, "USD", priceDigits)}
        </span>
        <span>
          Band {formatCurrency(bottomRowPrice, "USD", priceDigits)} to{" "}
          {formatCurrency(topRowPrice, "USD", priceDigits)}
        </span>
        <span>Volatility {formatNumber(numericVolatility * 100, 2)}%</span>
        <span>
          {formatDateLabel(startDate)} to {formatDateLabel(endDate)}
        </span>
      </div>

      <div className="scenario-heatmap__frame">
        <table
          className="scenario-heatmap__table"
          aria-label={`${title} showing profit and loss by date and ${spotLabel.toLowerCase()}`}
        >
	          <thead>
	            <tr>
	              <th scope="col" className="scenario-heatmap__axis">
	                <div className="scenario-heatmap__axis-label">
	                  <strong>{spotLabel}</strong>
	                  <small>{secondarySpotLabel ? `${spotLabel} / ${secondarySpotLabel}` : "Date"}</small>
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
	                        {formatCurrency(row.spot, "USD", priceDigits)}
	                      </strong>
	                      {secondarySpotLabel && Number.isFinite(row.secondarySpot) ? (
	                        <span className="scenario-heatmap__row-price scenario-heatmap__row-price--secondary">
	                          {formatCurrency(row.secondarySpot, "USD", secondaryPriceDigits)}
	                        </span>
	                      ) : null}
	                    </div>
	                    <small>{row.isCurrentPrice ? "Current price" : `${row.sigmaOffset > 0 ? "+" : ""}${formatNumber(row.sigmaOffset, 1)} sigma`}</small>
	                  </div>
	                </th>
                {row.cells.map((cell) => (
                  <td
                    key={`${row.id}-${cell.date}`}
                    className="scenario-heatmap__cell"
                    style={buildCellStyle(cell.pnl, maxAbsPnl, theme)}
                    title={`${formatDateLabel(cell.date)} · ${spotLabel} ${formatCurrency(row.spot, "USD", priceDigits)} · P/L ${formatCurrency(cell.pnl)}`}
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
