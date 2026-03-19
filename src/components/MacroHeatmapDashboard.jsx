import { useEffect, useRef, useState } from "react";
import TradingViewWidget from "./TradingViewWidget.jsx";
import { getMacroTileColors } from "../theme.js";

const DEFAULT_SECTION_HEIGHTS = {
  "global-markets": 1200,
  "etf-heatmap": 680,
  "money-and-reserves": 520,
  "debt-and-assets": 620
};
const DISPLAY_LOOKBACKS = ["1D", "1W", "1M", "6M", "1Y", "5Y", "ALL"];
const DISPLAY_LOOKBACK_TO_HEATMAP = {
  "1D": "24H",
  "1W": "7D",
  "1M": "30D",
  "6M": "180D",
  "1Y": "365D",
  "5Y": "MAX",
  ALL: "MAX"
};
const DISPLAY_LOOKBACK_TO_TV = {
  "1D": "1D",
  "1W": "1W",
  "1M": "1M",
  "6M": "6M",
  "1Y": "12M",
  "5Y": "60M",
  ALL: "ALL"
};
const LEGACY_LOOKBACK_TO_DISPLAY = {
  "24H": "1D",
  "7D": "1W",
  "30D": "1M",
  "180D": "6M",
  "365D": "1Y",
  MAX: "ALL"
};
const WATCHLIST_TRADINGVIEW_SYMBOLS = {
  SPX: "SPREADEX:SPX",
  RUT: "AMEX:IWM",
  US2K: "AMEX:IWM",
  DJI: "AMEX:DIA",
  QQQ: "NASDAQ:QQQ",
  SPY: "AMEX:SPY",
  VIX: "CAPITALCOM:VIX",
  VOO: "AMEX:VOO",
  EWU: "AMEX:EWU",
  VGK: "AMEX:VGK",
  GLD: "AMEX:GLD",
  USO: "AMEX:USO",
  TLT: "NASDAQ:TLT",
  "BTC-USD": "BINANCE:BTCUSDT",
  "ETH-USD": "BINANCE:ETHUSDT",
  FXE: "AMEX:FXE",
  FXB: "AMEX:FXB",
  UUP: "AMEX:UUP",
  SEA: "AMEX:SEA",
  IBIT: "NASDAQ:IBIT"
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getDefaultSectionHeight(sectionId) {
  return DEFAULT_SECTION_HEIGHTS[sectionId] ?? 520;
}

function cloneSectionLayout(layout) {
  return {
    order: [...(layout?.order ?? [])],
    heights: { ...(layout?.heights ?? {}) }
  };
}

function buildSectionLayout(sections, existingLayout) {
  const sectionIds = sections.map((section) => section.id);
  const existingOrder = Array.isArray(existingLayout?.order)
    ? existingLayout.order.filter((sectionId) => sectionIds.includes(sectionId))
    : [];
  const order = [
    ...existingOrder,
    ...sectionIds.filter((sectionId) => !existingOrder.includes(sectionId))
  ];
  const heights = Object.fromEntries(
    sectionIds.map((sectionId) => [
      sectionId,
      clamp(
        Number(existingLayout?.heights?.[sectionId] ?? getDefaultSectionHeight(sectionId)),
        420,
        1800
      )
    ])
  );

  return { order, heights };
}

function normalizeDisplayLookback(value, fallbackLookback = "1M") {
  if (DISPLAY_LOOKBACKS.includes(value)) {
    return value;
  }

  return LEGACY_LOOKBACK_TO_DISPLAY[value] ?? fallbackLookback;
}

function applyStoredLayout(storedLayout, sections, fallbackLookback) {
  return {
    layout: buildSectionLayout(sections, {
      order: storedLayout?.sectionOrder ?? storedLayout?.order ?? [],
      heights: storedLayout?.sectionHeights ?? storedLayout?.heights ?? {}
    }),
    lookback: normalizeDisplayLookback(storedLayout?.lookback, fallbackLookback)
  };
}

function reorderSectionIds(order, draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) {
    return order;
  }

  const nextOrder = order.filter((sectionId) => sectionId !== draggedId);
  const targetIndex = nextOrder.indexOf(targetId);

  if (targetIndex === -1) {
    return [...nextOrder, draggedId];
  }

  nextOrder.splice(targetIndex, 0, draggedId);
  return nextOrder;
}

function orderSections(sections, order) {
  const sectionsById = new Map(sections.map((section) => [section.id, section]));

  return order.map((sectionId) => sectionsById.get(sectionId)).filter(Boolean);
}

