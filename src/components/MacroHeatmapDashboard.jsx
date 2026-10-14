import { useEffect, useId, useMemo, useRef, useState } from "react";
import { getMacroTileColors } from "../theme.js";

const DEFAULT_SECTION_HEIGHTS = {
  "global-markets": 1400,
  "etf-heatmap": 680,
  "money-and-reserves": 520,
  "debt-and-assets": 620
};
const DISPLAY_LOOKBACKS = ["1D", "1W", "1M", "6M", "1Y", "2Y", "5Y"];
const DISPLAY_LOOKBACK_DAYS = { "1D": 1, "1W": 7, "1M": 30, "6M": 180, "1Y": 365, "2Y": 730, "5Y": 1825 };
const DISPLAY_LOOKBACK_TO_HEATMAP = {
  "1D": "24H",
  "1W": "7D",
  "1M": "30D",
  "6M": "180D",
  "1Y": "365D",
  "2Y": "730D",
  "5Y": "MAX"
};
const LEGACY_LOOKBACK_TO_DISPLAY = {
  "24H": "1D",
  "7D": "1W",
  "30D": "1M",
  "180D": "6M",
  "365D": "1Y",
  "730D": "2Y",
  MAX: "5Y",
  ALL: "5Y"
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

function formatShortUsd(value) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  const sign = value < 0 ? "-" : "";
  const absoluteValue = Math.abs(value);

  if (absoluteValue >= 1e12) {
    return `${sign}$${(absoluteValue / 1e12).toFixed(2)}T`;
  }

  if (absoluteValue >= 1e9) {
    return `${sign}$${Math.round(absoluteValue / 1e9)}B`;
  }

  if (absoluteValue >= 1e6) {
    return `${sign}$${Math.round(absoluteValue / 1e6)}M`;
  }

  return `${sign}$${Math.round(absoluteValue).toLocaleString("en-GB")}`;
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

function round(value) {
  return Number(Number(value).toFixed(2));
}

function getTileLookbackChange(tile, lookback) {
  const sparkline = tile?.sparklines?.[lookback];

  if (!Array.isArray(sparkline) || sparkline.length < 2) {
    return {
      changeUsd: tile?.changeUsd ?? 0,
      changePct: tile?.changePct ?? 0
    };
  }

  const startValue = sparkline[0];
  const endValue = sparkline[sparkline.length - 1];

  if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue === 0) {
    return {
      changeUsd: tile?.changeUsd ?? 0,
      changePct: tile?.changePct ?? 0
    };
  }

  const changeUsd = endValue - startValue;
  const changePct = (changeUsd / startValue) * 100;

  return {
    changeUsd: round(changeUsd),
    changePct: round(changePct)
  };
}

function summarizeTiles(tiles) {
  const totalValueUsd = tiles.reduce((sum, tile) => sum + (tile?.valueUsd ?? 0), 0);
  const weightedChangePct =
    totalValueUsd > 0
      ? tiles.reduce((sum, tile) => sum + (tile?.valueUsd ?? 0) * (tile?.changePct ?? 0), 0) / totalValueUsd
      : 0;

  return {
    totalValueUsd,
    weightedChangePct: round(weightedChangePct)
  };
}

