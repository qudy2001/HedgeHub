import { useEffect, useMemo, useState } from "react";

// A small TradingView-style chart: pixel-accurate SVG with price axis, date axis, crosshair,
// candlesticks or a line, volume bars, overlay lines and horizontal levels. No chart library needed.

const PURPLE = "#9770db";
const M = { l: 6, r: 58, t: 8, b: 22 };

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw)),
    f = raw / pow;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
}
function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const step = niceStep((max - min) / count),
    out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step)
    out.push(Number(v.toPrecision(12)));
  return out;
}
function shortDate(d) {
  const t = Date.parse(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : String(d);
}
function compact(n) {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  return a >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
}

export default function InteractiveChart({
  series = [],
  candles = null,
  levels = [],
  format = (v) => v.toFixed(2),
  height = 240,
  label = "Chart",
}) {
  // State-backed ref: the observer must (re)attach whenever the wrapper element is actually mounted.
  const [wrap, setWrap] = useState(null);
  // SVG presentation attributes do not reliably resolve CSS variables, so read the real theme colours.
  const css = (name, fallback) =>
    (wrap && getComputedStyle(wrap).getPropertyValue(name).trim()) || fallback;
  const GREEN = css("--s-green", "#087655"),
    RED = css("--s-red", "#ce414b"),
    LINE = css("--s-line", "#e2e9ed"),
    MUTED = css("--s-muted", "#788791"),
    TEXT = css("--s-text", "#172a33"),
    PANEL = css("--s-panel", "#ffffff");
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState(null); // { i, y }
  const [mode, setMode] = useState("candles");
  const [hidden, setHidden] = useState(() => new Set());
  const toggle = (key) =>
    setHidden((h) => {
      const next = new Set(h);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const hasCandles = Array.isArray(candles) && candles.length > 1;
  const candleMode = hasCandles && mode === "candles";

  useEffect(() => {
    if (!wrap) return undefined;
    const measure = () => setWidth(Math.max(240, Math.floor(wrap.clientWidth)));
    measure();
    window.addEventListener("resize", measure);
    // Cheap poll as well: some embedded browsers skip resize/ResizeObserver notifications.
    const poll = window.setInterval(measure, 400);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(wrap);
    return () => {
      ro?.disconnect();
      window.clearInterval(poll);
      window.removeEventListener("resize", measure);
    };
  }, [wrap]);
  // Safety net: if a resize notification was missed, the next render (hover, data refresh) corrects the width.
  useEffect(() => {
    if (!wrap) return;
    const w = Math.max(240, Math.floor(wrap.clientWidth));
    if (w !== width) setWidth(w);
  });

  const model = useMemo(() => {
    const dates = [
      ...new Set([
        ...(hasCandles ? candles.map((c) => c.date) : []),
        ...series.flatMap((s) => s.points.map((p) => p.date)),
      ]),
    ].sort();
    const index = new Map(dates.map((d, i) => [d, i]));
    const aligned = series.map((s) => {
      const arr = new Array(dates.length).fill(null);
      s.points.forEach((p) => {
        if (Number.isFinite(p.value)) arr[index.get(p.date)] = p.value;
      });
      return arr;
    });
    const bars = hasCandles ? new Array(dates.length).fill(null) : [];
    if (hasCandles) candles.forEach((c) => (bars[index.get(c.date)] = c));
    return { dates, aligned, bars };
  }, [series, candles, hasCandles]);

  const n = model.dates.length;
  if (n < 2) return <div className="empty-chart">Historical data unavailable</div>;

  const plotW = Math.max(40, width - M.l - M.r),
    plotH = height - M.t - M.b,
    hasVolume = candleMode && model.bars.some((b) => b?.volume > 0),
    volH = hasVolume ? plotH * 0.18 : 0,
    priceH = plotH - volH - (hasVolume ? 6 : 0),
    step = plotW / n,
    x = (i) => M.l + (i + 0.5) * step;

  // y domain
  const vals = [];
  if (candleMode) model.bars.forEach((b) => b && vals.push(b.high, b.low));
  else if (hasCandles) model.bars.forEach((b) => b && vals.push(b.close));
  model.aligned.forEach((arr, k) => !series[k].noScale && arr.forEach((v) => v != null && vals.push(v)));
  levels.forEach((l) => Number.isFinite(l.value) && vals.push(l.value));
  let lo = Math.min(...vals),
    hi = Math.max(...vals);
  const pad = (hi - lo || Math.abs(hi) * 0.02 || 1) * 0.06;
  lo -= pad;
  hi += pad;
  const y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * priceH,
    valueAt = (py) => lo + (1 - (py - M.t) / priceH) * (hi - lo),
    maxVol = Math.max(0, ...model.bars.map((b) => b?.volume ?? 0)),
    yTicks = niceTicks(lo, hi, Math.max(3, Math.round(priceH / 44))),
    xTickCount = Math.max(2, Math.floor(plotW / 90)),
    xTicks = Array.from({ length: xTickCount }, (_, k) =>
      Math.round(((k + 0.5) / xTickCount) * (n - 1)),
    );
  const tickFmt = (v) => format(v);
  const gid = `ichart-${label.replace(/\W/g, "")}`;
  const baseValue = (k) => model.aligned[k].find((v) => v != null);
  const levelColor = (l) => (l.color === "up" ? GREEN : l.color === "down" ? RED : MUTED);

  function lastIdx(arr, i) {
    for (let k = i; k >= 0; k -= 1) if (arr[k] != null) return k;
    return -1;
  }
  const at = hover ? hover.i : n - 1;
  let bar = null;
  if (hasCandles) for (let k = at; k >= 0 && !bar; k -= 1) bar = model.bars[k];
  const prevBar = hasCandles && at > 0 ? model.bars[at - 1] : null;

  function pointer(e) {
    const box = e.currentTarget.getBoundingClientRect(),
      px = e.clientX - box.left,
      py = e.clientY - box.top;
    const i = Math.min(n - 1, Math.max(0, Math.round((px - M.l) / step - 0.5)));
    setHover({ i, y: Math.min(M.t + priceH, Math.max(M.t, py)) });
  }

  // primary value for the right-axis crosshair tag + last-price tag
  const primary = model.aligned[0];
  const lastClose = hasCandles ? [...model.bars].reverse().find(Boolean)?.close : null;
  const lastTag = candleMode || hasCandles ? lastClose : primary?.[lastIdx(primary, n - 1)];
  const lastUp = hasCandles
    ? (() => {
        const b = [...model.bars].reverse().find(Boolean);
        return b ? b.close >= b.open : true;
      })()
    : true;

  return (
    <div className="ichart" ref={setWrap}>
      <div className="ichart-head">
        <span className="ichart-date">{shortDate(model.dates[at])} {String(model.dates[at]).slice(0, 4)}</span>
        {bar && (
          <span className="ichart-ohlc">
            <i>O</i> {format(bar.open)} <i>H</i> {format(bar.high)} <i>L</i> {format(bar.low)} <i>C</i>{" "}
            <b style={{ color: bar.close >= bar.open ? GREEN : RED }}>{format(bar.close)}</b>
            {prevBar && (
              <b style={{ color: bar.close >= prevBar.close ? GREEN : RED }}>
                {" "}
                {bar.close >= prevBar.close ? "+" : ""}
                {(((bar.close - prevBar.close) / prevBar.close) * 100).toFixed(2)}%
              </b>
            )}
            {bar.volume > 0 && (
              <>
                {" "}
                <i>Vol</i> {compact(bar.volume)}
              </>
            )}
          </span>
        )}
        {series.map((s, k) => {
          const j = lastIdx(model.aligned[k], at),
            hc = s.baseline && j >= 0 ? (model.aligned[k][j] >= baseValue(k) ? GREEN : RED) : (s.color ?? (k ? PURPLE : GREEN));
          return (
            <span
              key={s.key ?? s.label}
              className="ichart-val"
              role="button"
              tabIndex={0}
              title="Click to show or hide"
              onClick={() => toggle(s.key)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(s.key)}
              style={{ color: hc, cursor: "pointer", opacity: hidden.has(s.key) ? 0.4 : 1 }}
            >
              {s.label} <b>{j >= 0 ? format(model.aligned[k][j]) : "—"}</b>
            </span>
          );
        })}
        {hasCandles && (
          <span className="segmented ichart-mode">
            <button className={candleMode ? "active" : ""} onClick={() => setMode("candles")}>
              Candles
            </button>
            <button className={!candleMode ? "active" : ""} onClick={() => setMode("line")}>
              Line
            </button>
          </span>
        )}
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        style={{ display: "block", touchAction: "pan-y", cursor: "crosshair" }}
        onPointerMove={pointer}
        onPointerDown={pointer}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        <defs>
          {series.map((s, k) =>
            s.area && !s.baseline ? (
              <linearGradient key={k} id={`${gid}-area-${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color ?? (k ? PURPLE : GREEN)} stopOpacity="0.22" />
                <stop offset="100%" stopColor={s.color ?? (k ? PURPLE : GREEN)} stopOpacity="0" />
              </linearGradient>
            ) : null,
          )}
        </defs>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={M.l + plotW} y1={y(t)} y2={y(t)} stroke={LINE} strokeWidth="1" />
            <text x={M.l + plotW + 6} y={y(t) + 3.5} fontSize="10" fill={MUTED}>
              {tickFmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={height - 6} fontSize="10" textAnchor="middle" fill={MUTED}>
            {shortDate(model.dates[i])}
          </text>
        ))}
        {hasVolume &&
          model.bars.map((b, i) =>
            b?.volume > 0 ? (
              <rect
                key={i}
                x={x(i) - Math.max(0.5, step * 0.35)}
                width={Math.max(1, step * 0.7)}
                y={M.t + plotH - (b.volume / maxVol) * volH}
                height={(b.volume / maxVol) * volH}
                fill={b.close >= b.open ? GREEN : RED}
                opacity="0.35"
              />
            ) : null,
          )}
        <clipPath id={`${gid}-plot`}>
          <rect x={M.l} y={M.t} width={plotW} height={priceH} />
        </clipPath>
        <g clipPath={`url(#${gid}-plot)`}>
        {series.map((s, k) => {
          if (hidden.has(s.key)) return null;
          const pts = model.aligned[k]
            .map((v, i) => (v == null ? null : [x(i), y(v)]))
            .filter(Boolean);
          if (pts.length < 2) return null;
          const path = pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" "),
            color = s.color ?? (k ? PURPLE : GREEN),
            fx = pts[0][0],
            lx = pts[pts.length - 1][0],
            bottom = M.t + priceH;
          if (s.baseline) {
            // Direction-coloured area: green above the starting value, red below, each fading toward the baseline.
            const by = Math.min(bottom, Math.max(M.t, y(baseValue(k)))),
              id = `${gid}-${k}`;
            return (
              <g key={k}>
                <defs>
                  <linearGradient id={`${id}-up`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={M.t} y2={by}>
                    <stop offset="0%" stopColor={GREEN} stopOpacity="0.42" />
                    <stop offset="100%" stopColor={GREEN} stopOpacity="0.02" />
                  </linearGradient>
                  <linearGradient id={`${id}-down`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={by} y2={bottom}>
                    <stop offset="0%" stopColor={RED} stopOpacity="0.02" />
                    <stop offset="100%" stopColor={RED} stopOpacity="0.42" />
                  </linearGradient>
                  <clipPath id={`${id}-clip-up`}>
                    <rect x={M.l} y={M.t} width={plotW} height={Math.max(0, by - M.t)} />
                  </clipPath>
                  <clipPath id={`${id}-clip-down`}>
                    <rect x={M.l} y={by} width={plotW} height={Math.max(0, bottom - by)} />
                  </clipPath>
                </defs>
                {[
                  ["up", GREEN],
                  ["down", RED],
                ].map(([side, c]) => (
                  <g key={side} clipPath={`url(#${id}-clip-${side})`}>
                    <polygon points={`${fx},${by} ${path} ${lx},${by}`} fill={`url(#${id}-${side})`} />
                    <polyline fill="none" stroke={c} strokeWidth="1.9" strokeLinejoin="round" points={path} />
                  </g>
                ))}
                <line x1={M.l} x2={M.l + plotW} y1={by} y2={by} stroke={MUTED} strokeWidth="1" strokeDasharray="4 4" />
                <text x={M.l + 4} y={by - 3} fontSize="9.5" fill={MUTED}>
                  Period start {format(baseValue(k))}
                </text>
              </g>
            );
          }
          return (
            <g key={k}>
              {s.area && (
                <polygon
                  points={`${fx},${bottom} ${path} ${lx},${bottom}`}
                  fill={`url(#${gid}-area-${k})`}
                />
              )}
              <polyline
                fill="none"
                stroke={color}
                strokeWidth={s.dashed ? 1.4 : 1.9}
                strokeDasharray={s.dashed ? "5 4" : undefined}
                strokeLinejoin="round"
                points={path}
              />
            </g>
          );
        })}
        </g>
        {hasCandles && !candleMode && (
          <polyline
            fill="none"
            stroke={GREEN}
            strokeWidth="1.9"
            strokeLinejoin="round"
            points={model.bars
              .map((b, i) => (b ? `${x(i).toFixed(1)},${y(b.close).toFixed(1)}` : null))
              .filter(Boolean)
              .join(" ")}
          />
        )}
        {candleMode &&
          model.bars.map((b, i) => {
            if (!b) return null;
            const up = b.close >= b.open,
              c = up ? GREEN : RED,
              w = Math.max(1, Math.min(12, step * 0.68)),
              top = y(Math.max(b.open, b.close)),
              h = Math.max(1, Math.abs(y(b.open) - y(b.close)));
            return (
              <g key={i}>
                <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={c} strokeWidth="1" />
                <rect x={x(i) - w / 2} y={top} width={w} height={h} fill={c} />
              </g>
            );
          })}
        {levels.map(
          (l) =>
            Number.isFinite(l.value) && (
              <g key={l.label}>
                <line
                  x1={M.l}
                  x2={M.l + plotW}
                  y1={y(l.value)}
                  y2={y(l.value)}
                  stroke={levelColor(l)}
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <text x={M.l + 4} y={y(l.value) - 3} fontSize="9.5" fill={levelColor(l)}>
                  {l.label} {format(l.value)}
                </text>
              </g>
            ),
        )}
        {Number.isFinite(lastTag) && !hover && (
          <g>
            <rect x={M.l + plotW + 2} y={y(lastTag) - 8} width={M.r - 4} height="16" rx="3" fill={lastUp ? GREEN : RED} />
            <text x={M.l + plotW + 6} y={y(lastTag) + 3.5} fontSize="10" fill="#fff">
              {format(lastTag)}
            </text>
          </g>
        )}
        {hover && (
          <g pointerEvents="none">
            <line x1={x(hover.i)} x2={x(hover.i)} y1={M.t} y2={M.t + plotH} stroke={MUTED} strokeWidth="1" strokeDasharray="3 3" />
            <line x1={M.l} x2={M.l + plotW} y1={hover.y} y2={hover.y} stroke={MUTED} strokeWidth="1" strokeDasharray="3 3" />
            <rect x={M.l + plotW + 2} y={hover.y - 8} width={M.r - 4} height="16" rx="3" fill={TEXT} />
            <text x={M.l + plotW + 6} y={hover.y + 3.5} fontSize="10" fill={PANEL}>
              {tickFmt(valueAt(hover.y))}
            </text>
            <rect x={Math.min(Math.max(x(hover.i) - 28, M.l), M.l + plotW - 56)} y={height - M.b + 2} width="56" height="16" rx="3" fill={TEXT} />
            <text
              x={Math.min(Math.max(x(hover.i), M.l + 28), M.l + plotW - 28)}
              y={height - 6.5}
              fontSize="10"
              textAnchor="middle"
              fill={PANEL}
            >
              {shortDate(model.dates[hover.i])}
            </text>
            {model.aligned.map((arr, k) => {
              const j = lastIdx(arr, hover.i);
              return j >= 0 && j === hover.i && !hidden.has(series[k].key) && !series[k].noScale ? (
                <circle key={k} cx={x(j)} cy={y(arr[j])} r="3.5" fill={series[k].baseline ? (arr[j] >= baseValue(k) ? GREEN : RED) : (series[k].color ?? (k ? PURPLE : GREEN))} stroke={PANEL} strokeWidth="1.5" />
              ) : null;
            })}
          </g>
        )}
      </svg>
    </div>
  );
}
