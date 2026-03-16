import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

function currencyFormatter(value) {
  if (typeof value !== "number") {
    return value;
  }

  return `$${value.toLocaleString()}`;
}

export default function ScenarioChart({ data }) {
  return (
    <div className="chart-card">
      <div className="section-heading">
        <span>P&amp;L if BTC hits target on each day</span>
        <span className="pill pill--ghost">{data.length} days</span>
      </div>

      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={data}>
            <XAxis dataKey="date" tick={{ fill: "rgba(226,232,240,0.6)", fontSize: 11 }} />
            <YAxis
              yAxisId="profit"
              tick={{ fill: "rgba(226,232,240,0.6)", fontSize: 11 }}
              tickFormatter={currencyFormatter}
            />
            <YAxis
              yAxisId="price"
              orientation="right"
              tick={{ fill: "rgba(226,232,240,0.6)", fontSize: 11 }}
            />
            <Tooltip
              formatter={(value, name) =>
                name === "projectedProfit" ? currencyFormatter(value) : value
              }
              contentStyle={{
                background: "rgba(15, 23, 42, 0.92)",
                border: "1px solid rgba(148, 163, 184, 0.18)",
                borderRadius: "14px"
              }}
            />
            <Area
              yAxisId="profit"
              type="monotone"
              dataKey="projectedProfit"
              stroke="#f59e0b"
              fill="rgba(245,158,11,0.22)"
              strokeWidth={2.5}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="maxProjectedOptionPrice"
              stroke="#38bdf8"
              dot={false}
              strokeWidth={2}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="theoreticalOptionPrice"
              stroke="#34d399"
              dot={false}
              strokeWidth={1.7}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