function buildMacroDashboardLookbackView(macroDashboard, lookback) {
  if (!macroDashboard) {
    return null;
  }

  const sections = (macroDashboard.sections ?? []).map((section) => {
    const groups = (section.groups ?? []).map((group) => {
      const tiles = (group.tiles ?? []).map((tile) => {
        const change = getTileLookbackChange(tile, lookback);

        return {
          ...tile,
          changeUsd: change.changeUsd,
          changePct: change.changePct
        };
      });
      const groupSummary = summarizeTiles(tiles);

      return {
        ...group,
        tiles,
        totalValueUsd: groupSummary.totalValueUsd,
        weightedChangePct: groupSummary.weightedChangePct
      };
    });

    const sectionTiles = groups.flatMap((group) => group.tiles ?? []);
    const sectionSummary = summarizeTiles(sectionTiles);

    return {
      ...section,
      groups,
      totalValueUsd: sectionSummary.totalValueUsd,
      weightedChangePct: sectionSummary.weightedChangePct
    };
  });

  const flowTiles = sections.flatMap((section) =>
    (section.groups ?? []).flatMap((group) =>
      (group.tiles ?? []).map((tile) => ({
        id: tile.id,
        label: tile.label,
        groupTitle: group.title,
        sectionTitle: section.title,
        changeUsd: tile.changeUsd,
        changePct: tile.changePct
      }))
    )
  );

  const positiveChangeUsd = flowTiles.reduce((sum, tile) => sum + Math.max(tile.changeUsd ?? 0, 0), 0);
  const negativeChangeUsd = flowTiles.reduce((sum, tile) => sum + Math.min(tile.changeUsd ?? 0, 0), 0);

  const flowSummary = {
    positiveChangeUsd: round(positiveChangeUsd),
    negativeChangeUsd: round(negativeChangeUsd),
    netChangeUsd: round(positiveChangeUsd + negativeChangeUsd),
    largestInflows: [...flowTiles].sort((left, right) => (right.changeUsd ?? 0) - (left.changeUsd ?? 0)).slice(0, 5),
    largestOutflows: [...flowTiles].sort((left, right) => (left.changeUsd ?? 0) - (right.changeUsd ?? 0)).slice(0, 5)
  };

  return {
    ...macroDashboard,
    sections,
    flowSummary
  };
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

function getTileTypography(valueText) {
  const valueChars = Math.max(valueText.length, 4);

  return {
    labelSize: "clamp(9px, min(12cqh, 13cqw), 24px)",
    changeSize: "clamp(8px, min(9cqh, 9cqw), 16px)",
    valueSize: `clamp(10px, min(${(88 / (0.6 * valueChars)).toFixed(1)}cqw, 36cqh), 60px)`
  };
}

function HeatmapTile({ tile, layout, lookback, theme, onSelect }) {
  const density = getTileDensity(layout);
  const colors = getTileColors(tile.changePct, theme);
  const tileLabel =
    density === "tiny" || (density === "small" && tile.label.length > 16) ? abbreviateLabel(tile.label) : tile.label;
  const valueText = formatCompactUsd(tile.valueUsd);
  const typeScale = getTileTypography(valueText);
  const showPercent = density !== "tiny";

  return (
    <article
      className={`macro-tile macro-tile--${density}`}
      role="button"
      tabIndex={0}
      aria-label={`${tile.label} chart`}
      onClick={() => onSelect?.(tile)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.(tile);
        }
      }}
      style={{
        ...getBoxStyle(layout, density === "tiny" ? 1 : density === "small" ? 2 : 3),
        background: colors.background,
        borderColor: colors.stroke,
        color: colors.text
      }}
      title={`${tile.label}\n${formatFullUsd(tile.valueUsd)}\n${formatPercent(tile.changePct)}\n${tile.detail}\n${lookback}: ${formatPercent(getTileLookbackChange(tile, lookback).changePct)}`}
    >
      <div className="macro-tile__top">
        <strong style={{ fontSize: typeScale.labelSize }}>{tileLabel}</strong>
        {showPercent ? (
          <span
            className={`macro-tile__change ${tile.changePct >= 0 ? "positive" : "negative"}`}
            style={{ fontSize: typeScale.changeSize }}
          >
            {formatPercent(tile.changePct)}
          </span>
        ) : null}
      </div>
      <div className="macro-tile__value" style={{ fontSize: typeScale.valueSize }}>
        {valueText}
      </div>
    </article>
  );
}

function HeatmapGroup({ group, layout, lookback, theme, onSelectTile }) {
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
          <HeatmapTile
            key={tile.id}
            tile={tile}
            layout={tile}
            lookback={lookback}
            theme={theme}
            onSelect={(selected) => onSelectTile(selected, group.title)}
          />
        ))}
      </div>
    </section>
  );
}

