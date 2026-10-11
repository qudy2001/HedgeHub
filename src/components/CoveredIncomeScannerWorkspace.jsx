import EntryResearchPanel from "./EntryResearchPanel.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { createMarketTimerContext } from "../marketTimers.js";
import { getChartPalette } from "../theme.js";
import { loadSavedFilters, persistSavedFilters } from "../savedFilters.js";

const COVERED_INCOME_FILTERS_STORAGE_KEY = "hedgehub:filters:covered-income";
const MAX_SORT_PRIORITIES = 4;

const defaultFilters = {
  symbols: "TSLA, AAPL, NVDA, SPY",
  maxAllocatedCash: "100000",
  strategyModes: ["cash_secured_put", "covered_call", "covered_strangle"],
  targetDte: [7, 15, 21, 30],
  minOptionVolume: "50",
  minOpenInterest: "100",
  maxBidAskSpreadPct: "10",
  putDeltaMin: "0.15",
  putDeltaMax: "0.30",
  callDeltaMin: "0.10",
  callDeltaMax: "0.25",
  excludeEarningsBeforeExpiry: true
};

const strategyModeLabels = {
  cash_secured_put: "Cash-secured put",
  covered_call: "Covered call",
  covered_strangle: "Covered strangle"
};

const columns = [
  { key: "symbol", label: "Symbol" },
  { key: "stockPrice", label: "Spot" },
  { key: "strategyType", label: "Strategy" },
  { key: "expiryDate", label: "Expiry" },
  { key: "dte", label: "DTE" },
  { key: "putStrike", label: "Put strike" },
  { key: "putPremium", label: "Put prem" },
  { key: "putDelta", label: "Put delta" },
  { key: "callStrike", label: "Call strike" },
  { key: "callPremium", label: "Call prem" },
  { key: "callDelta", label: "Call delta" },
  { key: "totalPremium", label: "Total premium" },
  { key: "allocatedCashUsed", label: "Allocated cash" },
  { key: "fullExposure", label: "Full exposure" },
  { key: "returnOnAllocatedCashPct", label: "Alloc ret %" },
  { key: "annualizedReturnOnAllocatedCashPct", label: "Alloc ann %" },
  { key: "returnOnFullExposurePct", label: "Exposure ret %" },
  { key: "annualizedReturnOnFullExposurePct", label: "Exposure ann %" },
  { key: "downsideBreakeven", label: "Down breakeven" },
  { key: "calledAwayPrice", label: "Called-away" },
  { key: "supportConfidenceScore", label: "Support conf" },
  { key: "resistanceConfidenceScore", label: "Resistance conf" },
  { key: "earningsFlag", label: "Earnings" },
  { key: "liquidityFlag", label: "Liquidity" },
  { key: "capitalWarning", label: "Capital" },
  { key: "finalStrategyScore", label: "Score" }
];

const COVERED_INCOME_COMPACT_MEDIA_QUERY = "(max-width: 1240px)";
const COVERED_INCOME_COMPACT_COLUMN_KEYS = [
  "symbol",
  "stockPrice",
  "strategyType",
  "expiryDate",
  "dte",
  "putStrike",
  "putPremium",
  "putDelta",
  "callStrike",
  "callPremium",
  "callDelta",
  "finalStrategyScore"
];

function matchesCoveredIncomeCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(COVERED_INCOME_COMPACT_MEDIA_QUERY).matches;
}

function getDefaultCoveredIncomeVisibleColumnKeys(isCompactViewport = false) {
  if (isCompactViewport) {
    return COVERED_INCOME_COMPACT_COLUMN_KEYS.filter((key) => columns.some((column) => column.key === key));
  }

  return columns.map((column) => column.key);
}

