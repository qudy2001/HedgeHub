import { useEffect, useMemo, useState } from "react";
import { createMarketTimerContext } from "../marketTimers.js";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";

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

function formatQuoteSizePair(bidSize, askSize) {
  const numericBidSize = Number(bidSize);
  const numericAskSize = Number(askSize);

  if (
    !Number.isFinite(numericBidSize) ||
    numericBidSize < 0 ||
    !Number.isFinite(numericAskSize) ||
    numericAskSize < 0
  ) {
    return "n/a";
  }

  return `${formatWholeNumber(numericBidSize)}/${formatWholeNumber(numericAskSize)}`;
}

function toOptionalNumber(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  if (typeof value === "string" && value.trim() === "") {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function compareRows(left, right, sortKey, sortDirection) {
  const leftValue = left?.[sortKey];
  const rightValue = right?.[sortKey];

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

function getQuoteQualityPillClass(value) {
  if (value === "NBBO") {
    return "pill pill--live";
  }
  if (value === "Live feed") {
    return "pill pill--warning";
  }
  return "pill pill--ghost";
}

const columns = [
  { key: "compositeScore", label: "Score" },
  { key: "symbol", label: "Ticker" },
  { key: "underlyingPrice", label: "Spot" },
  { key: "expiration", label: "Expiry" },
  { key: "daysToExpiry", label: "DTE" },
  { key: "strike", label: "Strike" },
  { key: "straddleCost", label: "Straddle" },
  { key: "impliedMovePct", label: "Implied move" },
  { key: "deltaChangeForOnePctMove", label: "Delta shift / 1%" },
  { key: "dailyBreakevenMovePct", label: "1d breakeven" },
  { key: "thetaBurnPctPerDay", label: "Theta burn" },
  { key: "spreadPct", label: "Spread" },
  { key: "liquidityScore", label: "Liquidity" },
  { key: "quoteQuality", label: "Quotes" }
];

const MAX_SORT_PRIORITIES = 4;

function buildScenarioOrderFromDeltaRow(row, generatedAt) {
  if (!row) {
    return null;
  }

  const purchaseDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);
  const marketContext = row.marketContext ?? {};
  const riskFreeRate = Number(marketContext.riskFreeRate ?? 0.0425) || 0.0425;
  const impliedVolatility = Number(marketContext.impliedVolatility ?? 0.24) || 0.24;

  return {
    id: row.id,
    combinationLabel: `${row.symbol} · ${row.strategyType} · ${row.expiration}`,
    assetLabel: row.symbol,
    strategyType: row.strategyType,
    purchaseDate,
    createdAt: generatedAt ?? null,
    closedAt: "",
    status: "open",
    polymarketMarketId: "",
    polymarketQuestion: `${row.symbol} delta hedge`,
    polymarketUrl: "",
    strategyCloseDate: row.expiration,
    polymarketResolutionDate: row.expiration,
    marketReferenceYesPrice: 0.5,
    valuationContext: {
      proxySymbol: marketContext.proxySymbol ?? row.symbol,
      underlyingSymbol: marketContext.underlyingSymbol ?? row.symbol,
      currentProxySpot: Number(marketContext.currentProxySpot ?? row.underlyingPrice ?? 0),
      currentUnderlyingSpot: Number(marketContext.currentUnderlyingSpot ?? row.underlyingPrice ?? 0),
      conversionRatio: Number(marketContext.conversionRatio ?? 1) || 1,
      targetUnderlyingValue: Number(marketContext.targetUnderlyingValue ?? row.underlyingPrice ?? 0),
      currentYesPrice: 0.5
    },
    legs: (row.optionLegs ?? []).map((leg, index) => ({
      id: `${row.id}:option:${index}`,
      label: `${leg.action} ${String(leg.optionType ?? "call").toUpperCase()} ${leg.strike}`,
      kind: "option",
      action: leg.action,
      quantity: Number(leg.quantity ?? 1),
      entryPrice: Number(leg.entryPrice ?? 0),
      contractMultiplier: Number(leg.contractMultiplier ?? 100),
      optionType: leg.optionType ?? "call",
      expiry: leg.expiration ?? row.expiration,
      strike: Number(leg.strike ?? 0),
      contractSymbol: leg.contractSymbol ?? "",
      rootSymbol: leg.rootSymbol ?? row.symbol,
      impliedVolatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
      riskFreeRate: Number(riskFreeRate) || 0.0425,
      quoteSource: leg.quoteSource ?? (leg.isLive === true ? "live" : "modeled"),
      isLive: leg.isLive === true
    }))
  };
}

export default function DeltaHedgeScannerWorkspace({
  strategyDefinition,
  onMarketTimerContextChange = null,
  theme = "dark"
}) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [tickerDraft, setTickerDraft] = useState("");
  const [tickerBusy, setTickerBusy] = useState(false);
  const [tickerFeedback, setTickerFeedback] = useState(null);
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [selectedQuoteQualities, setSelectedQuoteQualities] = useState([]);
  const [minLiquidity, setMinLiquidity] = useState("40");
  const [maxBreakevenMovePct, setMaxBreakevenMovePct] = useState("");
  const [maxThetaBurnPct, setMaxThetaBurnPct] = useState("");
  const [sortState, setSortState] = useState([{ key: "compositeScore", direction: "desc" }]);

  async function loadScan(force = false) {
    const nextRefreshing = payload != null;
    if (nextRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");

    try {
      const response = await fetch(`/api/strategies/strategy-4/scan${force ? "?force=true" : ""}`);
      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Unable to load delta hedge rows");
      }

      setPayload(json);
      setSelectedRowId((current) => current || json.selectedRowId || json.rows?.[0]?.id || null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadScan(false);
  }, []);

  useEffect(() => {
    const quoteQualities = payload?.filters?.quoteQualities ?? [];
    setSelectedQuoteQualities((current) => {
      const next = current.filter((quality) => quoteQualities.includes(quality));
      return next.length ? next : quoteQualities;
    });
  }, [payload?.filters?.quoteQualities]);

  const filteredRows = useMemo(() => {
    const rows = payload?.rows ?? [];
    const minLiquidityThreshold = toOptionalNumber(minLiquidity, null);
    const maxBreakevenThreshold = toOptionalNumber(maxBreakevenMovePct, null);
    const maxThetaBurnThreshold = toOptionalNumber(maxThetaBurnPct, null);

    return rows.filter((row) => {
      return (
        selectedQuoteQualities.includes(row.quoteQuality) &&
        (minLiquidityThreshold == null || Number(row.liquidityScore ?? 0) >= minLiquidityThreshold) &&
        (maxBreakevenThreshold == null ||
          row.dailyBreakevenMovePct == null ||
          Number(row.dailyBreakevenMovePct ?? Number.POSITIVE_INFINITY) <= maxBreakevenThreshold) &&
        (maxThetaBurnThreshold == null ||
          row.thetaBurnPctPerDay == null ||
          Number(row.thetaBurnPctPerDay ?? Number.POSITIVE_INFINITY) <= maxThetaBurnThreshold)
      );
    });
  }, [maxBreakevenMovePct, maxThetaBurnPct, minLiquidity, payload?.rows, selectedQuoteQualities]);

  const sortedRows = useMemo(
    () =>
      [...filteredRows].sort((left, right) => {
        for (const sortDescriptor of sortState) {
          if (!sortDescriptor?.key) {
            continue;
          }

          const direction = sortDescriptor.direction === "asc" ? "asc" : "desc";
          const comparedValue = compareRows(left, right, sortDescriptor.key, direction);
          if (comparedValue !== 0) {
            return comparedValue;
          }
        }

        return compareRows(left, right, "id", "asc");
      }),
    [filteredRows, sortState]
  );

  useEffect(() => {
    if (!sortedRows.length) {
      setSelectedRowId(null);
      return;
    }

    if (!sortedRows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(sortedRows[0].id);
    }
  }, [selectedRowId, sortedRows]);

  const selectedRow = sortedRows.find((row) => row.id === selectedRowId) ?? null;
  const selectedScenarioOrder = useMemo(
    () => buildScenarioOrderFromDeltaRow(selectedRow, payload?.generatedAt),
    [payload?.generatedAt, selectedRow]
  );
  const marketTimerContext = useMemo(() => {
    if (!selectedRow) {
      return null;
    }

    return createMarketTimerContext({
      source: "delta-hedge",
      label: selectedRow.symbol,
      optionSymbol: selectedRow.optionLegs?.[0]?.rootSymbol ?? selectedRow.symbol,
      underlyingSymbol: selectedRow.marketContext?.underlyingSymbol ?? selectedRow.symbol,
      referenceSymbol: selectedRow.symbol,
      optionExpiries: [
        selectedRow.expiration,
        ...(selectedRow.optionLegs ?? []).map((leg) => leg.expiration)
      ],
      exerciseStyle: "american",
      settlementType: "physical"
    });
  }, [selectedRow]);

  useEffect(() => {
    if (!onMarketTimerContextChange) {
      return undefined;
    }

    onMarketTimerContextChange(marketTimerContext);
    return () => {
      onMarketTimerContextChange(null);
    };
  }, [marketTimerContext, onMarketTimerContextChange]);

  function toggleQuoteQuality(quality) {
    setSelectedQuoteQualities((current) => {
      if (current.includes(quality)) {
        return current.length === 1 ? current : current.filter((item) => item !== quality);
      }

      return [...current, quality];
    });
  }

  function handleSort(columnKey, options = {}) {
    const isAdditive = options.additive === true;

    setSortState((current) => {
      const currentSortState = Array.isArray(current) ? current : [];
      const existingIndex = currentSortState.findIndex((sortDescriptor) => sortDescriptor?.key === columnKey);
      const existingDescriptor = existingIndex >= 0 ? currentSortState[existingIndex] : null;
      const hasSingleActiveSort = existingIndex === 0 && currentSortState.length === 1;

      if (!isAdditive) {
        if (hasSingleActiveSort) {
          const direction = existingDescriptor?.direction === "asc" ? "desc" : "asc";
          return [{ key: columnKey, direction }];
        }

        const direction = existingDescriptor?.direction === "asc" ? "asc" : "desc";
        return [{ key: columnKey, direction }];
      }

      if (existingIndex >= 0) {
        const direction = existingDescriptor?.direction === "asc" ? "desc" : "asc";
        const nextSortState = [...currentSortState];
        nextSortState[existingIndex] = { key: columnKey, direction };
        return nextSortState;
      }

      const nextSortState =
        currentSortState.length >= MAX_SORT_PRIORITIES
          ? currentSortState.slice(0, MAX_SORT_PRIORITIES - 1)
          : currentSortState;

      return [...nextSortState, { key: columnKey, direction: "desc" }];
    });
  }

  function resetFilters() {
    setSelectedQuoteQualities(payload?.filters?.quoteQualities ?? []);
    setMinLiquidity("40");
    setMaxBreakevenMovePct("");
    setMaxThetaBurnPct("");
  }

  async function handleAddTicker() {
    const symbol = tickerDraft.trim().toUpperCase();
    if (!symbol) {
      setTickerFeedback({
        tone: "error",
        message: "Enter a stock ticker first."
      });
      return;
    }

    setTickerBusy(true);
    setTickerFeedback(null);
    try {
      const response = await fetch("/api/strategies/strategy-4/tickers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ symbol })
      });
      const json = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(json?.error || "Unable to add stock ticker");
      }

      setTickerDraft("");
      setTickerFeedback({
        tone: "success",
        message: `Added ${symbol} to the scanner universe.`
      });
      await loadScan(true);
    } catch (tickerError) {
      setTickerFeedback({
        tone: "error",
        message: tickerError.message
      });
    } finally {
      setTickerBusy(false);
    }
  }

  async function handleRemoveTicker(symbol) {
    setTickerBusy(true);
    setTickerFeedback(null);
    try {
      const response = await fetch(`/api/strategies/strategy-4/tickers/${encodeURIComponent(symbol)}`, {
        method: "DELETE"
      });
      const json = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(json?.error || "Unable to remove stock ticker");
      }

      setTickerFeedback({
        tone: "success",
        message: `Removed ${symbol} from the custom scanner universe.`
      });
      await loadScan(true);
    } catch (tickerError) {
      setTickerFeedback({
        tone: "error",
        message: tickerError.message
      });
    } finally {
      setTickerBusy(false);
    }
  }

  if (loading) {
    return <div className="app-state">Loading delta hedge scanner…</div>;
  }

  if (error) {
    return <div className="app-state">{error}</div>;
  }

  return (
    <main className="workspace workspace--screening-v2 workspace--delta-hedge">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Delta Hedge Scanner</span>
          <h2>{strategyDefinition?.name ?? "Stock delta hedge scanner"}</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--live">{payload?.summary?.candidates ?? 0} candidates</span>
            <span className="pill pill--ghost">{payload?.summary?.liveCandidates ?? 0} live</span>
          </div>
          <button type="button" className="finder-action" onClick={() => loadScan(true)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh scan"}
          </button>
        </div>
      </header>

      {payload?.warnings?.length ? (
        <div className="warning-strip">
          {payload.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}

      <section className="screening-v2__summary-grid">
        <article className="insight-card screening-v2__summary-card">
          <span>Symbols scanned</span>
          <strong>{payload?.summary?.symbolsScanned ?? 0}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Live candidates</span>
          <strong>{payload?.summary?.liveCandidates ?? 0}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg liquidity</span>
          <strong>{formatNumber(payload?.summary?.averageLiquidityScore, 1)}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg 1d breakeven</span>
          <strong>{formatPercent(payload?.summary?.averageBreakevenMovePct)}</strong>
        </article>
      </section>

      <article className="insight-card screening-v2__filters">
        <div className="strategy-settings__page-head">
          <div>
            <span className="brand__eyebrow">Scanner Universe</span>
            <h3>Add stock tickers</h3>
          </div>
          <p className="card-copy">
            Add more U.S. optionable names to this scan. Custom tickers are persisted and scanned alongside the
            default watchlist.
          </p>
        </div>

        {tickerFeedback ? (
          <div className={`refresh-feedback refresh-feedback--${tickerFeedback.tone}`}>
            <span>{tickerFeedback.message}</span>
          </div>
        ) : null}

        <div className="delta-hedge__ticker-form">
          <label className="delta-hedge__ticker-input">
            <span>Ticker</span>
            <input
              value={tickerDraft}
              placeholder="TSM"
              onChange={(event) => setTickerDraft(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddTicker();
                }
              }}
            />
          </label>
          <button type="button" className="finder-action" onClick={handleAddTicker} disabled={tickerBusy}>
            {tickerBusy ? "Saving…" : "Add ticker"}
          </button>
        </div>

        <div className="delta-hedge__ticker-list">
          {(payload?.stockUniverse ?? []).map((stock) => (
            <div key={stock.symbol} className={`delta-hedge__ticker-chip ${stock.isCustom ? "delta-hedge__ticker-chip--custom" : ""}`}>
              <div className="finder-cell-stack">
                <strong>{stock.symbol}</strong>
                <span className="screening-v2__subtle">{stock.label}</span>
              </div>
              {stock.isCustom ? (
                <button
                  type="button"
                  className="delta-hedge__ticker-remove"
                  onClick={() => handleRemoveTicker(stock.symbol)}
                  disabled={tickerBusy}
                  aria-label={`Remove ${stock.symbol}`}
                >
                  Remove
                </button>
              ) : (
                <span className="pill pill--ghost">Default</span>
              )}
            </div>
          ))}
        </div>
      </article>

      <article className="insight-card screening-v2__filters">
        <div className="strategy-settings__page-head">
          <div>
            <span className="brand__eyebrow">Filters</span>
            <h3>Focus on hedgeable names</h3>
          </div>
          <p className="card-copy">
            This scan ranks ATM straddles on your screenshot watchlist by liquidity, gamma response, and one-day theta
            break-even move.
          </p>
        </div>

        <div className="screening-v2__filter-grid">
          <label>
            <span>Min liquidity</span>
            <input value={minLiquidity} onChange={(event) => setMinLiquidity(event.target.value)} />
          </label>
          <label>
            <span>Max 1d breakeven %</span>
            <input value={maxBreakevenMovePct} onChange={(event) => setMaxBreakevenMovePct(event.target.value)} />
          </label>
          <label>
            <span>Max theta burn %</span>
            <input value={maxThetaBurnPct} onChange={(event) => setMaxThetaBurnPct(event.target.value)} />
          </label>
        </div>

        <div className="screening-v2__pill-row">
          {(payload?.filters?.quoteQualities ?? []).map((quality) => (
            <button
              key={quality}
              type="button"
              className={`finder-action ${selectedQuoteQualities.includes(quality) ? "tv-finder__filter-control--active" : ""}`}
              onClick={() => toggleQuoteQuality(quality)}
            >
              {quality}
            </button>
          ))}
          <button type="button" className="finder-action" onClick={resetFilters}>
            Reset filters
          </button>
        </div>
      </article>

      <section className="screening-v2__selected-layout">
        <article className="insight-card screening-v2__table-card">
          <div className="strategy-settings__page-head">
            <div>
              <span className="brand__eyebrow">Ranked setups</span>
              <h3>Best ATM straddle per stock</h3>
            </div>
            <p className="card-copy">
              One row per symbol. Lower daily break-even and stronger delta shift for a 1% move generally make dynamic
              hedging easier.
            </p>
          </div>

          <div className="screening-v2__table-wrap">
            <table className="screening-v2__table">
              <thead>
                <tr>
                  {columns.map((column) => (
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
                          const sortIndex = sortState.findIndex(
                            (sortDescriptor) => sortDescriptor?.key === column.key
                          );
                          if (sortIndex < 0) {
                            return null;
                          }

                          const sortDescriptor = sortState[sortIndex];
                          const direction = sortDescriptor?.direction === "asc" ? "asc" : "desc";

                          return (
                            <span className="finder-sort__indicator" aria-hidden="true">
                              <span className="finder-sort__priority">{sortIndex + 1}</span>
                              <span className="finder-sort__direction">{direction === "asc" ? "↑" : "↓"}</span>
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
                      className={row.id === selectedRowId ? "screening-v2__table-row--active" : ""}
                      onClick={() => setSelectedRowId(row.id)}
                    >
                      <td>{formatNumber(row.compositeScore)}</td>
                      <td>
                        <div className="finder-cell-stack">
                          <strong>{row.symbol}</strong>
                          <span className="screening-v2__subtle">{row.companyName}</span>
                        </div>
                      </td>
                      <td>{formatCurrency(row.underlyingPrice)}</td>
                      <td>{row.expiration}</td>
                      <td>{formatWholeNumber(row.daysToExpiry)}</td>
                      <td>{formatCurrency(row.strike)}</td>
                      <td>{formatCurrency(row.straddleCost)}</td>
                      <td>{formatPercent(row.impliedMovePct)}</td>
                      <td>{formatNumber(row.deltaChangeForOnePctMove)}</td>
                      <td>{formatPercent(row.dailyBreakevenMovePct)}</td>
                      <td>{formatPercent(row.thetaBurnPctPerDay)}</td>
                      <td>{formatPercent(row.spreadPct)}</td>
                      <td>{formatNumber(row.liquidityScore)}</td>
                      <td>{row.quoteQuality}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={columns.length}>
                      No delta hedge candidates match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="screening-v2__selected-summary">
          {selectedRow ? (
            <>
              <div className="screening-v2__selected-top">
                <div className="screening-v2__selected-head">
                  <div className="screening-v2__selected-copy">
                    <span className="brand__eyebrow">Selected setup</span>
                    <h3>{selectedRow.symbol} · {selectedRow.strategyType}</h3>
                    <p className="screening-v2__selected-question">
                      {selectedRow.companyName} with {selectedRow.daysToExpiry} DTE and an ATM strike near{" "}
                      {formatCurrency(selectedRow.strike)}.
                    </p>
                  </div>
                  <div className="status-block__actions">
                    <span className={getQuoteQualityPillClass(selectedRow.quoteQuality)}>{selectedRow.quoteQuality}</span>
                    <span className="pill pill--ghost">{formatWholeNumber(selectedRow.daysToExpiry)} DTE</span>
                  </div>
                </div>

                <div className="screening-v2__selected-grid">
                  <div className="screening-v2__selected-panel">
                    <h4>Core metrics</h4>
                    <div className="summary-stack">
                      <div className="summary-row">
                        <span>Composite score</span>
                        <strong>{formatNumber(selectedRow.compositeScore)}</strong>
                      </div>
                      <div className="summary-row">
                        <span>Spot / strike</span>
                        <strong>{formatCurrency(selectedRow.underlyingPrice)} / {formatCurrency(selectedRow.strike)}</strong>
                      </div>
                      <div className="summary-row">
                        <span>Straddle cost</span>
                        <strong>{formatCurrency(selectedRow.straddleCost)}</strong>
                      </div>
                      <div className="summary-row">
                        <span>Implied move to expiry</span>
                        <strong>{formatCurrency(selectedRow.impliedMoveUsd)} ({formatPercent(selectedRow.impliedMovePct)})</strong>
                      </div>
                      <div className="summary-row">
                        <span>Net delta</span>
                        <strong>{formatNumber(selectedRow.netDeltaShares)} shares</strong>
                      </div>
                    </div>
                  </div>

                  <div className="screening-v2__selected-panel">
                    <h4>Hedge mechanics</h4>
                    <div className="summary-stack">
                      <div className="summary-row">
                        <span>Delta shift for a 1% move</span>
                        <strong>{formatNumber(selectedRow.deltaChangeForOnePctMove)} shares</strong>
                      </div>
                      <div className="summary-row">
                        <span>1-day theta burn</span>
                        <strong>{formatCurrency(selectedRow.thetaPerDay)} ({formatPercent(selectedRow.thetaBurnPctPerDay)})</strong>
                      </div>
                      <div className="summary-row">
                        <span>1-day breakeven move</span>
                        <strong>{formatCurrency(selectedRow.dailyBreakevenMoveUsd)} ({formatPercent(selectedRow.dailyBreakevenMovePct)})</strong>
                      </div>
                      <div className="summary-row">
                        <span>Move for 10 delta change</span>
                        <strong>{formatCurrency(selectedRow.rebalanceMoveForTenDeltaUsd)} ({formatPercent(selectedRow.rebalanceMoveForTenDeltaPct)})</strong>
                      </div>
                      <div className="summary-row">
                        <span>Spread / liquidity</span>
                        <strong>{formatPercent(selectedRow.spreadPct)} / {formatNumber(selectedRow.liquidityScore)}</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="screening-v2__detail-grid">
                <article className="insight-card">
                  <span className="brand__eyebrow">Assumptions</span>
                  <h3>How to read the score</h3>
                  <div className="summary-stack">
                    {(payload?.assumptions ?? []).map((assumption) => (
                      <div key={assumption} className="summary-row">
                        <span>{assumption}</span>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="insight-card screening-v2__selected-panel screening-v2__selected-panel--contracts">
                  <h4>Option legs</h4>
                  <div className="screening-v2__contract-table-wrap">
                    <table className="screening-v2__contract-table">
                      <thead>
                        <tr>
                          <th>Leg</th>
                          <th>Strike</th>
                          <th>Expiry</th>
                          <th>Entry</th>
                          <th>Bid/ask</th>
                          <th>Size</th>
                          <th>Volume</th>
                          <th>OI</th>
                          <th>IV</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(selectedRow.optionLegs ?? []).map((leg) => (
                          <tr key={`${leg.contractSymbol}:${leg.optionType}`}>
                            <td>{String(leg.optionType ?? "").toUpperCase()}</td>
                            <td>{formatCurrency(leg.strike)}</td>
                            <td>{leg.expiration}</td>
                            <td>{formatCurrency(leg.entryPrice)}</td>
                            <td>
                              {formatCurrency(leg.bid, "USD")} / {formatCurrency(leg.ask, "USD")}
                            </td>
                            <td>{formatQuoteSizePair(leg.bidSize, leg.askSize)}</td>
                            <td>{formatWholeNumber(leg.volume)}</td>
                            <td>{formatWholeNumber(leg.openInterest)}</td>
                            <td>{formatPercent(Number(leg.impliedVolatility ?? 0) * 100)}</td>
                            <td>{leg.quoteSource}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>
              </div>
            </>
          ) : (
            <article className="insight-card">
              <p className="card-copy">Pick a row to inspect the hedge metrics in more detail.</p>
            </article>
          )}
        </article>
      </section>

      {selectedScenarioOrder ? (
        <PaperTradeScenarioPanel
          order={selectedScenarioOrder}
          lastUpdated={payload?.generatedAt}
          className="paper-scenario-card--screening"
          defaultOpen={true}
          theme={theme}
        />
      ) : null}
    </main>
  );
}
