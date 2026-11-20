import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { getChartPalette } from "../theme.js";

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

function formatRangeLabel(startDate, endDate) {
  if (!startDate && !endDate) {
    return "All history";
  }

  if (startDate && endDate) {
    return `${startDate} to ${endDate}`;
  }

  return startDate ? `From ${startDate}` : `Through ${endDate}`;
}

function formatDateLabel(value, granularity) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  if (granularity === "hour") {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  if (granularity === "week" || granularity === "month") {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    }).format(date);
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short"
  }).format(date);
}

export default function PaperPortfolioHistoryChart({
  data,
  theme = "dark",
  granularity = "day",
  scopeLabel = "Combined",
  rangeLabel = "All history"
}) {
  const chartTheme = getChartPalette(theme);
  const values = (data ?? []).map((point) => Number(point.pnl)).filter((value) => Number.isFinite(value));
  const minValue = values.length ? Math.min(...values, 0) : -1;
  const maxValue = values.length ? Math.max(...values, 0) : 1;
  const range = Math.max(maxValue - minValue, 1);
  const padding = Math.max(range * 0.12, 40);
  const domain = [minValue - padding, maxValue + padding];
  const latestPoint = data?.[data.length - 1] ?? null;

  if (!data?.length) {
    return (
      <section className="detail-chart paper-portfolio-history">
        <div className="detail-chart__header">
          <div>
            <span className="brand__eyebrow">Portfolio P&amp;L</span>
            <p className="detail-chart__copy">
              No portfolio history matches the current filters.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="detail-chart paper-portfolio-history">
      <div className="detail-chart__header">
        <div>
          <span className="brand__eyebrow">Portfolio P&amp;L</span>
          <p className="detail-chart__copy">
            {scopeLabel} view aggregated from stored paper-trade history. Grouped by {granularity} across {rangeLabel.toLowerCase()}.
          </p>
        </div>
        <div className="paper-portfolio-history__summary">
          <span className={`pill ${Number(latestPoint?.pnl ?? 0) >= 0 ? "pill--live" : "pill--short"}`}>
            Latest {formatCurrency(latestPoint?.pnl ?? 0)}
          </span>
          <span className="pill pill--ghost">
            {rangeLabel || formatRangeLabel(data[0]?.date ?? "", latestPoint?.date ?? "")}
          </span>
        </div>
      </div>

      <div className="paper-portfolio-history__frame">
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={data}>
            <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
              minTickGap={24}
            />
            <YAxis
              domain={domain}
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
              tickFormatter={(value) => formatCurrency(value, 0)}
            />
            <Tooltip
              formatter={(value) => [formatCurrency(value), "P&L"]}
              labelFormatter={(_label, payload) =>
                payload?.[0]?.payload?.bucketStart
                  ? formatDateLabel(payload[0].payload.bucketStart, granularity)
                  : ""
              }
              contentStyle={{
                background: chartTheme.tooltipBackground,
                border: `1px solid ${chartTheme.tooltipBorder}`,
                borderRadius: 16
              }}
            />
            <ReferenceLine y={0} stroke={chartTheme.historyZeroLine} strokeDasharray="4 4" />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke={chartTheme.strategyLineStroke}
              fill={chartTheme.strategyAreaFill}
              strokeWidth={2.2}
              activeDot={{ r: 4 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