function formatCurrency(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `$${numericValue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatCurrencyCompact(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(numericValue) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2
  }).format(numericValue);
}

function formatPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${numericValue.toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return numericValue.toFixed(digits);
}

function formatWholeNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(numericValue);
}

function formatStrategyType(value) {
  return strategyModeLabels[value] ?? String(value ?? "").replaceAll("_", " ");
}

function buildInitialFilters() {
  const saved = loadSavedFilters(COVERED_INCOME_FILTERS_STORAGE_KEY);
  if (!saved || typeof saved !== "object") {
    return defaultFilters;
  }

  return {
    ...defaultFilters,
    ...saved,
    strategyModes: Array.isArray(saved.strategyModes) && saved.strategyModes.length
      ? saved.strategyModes
      : defaultFilters.strategyModes,
    targetDte: Array.isArray(saved.targetDte) && saved.targetDte.length
      ? saved.targetDte
      : defaultFilters.targetDte,
    excludeEarningsBeforeExpiry: saved.excludeEarningsBeforeExpiry !== false,
    visibleColumnKeys:
      Array.isArray(saved.visibleColumnKeys) && saved.visibleColumnKeys.length
        ? saved.visibleColumnKeys.filter((key) => columns.some((column) => column.key === key))
        : getDefaultCoveredIncomeVisibleColumnKeys(matchesCoveredIncomeCompactViewport())
  };
}

function buildRequestPayload(filters) {
  return {
    symbols: String(filters.symbols ?? "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
    maxAllocatedCash: Number(filters.maxAllocatedCash ?? 0),
    strategyModes: filters.strategyModes,
    targetDte: filters.targetDte,
    minOptionVolume: Number(filters.minOptionVolume ?? 0),
    minOpenInterest: Number(filters.minOpenInterest ?? 0),
    maxBidAskSpreadPct: Number(filters.maxBidAskSpreadPct ?? 0),
    putDeltaRange: {
      min: Number(filters.putDeltaMin ?? 0),
      max: Number(filters.putDeltaMax ?? 0)
    },
    callDeltaRange: {
      min: Number(filters.callDeltaMin ?? 0),
      max: Number(filters.callDeltaMax ?? 0)
    },
    excludeEarningsBeforeExpiry: filters.excludeEarningsBeforeExpiry !== false
  };
}

function compareRows(left, right, sortKey, sortDirection) {
  const leftValue = readSortValue(left, sortKey);
  const rightValue = readSortValue(right, sortKey);

  if (typeof leftValue === "string" || typeof rightValue === "string") {
    const comparison = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
    return sortDirection === "asc" ? comparison : -comparison;
  }

  const numericLeft = Number(leftValue);
  const numericRight = Number(rightValue);
  if (!Number.isFinite(numericLeft) && !Number.isFinite(numericRight)) {
    return 0;
  }
  if (!Number.isFinite(numericLeft)) {
    return 1;
  }
  if (!Number.isFinite(numericRight)) {
    return -1;
  }

  return sortDirection === "asc" ? numericLeft - numericRight : numericRight - numericLeft;
}

function readSortValue(row, key) {
  if (!row) {
    return null;
  }

  switch (key) {
    case "symbol":
      return row.symbol;
    case "stockPrice":
      return row.stockPrice;
    case "strategyType":
      return formatStrategyType(row.strategyType);
    case "expiryDate":
      return row.expiryDate;
    case "dte":
      return row.dte;
    case "putStrike":
      return row.put?.strike ?? null;
    case "putPremium":
      return row.put?.mid ?? null;
    case "putDelta":
      return row.put?.delta ?? null;
    case "callStrike":
      return row.call?.strike ?? null;
    case "callPremium":
      return row.call?.mid ?? null;
    case "callDelta":
      return row.call?.delta ?? null;
    case "totalPremium":
      return row.premium?.totalPremium ?? null;
    case "allocatedCashUsed":
      return row.capital?.allocatedCashUsed ?? null;
    case "fullExposure":
      return row.capital?.fullCashSecuredExposure ?? null;
    case "returnOnAllocatedCashPct":
      return row.returns?.returnOnAllocatedCashPct ?? null;
    case "annualizedReturnOnAllocatedCashPct":
      return row.returns?.annualizedReturnOnAllocatedCashPct ?? null;
    case "returnOnFullExposurePct":
      return row.returns?.returnOnFullExposurePct ?? null;
    case "annualizedReturnOnFullExposurePct":
      return row.returns?.annualizedReturnOnFullExposurePct ?? null;
    case "downsideBreakeven":
      return row.breakevens?.downsideBreakeven ?? null;
    case "calledAwayPrice":
      return row.breakevens?.calledAwayPrice ?? null;
    case "supportConfidenceScore":
      return row.priceZones?.supportConfidenceScore ?? null;
    case "resistanceConfidenceScore":
      return row.priceZones?.resistanceConfidenceScore ?? null;
    case "earningsFlag":
      return row.risk?.earningsBeforeExpiry === true ? 1 : 0;
    case "liquidityFlag":
      return row.risk?.liquidityWarning === true ? 1 : 0;
    case "capitalWarning":
      return row.risk?.capitalWarning === true ? 1 : 0;
    case "finalStrategyScore":
      return row.score?.finalStrategyScore ?? null;
    default:
      return null;
  }
}

function formatCell(row, key) {
  switch (key) {
    case "symbol":
      return row.symbol;
    case "stockPrice":
      return formatCurrency(row.stockPrice);
    case "strategyType":
      return formatStrategyType(row.strategyType);
    case "expiryDate":
      return row.expiryDate;
    case "dte":
      return formatWholeNumber(row.dte);
    case "putStrike":
      return row.put ? formatCurrency(row.put.strike) : "—";
    case "putPremium":
      return row.put ? formatCurrency(row.put.mid) : "—";
    case "putDelta":
      return row.put ? formatNumber(row.put.delta, 3) : "—";
    case "callStrike":
      return row.call ? formatCurrency(row.call.strike) : "—";
    case "callPremium":
      return row.call ? formatCurrency(row.call.mid) : "—";
    case "callDelta":
      return row.call ? formatNumber(row.call.delta, 3) : "—";
    case "totalPremium":
      return formatCurrency(row.premium?.totalPremium);
    case "allocatedCashUsed":
      return formatCurrencyCompact(row.capital?.allocatedCashUsed);
    case "fullExposure":
      return formatCurrencyCompact(row.capital?.fullCashSecuredExposure);
    case "returnOnAllocatedCashPct":
      return formatPercent(row.returns?.returnOnAllocatedCashPct);
    case "annualizedReturnOnAllocatedCashPct":
      return formatPercent(row.returns?.annualizedReturnOnAllocatedCashPct);
    case "returnOnFullExposurePct":
      return formatPercent(row.returns?.returnOnFullExposurePct);
    case "annualizedReturnOnFullExposurePct":
      return formatPercent(row.returns?.annualizedReturnOnFullExposurePct);
    case "downsideBreakeven":
      return formatCurrency(row.breakevens?.downsideBreakeven);
    case "calledAwayPrice":
      return row.breakevens?.calledAwayPrice != null ? formatCurrency(row.breakevens.calledAwayPrice) : "—";
    case "supportConfidenceScore":
      return formatWholeNumber(row.priceZones?.supportConfidenceScore);
    case "resistanceConfidenceScore":
      return formatWholeNumber(row.priceZones?.resistanceConfidenceScore);
    case "earningsFlag":
      return row.risk?.earningsBeforeExpiry == null ? "Unknown" : row.risk.earningsBeforeExpiry ? "Flag" : "Clear";
    case "liquidityFlag":
      return row.risk?.liquidityWarning ? "Flag" : "Clear";
    case "capitalWarning":
      return row.risk?.capitalWarning ? "Flag" : "Clear";
    case "finalStrategyScore":
      return formatWholeNumber(row.score?.finalStrategyScore);
    default:
      return "n/a";
  }
}

function getHigherIsBetterTone(value, { goodMin, cautionMin }) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "neutral";
  }
  if (numericValue >= goodMin) {
    return "good";
  }
  if (numericValue >= cautionMin) {
    return "caution";
  }
  return "risk";
}

function getLowerIsBetterTone(value, { goodMax, cautionMax }) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "neutral";
  }
  if (numericValue <= goodMax) {
    return "good";
  }
  if (numericValue <= cautionMax) {
    return "caution";
  }
  return "risk";
}

function calculateDownsideBufferPct(row) {
  const stockPrice = Number(row?.stockPrice);
  const downsideBreakeven = Number(row?.breakevens?.downsideBreakeven);
  if (!Number.isFinite(stockPrice) || !(stockPrice > 0) || !Number.isFinite(downsideBreakeven)) {
    return null;
  }
  return ((stockPrice - downsideBreakeven) / stockPrice) * 100;
}

function calculateCalledAwayUpsidePct(row) {
  const stockPrice = Number(row?.stockPrice);
  const calledAwayPrice = Number(row?.breakevens?.calledAwayPrice);
  if (!Number.isFinite(stockPrice) || !(stockPrice > 0) || !Number.isFinite(calledAwayPrice)) {
    return null;
  }
  return ((calledAwayPrice - stockPrice) / stockPrice) * 100;
}

function getCellHeatMeta(row, key) {
  switch (key) {
    case "putDelta":
      return row.put ? {
        tone: getLowerIsBetterTone(Math.abs(row.put.delta), { goodMax: 0.18, cautionMax: 0.24 }),
        title: "Put delta risk: green <= 0.18, yellow 0.19-0.24, red > 0.24."
      } : null;
    case "callDelta":
      return row.call ? {
        tone: getLowerIsBetterTone(Math.abs(row.call.delta), { goodMax: 0.18, cautionMax: 0.24 }),
        title: "Call delta risk: green <= 0.18, yellow 0.19-0.24, red > 0.24."
      } : null;
    case "returnOnAllocatedCashPct":
      return {
        tone: getHigherIsBetterTone(row.returns?.returnOnAllocatedCashPct, { goodMin: 2.5, cautionMin: 1.25 }),
        title: "Cycle return on allocated cash: green >= 2.50%, yellow 1.25%-2.49%, red < 1.25%."
      };
    case "annualizedReturnOnAllocatedCashPct":
      return {
        tone: getHigherIsBetterTone(row.returns?.annualizedReturnOnAllocatedCashPct, { goodMin: 24, cautionMin: 12 }),
        title: "Annualized return on allocated cash: green >= 24%, yellow 12%-23.99%, red < 12%."
      };
    case "returnOnFullExposurePct":
      return {
        tone: getHigherIsBetterTone(row.returns?.returnOnFullExposurePct, { goodMin: 1.5, cautionMin: 0.8 }),
        title: "Cycle return on full exposure: green >= 1.50%, yellow 0.80%-1.49%, red < 0.80%."
      };
    case "annualizedReturnOnFullExposurePct":
      return {
        tone: getHigherIsBetterTone(row.returns?.annualizedReturnOnFullExposurePct, { goodMin: 16, cautionMin: 8 }),
        title: "Annualized return on full exposure: green >= 16%, yellow 8%-15.99%, red < 8%."
      };
    case "downsideBreakeven": {
      const downsideBufferPct = calculateDownsideBufferPct(row);
      return downsideBufferPct != null ? {
        tone: getHigherIsBetterTone(downsideBufferPct, { goodMin: 10, cautionMin: 5 }),
        title: `Downside cushion vs spot: green >= 10%, yellow 5%-9.99%, red < 5%. Current cushion ${formatPercent(downsideBufferPct)}.`
      } : null;
    }
    case "calledAwayPrice": {
      const calledAwayUpsidePct = calculateCalledAwayUpsidePct(row);
      return calledAwayUpsidePct != null ? {
        tone: getHigherIsBetterTone(calledAwayUpsidePct, { goodMin: 8, cautionMin: 4 }),
        title: `Upside capture to called-away price: green >= 8%, yellow 4%-7.99%, red < 4%. Current capture ${formatPercent(calledAwayUpsidePct)}.`
      } : null;
    }
    case "supportConfidenceScore":
      return {
        tone: getHigherIsBetterTone(row.priceZones?.supportConfidenceScore, { goodMin: 70, cautionMin: 55 }),
        title: "Support confidence: green >= 70, yellow 55-69, red < 55."
      };
    case "resistanceConfidenceScore":
      return {
        tone: getHigherIsBetterTone(row.priceZones?.resistanceConfidenceScore, { goodMin: 70, cautionMin: 55 }),
        title: "Resistance confidence: green >= 70, yellow 55-69, red < 55."
      };
    case "earningsFlag":
      return {
        tone: row.risk?.earningsBeforeExpiry == null ? "caution" : row.risk.earningsBeforeExpiry ? "risk" : "good",
        title: row.risk?.earningsBeforeExpiry
          ? "Earnings before expiry adds elevated gap risk."
          : row.risk?.earningsBeforeExpiry == null ? "Earnings coverage unknown." : "No earnings event before expiry."
      };
    case "liquidityFlag":
      return {
        tone: row.risk?.liquidityWarning ? "caution" : "good",
        title: row.risk?.liquidityWarning
          ? "Liquidity warning: volume, open interest, or spread fell outside the preferred range."
          : "Liquidity checks passed."
      };
    case "capitalWarning":
      return {
        tone: row.risk?.capitalWarning ? "risk" : "good",
        title: row.risk?.capitalWarning
          ? "Full cash-secured exposure exceeds allocated cash."
          : "Full cash-secured exposure fits within allocated cash."
      };
    case "finalStrategyScore":
      return {
        tone: getHigherIsBetterTone(row.score?.finalStrategyScore, { goodMin: 70, cautionMin: 55 }),
        title: "Heuristic strategy score: green >= 70, yellow 55-69, red < 55."
      };
    default:
      return null;
  }
}

function renderHeatCell(row, key) {
  const content = formatCell(row, key);
  const heat = getCellHeatMeta(row, key);
  if (!heat || content === "—" || content === "n/a") {
    return content;
  }

  return (
    <span className={`covered-income__heat-badge covered-income__heat-badge--${heat.tone}`} title={heat.title}>
      {content}
    </span>
  );
}

function formatPayoffTooltip(value, name) {
  if (name === "pnl") {
    return formatCurrency(value);
  }
  if (name === "spot") {
    return formatCurrency(value);
  }
  return value;
}

function calculateSpreadPercent(bid, ask) {
  const numericBid = Number(bid);
  const numericAsk = Number(ask);
  if (!Number.isFinite(numericBid) || !Number.isFinite(numericAsk) || numericAsk < numericBid) {
    return null;
  }

  const mid = (numericBid + numericAsk) / 2;
  if (!(mid > 0)) {
    return null;
  }

  return ((numericAsk - numericBid) / mid) * 100;
}

function getRiskToneClassName(isFlagged) {
  return isFlagged ? "pill pill--ghost covered-income__flag covered-income__flag--warning" : "pill pill--ghost";
}

function toggleArrayValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function toggleNumericValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value].sort((left, right) => left - right);
}

function PayoffChart({ row, theme = "dark" }) {
  const chartTheme = getChartPalette(theme);
  const points = Array.isArray(row?.detail?.payoffCurve) ? row.detail.payoffCurve : [];
  if (!points.length) {
    return null;
  }

  return (
    <article className="insight-card covered-income__chart-card">
      <div className="detail-chart__header">
        <div>
          <span className="brand__eyebrow">Payoff diagram</span>
          <h3>Expiry P&amp;L</h3>
          <p className="detail-chart__copy">
            The stock leg is included, so covered calls and covered strangles do not double-count upside loss above the
            short call strike.
          </p>
        </div>
      </div>

      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={points}>
            <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="spot"
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
              tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
            />
            <YAxis
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
              tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
            />
            <Tooltip
              formatter={formatPayoffTooltip}
              contentStyle={{
                background: chartTheme.tooltipBackground,
                border: `1px solid ${chartTheme.tooltipBorder}`,
                borderRadius: "14px"
              }}
            />
            <ReferenceLine y={0} stroke={chartTheme.grid} strokeDasharray="4 4" />
            <ReferenceLine x={row.stockPrice} stroke={chartTheme.scenarioLineSky} strokeDasharray="4 4" />
            {row.put?.strike != null ? (
              <ReferenceLine x={row.put.strike} stroke="#fb7185" strokeDasharray="3 3" />
            ) : null}
            {row.call?.strike != null ? (
              <ReferenceLine x={row.call.strike} stroke="#34d399" strokeDasharray="3 3" />
            ) : null}
            <Line
              type="monotone"
              dataKey="pnl"
              stroke={chartTheme.strategyLineStroke}
              strokeWidth={2.6}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}

export default function CoveredIncomeScannerWorkspace({
  strategyDefinition,
  onMarketTimerContextChange = null,
  theme = "dark"
}) {
  const detailRef = useRef(null);
  const [filters, setFilters] = useState(() => buildInitialFilters());
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [sortState, setSortState] = useState([{ key: "finalStrategyScore", direction: "desc" }]);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(
    () => buildInitialFilters().visibleColumnKeys ?? getDefaultCoveredIncomeVisibleColumnKeys(matchesCoveredIncomeCompactViewport())
  );

  async function loadScan(force = false, nextFilters = filters) {
    const nextRefreshing = payload != null;
    if (nextRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");
    setFeedback("");

    try {
      const response = await fetch("/api/strategies/strategy-5/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...buildRequestPayload(nextFilters),
          force
        })
      });
      const json = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(json?.error || "Unable to load covered income scanner");
      }

      setPayload(json);
      setSelectedRowId((current) => current || json.rows?.[0]?.id || null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadScan(false, filters);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sortedRows = useMemo(() => {
    const rows = [...(payload?.rows ?? [])];
    return rows.sort((left, right) => {
      for (const descriptor of sortState) {
        const comparison = compareRows(left, right, descriptor.key, descriptor.direction);
        if (comparison !== 0) {
          return comparison;
        }
      }
      return 0;
    });
  }, [payload?.rows, sortState]);

  const visibleColumns = useMemo(() => {
    const nextColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
    return nextColumns.length ? nextColumns : [columns[0]];
  }, [visibleColumnKeys]);
  const coveredIncomeTableMinWidth = useMemo(
    () => `${Math.max(visibleColumns.length * 140, 280)}px`,
    [visibleColumns.length]
  );

  const selectedRow = useMemo(() => {
    return sortedRows.find((row) => row.id === selectedRowId) ?? sortedRows[0] ?? null;
  }, [selectedRowId, sortedRows]);

  const selectedLegRows = useMemo(() => {
    if (!selectedRow) {
      return [];
    }

    const rows = [];
    if ((selectedRow.sharesRequired ?? 0) > 0) {
      rows.push({
        id: `${selectedRow.id}:stock`,
        action: "LONG",
        quantity: selectedRow.sharesRequired,
        strikeLabel: "Stock",
        bid: null,
        ask: null,
        mark: selectedRow.stockPrice,
        volume: null,
        openInterest: null,
        spreadPct: null,
        referenceLabel: `${selectedRow.symbol} shares`,
        referenceMeta: `Coverage for ${formatStrategyType(selectedRow.strategyType)}`
      });
    }

    if (selectedRow.put) {
      rows.push({
        id: `${selectedRow.id}:put`,
        action: "SHORT",
        quantity: selectedRow.contracts,
        strikeLabel: `${formatNumber(selectedRow.put.strike, 2)}P`,
        bid: selectedRow.put.bid,
        ask: selectedRow.put.ask,
        mark: selectedRow.put.mid,
        volume: selectedRow.put.volume,
        openInterest: selectedRow.put.openInterest,
        spreadPct: calculateSpreadPercent(selectedRow.put.bid, selectedRow.put.ask),
        referenceLabel: selectedRow.put.contractSymbol || `${selectedRow.symbol} put`,
        referenceMeta: `${selectedRow.put.assignmentRisk} assignment risk`
      });
    }

    if (selectedRow.call) {
      rows.push({
        id: `${selectedRow.id}:call`,
        action: "SHORT",
        quantity: selectedRow.contracts,
        strikeLabel: `${formatNumber(selectedRow.call.strike, 2)}C`,
        bid: selectedRow.call.bid,
        ask: selectedRow.call.ask,
        mark: selectedRow.call.mid,
        volume: selectedRow.call.volume,
        openInterest: selectedRow.call.openInterest,
        spreadPct: calculateSpreadPercent(selectedRow.call.bid, selectedRow.call.ask),
        referenceLabel: selectedRow.call.contractSymbol || `${selectedRow.symbol} call`,
        referenceMeta: `${selectedRow.call.assignmentRisk} assignment risk`
      });
    }

    return rows;
  }, [selectedRow]);

  const assignmentScenarios = useMemo(() => {
    if (!selectedRow) {
      return [];
    }

    if (selectedRow.strategyType === "cash_secured_put") {
      return [
        `Below ${formatCurrency(selectedRow.put?.strike)}: you keep the premium and may be assigned shares near support.`,
        `Above ${formatCurrency(selectedRow.put?.strike)}: the put expires worthless and premium is fully retained.`
      ];
    }

    if (selectedRow.strategyType === "covered_call") {
      return [
        `Below ${formatCurrency(selectedRow.call?.strike)}: you keep the shares and the call premium.`,
        `Above ${formatCurrency(selectedRow.call?.strike)}: shares can be called away and upside is capped near ${formatCurrency(selectedRow.breakevens?.calledAwayPrice)}.`
      ];
    }

    return [
      `Below ${formatCurrency(selectedRow.put?.strike)}: you keep the call premium and can be assigned additional shares on the short put.`,
      `Between ${formatCurrency(selectedRow.put?.strike)} and ${formatCurrency(selectedRow.call?.strike)}: both options can expire worthless and the credit is retained.`,
      `Above ${formatCurrency(selectedRow.call?.strike)}: existing shares can be called away while the short put expires worthless.`
    ];
  }, [selectedRow]);

  useEffect(() => {
    if (!onMarketTimerContextChange) {
      return;
    }

    if (!selectedRow) {
      onMarketTimerContextChange(null);
      return;
    }

    onMarketTimerContextChange(
      createMarketTimerContext({
        source: "covered-income-scanner",
        label: selectedRow.symbol,
        optionSymbol: selectedRow.symbol,
        underlyingSymbol: selectedRow.symbol,
        referenceSymbol: "",
        optionExpiries: [selectedRow.expiryDate]
      })
    );

    return () => {
      onMarketTimerContextChange(null);
    };
  }, [onMarketTimerContextChange, selectedRow]);

  function handleFilterChange(key, value) {
    setFilters((current) => ({
      ...current,
      [key]: value
    }));
  }

  function handleStrategyModeToggle(mode) {
    setFilters((current) => ({
      ...current,
      strategyModes: toggleArrayValue(current.strategyModes, mode)
    }));
  }

  function handleDteToggle(dte) {
    setFilters((current) => ({
      ...current,
      targetDte: toggleNumericValue(current.targetDte, dte)
    }));
  }

  function toggleVisibleColumn(columnKey) {
    setVisibleColumnKeys((current) => {
      if (current.includes(columnKey)) {
        return current.length === 1 ? current : current.filter((key) => key !== columnKey);
      }

      return columns.map((column) => column.key).filter((key) => key === columnKey || current.includes(key));
    });
  }

  function showAllColumns() {
    setVisibleColumnKeys(columns.map((column) => column.key));
  }

  function showCompactColumns() {
    setVisibleColumnKeys(getDefaultCoveredIncomeVisibleColumnKeys(true));
  }

  function handleRowSelect(rowId) {
    setSelectedRowId(rowId);

    window.requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  function handleSort(key, { additive = false } = {}) {
    setSortState((current) => {
      const existingIndex = current.findIndex((descriptor) => descriptor.key === key);
      const existing = existingIndex >= 0 ? current[existingIndex] : null;
      const nextDirection = existing?.direction === "desc" ? "asc" : "desc";

      if (!additive) {
        return [{ key, direction: nextDirection }];
      }

      const nextState = current.filter((descriptor) => descriptor.key !== key);
      nextState.unshift({ key, direction: nextDirection });
      return nextState.slice(0, MAX_SORT_PRIORITIES);
    });
  }

  function saveFilters() {
    const saved = persistSavedFilters(COVERED_INCOME_FILTERS_STORAGE_KEY, {
      ...filters,
      visibleColumnKeys
    });
    setFeedback(saved ? "Scanner filters saved locally." : "Unable to save filters locally.");
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setVisibleColumnKeys(getDefaultCoveredIncomeVisibleColumnKeys(matchesCoveredIncomeCompactViewport()));
    setFeedback("Scanner filters reset to defaults.");
  }

  if (loading) {
    return <div className="app-state">Loading covered income scanner…</div>;
  }



  return (
    <main className="workspace workspace--screening-v2 workspace--covered-income">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Covered Income Scanner</span>
          <h2>{strategyDefinition?.name ?? "Covered income scanner"}</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--live">{payload?.summary?.candidateCount ?? 0} candidates</span>
            <span className="pill pill--ghost">{payload?.summary?.capitalWarnings ?? 0} capital flags</span>
          </div>
          <button type="button" className="finder-action" onClick={() => loadScan(true)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh scan"}
          </button>
        </div>
      </header>
      <EntryResearchPanel initialSymbol={selectedRow?.symbol || filters.symbols.split(/[ ,]+/)[0]} />
      {error && <p role="alert" className="warning-strip">{error} Previous scan retained.</p>}
      <p className="card-copy">Income estimates use bid premiums before fees. Rankings are heuristic. Missing earnings coverage is not a clear result.</p>

      {payload?.warnings?.length ? (
        <div className="warning-strip">
          {payload.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}

      {feedback ? (
        <div className="screening-v2__notice screening-v2__notice--info">
          <span>{feedback}</span>
        </div>
      ) : null}

      <section className="screening-v2__summary-grid">
        <article className="insight-card screening-v2__summary-card">
          <span>Symbols scanned</span>
          <strong>{payload?.summary?.symbolsScanned ?? 0}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg allocated return</span>
          <strong>{formatPercent(payload?.summary?.averageReturnOnAllocatedCashPct)}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg annualized return</span>
          <strong>{formatPercent(payload?.summary?.averageAnnualizedReturnOnAllocatedCashPct)}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg final score</span>
          <strong>{formatNumber(payload?.summary?.averageFinalScore, 1)}</strong>
        </article>
      </section>

      <article className="insight-card screening-v2__filters covered-income__filters-card">
        <div className="covered-income__filter-toolbar">
          <span className="brand__eyebrow covered-income__filter-title">Scanner filters</span>

          <label className="covered-income__filter-control covered-income__filter-control--symbols">
            <span className="covered-income__filter-label">Symbols</span>
            <input
              className="covered-income__filter-input"
              value={filters.symbols}
              onChange={(event) => handleFilterChange("symbols", event.target.value.toUpperCase())}
              placeholder="TSLA, AAPL, NVDA, SPY"
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Cash</span>
            <input
              className="covered-income__filter-input"
              value={filters.maxAllocatedCash}
              onChange={(event) => handleFilterChange("maxAllocatedCash", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Min vol</span>
            <input
              className="covered-income__filter-input"
              value={filters.minOptionVolume}
              onChange={(event) => handleFilterChange("minOptionVolume", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Min OI</span>
            <input
              className="covered-income__filter-input"
              value={filters.minOpenInterest}
              onChange={(event) => handleFilterChange("minOpenInterest", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Spread %</span>
            <input
              className="covered-income__filter-input"
              value={filters.maxBidAskSpreadPct}
              onChange={(event) => handleFilterChange("maxBidAskSpreadPct", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control covered-income__filter-control--range">
            <span className="covered-income__filter-label">Put Δ</span>
            <div className="covered-income__filter-range">
              <input
                className="covered-income__filter-input"
                value={filters.putDeltaMin}
                onChange={(event) => handleFilterChange("putDeltaMin", event.target.value)}
              />
              <span className="covered-income__filter-separator">to</span>
              <input
                className="covered-income__filter-input"
                value={filters.putDeltaMax}
                onChange={(event) => handleFilterChange("putDeltaMax", event.target.value)}
              />
            </div>
          </label>

          <label className="covered-income__filter-control covered-income__filter-control--range">
            <span className="covered-income__filter-label">Call Δ</span>
            <div className="covered-income__filter-range">
              <input
                className="covered-income__filter-input"
                value={filters.callDeltaMin}
                onChange={(event) => handleFilterChange("callDeltaMin", event.target.value)}
              />
              <span className="covered-income__filter-separator">to</span>
              <input
                className="covered-income__filter-input"
                value={filters.callDeltaMax}
                onChange={(event) => handleFilterChange("callDeltaMax", event.target.value)}
              />
            </div>
          </label>

          <div className="covered-income__filter-chip-group">
            {Object.entries(strategyModeLabels).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`finder-action ${filters.strategyModes.includes(mode) ? "tv-finder__filter-control--active" : ""}`}
                onClick={() => handleStrategyModeToggle(mode)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="covered-income__filter-chip-group">
            {[7, 15, 21, 30].map((dte) => (
              <button
                key={dte}
                type="button"
                className={`finder-action ${filters.targetDte.includes(dte) ? "tv-finder__filter-control--active" : ""}`}
                onClick={() => handleDteToggle(dte)}
              >
                {dte}D
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`finder-action ${filters.excludeEarningsBeforeExpiry ? "tv-finder__filter-control--active" : ""}`}
            onClick={() =>
              handleFilterChange("excludeEarningsBeforeExpiry", !filters.excludeEarningsBeforeExpiry)
            }
          >
            Earnings off
          </button>

          <button type="button" className="finder-action" onClick={() => loadScan(false, filters)}>
            Scan
          </button>
          <button type="button" className="finder-action" onClick={saveFilters}>
            Save filters
          </button>
          <button type="button" className="finder-action" onClick={resetFilters}>
            Reset filters
          </button>
          <details className="finder-menu">
            <summary className="finder-control">
              <span>Columns</span>
            </summary>
            <div className="finder-menu__panel">
              <div className="finder-menu__header">
                <strong>Visible columns</strong>
                <div className="finder-menu__header-actions">
                  <button type="button" className="finder-menu__reset" onClick={showAllColumns}>
                    All
                  </button>
                  <button type="button" className="finder-menu__reset" onClick={showCompactColumns}>
                    Compact
                  </button>
                </div>
              </div>
              <div className="finder-menu__list">
                {columns.map((column) => {
                  const isActive = visibleColumnKeys.includes(column.key);
                  return (
                    <button
                      key={column.key}
                      type="button"
                      className={`finder-menu__option ${isActive ? "finder-menu__option--active" : ""}`}
                      onClick={() => toggleVisibleColumn(column.key)}
                      disabled={isActive && visibleColumnKeys.length === 1}
                    >
                      <span>{column.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </details>
        </div>
      </article>

      <section className="screening-v2__selected-layout">
        <article className="insight-card screening-v2__table-card">
          <div className="strategy-settings__page-head">
            <div>
              <span className="brand__eyebrow">Scanner table</span>
              <h3>Ranked option income setups</h3>
            </div>
            <p className="card-copy">
              The scanner ranks income candidates by yield, price structure, expected-move safety, IV richness,
              liquidity, and technical location. Scores are heuristic, not probabilities.
            </p>
          </div>

          <div className="covered-income__color-guide" role="note" aria-label="Color guide for scanner columns">
            <span className="covered-income__color-guide-title">Color guide</span>
            <span className="covered-income__color-guide-item">
              <span className="covered-income__heat-badge covered-income__heat-badge--good">Green</span>
              Score / confidence &gt;= 70, alloc ann &gt;= 24%, full-exp ann &gt;= 16%
            </span>
            <span className="covered-income__color-guide-item">
              <span className="covered-income__heat-badge covered-income__heat-badge--caution">Yellow</span>
              Score / confidence 55-69, alloc ann 12%-23.99%, full-exp ann 8%-15.99%
            </span>
            <span className="covered-income__color-guide-item">
              <span className="covered-income__heat-badge covered-income__heat-badge--risk">Red</span>
              Score / confidence &lt; 55, alloc ann &lt; 12%, full-exp ann &lt; 8%, or hard risk flags
            </span>
          </div>

          <div className="screening-v2__table-wrap">
            <table className="screening-v2__table" style={{ minWidth: coveredIncomeTableMinWidth }}>
              <thead>
                <tr>
                  {visibleColumns.map((column) => (
                    <th key={column.key}>
                      <button
                        type="button"
                        title="Click to sort. Shift-click (or Ctrl/⌘-click) to add up to 4 sort priorities."
                        onClick={(event) =>
                          handleSort(column.key, {
                            additive: event.shiftKey || event.metaKey || event.ctrlKey
                          })
                        }
                      >
                        <span>{column.label}</span>
                        {(() => {
                          const index = sortState.findIndex((descriptor) => descriptor.key === column.key);
                          if (index < 0) {
                            return null;
                          }
                          const descriptor = sortState[index];
                          return (
                            <span className="finder-sort__indicator" aria-hidden="true">
                              <span className="finder-sort__priority">{index + 1}</span>
                              <span className="finder-sort__direction">{descriptor.direction === "asc" ? "↑" : "↓"}</span>
                            </span>
                          );
                        })()}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.length ? (
                  sortedRows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.id === selectedRow?.id ? "screening-v2__table-row--active" : ""}
                      onClick={() => handleRowSelect(row.id)}
                    >
                      {visibleColumns.map((column) => (
                        <td key={column.key}>
                          {column.key === "symbol" ? (
                            <div className="finder-cell-stack">
                              <strong>{row.symbol}</strong>
                              <span className="screening-v2__subtle">{row.companyName}</span>
                            </div>
                          ) : (
                            renderHeatCell(row, column.key)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={visibleColumns.length} className="finder-empty">
                      No candidates matched the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      {selectedRow ? (
        <>
          <section ref={detailRef} className="selection-banner tv-finder__selection-banner">
            <div className="selection-banner__title">
              <span className="brand__eyebrow">Selected setup</span>
              <strong>
                {selectedRow.symbol} · {formatStrategyType(selectedRow.strategyType)} · {selectedRow.expiryDate}
              </strong>
            </div>
            <div className="selection-banner__actions">
              <div className="detail-badges">
                <span className="pill pill--live">Score {formatNumber(selectedRow.score?.finalStrategyScore, 0)}</span>
                <span className="pill pill--ghost">{formatWholeNumber(selectedRow.contracts)} contracts</span>
                <span className="pill pill--ghost">{formatWholeNumber(selectedRow.dte)} DTE</span>
                <span className={getRiskToneClassName(selectedRow.risk?.capitalWarning)}>
                  {selectedRow.risk?.capitalWarning ? "Capital flag" : "Capital OK"}
                </span>
              </div>
            </div>
          </section>

          <div className="detail-panels covered-income__detail-panels">
            <div className="detail-panel">
              <h4>Strategy overview</h4>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Overview</span>
                <dl>
                  <div><dt>Underlying price</dt><dd>{formatCurrency(selectedRow.stockPrice)}</dd></div>
                  <div><dt>Strategy type</dt><dd>{formatStrategyType(selectedRow.strategyType)}</dd></div>
                  <div><dt>Expiry</dt><dd>{selectedRow.expiryDate}</dd></div>
                  <div><dt>Days to expiry</dt><dd>{formatWholeNumber(selectedRow.dte)}</dd></div>
                  <div><dt>Support</dt><dd>{formatCurrency(selectedRow.priceZones?.supportPrice)}</dd></div>
                  <div><dt>Resistance</dt><dd>{formatCurrency(selectedRow.priceZones?.resistancePrice)}</dd></div>
                  <div><dt>Expected move</dt><dd>{formatCurrency(selectedRow.priceZones?.expectedMove)}</dd></div>
                  <div><dt>ATM IV</dt><dd>{formatPercent((selectedRow.priceZones?.atmIv ?? 0) * 100)}</dd></div>
                  <div><dt>Historical vol</dt><dd>{formatPercent((selectedRow.marketData?.historicalVolatility ?? 0) * 100)}</dd></div>
                </dl>
              </div>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Returns and capital</span>
                <dl>
                  <div><dt>Total premium</dt><dd>{formatCurrency(selectedRow.premium?.totalPremium)}</dd></div>
                  <div><dt>Return on allocated cash</dt><dd>{formatPercent(selectedRow.returns?.returnOnAllocatedCashPct)}</dd></div>
                  <div><dt>Annualized allocated return</dt><dd>{formatPercent(selectedRow.returns?.annualizedReturnOnAllocatedCashPct)}</dd></div>
                  <div><dt>Return on full exposure</dt><dd>{formatPercent(selectedRow.returns?.returnOnFullExposurePct)}</dd></div>
                  <div><dt>Annualized full exposure return</dt><dd>{formatPercent(selectedRow.returns?.annualizedReturnOnFullExposurePct)}</dd></div>
                  <div><dt>Allocated cash used</dt><dd>{formatCurrency(selectedRow.capital?.allocatedCashUsed)}</dd></div>
                  <div><dt>Full exposure</dt><dd>{formatCurrency(selectedRow.capital?.fullCashSecuredExposure)}</dd></div>
                  <div><dt>Shares required</dt><dd>{formatWholeNumber(selectedRow.sharesRequired)}</dd></div>
                </dl>
              </div>
            </div>

            <div className="detail-panel detail-panel--contracts">
              <h4>Contract details</h4>
              <div className="detail-badges">
                {selectedRow.put ? (
                  <span className="pill pill--ghost">
                    Put {formatCurrency(selectedRow.put.strike)} · {selectedRow.put.assignmentRisk}
                  </span>
                ) : null}
                {selectedRow.call ? (
                  <span className="pill pill--ghost">
                    Call {formatCurrency(selectedRow.call.strike)} · {selectedRow.call.assignmentRisk}
                  </span>
                ) : null}
                <span className={getRiskToneClassName(selectedRow.risk?.liquidityWarning)}>
                  {selectedRow.risk?.liquidityWarning ? "Liquidity warning" : "Liquidity OK"}
                </span>
              </div>
              <div className="legs-table">
                <div className="legs-table__head">
                  <span>Action</span>
                  <span>Qty</span>
                  <span>Strike</span>
                  <span>Bid</span>
                  <span>Ask</span>
                  <span>Mark</span>
                  <span>Vol</span>
                  <span>OI</span>
                  <span>Spread</span>
                  <span>Code / note</span>
                </div>
                {selectedLegRows.map((leg) => (
                  <div key={leg.id} className="legs-table__row">
                    <span className={`legs-action legs-action--${leg.action.toLowerCase()}`}>{leg.action}</span>
                    <span>{formatWholeNumber(leg.quantity)}</span>
                    <span>{leg.strikeLabel}</span>
                    <span>{leg.bid != null ? formatCurrency(leg.bid) : "—"}</span>
                    <span>{leg.ask != null ? formatCurrency(leg.ask) : "—"}</span>
                    <span>{leg.mark != null ? formatCurrency(leg.mark) : "—"}</span>
                    <span>{leg.volume != null ? formatWholeNumber(leg.volume) : ""}</span>
                    <span>{leg.openInterest != null ? formatWholeNumber(leg.openInterest) : ""}</span>
                    <span>{leg.spreadPct != null ? `${formatNumber(leg.spreadPct, 2)}%` : ""}</span>
                    <span className="leg-reference">
                      <span>{leg.referenceLabel}</span>
                      <small>{leg.referenceMeta}</small>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="detail-panel detail-panel--controls">
              <h4>Trade context</h4>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Risk analysis</span>
                <dl>
                  <div><dt>Downside breakeven</dt><dd>{formatCurrency(selectedRow.breakevens?.downsideBreakeven)}</dd></div>
                  <div><dt>Upside breakeven</dt><dd>{selectedRow.breakevens?.upsideBreakeven != null ? formatCurrency(selectedRow.breakevens.upsideBreakeven) : "—"}</dd></div>
                  <div><dt>Called-away price</dt><dd>{selectedRow.breakevens?.calledAwayPrice != null ? formatCurrency(selectedRow.breakevens.calledAwayPrice) : "—"}</dd></div>
                  <div><dt>Support confidence</dt><dd>{formatWholeNumber(selectedRow.priceZones?.supportConfidenceScore)}</dd></div>
                  <div><dt>Resistance confidence</dt><dd>{formatWholeNumber(selectedRow.priceZones?.resistanceConfidenceScore)}</dd></div>
                  <div><dt>Earnings before expiry</dt><dd>{selectedRow.risk?.earningsBeforeExpiry == null ? "Unknown" : selectedRow.risk.earningsBeforeExpiry ? "Yes" : "No"}</dd></div>
                  <div><dt>Put inside expected move</dt><dd>{selectedRow.risk?.putInsideExpectedMove ? "Yes" : "No"}</dd></div>
                  <div><dt>Call inside expected move</dt><dd>{selectedRow.risk?.callInsideExpectedMove ? "Yes" : "No"}</dd></div>
                </dl>
              </div>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Score breakdown</span>
                <dl>
                  <div><dt>Final score</dt><dd>{formatWholeNumber(selectedRow.score?.finalStrategyScore)}</dd></div>
                  <div><dt>Yield</dt><dd>{formatWholeNumber(selectedRow.score?.yieldScore)}</dd></div>
                  <div><dt>Support / resistance</dt><dd>{formatWholeNumber(selectedRow.score?.supportResistanceScore)}</dd></div>
                  <div><dt>Expected move safety</dt><dd>{formatWholeNumber(selectedRow.score?.expectedMoveSafetyScore)}</dd></div>
                  <div><dt>IV richness</dt><dd>{formatWholeNumber(selectedRow.score?.ivRichnessScore)}</dd></div>
                  <div><dt>Liquidity</dt><dd>{formatWholeNumber(selectedRow.score?.liquidityScore)}</dd></div>
                  <div><dt>Technical location</dt><dd>{formatWholeNumber(selectedRow.score?.valuationScore)}</dd></div>
                </dl>
              </div>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Assignment scenarios</span>
                <div className="covered-income__warning-list">
                  {assignmentScenarios.map((scenario) => (
                    <p key={scenario}>{scenario}</p>
                  ))}
                  {(selectedRow.risk?.warningMessages ?? []).map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <PayoffChart row={selectedRow} theme={theme} />

          <section className="screening-v2__selected-layout covered-income__selected-layout">
            <article className="insight-card screening-v2__table-card">
              <div className="strategy-settings__page-head">
                <div>
                  <span className="brand__eyebrow">Scenario table</span>
                  <h3>Expiry P&amp;L checkpoints</h3>
                </div>
                <p className="card-copy">
                  These checkpoints are there to make assignment and capped-upside tradeoffs obvious before you choose a
                  combination manually.
                </p>
              </div>

              <div className="screening-v2__contract-table-wrap">
                <table className="screening-v2__contract-table">
                  <thead>
                    <tr>
                      <th>Underlying at expiry</th>
                      <th>Expiry P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedRow.detail?.scenarioPoints ?? []).map((point) => (
                      <tr key={`${selectedRow.id}:${point.spot}`}>
                        <td>{formatCurrency(point.spot)}</td>
                        <td>{formatCurrency(point.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}
