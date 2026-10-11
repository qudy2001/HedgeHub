import useStockVolumeProfile from "./useStockVolumeProfile.js";
import { STOCK_INTERVAL_LABELS } from "../../shared/stockVolumeProfile.js";
import { useMemo, useState } from "react";
import { distribution } from "../../shared/optionDistribution.js";
const compact = (n) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const full = (n) => new Intl.NumberFormat("en-US").format(n);
const dateLabel = (date, group) =>
  group === "month"
    ? new Date(date + "-01T00:00:00Z").toLocaleDateString("en-GB", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : `${group === "week" ? "Week of " : ""}${new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" })}`;
export default function OptionDistribution({
  data,
  metric,
  loading,
  error,
  days,
  onDays,
  stockSymbol,
  stockBars,
  demo,
  stockSettings = { visible: true, interval: "60min", days: 30, preset: "30" },
  onStockSettings = () => {},
}) {
  const [axis, setAxis] = useState("strike"),
    [grouping, setGrouping] = useState("auto"),
    [hover, setHover] = useState(null);
  const model = useMemo(
    () =>
      distribution(data?.contracts ?? [], metric, {
        asOf: data?.asOf?.slice(0, 10),
        grouping,
        axis,
      }),
    [data, metric, grouping, axis],
  );
  const [customDays, setCustomDays] = useState(String(stockSettings.days)),
    [stockRefresh, setStockRefresh] = useState(0);
  const stockVisible =
    metric === "volume" && stockSettings.visible && axis === "strike";
  const stock = useStockVolumeProfile({
    active: stockVisible && !loading && !error,
    symbol: stockSymbol,
    buckets: model.bars,
    interval: stockSettings.interval,
    days: stockSettings.days,
    demo,
    dailyBars: stockBars,
    refresh: stockRefresh,
  });
  const stockResult = stock.result,
    stockMax = Math.max(1, ...(stockResult?.bins ?? []).map((b) => b.volume));
  const stockChange = (patch) =>
    onStockSettings({ ...stockSettings, ...patch });
  const selected = model.bars.find((b) => b.key === hover),
    max = Math.max(1, ...model.bars.flatMap((b) => [b.call, b.put])),
    width = 720,
    left = 52,
    right = stockVisible && stockResult ? 62 : 12,
    zero = 116,
    amplitude = 78,
    step = (width - left - right) / Math.max(1, model.bars.length),
    barWidth = Math.max(1, step * 0.65);
  const title = metric === "openInterest" ? "open interest" : "session volume";
  return (
    <div className="option-distribution">
      <div className="distribution-controls">
        <label>
          View
          <select
            aria-label={`${title} view`}
            value={axis}
            onChange={(e) => {
              setAxis(e.target.value);
              setHover(null);
            }}
          >
            <option value="strike">Strike price</option>
            <option value="expiry">Expiry dates</option>
          </select>
        </label>
        <label>
          Dates
          <select
            aria-label={`${title} date grouping`}
            value={grouping}
            onChange={(e) => {
              setGrouping(e.target.value);
              setHover(null);
            }}
          >
            {["auto", "day", "week", "month"].map((v) => (
              <option key={v} value={v}>
                {v === "auto"
                  ? `Auto (${model.grouping}s)`
                  : v === "day"
                    ? "Exact dates"
                    : v === "week"
                      ? "Weeks"
                      : "Months"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Horizon
          <select
            aria-label={`${title} horizon`}
            value={days}
            onChange={(e) => onDays(Number(e.target.value))}
          >
            <option value={365}>1 year</option>
            <option value={730}>2 years</option>
          </select>
        </label>
        <span className="distribution-legend">
          <i />
          Calls <i />
          Puts
        </span>
      </div>
      {metric === "volume" && (
        <div className="stock-volume-controls">
          <label className="stock-volume-toggle">
            <input
              type="checkbox"
              checked={stockSettings.visible}
              onChange={(e) => stockChange({ visible: e.target.checked })}
            />
            Stock volume layer
          </label>
          {stockSettings.visible && (
            <>
              <label>
                Bars
                <select
                  aria-label="Stock volume bar interval"
                  value={stockSettings.interval}
                  onChange={(e) => stockChange({ interval: e.target.value })}
                >
                  {Object.entries(STOCK_INTERVAL_LABELS).map(
                    ([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Lookback
                <select
                  aria-label="Stock volume lookback"
                  value={stockSettings.preset ?? String(stockSettings.days)}
                  onChange={(e) => {
                    const preset = e.target.value;
                    if (preset === "custom") setCustomDays(String(stockSettings.days));
                    stockChange({
                      preset,
                      ...(preset !== "custom" ? { days: Number(preset) } : {}),
                    });
                  }}
                >
                  {[
                    ["1", "1 day"],
                    ["7", "1 week"],
                    ["30", "1 month"],
                    ["180", "6 months"],
                    ["365", "1 year"],
                    ["custom", "Custom days"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {stockSettings.preset === "custom" && (
                <>
                  <input
                    aria-label="Custom stock history days"
                    type="number"
                    min="1"
                    max="365"
                    value={customDays}
                    onChange={(e) => setCustomDays(e.target.value)}
                  />
                  <button
                    disabled={
                      !Number.isInteger(Number(customDays)) ||
                      Number(customDays) < 1 ||
                      Number(customDays) > 365
                    }
                    onClick={() => stockChange({ days: Number(customDays) })}
                  >
                    Apply
                  </button>
                </>
              )}
              <button
                disabled={stock.loading || axis !== "strike"}
                onClick={() => setStockRefresh((v) => v + 1)}
              >
                Refresh
              </button>
              <span className="stock-volume-key">
                ● Stock shares · right scale
              </span>
              {axis !== "strike" && (
                <p className="subtle">
                  Stock volume has no expiry date. Switch to Strike price to
                  display this layer.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {stockVisible && stock.loading && (
        <div className="stock-volume-status" role="status">
          <span>
            {stock.waiting
              ? "Waiting for Tiger’s rate limit…"
              : stock.processing
                ? "Grouping cached bars by price…"
                : `Loading stock history · ${stock.processed ?? 0}/${stock.total ?? "…"} windows · ${stock.cacheHits ?? 0} cached`}
          </span>
          <progress max="100" value={stock.progress ?? 0} />
          <button onClick={() => stockChange({ visible: false })}>
            Cancel
          </button>
        </div>
      )}
      {stockVisible && stock.error && (
        <p className="negative" role="alert">
          Stock layer: {stock.error}
        </p>
      )}
      {loading ? (
        <div className="distribution-empty" role="status">
          Loading expiry coverage… Full-chain requests may take a minute.
        </div>
      ) : error ? (
        <div className="distribution-empty">{error}</div>
      ) : !model.bars.length ? (
        <div className="distribution-empty">
          {data
            ? "No reported " + title + " available."
            : "Select a scanned stock to load its option chain."}
        </div>
      ) : (
        <>
          <div className="distribution-summary">
            {[
              ["≤30 days", model.near],
              ["31–90 days", model.mid],
              [">90 days", model.far],
            ].map(([label, value]) => (
              <span key={label}>
                {label}
                <b>
                  {model.total
                    ? `${Math.round((value / model.total) * 100)}%`
                    : "—"}
                </b>
              </span>
            ))}
            <span>
              Total<b>{compact(model.total)}</b>
            </span>
          </div>
          <div
            className="distribution-chart"
            onMouseLeave={() => setHover(null)}
          >
            <svg
              viewBox="0 0 720 254"
              role="group"
              aria-label={`${title} by ${axis}. Calls above baseline, puts below. Hover, focus or tap bars for expiry details.`}
            >
              {[0, 0.5, 1].flatMap((f) =>
                [-1, 1].map((sign) => (
                  <g key={`${f}:${sign}`}>
                    <line
                      x1={left}
                      x2={width - right}
                      y1={zero + sign * f * amplitude}
                      y2={zero + sign * f * amplitude}
                      className={
                        f ? "distribution-gridline" : "distribution-baseline"
                      }
                    />
                    {(f || sign === 1) && (
                      <text
                        x={left - 6}
                        y={zero + sign * f * amplitude + 4}
                        textAnchor="end"
                        className="distribution-tick"
                      >
                        {compact(f * max)}
                      </text>
                    )}
                  </g>
                )),
              )}
              {stockVisible && stockResult && (
                <g className="stock-volume-axis" aria-hidden="true">
                  <text x={width - right + 7} y="22">
                    Shares
                  </text>
                  {[0, 0.5, 1].map((f) => (
                    <text
                      key={f}
                      x={width - right + 7}
                      y={zero - f * amplitude + 4}
                    >
                      {compact(stockMax * f)}
                    </text>
                  ))}
                </g>
              )}
              {model.bars.map((b, i) => {
                const x = left + step * (i + 0.5),
                  label =
                    axis === "strike"
                      ? b.label
                      : dateLabel(b.key, model.grouping);
                return (
                  <g
                    key={b.key}
                    tabIndex={0}
                    role="button"
                    aria-label={`${label}: calls ${full(b.call)}, puts ${full(b.put)}. Show expiry details.`}
                    onMouseEnter={() => setHover(b.key)}
                    onFocus={() => setHover(b.key)}
                    onBlur={() => setHover(null)}
                    onClick={() => setHover(b.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setHover(null);
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setHover(b.key);
                      }
                    }}
                  >
                    <rect
                      x={left + i * step}
                      y="26"
                      width={step}
                      height="182"
                      fill={hover === b.key ? "var(--s-tint)" : "transparent"}
                    />
                    {stockVisible && stockResult?.bins[i] && (
                      <rect
                        className="stock-volume-bar"
                        x={left + i * step + 1}
                        y={
                          zero -
                          (stockResult.bins[i].volume / stockMax) * amplitude
                        }
                        width={Math.max(1, step - 2)}
                        height={
                          (stockResult.bins[i].volume / stockMax) * amplitude
                        }
                        fill="#7386e8"
                        fillOpacity=".32"
                      />
                    )}
                    <rect
                      x={x - barWidth / 2}
                      y={zero - (b.call / max) * amplitude}
                      width={barWidth}
                      height={(b.call / max) * amplitude}
                      fill="#1abd83"
                    />
                    <rect
                      x={x - barWidth / 2}
                      y={zero}
                      width={barWidth}
                      height={(b.put / max) * amplitude}
                      fill="#f15b65"
                    />
                    {(i % Math.max(1, Math.ceil(model.bars.length / 5)) === 0 ||
                      i === model.bars.length - 1) && (
                      <text
                        x={x}
                        y="225"
                        textAnchor="middle"
                        className="distribution-tick"
                      >
                        {axis === "strike"
                          ? b.label
                          : dateLabel(b.key, model.grouping).replace(
                              "Week of ",
                              "",
                            )}
                      </text>
                    )}
                  </g>
                );
              })}
              <text
                x="380"
                y="250"
                textAnchor="middle"
                className="distribution-tick"
              >
                {axis === "strike"
                  ? model.strikeGrouped
                    ? "Strike ranges"
                    : "Strike price"
                  : `Expiry ${model.grouping === "day" ? "date" : model.grouping}`}
              </text>
            </svg>
            {selected && (
              <div className="distribution-tooltip" role="status">
                <strong>
                  {axis === "strike"
                    ? selected.label
                    : dateLabel(selected.key, model.grouping)}
                </strong>
                <div>
                  Calls {full(selected.call)} · Puts {full(selected.put)}
                </div>
                {stockVisible &&
                  stockResult &&
                  (() => {
                    const bucket =
                      stockResult.bins[
                        model.bars.findIndex((b) => b.key === hover)
                      ];
                    return bucket ? (
                      <div className="stock-volume-tooltip">
                        Stock: {full(bucket.volume)} shares · {bucket.bars} bars
                        <br />
                        Close-price bin ${bucket.min.toFixed(2)}–$
                        {bucket.max.toFixed(2)}
                        <br />
                        {STOCK_INTERVAL_LABELS[stockSettings.interval]} bars ·{" "}
                        {stockResult.from} → {stockResult.to}
                      </div>
                    ) : null;
                  })()}
                <small>
                  Top 5{" "}
                  {axis === "expiry"
                    ? "expiry dates"
                    : model.grouping === "day"
                      ? "expiry dates"
                      : `expiry ${model.grouping}s`}{" "}
                  · ranked by combined {title}
                </small>
                <table>
                  <thead>
                    <tr>
                      <th>Expiry</th>
                      <th>Calls</th>
                      <th>Puts</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.topDates.map((d) => (
                      <tr key={d.date}>
                        <td>
                          {dateLabel(
                            d.date,
                            axis === "expiry" ? "day" : model.grouping,
                          )}
                        </td>
                        <td>{compact(d.call)}</td>
                        <td>{compact(d.put)}</td>
                        <td>
                          {Math.round(
                            ((d.call + d.put) /
                              (selected.call + selected.put)) *
                              100,
                          )}
                          %
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!selected.topDates.length && <p>Reported values are zero.</p>}
              </div>
            )}
          </div>
          <p className="subtle">
            {model.from} → {model.to} · {model.contracts} contracts ·{" "}
            {model.missing > 0
              ? `${model.missing} missing values excluded · `
              : ""}
            Hover, focus or tap a bar for top expiries.
          </p>
        </>
      )}
      {stockVisible && stockResult && (
        <div className="stock-volume-footnote">
          <p>
            {stockResult.sample ? "Sample stock bars" : stockResult.source} ·{" "}
            {STOCK_INTERVAL_LABELS[stockSettings.interval]} · {stockResult.from}{" "}
            → {stockResult.to} · {full(stockResult.barCount)} bars
            {!stockResult.sample && ` · ${stockResult.cacheHits}/${stockResult.requestedWindows} windows from local cache`}
            .
          </p>
          <p>
            {compact(stockResult.displayedShares)} shares shown;{" "}
            {compact(stockResult.outsideShares)} outside the option price range.
            Each bar’s entire volume is grouped by its closing price; this is
            not tick-by-tick volume at price. Latest bar may still be forming.
          </p>
          {stockResult.barCount === 0 && (
            <p>No stock bars returned for this range.</p>
          )}
          {stockResult.warnings?.length > 0 && (
            <details>
              <summary>
                Stock history coverage notes ({stockResult.warnings.length})
              </summary>
              {stockResult.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </details>
          )}
        </div>
      )}
      {data && (
        <p className="subtle distribution-coverage">
          {data.sample ? "Sample data" : data.source} ·{" "}
          {data.complete === false ? "Partial coverage" : "Returned chain"} ·{" "}
          {data.asOf?.slice(0, 16).replace("T", " ")} UTC.{" "}
          {metric === "openInterest"
            ? "OI is the latest reported outstanding contract count, not IV."
            : "Volume is the provider’s reported session total."}{" "}
          Percentages use returned contracts only.
        </p>
      )}
      {data?.warnings?.length > 0 && (
        <details className="subtle">
          <summary>Coverage notes ({data.warnings.length})</summary>
          {data.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </details>
      )}
    </div>
  );
}
