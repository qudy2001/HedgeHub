import { useEffect, useMemo, useState } from "react";
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

function computeRangeWindow(profile, minPct, maxPct) {
  const lower = Math.min(minPct, maxPct);
  const upper = Math.max(minPct, maxPct);
  const points = (profile ?? []).filter((point) => point.pct >= lower && point.pct <= upper && point.pnl != null);
  if (!points.length) {
    return null;
  }

  const values = points.map((point) => Number(point.pnl));
  return {
    min: Math.min(...values),
    max: Math.max(...values)
  };
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

function buildScenarioOrderFromScreeningRow(row, generatedAt) {
  if (!row) {
    return null;
  }

  const marketContext = row.marketContext ?? {};
  const purchaseDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);
  const strategyCloseDate =
    [row.strategyCloseDate, row.eventDate, row.optionExpiry].filter(Boolean).sort()[0] ??
    row.eventDate ??
    purchaseDate;
  const referenceYesPrice = Number(
    marketContext.marketReferenceYesPrice ?? Number(row.polymarketProbability ?? 50) / 100
  );
  const proxySymbol = marketContext.proxySymbol ?? row.optionRootSymbol ?? row.referenceSymbol ?? row.assetLabel;
  const underlyingSymbol = marketContext.underlyingSymbol ?? row.referenceSymbol ?? proxySymbol;
  const riskFreeRate = Number(
    marketContext.riskFreeRate ?? row.optionLegs?.[0]?.riskFreeRate ?? 0.0425
  ) || 0.0425;

  const optionLegs = (row.optionLegs ?? []).map((leg, index) => ({
    id: `${row.id}:option:${index}`,
    label: `${leg.action} ${String(leg.optionType ?? "call").toUpperCase()} ${leg.strike}`,
    kind: "option",
    action: leg.action,
    quantity: Number(leg.quantity ?? 0),
    entryPrice: Number(leg.entryPrice ?? 0),
    contractMultiplier: Number(leg.contractMultiplier ?? 100),
    optionType: leg.optionType ?? "call",
    expiry: leg.expiration ?? row.optionExpiry ?? row.eventDate ?? purchaseDate,
    strike: Number(leg.strike ?? 0),
    contractSymbol: leg.contractSymbol ?? "",
    rootSymbol: leg.rootSymbol ?? proxySymbol,
    impliedVolatility:
      Number(leg.impliedVolatility ?? marketContext.impliedVolatility ?? 0.24) || 0.24,
    riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate,
    quoteSource: leg.quoteSource ?? (leg.isLive === true ? "live" : "modeled"),
    isLive: leg.isLive === true
  }));

  const polymarketLeg = row.polymarketLeg
    ? [
        {
          id: `${row.id}:polymarket`,
          label: row.polymarketLeg.side === "NO" ? "Long NO" : "Long YES",
          kind: "binary",
          action: "LONG",
          quantity: Number(row.polymarketLeg.quantity ?? 0),
          entryPrice: Number(row.polymarketLeg.entryPrice ?? referenceYesPrice),
          outcome: row.polymarketLeg.side === "NO" ? "NO" : "YES",
          polymarketMarketId: row.polymarketMarketId ?? "",
          quoteSource: "Polymarket",
          isLive: true
        }
      ]
    : [];

  return {
    id: row.id,
    assetLabel: row.assetLabel,
    strategyType: row.strategyClass ?? row.strategyName ?? "Strategy",
    purchaseDate,
    createdAt: generatedAt ?? null,
    closedAt: "",
    status: "open",
    polymarketMarketId: row.polymarketMarketId ?? "",
    polymarketQuestion: row.marketQuestion ?? "",
    polymarketUrl: row.polymarketUrl ?? "",
    strategyCloseDate,
    polymarketResolutionDate: row.eventDate ?? strategyCloseDate,
    marketReferenceYesPrice: referenceYesPrice,
    valuationContext: {
      proxySymbol,
      underlyingSymbol,
      currentProxySpot: Number(marketContext.currentProxySpot ?? 0),
      currentUnderlyingSpot: Number(marketContext.currentUnderlyingSpot ?? 0),
      conversionRatio: Number(marketContext.conversionRatio ?? 0),
      targetUnderlyingValue: Number(marketContext.targetUnderlyingValue ?? 0),
      currentYesPrice: referenceYesPrice
    },
    legs: [...optionLegs, ...polymarketLeg]
  };
}

