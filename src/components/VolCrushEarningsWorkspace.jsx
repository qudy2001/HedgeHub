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

function getQuoteQualityTone(quality) {
  const normalized = String(quality ?? "").trim().toLowerCase();
  if (normalized.includes("nbbo")) {
    return "live";
  }
  if (normalized.includes("snapshot")) {
    return "mapped";
  }
  return "seed";
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

function buildScenarioOrderFromVolCrushRow(row, generatedAt) {
  if (!row) {
    return null;
  }

  const purchaseDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);
  const marketContext = row.marketContext ?? {};
  const riskFreeRate = Number(marketContext.riskFreeRate ?? 0.0425) || 0.0425;
  const impliedVolatility = Number(marketContext.impliedVolatility ?? 0.24) || 0.24;

  return {
    id: row.id,
    assetLabel: row.assetLabel,
    strategyType: row.strategyType,
    purchaseDate,
    createdAt: generatedAt ?? null,
    closedAt: "",
    status: "open",
    polymarketMarketId: "",
    polymarketQuestion: `${row.companyName} earnings`,
    polymarketUrl: "",
    strategyCloseDate: row.expiration,
    polymarketResolutionDate: row.eventDate,
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

const columns = [
  { key: "compositeScore", label: "Score" },
  { key: "symbol", label: "Company" },
  { key: "eventDate", label: "Event" },
  { key: "releaseSession", label: "Session" },
  { key: "strategyType", label: "Structure" },
  { key: "expiration", label: "Expiry" },
  { key: "expectedMovePct", label: "Implied move" },
  { key: "netCredit", label: "Credit" },
  { key: "maxLoss", label: "Max loss" },
  { key: "netSpreadPct", label: "Spread" },
  { key: "liquidityScore", label: "Liquidity" },
  { key: "quoteQuality", label: "Quote quality" }
];

const MAX_SORT_PRIORITIES = 4;

export default function VolCrushEarningsWorkspace({
  strategyDefinition,
  onCreatePaperOrder = null,
  onOpenPaperTrading = null,
  onMarketTimerContextChange = null,
  theme = "dark"
}) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [selectedQuoteQualities, setSelectedQuoteQualities] = useState([]);
  const [maxDaysToEvent, setMaxDaysToEvent] = useState("14");
  const [minLiquidity, setMinLiquidity] = useState("");
  const [maxSpread, setMaxSpread] = useState("");
  const [sortState, setSortState] = useState([{ key: "compositeScore", direction: "desc" }]);
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [paperOrderState, setPaperOrderState] = useState(null);

  async function loadScan(force = false) {
    const nextRefreshing = payload != null;
    if (nextRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");

    try {
      const response = await fetch(`/api/strategies/strategy-2/scan${force ? "?force=true" : ""}`);
      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Unable to load earnings strategy rows");
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
    const sessions = payload?.filters?.sessions ?? [];
    setSelectedSessions((current) => {
      const next = current.filter((session) => sessions.includes(session));
      return next.length ? next : sessions;
    });
  }, [payload?.filters?.sessions]);

  useEffect(() => {
    const quoteQualities = payload?.filters?.quoteQualities ?? [];
    setSelectedQuoteQualities((current) => {
      const next = current.filter((quality) => quoteQualities.includes(quality));
      return next.length ? next : quoteQualities;
    });
  }, [payload?.filters?.quoteQualities]);

  const filteredRows = useMemo(() => {
    const rows = payload?.rows ?? [];
    const maxDaysThreshold = toOptionalNumber(maxDaysToEvent, 14);
    const minLiquidityThreshold = toOptionalNumber(minLiquidity, null);
    const maxSpreadThreshold = toOptionalNumber(maxSpread, null);

    return rows.filter((row) => {
      return (
        selectedSessions.includes(row.releaseSession) &&
        selectedQuoteQualities.includes(row.quoteQuality) &&
        Number(row.daysToEvent ?? 99) <= maxDaysThreshold &&
        (minLiquidityThreshold == null || Number(row.liquidityScore ?? 0) >= minLiquidityThreshold) &&
        (maxSpreadThreshold == null ||
          row.netSpreadPct == null ||
          Number(row.netSpreadPct ?? Number.POSITIVE_INFINITY) <= maxSpreadThreshold)
      );
    });
  }, [maxDaysToEvent, maxSpread, minLiquidity, payload?.rows, selectedQuoteQualities, selectedSessions]);

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
    () => buildScenarioOrderFromVolCrushRow(selectedRow, payload?.generatedAt),
    [payload?.generatedAt, selectedRow]
  );
  const marketTimerContext = useMemo(() => {
    if (!selectedRow) {
      return null;
    }

    return createMarketTimerContext({
      source: "vol-crush",
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

  function toggleSession(session) {
    setSelectedSessions((current) => {
      if (current.includes(session)) {
        return current.length === 1 ? current : current.filter((item) => item !== session);
      }

      return [...current, session];
    });
  }

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
    setSelectedSessions(payload?.filters?.sessions ?? []);
    setSelectedQuoteQualities(payload?.filters?.quoteQualities ?? []);
    setMaxDaysToEvent("14");
    setMinLiquidity("");
    setMaxSpread("");
  }

  async function handleCreatePaperTrade() {
    if (!selectedRow || !onCreatePaperOrder) {
      return;
    }

    setPaperOrderSaving(true);
    setPaperOrderState(null);

    try {
      const marketContext = selectedRow.marketContext ?? {};
      const createResponse = await onCreatePaperOrder({
        strategyId: strategyDefinition?.id ?? "strategy-2",
        strategyName: strategyDefinition?.name ?? "Vol Crush Earnings",
        combinationId: selectedRow.id,
        combinationLabel: `${selectedRow.symbol} · ${selectedRow.strategyType} · ${selectedRow.expiration}`,
        assetLabel: selectedRow.symbol,
        strategyType: selectedRow.strategyType,
        marketBias: selectedRow.marketBias,
        marketBiasTone: selectedRow.marketBiasTone,
        maxProfit: selectedRow.maxProfit,
        maxLoss: selectedRow.maxLoss,
        maxProfitUnbounded: selectedRow.maxProfitUnbounded === true,
        maxLossUnbounded: selectedRow.maxLossUnbounded === true,
        purchaseDate: new Date().toISOString().slice(0, 10),
        polymarketResolutionDate: selectedRow.eventDate,
        strategyCloseDate: selectedRow.expiration,
        marketReferenceYesPrice: 0.5,
        marketContext: {
          proxySymbol: marketContext.proxySymbol ?? selectedRow.symbol,
          underlyingSymbol: marketContext.underlyingSymbol ?? selectedRow.symbol,
          currentProxySpot: Number(marketContext.currentProxySpot ?? selectedRow.underlyingPrice ?? 0),
          currentUnderlyingSpot: Number(marketContext.currentUnderlyingSpot ?? selectedRow.underlyingPrice ?? 0),
          conversionRatio: Number(marketContext.conversionRatio ?? 1) || 1,
          targetUnderlyingValue: Number(marketContext.targetUnderlyingValue ?? selectedRow.underlyingPrice ?? 0),
          impliedVolatility: Number(marketContext.impliedVolatility ?? selectedRow.averageIv ?? 0.24) || 0.24,
          riskFreeRate: Number(marketContext.riskFreeRate ?? 0.0425) || 0.0425
        },
        legs: (selectedRow.optionLegs ?? []).map((leg, index) => ({
          id: `${selectedRow.id}-leg-${index + 1}`,
          label: `${selectedRow.symbol} ${leg.expiration} ${leg.strike} ${String(leg.optionType).toUpperCase()}`,
          kind: "option",
          action: leg.action,
          quantity: Number(leg.quantity ?? 1),
          entryPrice: Number(leg.entryPrice ?? 0),
          contractMultiplier: Number(leg.contractMultiplier ?? 100),
          optionType: leg.optionType,
          expiry: leg.expiration,
          strike: Number(leg.strike ?? 0),
          contractSymbol: leg.contractSymbol ?? "",
          rootSymbol: leg.rootSymbol ?? selectedRow.symbol,
          impliedVolatility:
            Number(leg.impliedVolatility ?? marketContext.impliedVolatility ?? selectedRow.averageIv ?? 0.24) || 0.24,
          riskFreeRate: Number(marketContext.riskFreeRate ?? 0.0425) || 0.0425,
          quoteSource: leg.quoteSource ?? "scan",
          isLive: leg.isLive === true
        })),
        execution: {
          route: "local-paper"
        }
      });

      setPaperOrderState({
        tone: "success",
        message:
          createResponse?.message ??
          "Paper order saved. You can now monitor it from the paper-trading workspace."
      });
    } catch (createError) {
      setPaperOrderState({
        tone: "error",
        message: createError.message
      });
    } finally {
      setPaperOrderSaving(false);
    }
  }

  if (loading) {
    return <div className="app-state">Scanning upcoming earnings setups...</div>;
  }

  if (error) {
    return (
      <main className="workspace workspace--screening-v2 workspace--vol-crush">
        <header className="topbar">
          <div>
            <span className="brand__eyebrow">Strategy workspace</span>
            <h2>{strategyDefinition?.name ?? "Vol Crush Earnings"}</h2>
          </div>
        </header>
        <div className="screening-v2__notice screening-v2__notice--error">{error}</div>
      </main>
    );
  }

  return (
    <main className="workspace workspace--screening-v2 workspace--vol-crush">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Strategy workspace</span>
          <h2>{strategyDefinition?.name ?? "Vol Crush Earnings"}</h2>
          <p className="card-copy">
            Scan upcoming large-cap earnings, estimate the option market&apos;s implied move, and rank defined-risk iron condors that sell post-earnings volatility crush.
          </p>
        </div>

        <div className="screening-v2__actions">
          <button
            type="button"
            className="finder-action"
            disabled={refreshing}
            onClick={() => loadScan(true)}
          >
            {refreshing ? "Refreshing..." : "Refresh scan"}
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
          <span className="brand__eyebrow">Events considered</span>
          <strong>{payload?.summary?.eventsConsidered ?? 0}</strong>
          <p className="card-copy">Large-cap US earnings dates pulled into the near-term scan window.</p>
        </article>

        <article className="insight-card screening-v2__summary-card">
          <span className="brand__eyebrow">Ranked condors</span>
          <strong>{payload?.summary?.candidatesRanked ?? 0}</strong>
          <p className="card-copy">Defined-risk iron condors that had usable strikes on both sides of the implied move.</p>
        </article>

        <article className="insight-card screening-v2__summary-card">
          <span className="brand__eyebrow">Quote mix</span>
          <strong>
            {payload?.summary?.liveQuoteCandidates ?? 0} / {payload?.summary?.modeledCandidates ?? 0}
          </strong>
          <p className="card-copy">Live-like candidates first, with modeled chains kept as a fallback when live options are unavailable.</p>
        </article>
      </section>

      <section className="insight-card screening-v2__filters">
        <div className="section-heading">
          <span>Filters</span>
          <button type="button" className="finder-menu__reset" onClick={resetFilters}>
            Reset
          </button>
        </div>

        <div className="screening-v2__filter-grid">
          <label>
            <span>Max days to earnings</span>
            <input
              type="number"
              min="0"
              step="1"
              value={maxDaysToEvent}
              onChange={(event) => setMaxDaysToEvent(event.target.value)}
            />
          </label>
          <label>
            <span>Min liquidity score (optional)</span>
            <input
              type="number"
              step="1"
              value={minLiquidity}
              onChange={(event) => setMinLiquidity(event.target.value)}
            />
          </label>
          <label>
            <span>Max net spread % (optional)</span>
            <input
              type="number"
              step="0.5"
              value={maxSpread}
              onChange={(event) => setMaxSpread(event.target.value)}
            />
          </label>
        </div>

        <div className="screening-v2__pill-row">
          {(payload?.filters?.sessions ?? []).map((session) => (
            <button
              key={session}
              type="button"
              className={`chip ${selectedSessions.includes(session) ? "chip--active" : ""}`}
              onClick={() => toggleSession(session)}
            >
              {session}
            </button>
          ))}

          {(payload?.filters?.quoteQualities ?? []).map((quality) => (
            <button
              key={quality}
              type="button"
              className={`chip ${selectedQuoteQualities.includes(quality) ? "chip--active" : ""}`}
              onClick={() => toggleQuoteQuality(quality)}
            >
              {quality}
            </button>
          ))}
        </div>
      </section>

      <section className="insight-card screening-v2__table-card finder-table-card">
        <div className="section-heading">
          <span>Ranked earnings setups</span>
          <span className="pill pill--ghost">{sortedRows.length}</span>
        </div>

        {sortedRows.length ? (
          <div className="finder-table finder-table--vol-crush">
            <div className="finder-table__head finder-table__head--vol-crush">
              {columns.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  className="finder-sort"
                  title="Click to sort. Shift-click (or Ctrl/⌘-click) to add up to 4 sort priorities."
                  onClick={(event) =>
                    handleSort(column.key, {
                      additive: event.shiftKey || event.metaKey || event.ctrlKey
                    })
                  }
                >
                  <span className="finder-sort__label">{column.label}</span>
                  {(() => {
                    const sortIndex = sortState.findIndex((sortDescriptor) => sortDescriptor?.key === column.key);
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
              ))}
            </div>

            {sortedRows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`finder-row finder-row--vol-crush ${row.id === selectedRowId ? "finder-row--active" : ""}`}
                onClick={() => setSelectedRowId(row.id)}
              >
                <span>{row.compositeScore?.toFixed?.(2) ?? "n/a"}</span>
                <span className="finder-asset-cell finder-asset-cell--vol-crush">
                  <span>{row.symbol}</span>
                  <span className="screening-v2__subtle">{row.companyName}</span>
                </span>
                <span className="finder-cell-stack">
                  <strong>{row.eventDate}</strong>
                  <div className="screening-v2__subtle">{row.daysToEvent}d</div>
                </span>
                <span>{row.releaseSession}</span>
                <span>
                  <span className="bias-pill bias-pill--range">{row.strategyType}</span>
                </span>
                <span>{row.expiration}</span>
                <span>{formatPercent(row.expectedMovePct)}</span>
                <span className="positive">{formatCurrency(Number(row.netCredit ?? 0) * 100)}</span>
                <span className="negative">{formatCurrency(row.maxLoss)}</span>
                <span className="negative">{row.netSpreadPct != null ? formatPercent(row.netSpreadPct) : "n/a"}</span>
                <span>{row.liquidityScore?.toFixed?.(2) ?? "n/a"}</span>
                <span className={`source-pill source-pill--${getQuoteQualityTone(row.quoteQuality)}`}>
                  {row.quoteQuality}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="app-state app-state--inline">
            No earnings setups matched the current filters. Relax the liquidity or spread guardrails to see more candidates.
          </div>
        )}
      </section>

      {selectedRow ? (
        <section className="screening-v2__selected-layout">
          <article className="insight-card screening-v2__selected-top detail-card">
            <div className="screening-v2__selected-head selection-banner">
              <div className="screening-v2__selected-copy selection-banner__title">
                <span className="brand__eyebrow">Selected setup</span>
                <strong>
                  {selectedRow.symbol} · {selectedRow.strategyType} · {selectedRow.expiration}
                </strong>
                <p className="screening-v2__selected-question">
                  {selectedRow.companyName} reports on {selectedRow.eventDate} ({selectedRow.releaseSession}). The market is pricing an expected move of {formatCurrency(selectedRow.expectedMoveDollar)} or {formatPercent(selectedRow.expectedMovePct)}.
                </p>
                <div className="detail-badges">
                  <span className="pill pill--ghost">{selectedRow.quoteQuality}</span>
                  <span className="pill pill--ghost">Expiry {selectedRow.expiration}</span>
                  <span className="pill pill--ghost">Planned exit {selectedRow.plannedExitDate}</span>
                  <span className="pill pill--live">{selectedRow.marketCapLabel}</span>
                </div>
              </div>

              <div className="detail-card__actions selection-banner__actions">
                <button
                  type="button"
                  className="finder-action"
                  disabled={!onCreatePaperOrder || paperOrderSaving}
                  onClick={handleCreatePaperTrade}
                >
                  {paperOrderSaving ? "Saving..." : "Save to paper trading"}
                </button>
                {onOpenPaperTrading ? (
                  <button type="button" className="finder-menu__reset" onClick={onOpenPaperTrading}>
                    Open paper book
                  </button>
                ) : null}
              </div>
            </div>

            {paperOrderState ? (
              <div className={`screening-v2__notice screening-v2__notice--${paperOrderState.tone}`}>
                {paperOrderState.message}
              </div>
            ) : null}

            <div className="screening-v2__selected-grid">
              <section className="screening-v2__selected-panel detail-panel">
                <h4>Trade plan</h4>
                <div className="summary-stack">
                  <div className="summary-row">
                    <span>Underlying price</span>
                    <strong>{formatCurrency(selectedRow.underlyingPrice)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Expected move</span>
                    <strong>{formatCurrency(selectedRow.expectedMoveDollar)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Net credit</span>
                    <strong>{formatCurrency(Number(selectedRow.netCredit ?? 0) * 100)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Max profit</span>
                    <strong>{formatCurrency(selectedRow.maxProfit)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Max loss</span>
                    <strong>{formatCurrency(selectedRow.maxLoss)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Breakeven band</span>
                    <strong>
                      {formatCurrency(selectedRow.breakevenLow)} to {formatCurrency(selectedRow.breakevenHigh)}
                    </strong>
                  </div>
                  <div className="summary-row">
                    <span>Credit / risk</span>
                    <strong>{formatPercent(selectedRow.creditToRiskPct)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Average IV</span>
                    <strong>{formatPercent(selectedRow.averageIvPct)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Liquidity score</span>
                    <strong>{selectedRow.liquidityScore?.toFixed?.(2) ?? "n/a"}</strong>
                  </div>
                </div>
              </section>

              <section className="screening-v2__selected-panel screening-v2__selected-panel--contracts detail-panel detail-panel--contracts">
                <h4>Legs and management</h4>
                <div className="screening-v2__contract-table-wrap">
                  <table className="screening-v2__contract-table">
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>Qty</th>
                        <th>Strike</th>
                        <th>Entry</th>
                        <th>Bid</th>
                        <th>Ask</th>
                        <th>Spread</th>
                        <th>Contract</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selectedRow.optionLegs ?? []).map((leg) => (
                        <tr key={`${leg.contractSymbol}-${leg.action}`}>
                          <td>{leg.action}</td>
                          <td>{leg.quantity}</td>
                          <td>
                            {leg.strike}
                            {String(leg.optionType ?? "call").toUpperCase()} · {leg.expiration}
                          </td>
                          <td>{formatCurrency(Number(leg.entryPrice ?? 0) * 100)}</td>
                          <td>{leg.bid != null ? formatCurrency(Number(leg.bid) * 100) : "n/a"}</td>
                          <td>{leg.ask != null ? formatCurrency(Number(leg.ask) * 100) : "n/a"}</td>
                          <td>{leg.spread != null ? formatPercent(leg.spread) : "n/a"}</td>
                          <td>
                            <div className="screening-v2__contract-link">
                              <strong>{leg.contractSymbol || `${leg.action} ${leg.optionType} ${leg.strike}`}</strong>
                              <span>{leg.quoteSource ?? "scan"}</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="summary-stack">
                  <div className="summary-row">
                    <span>Management rule</span>
                    <strong>{selectedRow.managementPlan}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Why this structure</span>
                    <strong>Short strikes are set around the market&apos;s implied move, with long wings added to cap earnings-gap risk.</strong>
                  </div>
                </div>
              </section>
            </div>
          </article>

          {selectedScenarioOrder ? (
            <PaperTradeScenarioPanel
              order={selectedScenarioOrder}
              lastUpdated={payload?.generatedAt}
              className="paper-scenario-card--screening"
              defaultOpen={true}
              theme={theme}
            />
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