function HeatmapSurface({ section, lookback, surfaceHeight, theme, onSelectTile }) {
  const groupLayouts = buildBinaryTreemap(section.groups, "totalValueUsd");

  return (
    <div className="macro-surface" style={{ height: `${surfaceHeight}px` }}>
      {groupLayouts.map((group) => (
        <HeatmapGroup
          key={group.id}
          group={group}
          layout={group}
          lookback={lookback}
          theme={theme}
          onSelectTile={onSelectTile}
        />
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
  dashboardActionError
}) {
  return (
    <div className="macro-dashboard-bar">
      <div className="macro-dashboard-bar__header">
        <div>
          <span className="brand__eyebrow">Dashboard layout</span>
          <p className="card-copy">Use edit mode to drag sections and resize them from the lower-right handles.</p>
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
  theme,
  surfaceHeight,
  editMode,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onResizeStart,
  onSelectTile
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
        <HeatmapSurface
          section={section}
          lookback={lookback}
          surfaceHeight={surfaceHeight}
          theme={theme}
          onSelectTile={onSelectTile}
        />
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

function formatChartDate(date, days) {
  if (days <= 1) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  if (days <= 60) {
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  return date.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

function TileDetailChart({ tile, lookback, displayLookback, endTime, theme }) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState(null);
  const values = tile.sparklines?.[lookback] ?? [];

  if (!Array.isArray(values) || values.length < 2) {
    return <div className="macro-detail__empty">No history is available for this range.</div>;
  }

  const width = 880;
  const height = 340;
  const margin = { top: 16, right: 16, bottom: 30, left: 76 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const count = values.length;
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const padding = (maxValue - minValue) * 0.08 || Math.abs(maxValue) * 0.01 || 1;
  const low = minValue - padding;
  const high = maxValue + padding;
  const days = DISPLAY_LOOKBACK_DAYS[displayLookback] ?? 30;
  const xAt = (index) => margin.left + (index / (count - 1)) * plotWidth;
  const yAt = (value) => margin.top + (1 - (value - low) / (high - low)) * plotHeight;
  const dateAt = (index) => new Date(endTime - ((count - 1 - index) / (count - 1)) * days * 86400000);
  const linePath = values
    .map((value, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)} ${yAt(value).toFixed(1)}`)
    .join(" ");
  const baseY = margin.top + plotHeight;
  const areaPath = `${linePath} L${xAt(count - 1).toFixed(1)} ${baseY} L${margin.left} ${baseY} Z`;
  const change = getTileLookbackChange(tile, lookback);
  const colors = getTileColors(change.changePct, theme);
  const activeIndex = hoverIndex ?? count - 1;
  const activeValue = values[activeIndex];
  const activeChangePct = values[0] ? ((activeValue - values[0]) / values[0]) * 100 : 0;
  const yTicks = Array.from({ length: 5 }, (_, step) => low + ((high - low) * step) / 4);
  const xTickIndexes = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(ratio * (count - 1)));

  function handlePointerMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = (viewX - margin.left) / plotWidth;
    setHoverIndex(clamp(Math.round(ratio * (count - 1)), 0, count - 1));
  }

  return (
    <div className="macro-detail__chart-wrap">
      <div className="macro-detail__readout">
        <span>{formatChartDate(dateAt(activeIndex), days)}</span>
        <strong>{formatShortUsd(activeValue)}</strong>
        <span className={activeChangePct >= 0 ? "positive" : "negative"}>
          {formatPercent(activeChangePct)} vs start
        </span>
      </div>
      <svg
        className="macro-detail__chart"
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
        role="img"
        aria-label={`${tile.label} value over ${displayLookback}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.line} stopOpacity="0.24" />
            <stop offset="100%" stopColor={colors.line} stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={width - margin.right} y1={yAt(tick)} y2={yAt(tick)} stroke="rgba(148, 163, 184, 0.14)" strokeWidth="1" />
            <text className="macro-detail__axis" x={margin.left - 10} y={yAt(tick)} textAnchor="end" dominantBaseline="middle">
              {formatShortUsd(tick)}
            </text>
          </g>
        ))}
        <line
          x1={margin.left}
          x2={width - margin.right}
          y1={yAt(values[0])}
          y2={yAt(values[0])}
          stroke={colors.baseline}
          strokeWidth="1"
        />
        {xTickIndexes.map((index, position) => (
          <text
            key={index}
            className="macro-detail__axis"
            x={xAt(index)}
            y={height - 8}
            textAnchor={position === 0 ? "start" : position === xTickIndexes.length - 1 ? "end" : "middle"}
          >
            {formatChartDate(dateAt(index), days)}
          </text>
        ))}
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={linePath} fill="none" stroke={colors.line} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {hoverIndex !== null ? (
          <line
            x1={xAt(hoverIndex)}
            x2={xAt(hoverIndex)}
            y1={margin.top}
            y2={baseY}
            stroke="rgba(148, 163, 184, 0.5)"
            strokeWidth="1"
          />
        ) : null}
        <circle cx={xAt(activeIndex)} cy={yAt(activeValue)} r="5" fill={colors.line} stroke="#0b1120" strokeWidth="2" />
      </svg>
      <dl className="macro-detail__stats">
        <div>
          <dt>Start</dt>
          <dd>{formatShortUsd(values[0])}</dd>
        </div>
        <div>
          <dt>End</dt>
          <dd>{formatShortUsd(values[count - 1])}</dd>
        </div>
        <div>
          <dt>Change</dt>
          <dd className={change.changePct >= 0 ? "positive" : "negative"}>
            {formatPercent(change.changePct)} ({change.changeUsd >= 0 ? "+" : "-"}
            {formatShortUsd(Math.abs(change.changeUsd))})
          </dd>
        </div>
        <div>
          <dt>High</dt>
          <dd>{formatShortUsd(maxValue)}</dd>
        </div>
        <div>
          <dt>Low</dt>
          <dd>{formatShortUsd(minValue)}</dd>
        </div>
      </dl>
    </div>
  );
}

function TileDetailModal({ tile, groupTitle, lookbacks, selectedLookback, onLookbackChange, endTime, theme, onClose }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="macro-detail-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="macro-detail" role="dialog" aria-modal="true" aria-label={`${tile.label} chart`}>
        <header className="macro-detail__header">
          <div>
            <span className="macro-detail__group">{groupTitle}</span>
            <h3>{tile.label}</h3>
            <span>{tile.detail}</span>
          </div>
          <button type="button" className="macro-layout-button" onClick={onClose} aria-label="Close chart">
            Close
          </button>
        </header>
        <LookbackSelector
          label="Chart range"
          lookbacks={lookbacks}
          selectedLookback={selectedLookback}
          onChange={onLookbackChange}
        />
        <TileDetailChart
          tile={tile}
          lookback={DISPLAY_LOOKBACK_TO_HEATMAP[selectedLookback] ?? "30D"}
          displayLookback={selectedLookback}
          endTime={endTime}
          theme={theme}
        />
      </div>
    </div>
  );
}

function LookbackSelector({ lookbacks, selectedLookback, onChange, disabled = false, label = "Mini-chart range" }) {
  return (
    <div className="macro-lookback">
      <span className="macro-lookback__label">{label}</span>
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

export default function MacroHeatmapDashboard({ macroDashboard, theme = "dark" }) {
  const sections = macroDashboard?.sections ?? [];
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
  const resizeStateRef = useRef(null);
  const [selectedTile, setSelectedTile] = useState(null);

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

  const heatmapLookback = DISPLAY_LOOKBACK_TO_HEATMAP[selectedLookback] ?? "30D";
  const macroDashboardView = useMemo(
    () => buildMacroDashboardLookbackView(macroDashboard, heatmapLookback) || macroDashboard,
    [macroDashboard, heatmapLookback]
  );

  if (!macroDashboard) {
    return null;
  }

  const orderedSections = orderSections(macroDashboardView.sections, sectionLayout.order);

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
      />

      <div className="macro-flow-grid">
        <article className="macro-flow-card macro-flow-card--summary">
          <div className="section-heading">
            <span>Illustrative value changes</span>
            <span className="pill pill--ghost">curated estimates, not observed flows</span>
          </div>
          <div className="macro-pulse">
            <div>
              <span>Net tracked change</span>
              <strong className={macroDashboardView.flowSummary.netChangeUsd >= 0 ? "positive" : "negative"}>
                {formatFlowUsd(macroDashboardView.flowSummary.netChangeUsd)}
              </strong>
            </div>
            <div>
              <span>Gross expansion</span>
              <strong className="positive">{formatFlowUsd(macroDashboardView.flowSummary.positiveChangeUsd)}</strong>
            </div>
            <div>
              <span>Gross contraction</span>
              <strong className="negative">{formatFlowUsd(macroDashboardView.flowSummary.negativeChangeUsd)}</strong>
            </div>
          </div>
        </article>

        <FlowColumn
          title="Largest estimated expansions"
          accentClass="pill--live"
          items={macroDashboardView.flowSummary.largestInflows}
        />

        <FlowColumn
          title="Largest estimated contractions"
          accentClass="pill--ghost"
          items={macroDashboardView.flowSummary.largestOutflows}
        />

        <AtlasControlsCard
          totalValueUsd={macroDashboardView.totals.grossTrackedValueUsd}
          lookbacks={lookbacks}
          selectedLookback={selectedLookback}
          onSelectLookback={setSelectedLookback}
          refreshedAt={macroDashboardView.refreshedAt}
          nextRefreshAt={macroDashboardView.nextRefreshAt}
        />
      </div>

      <div className="macro-heatmap-stack">
        {orderedSections.map((section) => {
          const surfaceHeight = sectionLayout.heights[section.id] ?? getDefaultSectionHeight(section.id);

          return (
            <HeatmapSection
              key={section.id}
              section={section}
              lookback={heatmapLookback}
              theme={theme}
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
              onSelectTile={(tile, groupTitle) => setSelectedTile({ tile, groupTitle })}
            />
          );
        })}
      </div>
      {selectedTile ? (
        <TileDetailModal
          tile={selectedTile.tile}
          groupTitle={selectedTile.groupTitle}
          lookbacks={lookbacks}
          selectedLookback={selectedLookback}
          onLookbackChange={setSelectedLookback}
          endTime={Date.parse(macroDashboardView?.refreshedAt) || Date.now()}
          theme={theme}
          onClose={() => setSelectedTile(null)}
        />
      ) : null}
    </section>
  );
}
