import { useEffect, useRef, useState } from "react";

function formatCurrency(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(value));
}

function formatDateTimeLabel(value) {
  if (!value) {
    return "n/a";
  }

  const normalizedValue =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatHourLabel(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit"
  }).format(date);
}

function buildTickValues(minValue, maxValue, count = 5) {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return [0];
  }

  if (Math.abs(maxValue - minValue) < 0.000001) {
    return [minValue];
  }

  const step = (maxValue - minValue) / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_value, index) => minValue + (step * index));
}

export default function PaperTradeHistoryChart({ history }) {
  const containerRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(null);
  const candles = history?.candles ?? [];

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return undefined;
    }

    const updateSize = () => {
      setChartWidth(node.getBoundingClientRect().width);
    };

    updateSize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => {
        window.removeEventListener("resize", updateSize);
      };
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  if (!candles.length) {
    return null;
  }

  const width = Math.max(chartWidth || 860, 320);
  const height = 280;
  const margin = {
    top: 16,
    right: 16,
    bottom: 34,
    left: 74
  };
  const plotWidth = Math.max(width - margin.left - margin.right, 40);
  const plotHeight = Math.max(height - margin.top - margin.bottom, 40);
  const values = candles.flatMap((candle) => [candle.high, candle.low, candle.open, candle.close, 0]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = Math.max(maxValue - minValue, 1);
  const padding = Math.max(range * 0.14, 12);
  const domainMin = minValue - padding;
  const domainMax = maxValue + padding;
  const domainRange = Math.max(domainMax - domainMin, 1);
  const slotWidth = plotWidth / Math.max(candles.length, 1);
  const bodyWidth = Math.min(Math.max(slotWidth * 0.48, 7), 18);
  const tickValues = buildTickValues(domainMin, domainMax, 5);
  const tickStep = Math.max(Math.ceil(candles.length / 6), 1);
  const activeCandle = candles[activeIndex ?? candles.length - 1];
  const yFor = (value) => margin.top + (((domainMax - value) / domainRange) * plotHeight);
  const xForIndex = (index) => margin.left + (slotWidth * index) + (slotWidth / 2);
  const zeroY = yFor(0);

  return (
    <section className="paper-history-card">
      <div className="paper-history-card__header">
        <div>
          <span className="brand__eyebrow">{history.live ? "Live P&L history" : "Closed P&L history"}</span>
          <p className="paper-history-card__copy">
            Hourly candles built from the existing 5-minute valuation refresh. High and low come from the strongest and weakest sampled
            P&amp;L inside each hour.
          </p>
        </div>
        <span className={`pill ${history.live ? "pill--live" : "pill--ghost"}`}>
          {history.live ? "1h candles · live" : "1h candles · static"}
        </span>
      </div>

      <div className="paper-history-card__stats">
        <span>{formatHourLabel(activeCandle.bucketStart)}</span>
        <span>Open {formatCurrency(activeCandle.open)}</span>
        <span>High {formatCurrency(activeCandle.high)}</span>
        <span>Low {formatCurrency(activeCandle.low)}</span>
        <span>Close {formatCurrency(activeCandle.close)}</span>
      </div>

      <div ref={containerRef} className="paper-history-card__frame">
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Paper trade profit and loss history">
          {tickValues.map((tick) => {
            const y = yFor(tick);
            const isZeroLine = Math.abs(tick) < range * 0.01;

            return (
              <g key={tick}>
                <line
                  x1={margin.left}
                  x2={width - margin.right}
                  y1={y}
                  y2={y}
                  stroke={isZeroLine ? "rgba(56, 189, 248, 0.36)" : "rgba(148, 163, 184, 0.12)"}
                  strokeDasharray={isZeroLine ? "0" : "4 6"}
                />
                <text
                  x={margin.left - 12}
                  y={y + 4}
                  textAnchor="end"
                  fill="rgba(209, 212, 220, 0.68)"
                  fontSize="11"
                >
                  {formatCurrency(tick)}
                </text>
              </g>
            );
          })}

          <line
            x1={margin.left}
            x2={width - margin.right}
            y1={zeroY}
            y2={zeroY}
            stroke="rgba(56, 189, 248, 0.28)"
            strokeWidth="1.1"
          />

          {candles.map((candle, index) => {
            const centerX = xForIndex(index);
            const openY = yFor(candle.open);
            const closeY = yFor(candle.close);
            const highY = yFor(candle.high);
            const lowY = yFor(candle.low);
            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(Math.abs(closeY - openY), 2);
            const rising = candle.close >= candle.open;
            const bodyFill = rising ? "rgba(52, 211, 153, 0.78)" : "rgba(251, 113, 133, 0.72)";
            const wickStroke = rising ? "rgba(52, 211, 153, 0.94)" : "rgba(251, 113, 133, 0.92)";

            return (
              <g
                key={`${candle.bucketStart}-${index}`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                style={{ cursor: "pointer" }}
              >
                <line
                  x1={centerX}
                  x2={centerX}
                  y1={highY}
                  y2={lowY}
                  stroke={wickStroke}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <rect
                  x={centerX - (bodyWidth / 2)}
                  y={bodyTop}
                  width={bodyWidth}
                  height={bodyHeight}
                  rx="2"
                  fill={bodyFill}
                  stroke={wickStroke}
                  strokeWidth="1"
                />
              </g>
            );
          })}

          {candles.map((candle, index) => {
            if (index % tickStep !== 0 && index !== candles.length - 1) {
              return null;
            }

            return (
              <text
                key={`label-${candle.bucketStart}`}
                x={xForIndex(index)}
                y={height - 10}
                textAnchor="middle"
                fill="rgba(209, 212, 220, 0.68)"
                fontSize="11"
              >
                {formatHourLabel(candle.bucketStart)}
              </text>
            );
          })}
        </svg>
      </div>

      <div className="paper-history-card__footer">
        <span>Opened {formatDateTimeLabel(history.startAt)}</span>
        <span>
          {history.live ? `Last sampled ${formatDateTimeLabel(history.lastCapturedAt)}` : `Closed ${formatDateTimeLabel(history.endAt)}`}
        </span>
      </div>
    </section>
  );
}