const columns = [
  { key: "compositeScore", label: "Score" },
  { key: "strategyName", label: "Strategy" },
  { key: "assetLabel", label: "Asset" },
  { key: "eventDate", label: "Event" },
  { key: "polymarketProbability", label: "PM prob" },
  { key: "optionImpliedProbability", label: "Opt prob" },
  { key: "probabilityMismatchPct", label: "Mismatch" },
  { key: "expectedValue", label: "Exp value" },
  { key: "executionRiskScore", label: "Exec risk" },
  { key: "exitLiquidityScore", label: "Exit liquidity" },
  { key: "hedgeQualityScore", label: "Hedge quality" },
  { key: "settlementType", label: "Settlement" },
  { key: "failureReason", label: "Debug" }
];

export default function StrategyScreeningWorkspace({
  screenerPayload,
  onManualRefresh = null,
  refreshing = false,
  refreshNotice = null,
  theme = "dark"
}) {
  const rows = screenerPayload?.rows ?? [];
  const settlementTypes = screenerPayload?.filters?.settlementTypes ?? [];
  const strategyClasses = screenerPayload?.filters?.strategyClasses ?? [];
  const defaultExpectedRange = screenerPayload?.filters?.expectedPriceRange ?? { min: 5, max: 10 };
  const defaultExecutionRiskMax = screenerPayload?.filters?.executionRiskMax;
  const defaultExitLiquidityMin = screenerPayload?.filters?.exitLiquidityMin;
  const defaultHedgeQualityMin = Number(screenerPayload?.filters?.hedgeQualityMin ?? 0);
  const settlementTypesKey = settlementTypes.join("|");
  const strategyClassesKey = strategyClasses.join("|");
  const [selectedSettlementTypes, setSelectedSettlementTypes] = useState(settlementTypes);
  const [selectedStrategyClasses, setSelectedStrategyClasses] = useState(strategyClasses);
  const [probabilityMismatchMin, setProbabilityMismatchMin] = useState("");
  const [executionRiskMax, setExecutionRiskMax] = useState("");
  const [exitLiquidityMin, setExitLiquidityMin] = useState("");
  const [hedgeQualityMin, setHedgeQualityMin] = useState("");
  const [expectedRangeMin, setExpectedRangeMin] = useState(String(defaultExpectedRange.min ?? 5));
  const [expectedRangeMax, setExpectedRangeMax] = useState(String(defaultExpectedRange.max ?? 10));
  const [sortKey, setSortKey] = useState("compositeScore");
  const [sortDirection, setSortDirection] = useState("desc");
  const [selectedRowId, setSelectedRowId] = useState(null);

  useEffect(() => {
    setSelectedSettlementTypes((current) => {
      const next = current.filter((type) => settlementTypes.includes(type));
      return next.length ? next : settlementTypes;
    });
  }, [settlementTypesKey, settlementTypes]);

  useEffect(() => {
    setSelectedStrategyClasses((current) => {
      const next = current.filter((strategyClass) => strategyClasses.includes(strategyClass));
      return next.length ? next : strategyClasses;
    });
  }, [strategyClassesKey, strategyClasses]);

  useEffect(() => {
    setProbabilityMismatchMin("");
    setExecutionRiskMax("");
    setExitLiquidityMin("");
    setHedgeQualityMin(defaultHedgeQualityMin > 0 ? String(defaultHedgeQualityMin) : "");
    setExpectedRangeMin(String(defaultExpectedRange.min ?? 5));
    setExpectedRangeMax(String(defaultExpectedRange.max ?? 10));
  }, [
    defaultExpectedRange.max,
    defaultExpectedRange.min,
    defaultExecutionRiskMax,
    defaultExitLiquidityMin,
    defaultHedgeQualityMin
  ]);

  const probabilityThreshold = toOptionalNumber(probabilityMismatchMin, null);
  const executionRiskThreshold = toOptionalNumber(executionRiskMax, null);
  const exitLiquidityThreshold = toOptionalNumber(exitLiquidityMin, null);
  const hedgeQualityThreshold = toOptionalNumber(hedgeQualityMin, null);
  const rangeMin = toOptionalNumber(expectedRangeMin, defaultExpectedRange.min ?? 5);
  const rangeMax = toOptionalNumber(expectedRangeMax, defaultExpectedRange.max ?? 10);

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        return (
          (probabilityThreshold == null || Math.abs(Number(row.probabilityMismatchPct ?? 0)) >= probabilityThreshold) &&
          (executionRiskThreshold == null || Number(row.executionRiskScore ?? Infinity) <= executionRiskThreshold) &&
          (exitLiquidityThreshold == null || Number(row.exitLiquidityScore ?? 0) >= exitLiquidityThreshold) &&
          (hedgeQualityThreshold == null || Number(row.hedgeQualityScore ?? 0) >= hedgeQualityThreshold) &&
          selectedSettlementTypes.includes(row.settlementType) &&
          selectedStrategyClasses.includes(row.strategyClass)
        );
      }),
    [
      executionRiskThreshold,
      exitLiquidityThreshold,
      hedgeQualityThreshold,
      probabilityThreshold,
      rows,
      selectedSettlementTypes,
      selectedStrategyClasses
    ]
  );

  const sortedRows = useMemo(
    () => [...filteredRows].sort((left, right) => compareRows(left, right, sortKey, sortDirection)),
    [filteredRows, sortDirection, sortKey]
  );

  useEffect(() => {
    if (!sortedRows.length) {
      setSelectedRowId(null);
      return;
    }

    const currentSelectionVisible = sortedRows.some((row) => row.id === selectedRowId);
    if (!currentSelectionVisible) {
      setSelectedRowId(sortedRows[0].id);
    }
  }, [selectedRowId, sortedRows]);

  const selectedRow = sortedRows.find((row) => row.id === selectedRowId) ?? null;
  const selectedRangeWindow = selectedRow ? computeRangeWindow(selectedRow.expectedRangeProfile, rangeMin, rangeMax) : null;
  const selectedScenarioOrder = useMemo(
    () => buildScenarioOrderFromScreeningRow(selectedRow, screenerPayload?.generatedAt),
    [screenerPayload?.generatedAt, selectedRow]
  );

  function toggleSettlementType(type) {
    setSelectedSettlementTypes((current) => {
      if (current.includes(type)) {
        return current.length === 1 ? current : current.filter((item) => item !== type);
      }

      return [...current, type];
    });
  }

  function toggleStrategyClass(strategyClass) {
    setSelectedStrategyClasses((current) => {
      if (current.includes(strategyClass)) {
        return current.length === 1 ? current : current.filter((item) => item !== strategyClass);
      }

      return [...current, strategyClass];
    });
  }

  function handleSort(columnKey) {
    if (sortKey === columnKey) {
      setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }

    setSortKey(columnKey);
    setSortDirection("desc");
  }

  function resetFilters() {
    setSelectedSettlementTypes(settlementTypes);
    setSelectedStrategyClasses(strategyClasses);
    setProbabilityMismatchMin("");
    setExecutionRiskMax("");
    setExitLiquidityMin("");
    setHedgeQualityMin(defaultHedgeQualityMin > 0 ? String(defaultHedgeQualityMin) : "");
    setExpectedRangeMin(String(defaultExpectedRange.min ?? 5));
    setExpectedRangeMax(String(defaultExpectedRange.max ?? 10));
  }

  if (!screenerPayload) {
    return <div className="app-state">No V2 screening data yet.</div>;
  }

  return (
    <main className="workspace workspace--screening-v2">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Strategy screening</span>
          <h2>Executable Edge Screener V2</h2>
          <p className="card-copy">
            Screen Polymarket mispricings against option-implied probability, then keep only executable hedges.
          </p>
        </div>

        <div className="screening-v2__actions">
          <button
            type="button"
            className="finder-action"
            disabled={!onManualRefresh || refreshing}
            onClick={() => onManualRefresh?.()}
          >
            {refreshing ? "Refreshing..." : "Refresh live data"}
          </button>
        </div>
      </header>

      {refreshNotice ? (
        <div className={`screening-v2__notice screening-v2__notice--${refreshNotice.tone ?? "info"}`}>
          {refreshNotice.message}
        </div>
      ) : null}

      {screenerPayload.warnings?.length ? (
        <div className="warning-strip">
          {screenerPayload.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}

      <section className="screening-v2__summary-grid">
        <article className="insight-card screening-v2__summary-card">
          <span className="brand__eyebrow">Ranked edges</span>
          <strong>{screenerPayload.summary?.executableEdges ?? 0}</strong>
          <p className="card-copy">Top-ranked live candidates after scoring edge, expected value, liquidity, execution cost, and hedge quality.</p>
        </article>

        <article className="insight-card screening-v2__summary-card">
          <span className="brand__eyebrow">Candidates generated</span>
          <strong>{screenerPayload.summary?.candidatesGenerated ?? 0}</strong>
          <p className="card-copy">Tradable candidates scored by V2 before the top-ranked set is returned to the screen.</p>
        </article>

        <article className="insight-card screening-v2__summary-card">
          <span className="brand__eyebrow">Capital guardrail</span>
          <strong>{formatCurrency(screenerPayload.summary?.capitalLimit)}</strong>
          <p className="card-copy">
            Only tradable quotes and max-loss-versus-capital remain hard gates. The screener then returns the top {screenerPayload.summary?.topLimit ?? rows.length} ranked setups.
          </p>
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
            <span>Probability mismatch min (optional)</span>
            <input
              type="number"
              step="0.5"
              value={probabilityMismatchMin}
              onChange={(event) => setProbabilityMismatchMin(event.target.value)}
            />
          </label>
          <label>
            <span>Execution risk max (optional)</span>
            <input
              type="number"
              step="0.5"
              placeholder={defaultExecutionRiskMax == null ? "none" : String(defaultExecutionRiskMax)}
              value={executionRiskMax}
              onChange={(event) => setExecutionRiskMax(event.target.value)}
            />
          </label>
          <label>
            <span>Exit liquidity min (optional)</span>
            <input
              type="number"
              step="1"
              placeholder={defaultExitLiquidityMin == null ? "none" : String(defaultExitLiquidityMin)}
              value={exitLiquidityMin}
              onChange={(event) => setExitLiquidityMin(event.target.value)}
            />
          </label>
          <label>
            <span>Hedge quality min (optional)</span>
            <input
              type="number"
              step="1"
              value={hedgeQualityMin}
              onChange={(event) => setHedgeQualityMin(event.target.value)}
            />
          </label>
          <label>
            <span>Expected range from (diagnostic)</span>
            <input
              type="number"
              step="1"
              value={expectedRangeMin}
              onChange={(event) => setExpectedRangeMin(event.target.value)}
            />
          </label>
          <label>
            <span>Expected range to (diagnostic)</span>
            <input
              type="number"
              step="1"
              value={expectedRangeMax}
              onChange={(event) => setExpectedRangeMax(event.target.value)}
            />
          </label>
        </div>

        <div className="screening-v2__pill-row">
          {strategyClasses.map((strategyClass) => (
            <button
              key={strategyClass}
              type="button"
              className={`chip ${selectedStrategyClasses.includes(strategyClass) ? "chip--active" : ""}`}
              onClick={() => toggleStrategyClass(strategyClass)}
            >
              {strategyClass}
            </button>
          ))}
        </div>

        <div className="screening-v2__pill-row">
          {settlementTypes.map((type) => (
            <button
              key={type}
              type="button"
              className={`chip ${selectedSettlementTypes.includes(type) ? "chip--active" : ""}`}
              onClick={() => toggleSettlementType(type)}
            >
              {type}
            </button>
          ))}
        </div>
      </section>

      <section className="insight-card screening-v2__table-card">
        <div className="section-heading">
          <span>Top-ranked strategies</span>
          <span className="pill pill--ghost">{sortedRows.length}</span>
        </div>

        {sortedRows.length ? (
          <div className="screening-v2__table-wrap">
            <table className="screening-v2__table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key}>
                      <button type="button" onClick={() => handleSort(column.key)}>
                        {column.label}
                        {sortKey === column.key ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.id === selectedRowId ? "screening-v2__table-row--active" : ""}
                    onClick={() => setSelectedRowId(row.id)}
                  >
                    <td>{row.compositeScore?.toFixed?.(2) ?? "n/a"}</td>
                    <td>
                      <strong>{row.strategyName}</strong>
                      <div className="screening-v2__subtle">{row.strategyClass}</div>
                    </td>
                    <td>{row.assetLabel}</td>
                    <td>{row.eventDate}</td>
                    <td>{formatPercent(row.polymarketProbability)}</td>
                    <td>{formatPercent(row.optionImpliedProbability)}</td>
                    <td className={Number(row.probabilityMismatchPct ?? 0) >= 0 ? "positive" : "negative"}>
                      {formatPercent(row.probabilityMismatchPct)}
                    </td>
                    <td>{formatCurrency(row.expectedValue)}</td>
                    <td>{row.executionRiskScore?.toFixed?.(2) ?? "n/a"}</td>
                    <td>{row.exitLiquidityScore?.toFixed?.(0) ?? "n/a"}</td>
                    <td>{row.hedgeQualityScore?.toFixed?.(0) ?? "n/a"}</td>
                    <td>{row.settlementType}</td>
                    <td>{row.failureReason ?? "ranked_edge"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="app-state app-state--inline">
            No ranked V2 strategies matched the current optional filters. Relax the execution or liquidity inputs to see more rows.
          </div>
        )}
      </section>

      {selectedRow ? (
        <section className="screening-v2__selected-layout">
          <article className="insight-card screening-v2__selected-top">
            <div className="screening-v2__selected-head">
              <div className="screening-v2__selected-copy">
                <h3>{selectedRow.strategyName}</h3>
                <p className="screening-v2__selected-question">{selectedRow.marketQuestion}</p>
                <div className="detail-badges">
                  <span className="pill pill--ghost">{selectedRow.assetLabel}</span>
                  {selectedRow.eventDate ? <span className="pill pill--ghost">{selectedRow.eventDate}</span> : null}
                  {selectedRow.optionRootSymbol ? (
                    <span className="pill pill--ghost">{selectedRow.optionRootSymbol}</span>
                  ) : null}
                  {selectedRow.settlementType ? (
                    <span className="pill pill--ghost">{selectedRow.settlementType}</span>
                  ) : null}
                  {selectedRow.exerciseStyle ? (
                    <span className="pill pill--live">{selectedRow.exerciseStyle}</span>
                  ) : null}
                </div>
              </div>

              <div className="detail-card__actions">
                {selectedRow.polymarketUrl ? (
                  <a href={selectedRow.polymarketUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
                    Open Polymarket
                  </a>
                ) : null}
              </div>
            </div>

            <div className="screening-v2__selected-grid">
              <section className="screening-v2__selected-panel">
                <h4>Strategy overview</h4>
                <div className="summary-stack">
                  <div className="summary-row">
                    <span>Composite score</span>
                    <strong>{selectedRow.compositeScore?.toFixed?.(2) ?? "n/a"}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Expected value</span>
                    <strong>{formatCurrency(selectedRow.expectedValue)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Scenario: event happens</span>
                    <strong className={Number(selectedRow.scenarioEventPnL ?? 0) >= 0 ? "positive" : "negative"}>
                      {formatCurrency(selectedRow.scenarioEventPnL)}
                    </strong>
                  </div>
                  <div className="summary-row">
                    <span>Scenario: event fails</span>
                    <strong className={Number(selectedRow.scenarioFailPnL ?? 0) >= 0 ? "positive" : "negative"}>
                      {formatCurrency(selectedRow.scenarioFailPnL)}
                    </strong>
                  </div>
                  <div className="summary-row">
                    <span>Expected-range payoff</span>
                    <strong className={Number(selectedRangeWindow?.min ?? 0) >= 0 ? "positive" : "negative"}>
                      {selectedRangeWindow
                        ? `${formatCurrency(selectedRangeWindow.min)} to ${formatCurrency(selectedRangeWindow.max)}`
                        : "n/a"}
                    </strong>
                  </div>
                  <div className="summary-row">
                    <span>Debug reason</span>
                    <strong>{selectedRow.failureReason ?? "ranked_edge"}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Max loss</span>
                    <strong>{formatCurrency(selectedRow.maxLossValue)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Capital exposure</span>
                    <strong>{formatCurrency(selectedRow.capitalExposure)}</strong>
                  </div>
                </div>
              </section>

              <section className="screening-v2__selected-panel screening-v2__selected-panel--contracts">
                <h4>Contract details</h4>
                <div className="screening-v2__contract-table-wrap">
                  <table className="screening-v2__contract-table">
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>Qty</th>
                        <th>Strike / market</th>
                        <th>Entry</th>
                        <th>Bid</th>
                        <th>Ask</th>
                        <th>Spread</th>
                        <th>Code / link</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedRow.polymarketLeg ? (
                        <tr>
                          <td>{selectedRow.polymarketLeg.side === "YES" ? "Long YES" : "Long NO"}</td>
                          <td>{selectedRow.polymarketLeg.quantity}</td>
                          <td>{selectedRow.marketQuestion}</td>
                          <td>{formatPercent(selectedRow.polymarketLeg.entryPrice * 100)}</td>
                          <td>{formatPercent(selectedRow.polymarketLeg.entryPrice * 100)}</td>
                          <td>{formatPercent(selectedRow.polymarketLeg.entryPrice * 100)}</td>
                          <td>0.00%</td>
                          <td>
                            {selectedRow.polymarketUrl ? (
                              <a href={selectedRow.polymarketUrl} target="_blank" rel="noreferrer">
                                Open Polymarket event
                              </a>
                            ) : (
                              <span>Polymarket hedge</span>
                            )}
                          </td>
                        </tr>
                      ) : null}

                      {selectedRow.optionLegs.map((leg) => (
                        <tr key={`${leg.contractSymbol}-${leg.action}-${leg.strike}`}>
                          <td>{leg.action}</td>
                          <td>{leg.quantity}</td>
                          <td>
                            {leg.strike}
                            {String(leg.optionType ?? "call").toUpperCase()} · {leg.expiration}
                          </td>
                          <td>{formatCurrency(leg.entryPrice * 100)}</td>
                          <td>{leg.bid != null ? formatCurrency(Number(leg.bid) * 100) : "n/a"}</td>
                          <td>{leg.ask != null ? formatCurrency(Number(leg.ask) * 100) : "n/a"}</td>
                          <td>{leg.spread != null ? formatPercent(leg.spread) : "n/a"}</td>
                          <td>
                            <div className="screening-v2__contract-link">
                              <strong>{leg.contractSymbol || `${leg.action} ${leg.optionType} ${leg.strike}`}</strong>
                              <span>{leg.quoteSource ?? "modeled"}</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </article>

          {selectedScenarioOrder ? (
            <PaperTradeScenarioPanel
              order={selectedScenarioOrder}
              lastUpdated={screenerPayload?.generatedAt}
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
