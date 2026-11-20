import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { getChartPalette } from "../theme.js";

function currencyFormatter(value) {
  if (typeof value !== "number") {
    return value;
  }

  return `$${value.toLocaleString()}`;
}

export default function ScenarioChart({ data, theme = "dark" }) {
  const chartTheme = getChartPalette(theme);

  return (
    <div className="chart-card">
      <div className="section-heading">
        <span>P&amp;L if BTC hits target on each day</span>
        <span className="pill pill--ghost">{data.length} days</span>
      </div>

      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={data}>
            <XAxis dataKey="date" tick={{ fill: chartTheme.axis, fontSize: 11 }} />
            <YAxis
              yAxisId="profit"
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
              tickFormatter={currencyFormatter}
            />
            <YAxis
              yAxisId="price"
              orientation="right"
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
            />
            <Tooltip
              formatter={(value, name) =>
                name === "projectedProfit" ? currencyFormatter(value) : value
              }
              contentStyle={{
                background: chartTheme.tooltipBackground,
                border: `1px solid ${chartTheme.tooltipBorder}`,
                borderRadius: "14px"
              }}
            />
            <Area
              yAxisId="profit"
              type="monotone"
              dataKey="projectedProfit"
              stroke={chartTheme.scenarioAreaStroke}
              fill={chartTheme.scenarioAreaFill}
              strokeWidth={2.5}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="maxProjectedOptionPrice"
              stroke={chartTheme.scenarioLineSky}
              dot={false}
              strokeWidth={2}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="theoreticalOptionPrice"
              stroke={chartTheme.scenarioLineEmerald}
              dot={false}
              strokeWidth={1.7}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