function formatCompactUsd(value) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  const absoluteValue = Math.abs(value);
  const units = [
    { threshold: 1e15, suffix: "Q" },
    { threshold: 1e12, suffix: "T" },
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "K" }
  ];

  for (const unit of units) {
    if (absoluteValue >= unit.threshold) {
      const scaled = value / unit.threshold;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `$${scaled.toFixed(digits)}${unit.suffix}`;
    }
  }

  return `$${value.toFixed(0)}`;
}

function formatFullUsd(value) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatFlowUsd(value) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${value >= 0 ? "+" : ""}${formatCompactUsd(value)}`;
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp);
}

function formatRelativeTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return "n/a";
  }

  const diffSeconds = Math.max(Math.round((Date.now() - timestamp.getTime()) / 1000), 0);

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  if (diffSeconds < 3600) {
    return `${Math.round(diffSeconds / 60)}m ago`;
  }

  if (diffSeconds < 86400) {
    return `${Math.round(diffSeconds / 3600)}h ago`;
  }

  return formatTimestamp(value);
}

function getStreamStateLabel(state) {
  switch (state) {
    case "live":
      return "Live";
    case "connecting":
      return "Connecting";
    case "retrying":
      return "Retrying";
    case "disconnected":
      return "Disconnected";
    default:
      return "Idle";
  }
}

function resolveWatchlistTradingViewSymbol(item) {
  return WATCHLIST_TRADINGVIEW_SYMBOLS[item.symbol] ?? item.symbol;
}

function splitBalanced(items, valueKey) {
  if (items.length <= 1) {
    return [items, []];
  }

  const total = items.reduce((sum, item) => sum + item[valueKey], 0);
  let running = 0;
  let bestIndex = 1;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (let index = 1; index < items.length; index += 1) {
    running += items[index - 1][valueKey];
    const diff = Math.abs(total - running * 2);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  }

  return [items.slice(0, bestIndex), items.slice(bestIndex)];
}

function buildBinaryTreemap(items, valueKey, x = 0, y = 0, width = 100, height = 100) {
  const filteredItems = items
    .filter((item) => Number.isFinite(item[valueKey]) && item[valueKey] > 0)
    .sort((left, right) => right[valueKey] - left[valueKey]);

  if (!filteredItems.length || width <= 0 || height <= 0) {
    return [];
  }

  if (filteredItems.length === 1) {
    return [{ ...filteredItems[0], x, y, width, height }];
  }

  const total = filteredItems.reduce((sum, item) => sum + item[valueKey], 0);
  const [primaryItems, secondaryItems] = splitBalanced(filteredItems, valueKey);
  const primaryTotal = primaryItems.reduce((sum, item) => sum + item[valueKey], 0);

  if (!secondaryItems.length || primaryTotal <= 0 || total <= 0) {
    return [{ ...filteredItems[0], x, y, width, height }];
  }

  if (width >= height) {
    const primaryWidth = (width * primaryTotal) / total;

    return [
      ...buildBinaryTreemap(primaryItems, valueKey, x, y, primaryWidth, height),
      ...buildBinaryTreemap(secondaryItems, valueKey, x + primaryWidth, y, width - primaryWidth, height)
    ];
  }

  const primaryHeight = (height * primaryTotal) / total;

  return [
    ...buildBinaryTreemap(primaryItems, valueKey, x, y, width, primaryHeight),
    ...buildBinaryTreemap(secondaryItems, valueKey, x, y + primaryHeight, width, height - primaryHeight)
  ];
}

function getTileColors(changePct, theme) {
  return getMacroTileColors(changePct, theme);
}

function getBoxStyle(layout, gapPx = 4) {
  return {
    left: `calc(${layout.x}% + ${gapPx}px)`,
    top: `calc(${layout.y}% + ${gapPx}px)`,
    width: `calc(${layout.width}% - ${gapPx * 2}px)`,
    height: `calc(${layout.height}% - ${gapPx * 2}px)`
  };
}

function getTileDensity(layout) {
  if (layout.width > 22 && layout.height > 22) {
    return "large";
  }

  if (layout.width > 12 && layout.height > 12) {
    return "medium";
  }

  if (layout.width > 7 && layout.height > 7) {
    return "small";
  }

  return "tiny";
}

function abbreviateLabel(label) {
  const parts = label.split(/[\s/()-]+/).filter(Boolean);

  if (parts.length <= 1) {
    return label.slice(0, 6).toUpperCase();
  }

  return parts
    .slice(0, 4)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function buildSparklineGeometry(values, width = 180, height = 72, padding = 4) {
  if (!Array.isArray(values) || values.length < 2) {
    return null;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue;
  const toX = (index) => padding + (index / (values.length - 1)) * (width - padding * 2);
  const toY = (value) =>
    range === 0 ? height / 2 : padding + (1 - (value - minValue) / range) * (height - padding * 2);
  const points = values.map((value, index) => ({ x: toX(index), y: toY(value) }));
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");

  return {
    linePath,
    referenceY: toY(values[0]),
    firstPoint: points[0],
    lastPoint: points[points.length - 1],
    guideTopY: padding + (height - padding * 2) * 0.22,
    guideMidY: padding + (height - padding * 2) * 0.5,
    guideBottomY: padding + (height - padding * 2) * 0.78
  };
}

function TileSparkline({ tile, lookback, colors }) {
  const sparkline = tile.sparklines?.[lookback];
  const geometry = buildSparklineGeometry(sparkline);

  if (!geometry) {
    return null;
  }

  return (
    <svg viewBox="0 0 180 72" preserveAspectRatio="none" aria-hidden="true">
      <line
        x1="4"
        y1={geometry.guideTopY}
        x2="176"
        y2={geometry.guideTopY}
        stroke={colors.baseline}
        strokeOpacity="0.18"
        strokeWidth="1"
      />
      <line
        x1={geometry.firstPoint.x}
        y1={geometry.guideMidY}
        x2={geometry.lastPoint.x}
        y2={geometry.guideMidY}
        stroke={colors.baseline}
        strokeDasharray="4 4"
        strokeWidth="1"
      />
      <line
        x1="4"
        y1={geometry.guideBottomY}
        x2="176"
        y2={geometry.guideBottomY}
        stroke={colors.baseline}
        strokeOpacity="0.12"
        strokeWidth="1"
      />
      <path
        d={geometry.linePath}
        fill="none"
        stroke={colors.line}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function getTileTypography(layout, density, label) {
  const minDimension = Math.min(layout.width, layout.height);
  const area = layout.width * layout.height;
  const areaScale = clamp(Math.sqrt(area) / 18, 0.72, 1.32);
  const dimensionScale = clamp(minDimension / 18, 0.76, 1.36);
  const labelPenalty = clamp(Math.sqrt(Math.max(label.length, 8) / 12), 0.94, 1.55);
  const combinedScale = areaScale * dimensionScale;

  if (density === "large") {
    return {
      labelSize: clamp((18 * combinedScale) / labelPenalty, 14, 31),
      changeSize: clamp(13 * dimensionScale, 11, 18),
      valueSize: clamp((40 * combinedScale) / clamp(Math.sqrt(label.length / 10), 1, 1.28), 28, 56)
    };
  }

  if (density === "medium") {
    return {
      labelSize: clamp((15 * combinedScale) / labelPenalty, 11, 22),
      changeSize: clamp(11.5 * dimensionScale, 9, 15),
      valueSize: clamp((28 * combinedScale) / clamp(Math.sqrt(label.length / 11), 1, 1.22), 18, 36)
    };
  }

  if (density === "small") {
    return {
      labelSize: clamp((11.5 * combinedScale) / labelPenalty, 8, 15),
      changeSize: clamp(9 * dimensionScale, 7, 11),
      valueSize: clamp((16 * combinedScale) / clamp(Math.sqrt(label.length / 11), 1, 1.18), 11, 18)
    };
  }

  return {
    labelSize: clamp((9 * combinedScale) / labelPenalty, 7, 11),
    changeSize: 0,
    valueSize: 0
  };
}

function HeatmapTile({ tile, layout, lookback }) {
  const density = getTileDensity(layout);
  const colors = getTileColors(tile.changePct);
  const tileLabel =
    density === "tiny" || (density === "small" && tile.label.length > 16) ? abbreviateLabel(tile.label) : tile.label;
  const typeScale = getTileTypography(layout, density, tile.label);
  const showValue = density !== "tiny";
  const showPercent = density !== "tiny";

  return (
    <article
      className={`macro-tile macro-tile--${density}`}
      style={{
        ...getBoxStyle(layout, density === "tiny" ? 1 : density === "small" ? 2 : 3),
        background: colors.background,
        borderColor: colors.stroke,
        color: colors.text
      }}
      title={`${tile.label}\n${formatFullUsd(tile.valueUsd)}\n${formatPercent(tile.changePct)}\n${tile.detail}\nSparkline ${lookback}`}
    >
      <div className="macro-tile__top">
        <strong style={{ fontSize: `${typeScale.labelSize}px` }}>{tileLabel}</strong>
        {showPercent ? (
          <span
            className={`macro-tile__change ${tile.changePct >= 0 ? "positive" : "negative"}`}
            style={{ fontSize: `${typeScale.changeSize}px` }}
          >
            {formatPercent(tile.changePct)}
          </span>
        ) : null}
      </div>
      <div className={`macro-tile__spark macro-tile__spark--${density}`}>
        <TileSparkline tile={tile} lookback={lookback} colors={colors} />
      </div>
      {showValue ? (
        <div className={`macro-tile__value macro-tile__value--${density}`} style={{ fontSize: `${typeScale.valueSize}px` }}>
          {formatCompactUsd(tile.valueUsd)}
        </div>
      ) : null}
    </article>
  );
}

function HeatmapGroup({ group, layout, lookback }) {
  const tileLayouts = buildBinaryTreemap(group.tiles, "valueUsd");

  return (
    <section
      className="macro-group-block"
      style={getBoxStyle(layout, 6)}
      title={`${group.title}\n${formatFullUsd(group.totalValueUsd)}\n${formatPercent(group.weightedChangePct)}`}
    >
      <header className="macro-group-block__header">
        <span>{group.title}</span>
        <div className="macro-group-block__summary">
          <strong>{formatCompactUsd(group.totalValueUsd)}</strong>
          <span className={group.weightedChangePct >= 0 ? "positive" : "negative"}>
            {formatPercent(group.weightedChangePct)}
          </span>
        </div>
      </header>

      <div className="macro-group-block__body">
        {tileLayouts.map((tile) => (
          <HeatmapTile key={tile.id} tile={tile} layout={tile} lookback={lookback} />
        ))}
      </div>
    </section>
  );
}

function HeatmapSurface({ section, lookback, surfaceHeight }) {
  const groupLayouts = buildBinaryTreemap(section.groups, "totalValueUsd");

  return (
    <div className="macro-surface" style={{ height: `${surfaceHeight}px` }}>
      {groupLayouts.map((group) => (
        <HeatmapGroup key={group.id} group={group} layout={group} lookback={lookback} />
      ))}
    </div>
  );
}

function FlowColumn({ title, accentClass, items }) {
  return (
    <article className="macro-flow-card">
      <div className="section-heading">
        <span>{title}</span>
        <span className={`pill ${accentClass}`}>{items.length} tiles</span>
      </div>
      <div className="macro-flow-list">
        {items.map((item) => (
          <div key={item.id} className="macro-flow-row">
            <div>
              <strong>{item.label}</strong>
              <span>
                {item.groupTitle} / {item.sectionTitle}
              </span>
            </div>
            <div className="macro-flow-row__value">
              <strong className={item.changeUsd >= 0 ? "positive" : "negative"}>{formatFlowUsd(item.changeUsd)}</strong>
              <span className={item.changePct >= 0 ? "positive" : "negative"}>{formatPercent(item.changePct)}</span>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function LiveWatchlistSection({ items, timeframe, theme }) {
  if (!items.length) {
    return null;
  }

  return (
    <section className="macro-watchlist">
      <div className="section-heading">
        <span>Live watchlist</span>
        <span className="pill pill--ghost">{items.length} instruments</span>
      </div>

      <div className="macro-watchlist__grid">
        {items.map((item) => {
          const colors = getTileColors(item.changePercent, theme);
          const tradingViewSymbol = resolveWatchlistTradingViewSymbol(item);
          const dateRange = DISPLAY_LOOKBACK_TO_TV[timeframe] ?? "1M";

          return (
            <article
              key={`${item.symbol}-${item.label}`}
              className="macro-tile macro-tile--large macro-watchlist-tile"
              style={{
                background: colors.background,
                borderColor: colors.stroke,
                color: colors.text
              }}
              title={`${item.symbol}\n${item.label}\n${formatPercent(item.changePercent)}`}
            >
              <div className="macro-watchlist-tile__eyebrow">
                <span>{item.group}</span>
                <span>{item.symbol}</span>
              </div>

              <div className="macro-tile__spark macro-tile__spark--large">
                <TradingViewWidget
                  bare
                  type="mini-chart"
                  scriptName="mini-symbol-overview"
                  theme={theme}
                  config={{
                    symbol: tradingViewSymbol,
                    width: "100%",
                    height: "100%",
                    locale: "en",
                    dateRange,
                    colorTheme: "dark",
                    isTransparent: false,
                    autosize: true,
                    largeChartUrl: "",
                    chartOnly: false,
                    noTimeScale: true,
                    trendLineColor: colors.line,
                    underLineColor: colors.baseline,
                    underLineBottomColor: "rgba(0, 0, 0, 0)"
                  }}
                  containerClassName="macro-watchlist-tile__chart"
                />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DashboardLayoutBar({
  editMode,
  dashboardActionLoading,
  onEnterEditMode,
  onSaveDashboard,
  onCancelEditMode,
  onToggleLoadPanel,
  loadPanelOpen,
  savedDashboards,
  onLoadDashboard,
  loadedDashboard,
  dashboardActionError,
  streamDiagnostics
}) {
  const optionDiagnostics = streamDiagnostics?.options ?? null;
  const polymarketDiagnostics = streamDiagnostics?.polymarket ?? null;
  const optionState = optionDiagnostics?.state ?? "idle";
  const trackedContracts = Number(optionDiagnostics?.trackedContracts ?? 0);
  const subscribedContracts = Number(optionDiagnostics?.subscribedContracts ?? 0);
  const refreshEverySeconds = Number(polymarketDiagnostics?.refreshEverySeconds ?? 0);

  return (
    <div className="macro-dashboard-bar">
      <div className="macro-dashboard-bar__header">
        <div>
          <span className="brand__eyebrow">Dashboard layout</span>
          <p className="card-copy">Use edit mode to drag sections and resize them from the lower-right handles.</p>
        </div>

        <div className="macro-layout-diagnostics" aria-label="Live data diagnostics">
          <div className="macro-layout-diagnostics__row">
            <span className="macro-layout-diagnostics__label">Options</span>
            <span className={`macro-layout-diagnostics__state macro-layout-diagnostics__state--${optionState}`}>
              {getStreamStateLabel(optionState)}
            </span>
            <span>{trackedContracts} tracked</span>
            <span>{subscribedContracts} subscribed</span>
            <span>
              {optionDiagnostics?.lastQuoteAt
                ? `Last tick ${formatRelativeTimestamp(optionDiagnostics.lastQuoteAt)}`
                : trackedContracts > 0
                  ? "Awaiting tick"
                  : "No open option legs"}
            </span>
          </div>
          <div className="macro-layout-diagnostics__row">
            <span className="macro-layout-diagnostics__label">Polymarket</span>
            <span className="macro-layout-diagnostics__state macro-layout-diagnostics__state--polling">
              {refreshEverySeconds > 0 ? `${Math.round(refreshEverySeconds / 60)}m poll` : "Polling"}
            </span>
            <span>
              {polymarketDiagnostics?.lastRefreshAt
                ? `Last refresh ${formatRelativeTimestamp(polymarketDiagnostics.lastRefreshAt)}`
                : "Waiting for refresh"}
            </span>
          </div>
        </div>

        <div className="macro-dashboard-bar__actions">
          <div className="macro-layout-toolbar">
            {!editMode ? (
              <button type="button" className="macro-layout-button" onClick={onEnterEditMode}>
                Edit mode
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="macro-layout-button macro-layout-button--primary"
                  onClick={onSaveDashboard}
                  disabled={dashboardActionLoading}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="macro-layout-button"
                  onClick={onCancelEditMode}
                  disabled={dashboardActionLoading}
                >
                  Cancel
                </button>
              </>
            )}

            <button
              type="button"
              className="macro-layout-button"
              onClick={onToggleLoadPanel}
              disabled={dashboardActionLoading}
            >
              Load
            </button>
          </div>

          {loadedDashboard?.name ? <div className="macro-layout-active">Loaded dashboard: {loadedDashboard.name}</div> : null}
        </div>
      </div>

      {loadPanelOpen ? (
        <div className="macro-load-panel">
          <div className="macro-load-panel__header">
            <strong>Saved dashboards</strong>
            <span>{savedDashboards.length} preset{savedDashboards.length === 1 ? "" : "s"}</span>
          </div>

          {savedDashboards.length ? (
            <div className="macro-load-panel__list">
              {savedDashboards.map((dashboard) => (
                <button
                  key={dashboard.id}
                  type="button"
                  className="macro-load-panel__item"
                  onClick={() => onLoadDashboard(dashboard.id)}
                >
                  <strong>{dashboard.name}</strong>
                  <span>{formatTimestamp(dashboard.updatedAt)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="macro-load-panel__empty">No saved dashboards yet. Saved presets will appear here.</div>
          )}
        </div>
      ) : null}

      {dashboardActionError ? <div className="macro-layout-error">{dashboardActionError}</div> : null}
    </div>
  );
}

function AtlasControlsCard({
  totalValueUsd,
  lookbacks,
  selectedLookback,
  onSelectLookback,
  refreshedAt,
  nextRefreshAt
}) {
  return (
    <article className="macro-flow-card macro-flow-card--controls">
      <div className="macro-controls-stack">
        <div className="macro-atlas__total macro-atlas__total--card">
          <span>Gross tracked value</span>
          <strong>{formatCompactUsd(totalValueUsd)}</strong>
          <small>All tracked markets, money, debt, and balance-sheet pools</small>
        </div>

        <LookbackSelector
          lookbacks={lookbacks}
          selectedLookback={selectedLookback}
          onChange={onSelectLookback}
        />

        <div className="macro-atlas__legend macro-atlas__legend--compact">
          <span>Last refresh = {formatTimestamp(refreshedAt)}</span>
          <span>Next refresh = {formatTimestamp(nextRefreshAt)}</span>
        </div>
      </div>
    </article>
  );
}

function HeatmapSection({
  section,
  lookback,
  surfaceHeight,
  editMode,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onResizeStart
}) {
  return (
    <section
      className={`macro-section-shell ${editMode ? "macro-section-shell--editing" : ""} ${isDragging ? "macro-section-shell--dragging" : ""} ${isDropTarget ? "macro-section-shell--target" : ""}`}
      draggable={editMode}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {editMode ? (
        <div className="macro-section-shell__toolbar">
          <span>Drag to reorder</span>
          <span>{surfaceHeight}px high</span>
        </div>
      ) : null}

      <article className="macro-heatmap-card">
        <div className="macro-heatmap-card__header">
          <div>
            <h3>{section.title}</h3>
          </div>
          <div className="macro-heatmap-card__totals">
            <div>
              <span>Section total</span>
              <strong className="macro-heatmap-card__total-value">{formatCompactUsd(section.totalValueUsd)}</strong>
            </div>
            <div>
              <span>Weighted change</span>
              <strong className={section.weightedChangePct >= 0 ? "positive" : "negative"}>
                {formatPercent(section.weightedChangePct)}
              </strong>
            </div>
          </div>
        </div>
        <HeatmapSurface section={section} lookback={lookback} surfaceHeight={surfaceHeight} />
      </article>

      {editMode ? (
        <button
          type="button"
          className="macro-section-shell__resize"
          onPointerDown={(event) => onResizeStart(section.id, event)}
          aria-label={`Resize ${section.title}`}
          title={`Resize ${section.title}`}
        >
          resize
        </button>
      ) : null}
    </section>
  );
}

function LookbackSelector({ lookbacks, selectedLookback, onChange, disabled = false }) {
  return (
    <div className="macro-lookback">
      <span className="macro-lookback__label">Mini-chart range</span>
      <div className="macro-lookback__buttons">
        {lookbacks.map((lookback) => (
          <button
            key={lookback}
            type="button"
            className={`macro-lookback__button ${lookback === selectedLookback ? "macro-lookback__button--active" : ""}`}
            onClick={() => onChange(lookback)}
            disabled={disabled}
          >
            {lookback}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MacroHeatmapDashboard({
  macroDashboard,
  watchlist = [],
  streamDiagnostics = null,
  theme = "dark"
}) {
  const sections = macroDashboard?.sections ?? [];
  const liveWatchlist = Array.isArray(watchlist) ? watchlist : [];
  const lookbacks = DISPLAY_LOOKBACKS;
  const defaultLookback = normalizeDisplayLookback(macroDashboard?.defaultLookback ?? "30D", "1M");
  const [selectedLookback, setSelectedLookback] = useState(defaultLookback);
  const [sectionLayout, setSectionLayout] = useState(() => buildSectionLayout(sections, null));
  const [savedSnapshot, setSavedSnapshot] = useState(() => ({
    layout: buildSectionLayout(sections, null),
    lookback: defaultLookback
  }));
  const [editMode, setEditMode] = useState(false);
  const [draggedSectionId, setDraggedSectionId] = useState("");
  const [dropTargetSectionId, setDropTargetSectionId] = useState("");
  const [savedDashboards, setSavedDashboards] = useState([]);
  const [loadPanelOpen, setLoadPanelOpen] = useState(false);
  const [dashboardActionLoading, setDashboardActionLoading] = useState(false);
  const [dashboardActionError, setDashboardActionError] = useState("");
  const [loadedDashboard, setLoadedDashboard] = useState(null);
  const [streamStatus, setStreamStatus] = useState(streamDiagnostics);
  const resizeStateRef = useRef(null);

  useEffect(() => {
    if (!macroDashboard) {
      return;
    }

    setSectionLayout((currentLayout) => buildSectionLayout(macroDashboard.sections, currentLayout));
    setSavedSnapshot((currentSnapshot) => ({
      layout: buildSectionLayout(macroDashboard.sections, currentSnapshot?.layout),
      lookback: normalizeDisplayLookback(currentSnapshot?.lookback, defaultLookback)
    }));
    setSelectedLookback((currentLookback) => normalizeDisplayLookback(currentLookback, defaultLookback));
  }, [macroDashboard]);

  useEffect(() => {
    setStreamStatus(streamDiagnostics);
  }, [streamDiagnostics]);

  useEffect(() => {
    let isActive = true;

    async function loadStreamStatus() {
      try {
        const response = await fetch("/api/stream-status");

        if (!response.ok) {
          throw new Error(`Diagnostics request failed with ${response.status}`);
        }

        const payload = await response.json();
        if (isActive) {
          setStreamStatus(payload);
        }
      } catch (_error) {
        // Keep the last known diagnostics visible if the lightweight status call fails.
      }
    }

    loadStreamStatus();
    const interval = window.setInterval(loadStreamStatus, 15_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, []);

  if (!macroDashboard) {
    return null;
  }

  const orderedSections = orderSections(macroDashboard.sections, sectionLayout.order);

  async function refreshSavedDashboards() {
    const response = await fetch("/api/dashboards");

    if (!response.ok) {
      throw new Error("Failed to list dashboards");
    }

    const payload = await response.json();
    setSavedDashboards(payload.dashboards ?? []);
  }

  async function handleToggleLoadPanel() {
    const nextOpen = !loadPanelOpen;
    setLoadPanelOpen(nextOpen);
    setDashboardActionError("");

    if (!nextOpen) {
      return;
    }

    setDashboardActionLoading(true);

    try {
      await refreshSavedDashboards();
    } catch (error) {
      setDashboardActionError(error.message);
    } finally {
      setDashboardActionLoading(false);
    }
  }

  function handleEnterEditMode() {
    setEditMode(true);
    setLoadPanelOpen(false);
    setDashboardActionError("");
  }

  function handleCancelEditMode() {
    setSectionLayout(cloneSectionLayout(savedSnapshot.layout));
    setSelectedLookback(savedSnapshot.lookback);
    setEditMode(false);
    setDraggedSectionId("");
    setDropTargetSectionId("");
    setDashboardActionError("");
  }

  async function handleSaveDashboard() {
    const requestedName = window.prompt("Dashboard name", loadedDashboard?.name ?? "Macro Atlas");

    if (!requestedName || !requestedName.trim()) {
      return;
    }

    setDashboardActionLoading(true);
    setDashboardActionError("");

    try {
      const response = await fetch("/api/dashboards", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: requestedName.trim(),
          layout: {
            lookback: selectedLookback,
            sectionOrder: sectionLayout.order,
            sectionHeights: sectionLayout.heights
          }
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to save dashboard");
      }

      setLoadedDashboard(payload.dashboard);
      setSavedSnapshot({
        layout: cloneSectionLayout(sectionLayout),
        lookback: selectedLookback
      });
      setEditMode(false);
      setLoadPanelOpen(false);
      await refreshSavedDashboards();
    } catch (error) {
      setDashboardActionError(error.message);
    } finally {
      setDashboardActionLoading(false);
    }
  }

  async function handleLoadDashboard(dashboardId) {
    setDashboardActionLoading(true);
    setDashboardActionError("");

    try {
      const response = await fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load dashboard");
      }

      const nextSnapshot = applyStoredLayout(payload.dashboard.layout, macroDashboard.sections, defaultLookback);

      setSectionLayout(nextSnapshot.layout);
      setSavedSnapshot(nextSnapshot);
      setSelectedLookback(nextSnapshot.lookback);
      setLoadedDashboard(payload.dashboard);
      setEditMode(false);
      setLoadPanelOpen(false);
      setDraggedSectionId("");
      setDropTargetSectionId("");
    } catch (error) {
      setDashboardActionError(error.message);
    } finally {
      setDashboardActionLoading(false);
    }
  }

  function handleResizeStart(sectionId, event) {
    if (!editMode) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = sectionLayout.heights[sectionId] ?? getDefaultSectionHeight(sectionId);
    resizeStateRef.current = { sectionId, startY, startHeight };

    function handlePointerMove(moveEvent) {
      const resizeState = resizeStateRef.current;

      if (!resizeState || resizeState.sectionId !== sectionId) {
        return;
      }

      const nextHeight = clamp(Math.round(resizeState.startHeight + (moveEvent.clientY - resizeState.startY)), 420, 1800);
      setSectionLayout((currentLayout) => ({
        ...currentLayout,
        heights: {
          ...currentLayout.heights,
          [sectionId]: nextHeight
        }
      }));
    }

    function handlePointerUp() {
      resizeStateRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  return (
    <section className="macro-atlas">
      <DashboardLayoutBar
        editMode={editMode}
        dashboardActionLoading={dashboardActionLoading}
        onEnterEditMode={handleEnterEditMode}
        onSaveDashboard={handleSaveDashboard}
        onCancelEditMode={handleCancelEditMode}
        onToggleLoadPanel={handleToggleLoadPanel}
        loadPanelOpen={loadPanelOpen}
        savedDashboards={savedDashboards}
        onLoadDashboard={handleLoadDashboard}
        loadedDashboard={loadedDashboard}
        dashboardActionError={dashboardActionError}
        streamDiagnostics={streamStatus}
      />

      <div className="macro-flow-grid">
        <article className="macro-flow-card macro-flow-card--summary">
          <div className="section-heading">
            <span>Flow pulse</span>
            <span className="pill pill--ghost">gross proxy</span>
          </div>
          <div className="macro-pulse">
            <div>
              <span>Net tracked change</span>
              <strong className={macroDashboard.flowSummary.netChangeUsd >= 0 ? "positive" : "negative"}>
                {formatFlowUsd(macroDashboard.flowSummary.netChangeUsd)}
              </strong>
            </div>
            <div>
              <span>Gross expansion</span>
              <strong className="positive">{formatFlowUsd(macroDashboard.flowSummary.positiveChangeUsd)}</strong>
            </div>
            <div>
              <span>Gross contraction</span>
              <strong className="negative">{formatFlowUsd(macroDashboard.flowSummary.negativeChangeUsd)}</strong>
            </div>
          </div>
        </article>

        <FlowColumn
          title="Largest inflows"
          accentClass="pill--live"
          items={macroDashboard.flowSummary.largestInflows}
        />

        <FlowColumn
          title="Largest outflows"
          accentClass="pill--ghost"
          items={macroDashboard.flowSummary.largestOutflows}
        />

        <AtlasControlsCard
          totalValueUsd={macroDashboard.totals.grossTrackedValueUsd}
          lookbacks={lookbacks}
          selectedLookback={selectedLookback}
          onSelectLookback={setSelectedLookback}
          refreshedAt={macroDashboard.refreshedAt}
          nextRefreshAt={macroDashboard.nextRefreshAt}
        />
      </div>

      <LiveWatchlistSection items={liveWatchlist} timeframe={selectedLookback} theme={theme} />

      <div className="macro-heatmap-stack">
        {orderedSections.map((section) => {
          const surfaceHeight = sectionLayout.heights[section.id] ?? getDefaultSectionHeight(section.id);

          return (
            <HeatmapSection
              key={section.id}
              section={section}
              lookback={DISPLAY_LOOKBACK_TO_HEATMAP[selectedLookback] ?? "30D"}
              surfaceHeight={surfaceHeight}
              editMode={editMode}
              isDragging={draggedSectionId === section.id}
              isDropTarget={dropTargetSectionId === section.id && draggedSectionId !== section.id}
              onDragStart={(event) => {
                if (!editMode) {
                  return;
                }

                setDraggedSectionId(section.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", section.id);
              }}
              onDragEnd={() => {
                setDraggedSectionId("");
                setDropTargetSectionId("");
              }}
              onDragOver={(event) => {
                if (!editMode || !draggedSectionId || draggedSectionId === section.id) {
                  return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTargetSectionId(section.id);
              }}
              onDrop={(event) => {
                if (!editMode) {
                  return;
                }

                event.preventDefault();
                const transferredSectionId = event.dataTransfer.getData("text/plain");
                const sourceSectionId = draggedSectionId || transferredSectionId;

                if (!sourceSectionId || sourceSectionId === section.id) {
                  setDraggedSectionId("");
                  setDropTargetSectionId("");
                  return;
                }

                setSectionLayout((currentLayout) => ({
                  ...currentLayout,
                  order: reorderSectionIds(currentLayout.order, sourceSectionId, section.id)
                }));
                setDraggedSectionId("");
                setDropTargetSectionId("");
              }}
              onResizeStart={handleResizeStart}
            />
          );
        })}
      </div>
    </section>
  );
}
