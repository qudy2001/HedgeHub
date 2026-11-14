import OptionDistribution from "./OptionDistribution.jsx";
import OptionSummary, { SUMMARY_SECTIONS } from "./OptionSummary.jsx";
import AgentReport, { AgentHighlights, CompanySummary } from "./AgentReport.jsx";
import { companySummary, reportHighlights } from "../../shared/agentReport.js";
import OptionChainView from "./OptionChainView.jsx";
import TigerSubscriptions from "./TigerSubscriptions.jsx";
import { money, num, pct, pillTone } from "./format.js";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
const MacroHeatmapDashboard = lazy(() => import("../components/MacroHeatmapDashboard.jsx"));
import MonitoredStocksPanel from "../components/MonitoredStocksPanel.jsx";
import MonitoredStocksTileGrid from "../components/MonitoredStocksTileGrid.jsx";
import AuthScreen from "../components/AuthScreen.jsx";
import ScenarioHeatmap from "../components/ScenarioHeatmap.jsx";
import {
  DEFAULT_STRATEGY,
  TEMPLATES,
  SENTIMENTS,
  applyCatalysts,
  payoff,
  summarizePosition,
  technicals,
  realizedVol,
  DAY,
  addDays,
  dateOnly,
  backtest,
  validateStrategy,
} from "../../shared/builderEngine.js";
import { HEDGE_SCAN_STRATEGIES, HEDGE_TEMPLATES, hedgeChoicesForRow, templatesForHedgeChoices } from "../../shared/hedgeScan.js";
import {
  MARKET_TOPIC_CATEGORY_LABELS,
  SUGGESTION_TABS,
  suggestionTab,
  topicToItem,
} from "../../shared/marketTopics.js";
import { demoWorkspace } from "./demo.js";
import InteractiveChart from "./InteractiveChart.jsx";
import "./builder.css";
import "../styles/monitored-stocks.css";
import "../styles/monitored-stocks-grid.css";

const PANELS = [
  ["payoff", "Profit & loss", "chart"],
  ["hedges", "Hedge choices", "shield"],
  ["technicals", "Stock technicals", "trend"],
  ["options", "Options analytics", "pie"],
  ["valuation", "Agent valuation & options", "bulb"],
  ["oi-distribution", "Open interest distribution", "chart"],
  ["volume-distribution", "Volume distribution", "chart"],
  ["past", "Past events", "calendar"],
  ["future", "Upcoming events", "calendar"],
  ["tracking", "AI tracking", "target"],
  ["ai-stock-analysis", "AI Stock Analysis", "chip"],
  ["strategy-score", "Strategy score", "target"],
  ["results", "Scan results", "search"],
];
const DEFAULT_LAYOUT = {
  order: [
    "tracking",
    "valuation",
    "oi-distribution",
    "volume-distribution",
    "technicals",
    "options",
    "past",
    "future",
    "payoff",
    "hedges",
    "strategy-score",
    "results",
  ],
  layoutVersion: 4,
  hidden: [],
  collapsed: [],
  metrics: {},
  theme: "light",
};
const TOP_PANELS = ["valuation", "oi-distribution", "volume-distribution", "technicals", "options", "past", "future"];
function restoreLayout(saved = {}) {
  let order = Array.isArray(saved.order)
    ? saved.order.filter((id) => DEFAULT_LAYOUT.order.includes(id))
    : DEFAULT_LAYOUT.order;
  // v3: one-time migration putting the analysis rows (valuation with the option summary, OI + volume, technicals + options, events) on top of saved layouts.
  if ((saved.layoutVersion || 1) < 3) {
    order = [...TOP_PANELS, ...order.filter((id) => !TOP_PANELS.includes(id))];
  }
  // v4: AI tracking moves to the top and the Strategy score strip (now a panel) takes its old slot.
  if ((saved.layoutVersion || 1) < 4) {
    const at = Math.max(order.indexOf("tracking"), 0),
      rest = order.filter((id) => id !== "tracking" && id !== "strategy-score");
    rest.splice(at, 0, "strategy-score");
    order = ["tracking", ...rest];
  }
  return {
    ...DEFAULT_LAYOUT,
    ...saved,
    layoutVersion: DEFAULT_LAYOUT.layoutVersion,
    order: [...new Set([...order, ...DEFAULT_LAYOUT.order])],
  };
}
// EMA overlays for the Stock technicals chart. Computed over the full history, seeded with the SMA of the first
// `period` closes (as TradingView does); a line is omitted when there are not enough bars to compute it.
const EMA_LINES = [
  [14, "#f5a623"],
  [26, "#2f80ed"],
  [50, "#9770db"],
  [100, "#e056a0"],
  [200, "#12a3a3"],
  [250, "#8d6e63"],
];
function emaSeries(bars, period) {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  let ema = bars.slice(0, period).reduce((t, b) => t + b.close, 0) / period;
  const out = [{ date: bars[period - 1].date, value: ema }];
  for (let i = period; i < bars.length; i += 1) {
    ema = bars[i].close * k + ema * (1 - k);
    out.push({ date: bars[i].date, value: ema });
  }
  return out;
}
// Average of the latest value of every EMA line shown on the chart (lines without enough history are skipped).
function emaAverage(bars) {
  const last = EMA_LINES.map(([period]) => emaSeries(bars, period).at(-1)?.value).filter(Number.isFinite);
  return last.length ? last.reduce((t, v) => t + v, 0) / last.length : null;
}
const METRICS = {
  payoff: ["Net option cost", "Max loss", "Max gain", "Breakeven"],
  technicals: ["RSI", "EMA average", "Support", "Resistance"],
  options: ["IV", "HV", "IV rank", "Min OI"],
  valuation: ["Target", "Agent view", "What's happening", ...SUMMARY_SECTIONS],
};
const EVENT_EXTRA_GROUPS = [
  {
    id: "countries",
    label: "Countries",
    items: [
      { key: "country_eu", label: "Eurozone", desc: "ECB decisions, EU PMI, inflation data" },
      { key: "country_uk", label: "United Kingdom", desc: "BoE rate decisions, UK CPI & PMI" },
      { key: "country_cn", label: "China & Hong Kong", desc: "PBOC, China PMI and GDP releases" },
      { key: "country_jp", label: "Japan", desc: "BoJ decisions, Tokyo CPI, Tankan survey" },
      { key: "country_ca", label: "Canada", desc: "BoC rate decisions, Canadian jobs data" },
      { key: "country_au", label: "Australia & NZ", desc: "RBA decisions, Australian employment" },
    ],
  },
  {
    id: "indicators",
    label: "Indicators",
    items: [
      { key: "ind_medium", label: "Medium-importance releases", desc: "Housing starts, trade balance, consumer confidence, retail sales" },
      { key: "ind_all", label: "All data releases", desc: "Includes low-importance and preliminary/revised figures" },
    ],
  },
  {
    id: "peers",
    label: "Peer earnings",
    items: [
      { key: "peers_largecap", label: "Large-cap US peers", desc: "Earnings from companies with market cap above $100 billion" },
    ],
  },
  {
    id: "market",
    label: "Market events",
    items: [
      { key: "mkt_global_all", label: "Full global calendar", desc: "All countries and all importance levels — includes holidays, elections and observances" },
    ],
  },
];
const delta = (v) => `${v > 0 ? "+" : ""}${num(v, 0)}`;
const tone = (v) =>
  typeof v === "number"
    ? v > 0
      ? "positive"
      : v < 0
        ? "negative"
        : "neutral"
    : /bullish/i.test(v)
      ? "positive"
      : /bearish/i.test(v)
        ? "negative"
        : "neutral";
// Seconds left until `until` (epoch ms), ticking; null when there is nothing to wait for.
function useCountdown(until) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [until]);
  return until && until > now ? Math.ceil((until - now) / 1000) : null;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, body, method) {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body !== undefined
      ? { method: method || "POST", body: JSON.stringify(body) }
      : { method: method || "GET" }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Request failed (${response.status}): server returned a non-JSON response for ${path}`,
    );
  }
  if (!response.ok)
    throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}
function Icon({ name = "chart", size = 18 }) {
  const paths = {
    chart: "M4 19V12h3v7M10 19V8h3v11M16 19V4h3v15",
    shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z",
    trend: "M3 17l6-6 4 3 8-10M15 4h6v6",
    pie: "M12 3v9h9A9 9 0 1112 3z",
    bulb: "M9 18h6M10 21h4M8 14a6 6 0 118 0l-1 2H9z",
    calendar: "M5 5h14v15H5zM8 2v6M16 2v6M5 10h14",
    target: "M20 11a8 8 0 11-7-7M16 8l5-5M17 3h4v4M15 12a3 3 0 11-3-3",
    chip: "M8 8h8v8H8zM4 9h4M4 13h4M16 9h4M16 13h4M9 4v4M13 4v4M9 16v4M13 16v4",
    refresh: "M21 12a9 9 0 11-3-6.7M21 4v5h-5",
    search: "M10 4a6 6 0 110 12 6 6 0 010-12M15 15l6 6",
    settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
    sun: "M12 7a5 5 0 110 10 5 5 0 010-10M12 1v3M12 20v3M1 12h3M20 12h3",
    close: "M6 6l12 12M6 18L18 6",
    arrow: "M5 12h14M14 6l6 6-6 6",
    plus: "M12 5v14M5 12h14",
    check: "M5 12l5 5L20 6",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.chart} />
    </svg>
  );
}
function Drawer({ title, onClose, children, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const d = ref.current;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`studio-dialog ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="Close details" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
function Sparkline({ series, labels = [], dates = [], format }) {
  const [hover, setHover] = useState(null);
  const values = series.flatMap((s) => s.filter(Number.isFinite));
  if (values.length < 2)
    return <div className="empty-chart">Historical data unavailable</div>;
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1,
    fmt = format ?? ((v) => num(v, 2)),
    colors = ["#087e63", "#9770db"],
    yOf = (v) => 82 - ((v - min) / range) * 72;
  // Scrub: map the pointer's horizontal position to the nearest point of every series.
  function scrub(e) {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    setHover(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
  }
  const points =
    hover == null
      ? []
      : series.map((s, k) => {
          const i = Math.round(hover * (s.length - 1)),
            value = s[i];
          return {
            k,
            value,
            date: dates[k]?.[i] ?? dates[0]?.[i],
            x: s.length > 1 ? i / (s.length - 1) : 0,
          };
        }).filter((p) => Number.isFinite(p.value));
  const lead = points[0];
  return (
    <div className="spark">
      <div
        className="spark-plot"
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        <svg
          viewBox="0 0 480 90"
          role="img"
          aria-label={labels.join(" and ")}
          preserveAspectRatio="none"
        >
          {[15, 45, 75].map((y) => (
            <path key={y} d={`M0 ${y}H480`} className="gridline" />
          ))}
          {series.map((s, k) => (
            <polyline
              key={k}
              fill="none"
              stroke={colors[k] ?? colors[1]}
              strokeWidth="2.2"
              vectorEffect="non-scaling-stroke"
              points={s
                .map((v, i) => `${(i * 480) / (s.length - 1 || 1)},${yOf(v)}`)
                .join(" ")}
            />
          ))}
        </svg>
        {lead && (
          <>
            <span className="spark-cursor" style={{ left: `${lead.x * 100}%` }} />
            {points.map((p) => (
              <span
                key={p.k}
                className="spark-dot"
                style={{
                  left: `${p.x * 100}%`,
                  top: `${(yOf(p.value) / 90) * 100}%`,
                  background: colors[p.k] ?? colors[1],
                }}
              />
            ))}
            <div
              className="spark-tip"
              style={{
                left: `${lead.x * 100}%`,
                transform: `translateX(${lead.x > 0.7 ? "-100%" : lead.x < 0.3 ? "0" : "-50%"})`,
              }}
            >
              {lead.date && <b>{lead.date}</b>}
              {points.map((p) => (
                <span key={p.k} style={{ color: colors[p.k] ?? colors[1] }}>
                  {labels[p.k] ? `${labels[p.k]} ` : ""}
                  {fmt(p.value)}
                  {p.date && p.date !== lead.date ? ` · ${p.date}` : ""}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="chart-labels">
        {labels.map((s, i) => (
          <span key={s} style={{ color: colors[i] ?? colors[1] }}>
            — {s}
          </span>
        ))}
      </div>
    </div>
  );
}
function Badge({ children, value }) {
  return <span className={`badge ${tone(value ?? children)}`}>{children}</span>;
}
function Empty({ children }) {
  return <div className="studio-empty">{children}</div>;
}
// AI catalyst tracker: one collapsible folder per ticker. Open/closed choices are remembered in this browser.
// Items saved with no ticker apply to every stock ("Stock (blank = all)" in the item dialog).
const GENERAL_FOLDER = "All stocks";
const TRACKER_FOLDERS_KEY = "hedgehub.builder.trackerFolders";
function readTrackerFolders() {
  try {
    const stored = JSON.parse(localStorage.getItem(TRACKER_FOLDERS_KEY));
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}
function writeTrackerFolders(state) {
  try {
    localStorage.setItem(TRACKER_FOLDERS_KEY, JSON.stringify(state));
  } catch {}
}

// "AI suggestions" dialog: AI market topics (written through the MCP connector) sorted into tabs, plus the
// TradingAgents suggestions, which all stay in the ticker tab.
const SUGGESTION_TAB_EMPTY = {
  general: "No general topics yet. Ask your AI connector to add some with category general, commodity or forex.",
  ticker: "Nothing for this stock yet.",
  social: "No social topics yet. Ask your AI connector to add some with category social.",
  other: "No topics about other tickers yet.",
};
function ItemAction({ added, onAdd, onRemove }) {
  return added ? (
    <div className="added-row">
      <span className="badge positive">Added ✓</span>
      <button className="danger-button" onClick={onRemove}>
        Remove
      </button>
    </div>
  ) : (
    <div>
      <button onClick={onAdd}>Add to strategy</button>
    </div>
  );
}
function TopicCard({ topic, added, onAdd, onRemove }) {
  return (
    <article className="detail-box topic-card">
      <div className="topic-head">
        <strong>{topic.title}</strong>
        <span className="badge neutral">
          {MARKET_TOPIC_CATEGORY_LABELS[topic.category] ?? topic.category}
        </span>
      </div>
      <div className="topic-meta">
        <span>Weight {topic.weight}</span>
        <span className="positive">Bullish {topic.bullishScore}</span>
        <span className="negative">Bearish {topic.bearishScore}</span>
        {(topic.symbols ?? []).map((s) => (
          <span className="badge neutral" key={s}>
            {s}
          </span>
        ))}
      </div>
      <p className="topic-summary">{topic.summary}</p>
      <small>AI market topic · updated {sourceDate(topic.updatedAt)}</small>
      <ItemAction added={added} onAdd={() => onAdd(topic)} onRemove={() => onRemove(added)} />
    </article>
  );
}
function SuggestionsPanel({
  topics,
  suggestions,
  symbol,
  agentAvailable,
  onRefreshAgent,
  items,
  onAddTopic,
  onAddSuggestion,
  onRemoveItem,
  scheduleHref = null,
}) {
  const [chosen, setChosen] = useState(null);
  const addedItem = (key) => items.find((i) => i.eventKey === key);
  const grouped = useMemo(() => {
    const groups = { general: [], ticker: [], social: [], other: [] };
    for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
      const tab = suggestionTab(
        { kind: "topic", category: topic.category, symbols: topic.symbols },
        symbol,
      );
      groups[tab].push({ kind: "topic", topic });
    }
    for (const suggestion of suggestions) {
      groups[suggestionTab({ kind: "agent" }, symbol)].push({ kind: "agent", suggestion });
    }
    return groups;
  }, [topics, suggestions, symbol]);
  const active =
    chosen ??
    (grouped.ticker.length
      ? "ticker"
      : (SUGGESTION_TABS.find((tab) => grouped[tab].length) ?? "general"));
  const tabLabel = {
    general: "General",
    ticker: symbol,
    social: "Social",
    other: "Other tickers",
  };
  const tabHint = {
    general: "Market-wide topics: macro, rates, indices, commodities and forex.",
    ticker: `Topics about ${symbol} and TradingAgents suggestions.`,
    social: "Social-media and retail-sentiment themes.",
    other: "Topics about other tickers.",
  };
  return (
    <>
      <p>
        {agentAvailable
          ? "Suggested checkpoints from the latest agent reports and AI market topics. Review each one before enabling its rating contribution."
          : "TradingAgents is not configured. Manual tracking and AI market topics are still available."}
      </p>
      <button onClick={onRefreshAgent}>Refresh AI suggestions</button>
      {scheduleHref ? (
        <a
          className="suggest-schedule-link"
          href={scheduleHref}
          target="_blank"
          rel="noopener noreferrer"
          title="Opens Admin, Analysis tasks in a new tab"
        >
          AI schedule templates ↗
        </a>
      ) : null}
      <div className="suggest-tabs" role="tablist">
        {SUGGESTION_TABS.map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={active === tab}
            onClick={() => setChosen(tab)}
          >
            {tabLabel[tab]} <span className="count">{grouped[tab].length}</span>
          </button>
        ))}
      </div>
      <p className="subtle">{tabHint[active]}</p>
      {grouped[active].length ? (
        grouped[active].map((entry) =>
          entry.kind === "topic" ? (
            <TopicCard
              key={`topic-${entry.topic.id}`}
              topic={entry.topic}
              added={addedItem(`market topic ${entry.topic.id}`)}
              onAdd={onAddTopic}
              onRemove={(item) => onRemoveItem(item.id)}
            />
          ) : (
            <article className="detail-box" key={entry.suggestion.id}>
              <strong>{entry.suggestion.title}</strong>
              <p>
                {entry.suggestion.symbol} · {entry.suggestion.sentiment}
              </p>
              <ItemAction
                added={addedItem(entry.suggestion.eventKey)}
                onAdd={() => onAddSuggestion(entry.suggestion)}
                onRemove={() => onRemoveItem(addedItem(entry.suggestion.eventKey).id)}
              />
            </article>
          ),
        )
      ) : (
        <Empty>{SUGGESTION_TAB_EMPTY[active]}</Empty>
      )}
    </>
  );
}
function Field({ label, children }) {
  return (
    <label className="studio-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
const AGENT_TERMINAL = ["completed", "completed_with_errors", "failed", "stopped"];
// Saved research for a stock. Older saves also hold entries for runs that failed or never finished; those are not results.
const agentResult = (agent, s) =>
  agent?.valuations?.find(
    (v) => v.symbol === s && (!v.status || v.status === "completed"),
  );
// TradingAgents passes the model provider's raw error through; show its message only.
const agentErrorText = (e) => {
  const text = String(e ?? "");
  const message = /'message': '([^']+)'/.exec(text)?.[1] ?? text;
  return message.replace(/\s*\(request_id:[^)]*\)/, "").slice(0, 200);
};
// The latest run that covered a stock, from its own run or the strategy-wide one, whichever started last.
function agentRunFor(agent, s, polling) {
  const own = agent?.runsBySymbol?.[s];
  const wide = agent?.jobs?.[s] && agent.runId ? agent : null;
  const useOwn =
    own && (!wide || String(own.lastStarted ?? "") >= String(wide.lastStarted ?? ""));
  const run = useOwn
    ? { status: own.status, job: own.job, started: own.lastStarted, error: own.error }
    : wide
      ? { status: wide.status, job: wide.jobs[s], started: wide.lastStarted, error: wide.error }
      : null;
  if (!run) return polling ? { running: true } : null;
  const jobOpen = run.job
    ? !AGENT_TERMINAL.includes(run.job.status)
    : true;
  const running =
    polling || (!AGENT_TERMINAL.includes(run.status) && jobOpen);
  const failure =
    !running && (run.error || (run.job?.status === "failed" && (run.job.error || "The run failed.")));
  return {
    running,
    started: run.started,
    progress: run.job?.progress,
    failure: failure ? agentErrorText(failure) : "",
    failedAt: run.job?.at ?? run.started,
  };
}
function sourceDate(v) {
  return v
    ? new Date(v).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not checked";
}
const SPREAD_PRESETS = {
  tight: { max: 1 },
  medium: { min: 1, max: 3 },
  wide: { min: 3 },
};
const quoteSize = (l) =>
  l.bidSize != null && l.askSize != null ? Math.min(l.bidSize, l.askSize) : null;
function minLegValue(r, get) {
  const vals = (r.legs ?? []).map(get);
  return vals.length && vals.every((v) => v != null) ? Math.min(...vals) : null;
}
function maxLegSpreadPct(r) {
  const vals = (r.legs ?? []).map((l) =>
    l.ask > 0 && l.bid != null ? ((l.ask - l.bid) / ((l.ask + l.bid) / 2)) * 100 : null,
  );
  return vals.length && vals.every((v) => v != null) ? Math.max(...vals) : null;
}
function spreadInRange(v, { min = -Infinity, max = Infinity } = {}) {
  return v != null && v >= min && v < max;
}
const SORT_VALUES = {
  symbol: (r) => r.symbol,
  strategy: (r) => r.name,
  quoteSize: (r) => minLegValue(r, quoteSize),
  quotePrice: (r) => r.legs[0]?.bid ?? null,
  expiry: (r) => r.expiry,
  dte: (r) => r.dte,
  spot: (r) => r.spot,
  strike: (r) => r.legs[0]?.strike ?? null,
  annRet: (r) => r.annRetPct,
  ev: (r) => r.evPerBp,
  ivRank: (r) => r.ivRank,
  liquidity: (r) => r.liquidity,
  earnings: (r) => r.earnings,
  downBe: (r) => r.downBreakeven,
  cost: (r) => r.netDebit,
  maxProfit: (r) => (r.maxProfit == null ? Infinity : r.maxProfit),
  maxLoss: (r) => (r.maxLoss == null ? -Infinity : r.maxLoss),
  iv: (r) => r.iv,
  minOi: (r) => r.minOi,
  overall: (r) => r.overall,
};
function compareRows(a, b, { key, dir }) {
  const get = SORT_VALUES[key] ?? SORT_VALUES.overall;
  const x = get(a),
    y = get(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  const c = typeof x === "string" ? x.localeCompare(y) : x - y;
  return dir === "asc" ? c : -c;
}
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}

const NO_RESULTS = {};
const NOT_IN_SNAPSHOT = { events: [], warnings: ["Not saved in this snapshot."] };
function snapshotLabel(s) {
  const when = new Date(s.capturedAt).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${when} · ${s.rows} result${s.rows === 1 ? "" : "s"}${s.parts.includes("distribution") ? "" : " · no option chain"}`;
}
function daysAgo(iso) {
  const days = Math.round((Date.now() - Date.parse(iso)) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

export default function BuilderApp({ presentation = null }) {
  const basePath = presentation?.basePath ?? "/builder";
  const demo = new URLSearchParams(location.search).get("demo") === "1";
  const [auth, setAuth] = useState(demo ? { username: "Demo" } : null),
    [ready, setReady] = useState(demo),
    [bootstrap, setBootstrap] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (demo) return;
    let live = true;
    Promise.all([api("/auth/config"), api("/auth/me").catch(() => null)])
      .then(([config, session]) => {
        if (live) {
          setBootstrap(config.needsBootstrap);
          setAuth(session?.user ?? null);
          setReady(true);
        }
      })
      .catch((e) => {
        if (live) {
          setError(e.message);
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, [demo]);
  async function login(username, password) {
    setBusy(true);
    setError("");
    try {
      const r = await api(bootstrap ? "/auth/bootstrap" : "/auth/login", {
        username,
        password,
      });
      setAuth(r.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!ready)
    return <div className="studio-loading">Opening Strategy Studio…</div>;
  if (!auth)
    return (
      <div className="studio-login">
        <AuthScreen
          needsBootstrap={bootstrap}
          error={error}
          busy={busy}
          onLogin={login}
          onBootstrap={login}
        />
        <a href={`${basePath}?demo=1`}>Explore the interactive demo</a>
        <a href="/">Classic dashboard</a>
      </div>
    );
  return (
    <Workspace
      presentation={presentation}
      demo={demo}
      user={auth}
      logout={async () => {
        await api("/auth/logout", {});
        setAuth(null);
      }}
    />
  );
}
function Workspace({ demo, user, logout, presentation }) {
  const basePath = presentation?.basePath ?? "/builder";
  const storageKey = presentation?.storageKey ?? "hedgehub-studio-demo";
  const routeView = () => {
    const tail = location.pathname.replace(/\/$/, "").split("/").pop();
    return (presentation
      ? [
          "scanner",
          "distributions",
          "analytics",
          "events",
          "tracker",
          "backtests",
          "economy",
        ]
      : ["tracker", "backtests", "economy", "stock-analysis"]
    ).includes(tail)
      ? tail
      : "workspace";
  };
  const [macro, setMacro] = useState(null),
    [macroError, setMacroError] = useState("");
  const [distributionDays, setDistributionDays] = useState(365),
    [distributionData, setDistributionData] = useState(null),
    [distributionLoading, setDistributionLoading] = useState(false),
    [distributionError, setDistributionError] = useState("");
  const sample = useMemo(() => (demo ? demoWorkspace() : null), [demo]);
  const [strategy, setStrategy] = useState(
      sample?.definition ?? DEFAULT_STRATEGY,
    ),
    [strategyId, setStrategyId] = useState("default"),
    [saved, setSaved] = useState([]),
    [layout, setLayout] = useState(DEFAULT_LAYOUT),
    [dirty, setDirty] = useState(false);
  const [liveRows, setRows] = useState(sample?.rows ?? []),
    [liveDatasets, setDatasets] = useState(sample?.datasets ?? {}),
    [items, setItems] = useState(sample?.items ?? []),
    [agent, setAgent] = useState(sample?.agent ?? null),
    [agentAvailable, setAgentAvailable] = useState(false);
  const [selectedId, setSelectedId] = useState(sample?.rows[0]?.id ?? ""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [job, setJob] = useState(null),
    [busy, setBusy] = useState(false),
    [research, setResearch] = useState(null),
    [researchError, setResearchError] = useState(""),
    [researchingSymbols, setResearchingSymbols] = useState(() => new Set());
  const [modal, setModal] = useState(null),
    [includeCatalysts, setIncludeCatalysts] = useState(true),
    [minAnnRet, setMinAnnRet] = useState(""),
    [minLiquidity, setMinLiquidity] = useState(""),
    [maxIvRank, setMaxIvRank] = useState(""),
    [minDte, setMinDte] = useState(""),
    [maxDte, setMaxDte] = useState(""),
    [earningsFilter, setEarningsFilter] = useState("all"),
    [pageSize, setPageSize] = useState(5),
    [quoteSizeFilter, setQuoteSizeFilter] = useState("all"),
    [spreadFilter, setSpreadFilter] = useState("all"),
    [optVolFilter, setOptVolFilter] = useState("all"),
    [maxLossFilter, setMaxLossFilter] = useState("all"),
    [templateFilter, setTemplateFilter] = useState("all"),
    [minRating, setMinRating] = useState(""),
    [expiryFilter, setExpiryFilter] = useState("all"),
    [sort, setSort] = useState({ key: "overall", dir: "desc" }),
    [page, setPage] = useState(0),
    [expanded, setExpanded] = useState(false),
    [resultsView, setResultsView] = useState("table");
  const [view, setView] = useState(routeView);
  const [agentFilter, setAgentFilter] = useState("All"),
    [showResolved, setShowResolved] = useState(true),
    [trackerFolders, setTrackerFolders] = useState(readTrackerFolders),
    [marketTopics, setMarketTopics] = useState([]),
    [volDays, setVolDays] = useState(60),
    [past, setPast] = useState(30),
    [future, setFuture] = useState(30),
    [events, setEvents] = useState({ past: null, future: null }),
    [eventExtras, setEventExtras] = useState(() => {
      try { return JSON.parse(localStorage.getItem("studio-event-extras") ?? "[]"); } catch { return []; }
    }),
    [tests, setTests] = useState([]);
  const [enabledScans, setEnabledScans] = useState(() => {
    const ready = HEDGE_SCAN_STRATEGIES.filter((s) => s.status === "ready").map((s) => s.id);
    try {
      const saved = JSON.parse(localStorage.getItem("studio-hedge-scans"));
      return Array.isArray(saved) ? saved.filter((id) => ready.includes(id)) : ready;
    } catch {
      return ready;
    }
  });
  const [liveHedgeScan, setHedgeScan] = useState({ busy: false, error: "", results: {}, at: null, waitingUntil: null });
  const [selectedMonitoredStock, setSelectedMonitoredStock] = useState(null);
  // Historical snapshots: a saved scan of the selected stock replaces the live rows, datasets and panel data
  // below. While `history` is set, nothing here requests live market data.
  const [snapshotList, setSnapshotList] = useState([]),
    [snapshot, setSnapshot] = useState(null),
    [snapshotBusy, setSnapshotBusy] = useState(false);
  const history =
    snapshot?.scan && snapshot.symbol === selectedMonitoredStock ? snapshot : null;
  const rows = history ? history.scan.rows : liveRows;
  const datasets = useMemo(
    () => (history ? { [history.symbol]: history.scan.dataset } : liveDatasets),
    [history, liveDatasets],
  );
  const hedgeScan = useMemo(
    () =>
      history
        ? {
            busy: false,
            error: "",
            results: history.hedges?.results ?? NO_RESULTS,
            at: history.hedges?.generatedAt ?? null,
            waitingUntil: null,
          }
        : liveHedgeScan,
    [history, liveHedgeScan],
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode re-runs effects: it must come back to true
    return () => void (alive.current = false);
  }, []);
  const builderWait = useCountdown(busy ? job?.waitingUntil : null);
  const hedgeWait = useCountdown(hedgeScan.busy ? hedgeScan.waitingUntil : null);
  function toggleScan(id) {
    setEnabledScans((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem("studio-hedge-scans", JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  // Vanilla and Cash-Covered Put produce table rows, so their count is the table's.
  function tableCount(st) {
    if (!["vanilla", "cash_covered_put"].includes(st.id) || !rows.length) return null;
    return rows.filter(
      (r) =>
        (!selectedMonitoredStock || r.symbol === selectedMonitoredStock) &&
        hedgeChoicesForRow(r).includes(st.label),
    ).length;
  }
  async function runHedgeScan(only = enabledScans, symbols = null) {
    if (!only.length || history) return;
    setHedgeScan((h) => ({ ...h, busy: true, error: "", waitingUntil: null }));
    try {
      const started = await api("/hedge-scan/jobs", {
        strategies: only,
        symbols: symbols ?? (selectedMonitoredStock ? [selectedMonitoredStock] : strategy.symbols),
      });
      // Poll until done. If the data provider's rate limit forces a wait, the server waits it out and
      // reports `waitingUntil`; nobody needs to click Scan again.
      let j;
      let failures = 0;
      do {
        await sleep(1200);
        if (!alive.current) return;
        try {
          j = await api(`/hedge-scan/jobs/${started.id}`);
          failures = 0;
        } catch (e) {
          // One failed poll must not abandon a scan that is still running on the server.
          if (++failures >= 5 || /not found/i.test(e.message)) throw e;
          j = { status: "running" };
          continue;
        }
        setHedgeScan((h) => ({ ...h, waitingUntil: j.waitingUntil ?? null }));
      } while (j.status === "running");
      if (j.status !== "completed") throw new Error(j.error || "Scan failed");
      setHedgeScan((h) => ({
        busy: false,
        error: "",
        results: { ...h.results, ...j.result.results },
        at: j.result.generatedAt,
        waitingUntil: null,
      }));
    } catch (e) {
      if (alive.current) setHedgeScan((h) => ({ ...h, busy: false, error: e.message, waitingUntil: null }));
    }
  }
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const w = Number(localStorage.getItem("studio-sidebar-width"));
      return w >= 160 && w <= 520 ? w : 184;
    } catch {
      return 184;
    }
  });
  function startSidebarResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    let latest = startW;
    const move = (ev) => {
      latest = Math.min(520, Math.max(160, startW + ev.clientX - startX));
      setSidebarWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      try {
        localStorage.setItem("studio-sidebar-width", String(latest));
      } catch {}
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const [testSettings, setTestSettings] = useState({
    start: addDays(dateOnly(Date.now()), -180),
    end: dateOnly(Date.now()),
    capital: 100000,
    optionSlippage: 2,
    stockSlippage: 5,
    rate: 4.25,
    rollDays: 5,
    stopLoss: 20,
    takeProfit: 25,
  });
  const poll = useRef(null),
    selectionRequest = useRef(0),
    symbolPolls = useRef({});
  useEffect(
    () => () => Object.values(symbolPolls.current).forEach(clearTimeout),
    [],
  );
  const polymarketResult = enabledScans.includes("polymarket_hedge") ? hedgeScan.results.polymarket_hedge : null;
  const pmRows = useMemo(
    () => (polymarketResult?.rows ?? []).map((r) => polymarketTableRow(r, hedgeScan.at)),
    [polymarketResult, hedgeScan.at],
  );
  const row = useMemo(() => {
    const pool = [...rows, ...pmRows].filter(
      (r) =>
        (!selectedMonitoredStock || r.symbol === selectedMonitoredStock) &&
        r.legs.length,
    );
    return pool.find((r) => r.id === selectedId) ?? pool[0] ?? null;
  }, [rows, pmRows, selectedId, selectedMonitoredStock]);
  // A snapshot is scored with the tracking items it was scanned with, so its ratings read as they did then.
  const scoreItems = history?.scan.items ?? items;
  const ratedRows = useMemo(
    () => rows.map((r) => applyCatalysts(r, scoreItems, includeCatalysts)),
    [rows, scoreItems, includeCatalysts],
  );
  const selected = ratedRows.find((r) => r.id === row?.id),
    symbol = selectedMonitoredStock ?? row?.symbol ?? strategy.symbols[0],
    dataset = datasets[symbol],
    tech = useMemo(() => technicals(dataset?.bars ?? []), [dataset]);
  // Stock-side inputs for the Option and price summary panel (underlying IV first, then the selected row's).
  const summaryStats = useMemo(
    () => ({
      rsi: tech.rsi,
      support: tech.support,
      resistance: tech.resistance,
      hv: tech.hv,
      emaAverage: emaAverage(dataset?.bars ?? []),
      iv: research?.volatility?.history?.at(-1)?.iv ?? research?.volatility?.iv ?? (row?.modeled ? null : row?.iv),
      ivRank: research?.volatility?.historical?.rank,
    }),
    [tech, dataset, research, row],
  );
  // Polymarket rows are scored separately, so the tracking strip scores the items against the symbol on its own.
  const trackingRow = useMemo(
    () => selected ?? applyCatalysts({ symbol, template: row?.template, baseScore: null, scoreRange: [0, 0] }, scoreItems, includeCatalysts),
    [selected, symbol, row?.template, scoreItems, includeCatalysts],
  );
  const tableRows = useMemo(() => [...ratedRows, ...pmRows], [ratedRows, pmRows]);
  const quoteSizeAvailable = tableRows.some((r) => minLegValue(r, quoteSize) != null);
  const chainScanRows = useMemo(
    () => tableRows.filter((r) => r.symbol === symbol && r.legs.length > 0),
    [tableRows, symbol],
  );
  const filtered = useMemo(
    () =>
      tableRows
        .filter(
          (r) =>
            (selectedMonitoredStock == null || r.symbol === selectedMonitoredStock) &&
            r.legs.length > 0 &&
            (templateFilter === "all" || r.template === templateFilter) &&
            (expiryFilter === "all" || r.expiry === expiryFilter) &&
            (!minRating ||
              (r.overall != null && r.overall >= Number(minRating))) &&
            (minAnnRet === "" || (r.annRetPct != null && r.annRetPct >= Number(minAnnRet))) &&
            (minLiquidity === "" || (r.liquidity != null && r.liquidity >= Number(minLiquidity))) &&
            (maxIvRank === "" || (r.ivRank != null && r.ivRank <= Number(maxIvRank))) &&
            (minDte === "" || (r.dte != null && r.dte >= Number(minDte))) &&
            (maxDte === "" || (r.dte != null && r.dte <= Number(maxDte))) &&
            (quoteSizeFilter === "all" ||
              (minLegValue(r, quoteSize) ?? -1) > Number(quoteSizeFilter)) &&
            (spreadFilter === "all" || spreadInRange(maxLegSpreadPct(r), SPREAD_PRESETS[spreadFilter])) &&
            (optVolFilter === "all" || (minLegValue(r, (l) => l.volume) ?? -1) >= Number(optVolFilter)) &&
            (maxLossFilter === "all" || (r.maxLoss != null && r.maxLoss >= Number(maxLossFilter))) &&
            (earningsFilter === "all" ||
              (earningsFilter === "clear" ? r.earnings === "Clear" : r.earnings !== "Before expiry")),
        )
        .sort((a, b) => compareRows(a, b, sort)),
    [tableRows, selectedMonitoredStock, templateFilter, expiryFilter, minRating, minAnnRet, minLiquidity, maxIvRank, minDte, maxDte, earningsFilter, quoteSizeFilter, spreadFilter, optVolFilter, maxLossFilter, sort],
  );
  const valuation = history ? (history.scan.valuation ?? null) : agentResult(agent, symbol),
    valuationRun = agentRunFor(agent, symbol, researchingSymbols.has(symbol)),
    visibleItems = items.filter(
      (i) =>
        (!i.symbol || i.symbol === symbol) &&
        (showResolved || i.status !== "resolved") &&
        (view !== "tracker" ||
          agentFilter === "All" ||
          i.sentiment === agentFilter),
    );
  useEffect(() => {
    let live = true;
    setDistributionData(null);
    setDistributionError("");
    if (!dataset) {
      setDistributionLoading(false);
      return;
    }
    if (history) {
      const saved = history.distribution;
      if (!saved)
        setDistributionError("The option chain was not saved in this snapshot.");
      else {
        const limit = addDays(saved.asOf.slice(0, 10), distributionDays);
        setDistributionData({
          ...saved,
          contracts: saved.contracts.filter((c) => c.expiration <= limit),
          warnings: [
            ...(saved.warnings ?? []),
            ...(saved.days < distributionDays
              ? ["This snapshot saved the 1-year chain only; later expiries are not available."]
              : []),
          ],
        });
      }
      setDistributionLoading(false);
      return;
    }
    if (demo) {
      setDistributionData({
        ...dataset.distribution,
        contracts: (dataset.distribution?.contracts ?? []).filter(
          (c) =>
            c.expiration <=
            addDays(dataset.asOf.slice(0, 10), distributionDays),
        ),
      });
      setDistributionLoading(false);
      return;
    }
    setDistributionLoading(true);
    api(`/builder/distributions/${symbol}?days=${distributionDays}`)
      .then((data) => {
        if (live) setDistributionData(data);
      })
      .catch((e) => {
        if (live) setDistributionError(e.message);
      })
      .finally(() => {
        if (live) setDistributionLoading(false);
      });
    return () => {
      live = false;
    };
  }, [symbol, dataset?.asOf, demo, distributionDays, history]);
  useEffect(() => {
    setSnapshot(null);
    setSnapshotList([]);
  }, [selectedMonitoredStock]);
  // The list is re-read after each live scan of the stock, so today's snapshot shows up straight away.
  const liveAsOf = selectedMonitoredStock ? liveDatasets[selectedMonitoredStock]?.asOf : null;
  useEffect(() => {
    if (demo || !selectedMonitoredStock) return;
    let live = true;
    api(`/builder/snapshots?symbol=${encodeURIComponent(selectedMonitoredStock)}`)
      .then((data) => live && setSnapshotList(data.snapshots ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [demo, selectedMonitoredStock, liveAsOf]);
  async function openSnapshot(id) {
    setError("");
    if (!id) {
      // Drop the saved chain with the snapshot, so no live request is ever built from snapshot data.
      setDistributionData(null);
      setSnapshot(null);
      return;
    }
    setSnapshotBusy(true);
    try {
      const s = await api(`/builder/snapshots/${id}`);
      setDistributionData(null);
      setSnapshot(s);
      setSelectedId(s.scan?.rows?.[0]?.id ?? "");
      setPage(0);
      setNotice("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSnapshotBusy(false);
    }
  }
  useEffect(() => {
    if (view !== "economy" || demo || macro) return;
    let live = true;
    api("/macro-dashboard")
      .then((data) => {
        if (live) setMacro(data.macroDashboard);
      })
      .catch((e) => {
        if (live) setMacroError(e.message);
      });
    return () => {
      live = false;
    };
  }, [view, demo]);
  function navigate(next) {
    const p = next === "workspace" ? basePath : `${basePath}/${next}`;
    window.history.pushState({}, "", p + (demo ? "?demo=1" : ""));
    setView(next);
  }
  useEffect(() => {
    const pop = () => setView(routeView());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    document.body.classList.add("studio-body");
    return () => document.body.classList.remove("studio-body");
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = layout.theme;
  }, [layout.theme]);
  // AI market topics for the suggestions dialog; refetched each time the dialog opens.
  const suggestionsOpen = modal?.type === "suggestions";
  useEffect(() => {
    if (demo) return;
    let live = true;
    api("/builder/market-topics")
      .then((data) => live && setMarketTopics(data.topics ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [demo, suggestionsOpen]);
  useEffect(() => {
    if (demo) {
      try {
        const local = JSON.parse(localStorage.getItem(storageKey));
        if (local) {
          setLayout(restoreLayout(local.layout));
          setItems(local.items ?? sample.items);
          setStrategy(local.strategy ?? sample.definition);
        }
      } catch {}
      return;
    }
    api("/builder/strategies")
      .then((data) => {
        setSaved(data.strategies);
        setAgentAvailable(data.agentConfigured);
        if (data.strategies.length) loadStrategy(data.strategies[0].id);
      })
      .catch((e) => setError(e.message));
    return () => clearTimeout(poll.current);
  }, []);
  useEffect(() => {
    if (
      !agent?.runId ||
      demo ||
      ["completed", "completed_with_errors", "failed", "stopped"].includes(
        agent.status,
      )
    )
      return;
    const timer = setTimeout(
      () =>
        api(`/builder/strategies/${strategyId}/research`)
          .then((data) => {
            setAgent(data);
            if (data.trackedItems) setItems(data.trackedItems);
          })
          .catch((e) => setError(e.message)),
      10000,
    );
    return () => clearTimeout(timer);
  }, [agent, demo, strategyId]);
  // A per-stock run that is still going server-side (e.g. after a page reload) resumes its status checks.
  const ownRunStatus = agent?.runsBySymbol?.[symbol]?.status;
  useEffect(() => {
    if (
      demo ||
      !symbol ||
      !ownRunStatus ||
      AGENT_TERMINAL.includes(ownRunStatus) ||
      researchingSymbols.has(symbol)
    )
      return;
    checkAgentSymbol(symbol);
  }, [symbol, ownRunStatus, demo]);
  async function loadStrategy(id) {
    if (busy) {
      setError("Finish or cancel the current run before switching strategies.");
      return;
    }
    try {
      const s = await api(`/builder/strategies/${id}`);
      setStrategyId(id);
      setStrategy(s.definition);
      setLayout(restoreLayout(s.layout));
      setItems(s.items);
      setAgent(s.agent);
      setDirty(false);
      setRows([]);
      setSelectedId("");
      setDatasets({});
    } catch (e) {
      setError(e.message);
    }
  }
  async function save(asNew = false) {
    if (demo) {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ strategy, layout, items }),
      );
      setNotice("Demo layout saved in this browser.");
      setDirty(false);
      return strategyId;
    }
    const id = asNew ? crypto.randomUUID() : strategyId;
    const s = await api(
      `/builder/strategies/${id}`,
      { definition: strategy, layout },
      "PUT",
    );
    setStrategyId(id);
    setSaved((v) => [s, ...v.filter((x) => x.id !== id)]);
    setDirty(false);
    setNotice("Strategy and workspace saved.");
    return id;
  }
  function updateStrategy(patch) {
    setStrategy((s) => ({ ...s, ...patch }));
    setDirty(true);
  }
  function updateLayout(patch) {
    setLayout((l) => ({ ...l, ...patch }));
    setDirty(true);
  }
  function togglePanel(key) {
    updateLayout({
      hidden: layout.hidden.includes(key)
        ? layout.hidden.filter((k) => k !== key)
        : [...layout.hidden, key],
    });
  }
  function movePanel(id, direction) {
    const order = [...layout.order],
      i = order.indexOf(id),
      j = i + direction;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    updateLayout({ order });
  }
  function dropPanel(e, target) {
    e.preventDefault();
    const from = e.dataTransfer.getData("text/plain");
    if (!layout.order.includes(from) || from === target) return;
    const order = layout.order.filter((x) => x !== from);
    order.splice(order.indexOf(target), 0, from);
    updateLayout({ order });
  }
  function metricHidden(panel, label) {
    return layout.metrics?.[panel]?.includes(label);
  }
  function metrics(panel, entries) {
    return (
      <div className={`metrics ${panel === "payoff" ? "hero-metrics" : ""}`}>
        {entries
          .filter(([label]) => !metricHidden(panel, label))
          .map(([label, value, t]) => (
            <div key={label}>
              <span>{label}</span>
              <strong className={t || ""}>{value}</strong>
            </div>
          ))}
      </div>
    );
  }
  async function run(kind = "scan", only = null) {
    if (kind === "scan" && history) {
      setError("");
      setNotice("You are viewing a saved snapshot. Go back to live to scan.");
      return;
    }
    if (kind === "scan" && !demo && hedgeScan.busy) return; // a scan (possibly waiting out a rate limit) is already running
    const runStrategy = only ? { ...strategy, symbols: [only] } : strategy;
    const templates = templatesForHedgeChoices(enabledScans);
    if (kind === "scan" && !demo) {
      // Every ticked hedge choice scans. Vanilla / Cash-Covered Put fill the options table below;
      // the others (Polymarket Hedge, Probability Mismatch, ...) return their own results.
      const otherChoices = enabledScans.filter((id) => !HEDGE_TEMPLATES[id]);
      if (!templates.length && !otherChoices.length) {
        setError("");
        setNotice("Tick at least one hedge choice to scan.");
        return;
      }
      if (otherChoices.length) void runHedgeScan(otherChoices, only ? [only] : null);
    }
    const mergeRows = (prev, next) =>
      only ? [...prev.filter((r) => r.symbol !== only), ...next] : next;
    setError("");
    setBusy(true);
    setNotice("");
    try {
      if (demo) {
        validateStrategy(runStrategy);
        if (kind === "scan") {
          const d = demoWorkspace(runStrategy);
          setRows((prev) => mergeRows(prev, d.rows));
          setPage(0);
          setDatasets((prev) => (only ? { ...prev, ...d.datasets } : d.datasets));
          setSelectedId(d.rows[0]?.id);
          setNotice(
            "Illustrative sample results for AAPL, MSFT and SPY only. Demo options always use modeled pricing.",
          );
        } else {
          setTests(
            strategy.symbols
              .slice(0, 3)
              .filter((s) => sample.datasets[s])
              .map((s) =>
                backtest(
                  sample.datasets[s].bars,
                  { ...strategy, symbols: [s] },
                  testSettings,
                ),
              ),
          );
        }
        setBusy(false);
        return;
      }
      const id = await save();
      const j = await api(`/builder/${kind}`, {
        strategy: runStrategy,
        strategyId: id,
        includeCatalysts,
        // With only non-option choices ticked, still load the stock data so the analytics panels work.
        templates: templates.length ? templates : ["stock"],
        settings: testSettings,
      });
      setJob(j);
      const tick = async () => {
        try {
          const next = await api(`/builder/jobs/${j.id}`);
          setJob(next);
          if (["queued", "running"].includes(next.status)) {
            poll.current = setTimeout(tick, 1200);
            return;
          }
          setBusy(false);
          if (next.status === "completed") {
            if (kind === "scan") {
              setRows((prev) => mergeRows(prev, next.result.rows));
              setPage(0);
              setDatasets((prev) =>
                only ? { ...prev, ...next.result.datasets } : next.result.datasets,
              );
              setSelectedId(next.result.rows[0]?.id ?? "");
              setNotice(
                templates.length
                  ? `${next.result.rows.length} candidates scanned. ${next.result.warnings.join(" · ")}`
                  : `Stock data loaded. ${next.result.warnings.join(" · ")}`,
              );
            } else {
              setTests(next.result.rows);
              setNotice(next.result.warnings.join(" · "));
            }
          } else setError(next.error ?? `Run ${next.status}`);
        } catch (e) {
          setBusy(false);
          setError(e.message);
        }
      };
      void tick();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  async function cancel() {
    if (job) await api(`/builder/jobs/${job.id}/cancel`, {});
    clearTimeout(poll.current);
    setBusy(false);
    setJob(null);
    setNotice("Run cancelled.");
  }
  useEffect(() => {
    setPage(0);
  }, [templateFilter, minRating, expiryFilter, minAnnRet, minLiquidity, maxIvRank, minDte, maxDte, earningsFilter, pageSize, quoteSizeFilter, spreadFilter, optVolFilter, maxLossFilter, sort]);
  useEffect(() => {
    const request = ++selectionRequest.current;
    setResearch(null);
    setResearchError("");
    if (history) {
      setResearch(history.research);
      return;
    }
    if (!dataset || demo) return;
    api(`/builder/research/${symbol}`)
      .then((r) => {
        if (request === selectionRequest.current) setResearch(r);
      })
      .catch((e) => {
        if (request === selectionRequest.current) setResearchError(e.message);
      });
  }, [symbol, dataset?.asOf, demo, history]);
  useEffect(() => {
    if (history) {
      setEvents({
        past: history.events?.past ?? NOT_IN_SNAPSHOT,
        future: history.events?.future ?? NOT_IN_SNAPSHOT,
      });
      return;
    }
    if (!dataset || demo) return;
    let live = true;
    setEvents({ past: null, future: null });
    const extrasParam = eventExtras.length ? `&extras=${eventExtras.join(",")}` : "";
    for (const [direction, days] of [
      ["past", past],
      ["future", future],
    ])
      api(`/builder/events/${symbol}?direction=${direction}&days=${days}${extrasParam}`)
        .then((r) => {
          if (live) setEvents((e) => ({ ...e, [direction]: r }));
        })
        .catch((e) => {
          if (live)
            setEvents((v) => ({
              ...v,
              [direction]: { events: [], warnings: [e.message] },
            }));
        });
    return () => {
      live = false;
    };
  }, [symbol, past, future, eventExtras, dataset?.asOf, demo, history]);
  const getPnl = useCallback(
    ({ spot, date }) => (row ? payoff(row, spot, date) : 0),
    [row],
  );
  async function persistItem(item) {
    setError("");
    try {
      if (demo) {
        const v = {
          ...item,
          id: item.id ?? crypto.randomUUID(),
          checkedAt: new Date().toISOString(),
          history: [
            ...(item.history ?? []),
            { at: new Date().toISOString(), note: "Demo edit" },
          ],
        };
        setItems((list) => [...list.filter((x) => x.id !== v.id), v]);
      } else {
        const id = await save();
        const v = await api(`/builder/strategies/${id}/items`, item);
        setItems((list) => [...list.filter((x) => x.id !== v.id), v]);
      }
      setModal(null);
    } catch (e) {
      setError(e.message);
    }
  }
  async function removeItem(id, keepDialog = false) {
    try {
      if (!demo)
        await api(
          `/builder/strategies/${strategyId}/items/${id}`,
          undefined,
          "DELETE",
        );
      setItems((v) => v.filter((i) => i.id !== id));
      if (!keepDialog) setModal(null);
      setNotice("Item removed from this strategy. Discovery remains enabled.");
    } catch (e) {
      setError(e.message);
    }
  }
  async function refreshAgent() {
    setError("");
    if (demo) {
      setNotice(
        "AI is disabled in the demo. Configure TradingAgents for live discovery.",
      );
      return;
    }
    try {
      const id = await save();
      setAgent(await api(`/builder/strategies/${id}/research`, {}));
    } catch (e) {
      setError(e.message);
    }
  }
  // Shared by the "run" and "check" actions below: `start` controls whether
  // this call starts a new TradingAgents run (POST) or just reads the
  // current status/result (GET) — either way, while a run is in flight it
  // keeps polling until the run reaches a terminal status.
  async function pollAgentSymbol(sym, start) {
    clearTimeout(symbolPolls.current[sym]);
    setResearchingSymbols((s) => new Set(s).add(sym));
    const terminal = AGENT_TERMINAL;
    const stop = () =>
      setResearchingSymbols((s) => {
        const next = new Set(s);
        next.delete(sym);
        return next;
      });
    const tick = async (isStart) => {
      try {
        // Only starting a run saves the strategy first; a status check reads what is already there.
        const id = isStart ? await save() : strategyId;
        const path = `/builder/strategies/${id}/research/${encodeURIComponent(sym)}`;
        const data = await api(path, isStart ? {} : undefined);
        setAgent(data);
        const status = data?.runsBySymbol?.[sym]?.status;
        if (status && !terminal.includes(status))
          symbolPolls.current[sym] = setTimeout(() => tick(false), 2500);
        else stop();
      } catch (e) {
        setError(e.message);
        stop();
      }
    };
    await tick(start);
  }
  async function refreshAgentSymbol(sym) {
    setError("");
    if (demo) {
      setNotice(
        "AI is disabled in the demo. Configure TradingAgents for live discovery.",
      );
      return;
    }
    await pollAgentSymbol(sym, true);
  }
  // Reads the latest status/result for a symbol without starting a new
  // (billable) TradingAgents run. Keeps polling only if a run is already
  // in flight server-side.
  async function checkAgentSymbol(sym) {
    setError("");
    await pollAgentSymbol(sym, false);
  }
  // `forSymbol` is a ticker string; other arguments (e.g. a click event) fall back to the selected stock.
  function newItem(forSymbol) {
    setModal({
      type: "item",
      item: {
        title: "",
        condition: "",
        resolution: "",
        sentiment: "Neutral",
        status: "monitoring",
        points: 0,
        verified: false,
        symbol: typeof forSymbol === "string" ? forSymbol : symbol,
        template: row?.template ?? strategy.template,
        sources: [],
        impactUntil: addDays(dateOnly(Date.now()), 30),
        rationale: "",
      },
    });
  }
  const phase = busy
    ? `${job?.kind === "backtest" ? "Backtesting" : "Scanning"} · ${job?.progress ?? 0}%${
        builderWait ? ` · market-data rate limit reached, resuming automatically in ${builderWait}s` : ""
      }`
    : null;
  function panelHeader(id, title, icon) {
    return (
      <header className="panel-head">
        <h2>
          <Icon name={icon} />
          {title}
        </h2>
        <div>
          <button
            className="quiet"
            onClick={() =>
              id === "past" || id === "future"
                ? setModal({ type: "addCalendarItem" })
                : setModal({ type: "panel", id })
            }
            aria-label={`Customize ${title}`}
          >
            + Item
          </button>
          <button
            className="grip"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", id)}
            onClick={() => setModal({ type: "panel", id })}
            aria-label={`Move or hide ${title}`}
          >
            ⠿
          </button>
          <button
            className="collapse"
            aria-label={`Collapse ${title}`}
            onClick={() =>
              updateLayout({
                collapsed: layout.collapsed.includes(id)
                  ? layout.collapsed.filter((x) => x !== id)
                  : [...layout.collapsed, id],
              })
            }
          >
            {layout.collapsed.includes(id) ? "+" : "−"}
          </button>
        </div>
      </header>
    );
  }
  function eventsPanel(direction) {
    const days = direction === "past" ? past : future,
      data = events[direction];
    return (
      <>
        <div className="event-controls">
          <span>
            {direction === "past"
              ? "Observed price reactions"
              : "Scheduled events · scenario context"}
          </span>
          <div className="segmented">
            {[30, 60, 180, 365].map((n) => (
              <button
                key={n}
                className={n === days ? "active" : ""}
                onClick={() =>
                  direction === "past" ? setPast(n) : setFuture(n)
                }
              >
                {n}D
              </button>
            ))}
          </div>
        </div>
        {data?.events?.length ? (
          <table className="mini-table">
            <tbody>
              {(direction === "past"
                ? [...data.events].sort((a, b) => String(b.date).localeCompare(String(a.date)))
                : data.events
              ).slice(0, 10).map((e, i) => (
                <tr key={i}>
                  <td>
                    <button
                      className={`text-button${e.category === "earnings" ? " event-earnings" : e.category === "announcement" || e.category === "operating-update" || e.category === "regulatory" ? " event-catalyst" : ""}`}
                      onClick={() => setModal({ type: "event", event: e })}
                    >
                      {e.title}
                    </button>
                  </td>
                  <td>{e.date}</td>
                  <td className="mini-table-values">
                    {direction === "past" ? (
                      e.actual != null ? (
                        <>
                          <span className="val-actual">{e.actual}{e.unit ?? ""}</span>
                          {e.forecast != null && <span className="val-forecast">F: {e.forecast}{e.unit ?? ""}</span>}
                        </>
                      ) : pct(e.observedMove)
                    ) : (
                      <>
                        {e.forecast != null && <span>F: {e.forecast}{e.unit ?? ""}</span>}
                        {e.previous != null && <span className="val-prev">P: {e.previous}{e.unit ?? ""}</span>}
                        {e.forecast == null && e.previous == null && <span>{e.dateStatus}</span>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="subtle">
            {demo
              ? "No historical event claims in demo mode."
              : data
                ? "No events returned; coverage is incomplete."
                : dataset
                  ? "Loading calendar…"
                  : "Run a scan to load calendar coverage."}
          </p>
        )}
        <button
          className="text-button"
          onClick={() => setModal({ type: "events", direction, data })}
        >
          View calendar & coverage →
        </button>
      </>
    );
  }
  function trackingStrip() {
    return (
      <div className="tracking-content">
        <div className="track-actions">
          <span>
            {visibleItems.length} relevant · {items.length} saved
          </span>
          <span className={tone(trackingRow.catalystImpact)}>
            Net {delta(trackingRow.catalystImpact ?? 0)}
          </span>
          <span className="spacer" />
          <button onClick={newItem}>+ Add</button>
          <button
            className="badge neutral"
            onClick={() => setModal({ type: "suggestions" })}
          >
            {(agent?.suggestions?.length ?? 0) + marketTopics.length} suggestions
          </button>
          <button className="text-button" onClick={() => navigate("tracker")}>
            Open tracker ↗
          </button>
        </div>
        <div className="catalyst-chips">
          {visibleItems.length ? (
            visibleItems.map((item) => {
              const c = trackingRow.contributions.find((c) => c.id === item.id);
              return (
                <span className="chip-wrap" key={item.id}>
                  <button
                    className={`catalyst-chip ${tone(item.sentiment)}`}
                    onClick={() => setModal({ type: "item", item })}
                  >
                    <span
                      className={`status-dot ${item.status === "resolved" ? "resolved" : ""}`}
                    >
                      {item.status === "resolved" ? "✓" : "•"}
                    </span>
                    <span>{item.title}</span>
                    <b>{c?.excluded ? "?" : delta(c?.points ?? 0)}</b>
                  </button>
                  <span className="chip-tooltip" role="tooltip">
                    <strong>{item.title}</strong>
                    <span>
                      {item.status} · {item.sentiment}
                    </span>
                    <span>{c?.reason || item.condition}</span>
                    <span>
                      {sourceDate(item.checkedAt)} · Click for evidence &
                      history
                    </span>
                  </span>
                </span>
              );
            })
          ) : (
            <button className="text-button" onClick={newItem}>
              Add a catalyst or review AI suggestions
            </button>
          )}
        </div>
      </div>
    );
  }
  function sortTh(key, label) {
    const active = sort.key === key;
    return (
      <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          onClick={() =>
            setSort((s) =>
              s.key === key
                ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
                : { key, dir: typeof SORT_VALUES[key]?.({ legs: [], symbol: "", name: "", expiry: "" }) === "string" ? "asc" : "desc" },
            )
          }
        >
          {label}
          {active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
        </button>
      </th>
    );
  }
  // Toolbar buttons shared by the results table and the option chain. The chain reuses Columns and Expand,
  // so it can sit inline above the other panels or fill the screen, like the table.
  function resultsActions() {
    const chain = resultsView === "chain";
    return (
      <>
        <button aria-pressed={chain} onClick={() => setResultsView(chain ? "table" : "chain")}>
          {chain ? "Results table" : "Option chain"}
        </button>
        <button onClick={() => setModal({ type: "columns" })}>Columns</button>
        <button onClick={() => setExpanded(!expanded)}>
          {expanded ? "Close expanded" : "Expand"}
        </button>
      </>
    );
  }
  function resultsChain() {
    return (
      <div className={expanded ? "results-fullscreen" : ""}>
        <div className="results-toolbar">
          <strong>
            Option chain{" "}
            <small>
              {symbol}
              {distributionData?.contracts?.length ? ` · ${num(distributionData.contracts.length, 0)} contracts` : ""}
            </small>
          </strong>
          <label className="chain-horizon">
            Horizon
            <select
              aria-label="Option chain horizon"
              value={distributionDays}
              onChange={(e) => setDistributionDays(Number(e.target.value))}
            >
              <option value={365}>1 year</option>
              <option value={730}>2 years</option>
            </select>
          </label>
          {resultsActions()}
        </div>
        <OptionChainView
          symbol={symbol}
          spot={dataset?.spot}
          data={distributionData}
          loading={distributionLoading}
          error={distributionError}
          fee={strategy.fee}
          hv={tech.hv}
          scanRows={chainScanRows}
          selectedRow={row}
          onSelectRow={setSelectedId}
          hiddenColumns={layout.hiddenColumns ?? []}
        />
      </div>
    );
  }
  function resultsTable() {
    if (resultsView === "chain") return resultsChain();
    return (
      <div className={expanded ? "results-fullscreen" : ""}>
        <div className="results-toolbar">
          <strong>
            Scanned option results <small>{filtered.length} matches</small>
          </strong>
          <select
            aria-label="Filter strategy"
            value={templateFilter}
            onChange={(e) => setTemplateFilter(e.target.value)}
          >
            <option value="all">All strategies</option>
            {pmRows.length > 0 && <option value="polymarket">Polymarket + options</option>}
            {Object.entries(TEMPLATES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter expiry"
            value={expiryFilter}
            onChange={(e) => setExpiryFilter(e.target.value)}
          >
            <option value="all">All expiries</option>
            {[...new Set(tableRows.map((r) => r.expiry))].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <input
            aria-label="Minimum rating"
            type="number"
            min="0"
            max="100"
            placeholder="Min. rating"
            className="short"
            value={minRating}
            onChange={(e) => setMinRating(e.target.value)}
          />
          <input
            aria-label="Minimum annualized return"
            type="number"
            placeholder="Min ann ret %"
            className="short"
            value={minAnnRet}
            onChange={(e) => setMinAnnRet(e.target.value)}
          />
          <input
            aria-label="Minimum liquidity"
            type="number"
            placeholder="Min liquidity"
            className="short"
            value={minLiquidity}
            onChange={(e) => setMinLiquidity(e.target.value)}
          />
          <input
            aria-label="Maximum IV rank"
            type="number"
            placeholder="Max IV rank"
            className="short"
            value={maxIvRank}
            onChange={(e) => setMaxIvRank(e.target.value)}
          />
          <input
            aria-label="Minimum DTE"
            type="number"
            placeholder="Min DTE"
            className="short"
            value={minDte}
            onChange={(e) => setMinDte(e.target.value)}
          />
          <input
            aria-label="Maximum DTE"
            type="number"
            placeholder="Max DTE"
            className="short"
            value={maxDte}
            onChange={(e) => setMaxDte(e.target.value)}
          />
          <select
            aria-label="Filter bid/ask size"
            value={quoteSizeFilter}
            onChange={(e) => setQuoteSizeFilter(e.target.value)}
          >
            <option value="all">{quoteSizeAvailable ? "Bid/ask size" : "Bid/ask size unavailable"}</option>
            {[1, 10, 50, 100].map((n) => (
              <option key={n} value={n}>
                Bid/ask size &gt; {n}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter bid-ask spread"
            value={spreadFilter}
            onChange={(e) => setSpreadFilter(e.target.value)}
          >
            <option value="all">Bid-ask spread</option>
            <option value="tight">Below 1%</option>
            <option value="medium">1% to 3%</option>
            <option value="wide">Above 3%</option>
          </select>
          <select
            aria-label="Filter option volume"
            value={optVolFilter}
            onChange={(e) => setOptVolFilter(e.target.value)}
          >
            <option value="all">Opt vol</option>
            {[50, 200, 500, 1000, 5000].map((n) => (
              <option key={n} value={n}>
                Opt vol ≥ {n.toLocaleString()}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter max loss"
            value={maxLossFilter}
            onChange={(e) => setMaxLossFilter(e.target.value)}
          >
            <option value="all">Max loss</option>
            {[-500, -1000, -3000, -5000, -10000, -25000].map((n) => (
              <option key={n} value={n}>
                Max loss ≥ {n.toLocaleString()}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter earnings"
            value={earningsFilter}
            onChange={(e) => setEarningsFilter(e.target.value)}
          >
            <option value="all">Any earnings</option>
            <option value="nobefore">No earnings before expiry</option>
            <option value="clear">Earnings clear</option>
          </select>
          <select
            aria-label="Rows per page"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {[5, 10, 25, 50, 100, 250].map((n) => (
              <option key={n} value={n}>
                {n} rows
              </option>
            ))}
          </select>
          <label className="switch">
            <input
              type="checkbox"
              checked={includeCatalysts}
              onChange={(e) => setIncludeCatalysts(e.target.checked)}
            />
            Catalysts
          </label>
          {resultsActions()}
        </div>
        <div className="results-scroll">
          <table className="results-table">
            <thead>
              <tr>
                <th />
                {sortTh("symbol", "Symbol")}
                {sortTh("strategy", "Strategy")}
                <th>Hedge choices</th>
                <th>Legs to trade</th>
                {sortTh("quoteSize", "Bid/ask size")}
                {sortTh("quotePrice", "Bid/ask price")}
                {sortTh("expiry", "Expiry")}
                {sortTh("dte", "DTE")}
                {sortTh("strike", "Strike")}
                {sortTh("downBe", "Down breakeven")}
                {!layout.hiddenColumns?.includes("risk") && (
                  <>
                    {sortTh("maxProfit", "Max profit")}
                    {sortTh("maxLoss", "Max loss")}
                  </>
                )}
                {sortTh("annRet", "Ann ret %")}
                {sortTh("ev", "EV/BP")}
                {sortTh("ivRank", "IV rank")}
                {sortTh("liquidity", "Liquidity")}
                {!layout.hiddenColumns?.includes("risk") && sortTh("cost", "Debit / credit")}
                {!layout.hiddenColumns?.includes("iv") && sortTh("iv", "IV")}
                {!layout.hiddenColumns?.includes("oi") && sortTh("minOi", "Min OI")}
                {sortTh("earnings", "Earnings")}
                <th>Data</th>
                {sortTh("overall", "Score")}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(page * pageSize, page * pageSize + pageSize).map((r) => (
                <tr
                  key={r.id}
                  className={r.id === row?.id ? "selected" : ""}
                  onClick={() => setSelectedId(r.id)}
                >
                  <td>
                    <input
                      aria-label={`Select ${r.symbol} ${r.name} ${r.expiry}`}
                      type="radio"
                      name="scan-result"
                      checked={r.id === row?.id}
                      onChange={() => setSelectedId(r.id)}
                    />
                  </td>
                  <td>
                    <b>{r.symbol}</b>
                  </td>
                  <td>{r.name}</td>
                  <td>
                    {(r.kind === "polymarket" ? ["Polymarket Hedge"] : hedgeChoicesForRow(r)).map((label) => (
                      <span key={label} className="pill hedge-choice">
                        {label}
                      </span>
                    ))}
                    {!r.legs.length && "—"}
                  </td>
                  <td>
                    {r.kind === "polymarket" ? (
                      <span className="leg-list">
                        <span>
                          <b className="positive">
                            Buy {r.pm.pmSide} {num(r.pm.pmShares, 0)}×
                          </b>{" "}
                          @ {money(r.pm.pmPrice, 3)} ·{" "}
                          {r.pm.marketUrl ? (
                            <a href={r.pm.marketUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                              {r.pm.question}
                            </a>
                          ) : (
                            r.pm.question
                          )}
                        </span>
                        {r.legs.map((l, i) => (
                          <span key={i}>
                            <b className={l.quantity > 0 ? "positive" : "negative"}>
                              {l.quantity > 0 ? "Buy" : "Sell"} {Math.abs(l.quantity)}×
                            </b>{" "}
                            {r.symbol} {r.expiry} {num(l.strike, 2)}
                            {l.type === "put" ? "P" : "C"} @{" "}
                          <span className={l.quantity > 0 ? "leg-price ask" : "leg-price bid"}>{money(l.price, 2)}</span>
                          </span>
                        ))}
                      </span>
                    ) : (
                    <button
                      className="text-button leg-list"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(r.id);
                        setModal({ type: "result", row: r });
                      }}
                    >
                      {r.shares > 0 && <span>Hold {r.shares} shares</span>}
                      {r.legs.map((l, i) => (
                        <span key={i}>
                          <b className={l.quantity > 0 ? "positive" : "negative"}>
                            {l.quantity > 0 ? "Buy" : "Sell"} {Math.abs(l.quantity)}×
                          </b>{" "}
                          {r.symbol} {r.expiry} {num(l.strike, 2)}
                          {l.type === "put" ? "P" : "C"} @{" "}
                          <span className={l.quantity > 0 ? "leg-price ask" : "leg-price bid"}>{money(l.price, 2)}</span>
                        </span>
                      ))}
                      {!r.legs.length && !r.shares && <span>—</span>}
                    </button>
                    )}
                  </td>
                  <td>
                    <span className="quote-list">
                      {(r.kind === "polymarket" || r.shares > 0) && <span>&nbsp;</span>}
                      {r.legs.map((l, i) => (
                        <span key={i}>
                          <b className="positive">{l.bidSize ?? "—"}</b>/<b className="negative">{l.askSize ?? "—"}</b>
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    <span className="quote-list">
                      {(r.kind === "polymarket" || r.shares > 0) && <span>&nbsp;</span>}
                      {r.legs.map((l, i) => (
                        <span key={i}>
                          <b className="positive">{l.bid != null ? num(l.bid, 2) : "—"}</b>/<b className="negative">{l.ask != null ? num(l.ask, 2) : "—"}</b>
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>{r.expiry}</td>
                  <td>{r.dte ?? "—"}</td>
                  <td>
                    {r.legs
                      .map((l) => `${num(l.strike, 2)}${l.type === "put" ? "P" : "C"}`)
                      .join(" / ") || "—"}
                    {r.kind === "polymarket" && r.pm.pmTarget != null && (
                      <div className="subtle">
                        PM {r.pm.pmDirection === "down" ? "↓" : "↑"} {money(r.pm.pmTarget)}
                      </div>
                    )}
                  </td>
                  <td>{r.downBreakeven == null ? "—" : money(r.downBreakeven, 2)}</td>
                  {!layout.hiddenColumns?.includes("risk") && (
                    <>
                      <td className="positive">
                        {r.maxProfit == null ? "Unlimited" : money(r.maxProfit)}
                      </td>
                      <td className="negative">
                        {r.maxLoss == null ? "Unlimited" : money(r.maxLoss)}
                      </td>
                    </>
                  )}
                  <td>
                    <span className={`pill ${pillTone(r.annRetPct, 24, 8)}`}>
                      {r.annRetPct == null ? "—" : `${num(r.annRetPct, 2)}%`}
                    </span>
                  </td>
                  <td>
                    <span className={`pill ${pillTone(r.evPerBp, 1, 0.3)}`}>
                      {r.evPerBp == null ? "—" : `${num(r.evPerBp, 2)}%`}
                    </span>
                  </td>
                  <td>
                    <span className={`pill ${pillTone(r.ivRank, 50, 25)}`}>
                      {r.ivRank == null ? "—" : `${num(r.ivRank, 2)}%`}
                    </span>
                  </td>
                  <td>
                    <span className={`pill ${pillTone(r.liquidity, 70, 55)}`}>
                      {r.liquidity ?? "—"}
                    </span>
                  </td>
                  {!layout.hiddenColumns?.includes("risk") && (
                    <td>
                      {money(Math.abs(r.netDebit))}{" "}
                      {r.netDebit < 0 ? "credit" : "debit"}
                    </td>
                  )}
                  {!layout.hiddenColumns?.includes("iv") && (
                    <td>{pct(r.iv == null ? null : r.iv * 100)}</td>
                  )}
                  {!layout.hiddenColumns?.includes("oi") && (
                    <td>{num(r.minOi, 0)}</td>
                  )}
                  <td>
                    <span
                      className={`pill ${r.earnings === "Clear" ? "good" : r.earnings === "Before expiry" ? "bad" : "mid"}`}
                    >
                      {r.earnings ?? "—"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`data-label ${r.modeled ? "modeled" : ""}`}
                    >
                      {demo
                        ? "Sample"
                        : r.kind === "polymarket"
                          ? r.pm.quoted
                            ? "Quoted"
                            : "Unverified"
                          : !r.legs.length
                          ? "Stock"
                          : r.modeled
                            ? "Modeled"
                            : r.legs.every((l) => l.verifiedQuote)
                              ? "Quoted"
                              : "Unverified"}
                    </span>
                  </td>
                  <td>
                    {r.kind === "polymarket" ? (
                      <span className="subtle" title="Polymarket candidates are not scored yet">
                        Unscored
                      </span>
                    ) : (
                    <button
                      className={`rating ${tone(r.catalystImpact)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setModal({ type: "rating", row: r });
                      }}
                    >
                      {r.overall ??
                        `${r.adjustedRange[0]}–${r.adjustedRange[1]}`}{" "}
                      <small
                        title={
                          r.riskAdjustment
                            ? "Catalysts · risk adjustment (support/resistance + calendar)"
                            : "Catalysts"
                        }
                      >
                        ({delta(r.catalystImpact)}
                        {r.riskAdjustment && ` · ${delta(r.riskAdjustment.total)}`})
                      </small>
                    </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PolymarketNotes result={polymarketResult} busy={hedgeScan.busy && enabledScans.includes("polymarket_hedge")} />
          {!filtered.length && (
            <Empty>
              {busy
                ? "Collecting stock and option data…"
                : rows.length
                  ? "No results match these filters."
                  : "Run a scan to compare option contracts. If quotes are unavailable, choose clearly labeled modeled pricing in strategy settings."}
            </Empty>
          )}
        </div>
        <footer className="results-footer">
          <span>
            Selected result drives the heatmap.{" "}
            {strategy.pricingMode === "modeled"
              ? "Synthetic options; no market quote or OI is implied."
              : "Quote age and provenance are shown in details."}
          </span>
          <div>
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ‹
            </button>
            <span>
              {filtered.length
                ? `${page * pageSize + 1}–${Math.min(page * pageSize + pageSize, filtered.length)} of ${filtered.length}`
                : "0 results"}
            </span>
            <button
              disabled={(page + 1) * pageSize >= filtered.length}
              onClick={() => setPage((p) => p + 1)}
            >
              ›
            </button>
          </div>
        </footer>
      </div>
    );
  }
  function content(id) {
    switch (id) {
      case "payoff":
        return row ? (
          <>
            {metrics("payoff", [
              [row.binary ? "Net cost (Polymarket + options)" : "Net option cost", money(row.netDebit + row.fees, 2)],
              [
                "Max loss",
                row.maxLoss == null ? "Unlimited" : money(row.maxLoss),
                "negative",
              ],
              [
                "Max gain",
                row.maxProfit == null ? "Unlimited" : money(row.maxProfit),
                "positive",
              ],
              [
                "Breakeven",
                row.breakevens.map((v) => money(v, 2)).join(" / ") || "—",
              ],
            ])}
            <ScenarioHeatmap
              key={row.id}
              title={row.binary ? "Polymarket + option payoff heatmap" : "Option payoff heatmap"}
              description="Stock price × date · modeled P&L"
              startDate={row.asOf.slice(0, 10)}
              endDate={row.expiry}
              currentPrice={row.spot}
              volatility={row.iv ?? row.hv ?? 0.2}
              getCellPnL={getPnl}
              theme={layout.theme}
            />
            <p className="subtle">
              {row.binary
                ? "European reference pricing for the options. The Polymarket leg is modeled: a digital probability calibrated to today's market price, settling 1 or 0 at resolution (touch markets use the terminal price as an approximation). Polymarket fees are not included."
                : "European reference pricing; fees included. Catalysts affect ratings, not contractual payoffs."}
            </p>
          </>
        ) : (
          <Empty>
            <Icon name="chart" size={36} />
            <h3>Explore your strategy’s possibilities</h3>
            <p>
              Scan your stock list, then select an option result to see its
              payoff across prices and dates.
            </p>
            <div className="empty-actions">
              <button
                className="primary"
                onClick={() => run("scan", selectedMonitoredStock)}
                disabled={busy || hedgeScan.busy}
              >
                {selectedMonitoredStock
                  ? `Run first scan for ${selectedMonitoredStock}`
                  : "Run first scan"}
              </button>
              {selectedMonitoredStock && (
                <button onClick={() => run()} disabled={busy || hedgeScan.busy}>
                  Run all strategy tickers
                </button>
              )}
            </div>
          </Empty>
        );
      case "hedges":
        return (
          <>
            <div className="hedge-choices">
              {HEDGE_SCAN_STRATEGIES.map((st) => {
                const planned = st.status === "planned";
                const r = hedgeScan.results[st.id];
                return (
                  <label
                    key={st.id}
                    className={`${enabledScans.includes(st.id) ? "active" : ""}${planned ? " disabled" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={!planned && enabledScans.includes(st.id)}
                      disabled={planned}
                      onChange={() => toggleScan(st.id)}
                    />
                    <span>
                      <strong>{st.label}</strong>
                      <small>
                        {r?.status === "error"
                          ? r.error
                          : r?.status === "ok"
                            ? tableCount(st) != null
                              ? `${tableCount(st)} found`
                              : r.count === 0 && r.notes?.[0]
                                ? r.notes[0]
                                : `${r.count}${r.total > r.count ? ` of ${r.total}` : ""} found${r.top[0] ? ` · ${r.top[0].label}` : ""}`
                            : st.hint}
                      </small>
                    </span>
                    {r?.status === "error" && <em className="scan-badge">error</em>}
                  </label>
                );
              })}
            </div>
            <div className="hedge-scan-actions">
              <button
                className="primary"
                disabled={hedgeScan.busy || busy || !enabledScans.length}
                onClick={() => run("scan", selectedMonitoredStock)}
              >
                {hedgeScan.busy
                  ? "Scanning…"
                  : hedgeScan.at
                    ? "Rescan"
                    : `Scan ${enabledScans.length} selected`}
              </button>
              {hedgeScan.at && (
                <small className="subtle">
                  {new Date(hedgeScan.at).toLocaleTimeString()}
                </small>
              )}
            </div>
            {hedgeWait && (
              <p className="subtle">
                Market-data rate limit reached. Resuming automatically in {hedgeWait}s, no need to click Scan again.
              </p>
            )}
            {hedgeScan.error && <p className="negative">{hedgeScan.error}</p>}
            <div className="position">
              <strong>Selected position</strong>
              <small>{row?.expiry ?? `${strategy.dte} days`}</small>
              {row ? (
                <>
                  {row.shares > 0 && (
                    <p>
                      {row.shares} {row.symbol} shares
                    </p>
                  )}
                  {row.binary && (
                    <p>
                      <span className="positive">↗ Buy</span> {num(row.binary.quantity, 0)} Polymarket{" "}
                      {row.binary.outcome} @ {money(row.binary.entryPrice, 3)}
                      <small className="subtle"> · {row.pm?.question}</small>
                      {row.pm?.marketUrl && (
                        <>
                          {" "}
                          <a href={row.pm.marketUrl} target="_blank" rel="noreferrer">
                            Open on Polymarket ↗
                          </a>
                        </>
                      )}
                    </p>
                  )}
                  {row.legs.map((l, i) => (
                    <p key={i}>
                      <span
                        className={l.quantity > 0 ? "positive" : "negative"}
                      >
                        {l.quantity > 0 ? "↗ Buy" : "↘ Sell"}
                      </span>{" "}
                      {Math.abs(l.quantity)} × {row.symbol} {row.expiry}{" "}
                      {num(l.strike, 2)} {l.type} @ {money(l.price, 2)}
                      {l.contract && !l.contract.startsWith("MODEL:") && (
                        <small className="subtle"> · {l.contract}</small>
                      )}
                    </p>
                  ))}
                </>
              ) : (
                <p className="subtle">Choose a template and run a scan.</p>
              )}
              <button
                className="text-button"
                onClick={() => setModal({ type: "strategy" })}
              >
                Edit strategy parameters →
              </button>
            </div>
          </>
        );
      case "technicals":
        return (
          <>
            <InteractiveChart
              label={`${symbol ?? "Stock"} price`}
              height={250}
              format={(v) => money(v, 2)}
              candles={(dataset?.bars ?? []).slice(-120)}
              series={EMA_LINES.map(([period, color]) => ({
                key: `ema${period}`,
                label: `EMA${period}`,
                color,
                noScale: true,
                points: emaSeries(dataset?.bars ?? [], period).slice(-120),
              }))}
              levels={[
                { label: "Support", value: tech.support, color: "up" },
                { label: "Resistance", value: tech.resistance, color: "down" },
              ]}
            />
            {metrics("technicals", [
              ["RSI", num(tech.rsi)],
              ["EMA average", money(emaAverage(dataset?.bars ?? []), 2)],
              ["Support", money(tech.support, 2)],
              ["Resistance", money(tech.resistance, 2)],
            ])}
            <small className="subtle">
              {dataset?.source ?? "Awaiting data"} · 60-session price range
            </small>
          </>
        );
      case "oi-distribution":
      case "volume-distribution":
        return (
          <OptionDistribution
            data={distributionData}
            loading={distributionLoading}
            error={distributionError}
            metric={id === "oi-distribution" ? "openInterest" : "volume"}
            days={distributionDays}
            onDays={setDistributionDays}
            stockSymbol={symbol}
            stockBars={dataset?.bars}
            demo={demo}
            savedStock={history ? (history.stockVolume ?? []) : null}
            stockSettings={
              layout.stockVolume ?? {
                visible: true,
                interval: "60min",
                days: 30,
                preset: "30",
              }
            }
            onStockSettings={(settings) =>
              updateLayout({ stockVolume: settings })
            }
          />
        );
      case "options": {
        const from = addDays(dateOnly(history ? Date.parse(history.capturedAt) : Date.now()), -volDays),
          ivs = (research?.volatility?.history ?? []).filter(
            (b) => b.date >= from,
          ),
          hv = (dataset?.bars ?? [])
            .map((b, i, a) => ({
              date: b.date,
              value: realizedVol(a.slice(0, i + 1)),
            }))
            .filter((b) => b.date >= from && b.value != null),
          volFmt = (v) => `${(v <= 3 ? v * 100 : v).toFixed(1)}%`;
        return (
          <>
            <div className="event-controls">
              <span>Volatility history</span>
              <div className="segmented">
                {[30, 60, 180, 365].map((n) => (
                  <button
                    key={n}
                    className={volDays === n ? "active" : ""}
                    onClick={() => setVolDays(n)}
                  >
                    {n}D
                  </button>
                ))}
              </div>
            </div>
            <InteractiveChart
              label="Volatility history"
              height={250}
              format={volFmt}
              series={[
                ...(ivs.length
                  ? [
                      {
                        key: "iv",
                        label: "IV",
                        color: "#2f80ed",
                        points: ivs.map((b) => ({ date: b.date, value: b.iv })),
                      },
                    ]
                  : []),
                {
                  key: "hv",
                  label: ivs.length ? "HV" : "Realized vol",
                  color: "#e5484d",
                  points: hv.map((b) => ({ date: b.date, value: b.value })),
                },
              ]}
            />
            {metrics("options", [
              ["IV", pct(row?.iv != null ? row.iv * 100 : null)],
              ["HV", pct(tech.hv != null ? tech.hv * 100 : null)],
              ["IV rank", num(research?.volatility?.historical?.rank)],
              ["Min OI", num(row?.minOi, 0)],
            ])}
            <small className="subtle">
              {row?.modeled
                ? "Option volatility uses historical volatility; not market IV."
                : ivs.length
                  ? "Underlying IV history; contract IV is shown in results."
                  : "Historical IV needs provider coverage."}
            </small>
          </>
        );
      }
      case "valuation": {
        const highlights = reportHighlights(valuation?.report);
        // The suggestions are the live research, so a historical snapshot does not show them as its own.
        const happening =
          history || !valuation || metricHidden("valuation", "What's happening")
            ? []
            : companySummary(agent?.suggestions, symbol);
        // One panel: the agent's valuation beside the rule-based option and price summary for the same stock.
        return (
          <div className="valuation-combined">
          <div className={`valuation ${highlights.rating || highlights.tags.length ? "has-insight" : ""}`}>
            <div className="valuation-main">
            {valuation ? (
              <>
                <div className="target">
                  {!metricHidden("valuation", "Target") && (
                    <strong>{money(valuation.priceTarget)}</strong>
                  )}
                  {!metricHidden("valuation", "Agent view") && (
                    <Badge>{valuation.rating ?? "Unrated"}</Badge>
                  )}
                </div>
                <span className="subtle">
                  Agent price target · {sourceDate(valuation.asOf)}
                </span>
                <p>
                  {valuation.priceTarget && dataset
                    ? `${pct((valuation.priceTarget / dataset.spot - 1) * 100)} versus current stock price`
                    : "No structured price target supplied."}
                </p>
                <button
                  className="text-button"
                  onClick={() => setModal({ type: "valuation" })}
                >
                  View reasoning →
                </button>
              </>
            ) : (
              <>
                <h3>Research with TradingAgents</h3>
                <p className="subtle">
                  {agentAvailable
                    ? `Request research for ${symbol ?? "the selected stock"}.`
                    : "Connect the optional TradingAgents service to see price targets and evidence."}
                </p>
              </>
            )}
            {valuationRun?.running && (
              <p className="subtle" role="status">
                Researching {symbol}
                {valuationRun.started
                  ? ` · started ${sourceDate(valuationRun.started)}`
                  : ""}
                {valuationRun.progress?.total
                  ? ` · ${valuationRun.progress.done} of ${valuationRun.progress.total} reports done`
                  : ""}
              </p>
            )}
            {valuationRun?.failure && (
              <p className="negative">
                Last {symbol} run failed · {sourceDate(valuationRun.failedAt)}:{" "}
                {valuationRun.failure}
              </p>
            )}
            <button
              disabled={!symbol || valuationRun?.running}
              onClick={() => refreshAgentSymbol(symbol)}
            >
              {valuationRun?.running
                ? "Researching…"
                : valuation
                  ? `Re-run AI research for ${symbol}`
                  : `Run AI research for ${symbol ?? "stock"}`}
            </button>
            {researchError && (
              <p className="subtle">Additional research: {researchError}</p>
            )}
            </div>
            {(highlights.rating || highlights.tags.length > 0) && (
              <AgentHighlights rating={highlights.rating} tags={highlights.tags} />
            )}
            <CompanySummary items={happening} />
          </div>
          <OptionSummary
            data={distributionData}
            loading={distributionLoading}
            error={distributionError}
            spot={dataset?.spot}
            stats={summaryStats}
            symbol={symbol}
            hidden={(label) => metricHidden("valuation", label)}
          />
          </div>
        );
      }
      case "strategy-score":
        return (
                  <section className="score-strip">
                    <strong>
                      Strategy score{" "}
                      <b>
                        {selected?.overall ??
                          (selected
                            ? `${selected.adjustedRange[0]}–${selected.adjustedRange[1]}`
                            : "—")}
                        <small>/100</small>
                      </b>
                    </strong>
                    <span>
                      Base <b>{selected?.baseScore ?? "Incomplete"}</b>
                    </span>
                    <span>
                      Catalysts{" "}
                      <b className={tone(selected?.catalystImpact)}>
                        {selected ? delta(selected.catalystImpact) : "—"}
                      </b>
                    </span>
                    {selected?.riskAdjustment && (
                      <span>
                        Risk{" "}
                        <b className={tone(selected.riskAdjustment.total)}>
                          {delta(selected.riskAdjustment.total)}
                        </b>
                      </span>
                    )}
                    <span className="subtle">
                      {selected?.baseScore == null
                        ? "Liquidity unverified · score range only"
                        : "Explainable quality score"}
                    </span>
                    <span className="spacer" />
                    <button
                      className="text-button"
                      disabled={!selected}
                      onClick={() =>
                        setModal({ type: "rating", row: selected })
                      }
                    >
                      View breakdown →
                    </button>
                  </section>
        );
      case "past":
        return eventsPanel("past");
      case "future":
        return eventsPanel("future");
      case "tracking":
        return trackingStrip();
      case "results":
        return resultsTable();
      default:
        return null;
    }
  }
  function tracker() {
    // Group everything per ticker: the selected stock always gets a folder, "General" holds items with no ticker.
    const byTicker = new Map();
    const folderFor = (key) => {
      if (!byTicker.has(key)) byTicker.set(key, { key, suggestions: [], items: [] });
      return byTicker.get(key);
    };
    if (symbol) folderFor(symbol);
    for (const s of agent?.suggestions ?? []) folderFor(s.symbol || GENERAL_FOLDER).suggestions.push(s);
    for (const i of items) {
      if (!showResolved && i.status === "resolved") continue;
      if (agentFilter !== "All" && i.sentiment !== agentFilter) continue;
      folderFor(i.symbol || GENERAL_FOLDER).items.push(i);
    }
    const rank = (key) => (key === symbol ? 0 : key === GENERAL_FOLDER ? 2 : 1);
    const folders = [...byTicker.values()].sort(
      (a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key),
    );
    const folderOpen = (key) => trackerFolders[key] ?? (key === symbol || folders.length === 1);
    const saveFolders = (next) => {
      setTrackerFolders(next);
      writeTrackerFolders(next);
    };
    const toggleFolder = (key) => saveFolders({ ...trackerFolders, [key]: !folderOpen(key) });
    const setAllFolders = (open) =>
      saveFolders({ ...trackerFolders, ...Object.fromEntries(folders.map((f) => [f.key, open])) });
    const trackSuggestion = (s) =>
      setModal({
        type: "item",
        item: { ...s, id: undefined, impactUntil: addDays(dateOnly(Date.now()), 30) },
      });
    const trackedRow = (i) => (
      <button
        key={i.id}
        className="tracker-row"
        onClick={() => setModal({ type: "item", item: i })}
      >
        <span className={`status-dot ${i.status === "resolved" ? "resolved" : ""}`}>
          {i.status === "resolved" ? "✓" : "○"}
        </span>
        <span>
          <strong>{i.title}</strong>
          <small>
            {i.status} · {i.verified ? "Evidence reviewed" : "Unverified"}
          </small>
          <small>{i.condition}</small>
          <small>{sourceDate(i.checkedAt)}</small>
        </span>
        <b>{delta(i.points)}</b>
      </button>
    );
    return (
      <div className="tracker-page">
        <div className="page-title">
          <div>
            <span className="eyebrow">RESEARCH WORKSPACE</span>
            <h1>AI catalyst tracker</h1>
            <p>
              Discover market catalysts. Keep the ones that matter to your
              strategy.
            </p>
          </div>
          <button className="primary" onClick={newItem}>
            + Add tracking item
          </button>
        </div>
        <div className="panel">
          <header className="panel-head">
            <h2>Daily discovery</h2>
            <button onClick={refreshAgent}>Refresh suggestions</button>
          </header>
          <p className="subtle">
            {agentAvailable
              ? "TradingAgents checks saved strategies daily while the server is running."
              : "Set TRADINGAGENTS_URL on the server to enable daily AI research."}{" "}
            Sources and completion claims require review.
          </p>
          {agent?.error && <p className="negative">{agent.error}</p>}
          {agent?.suggestions?.length ? (
            <p className="subtle">
              {agent.suggestions.length} suggestion
              {agent.suggestions.length === 1 ? "" : "s"}, grouped into a
              folder per ticker below.
            </p>
          ) : (
            <Empty>
              No AI suggestions yet. Add a manual topic or request research.
            </Empty>
          )}
        </div>
        <div className="tracker-controls">
          {["All", ...SENTIMENTS].map((s) => (
            <button
              className={agentFilter === s ? "active" : ""}
              key={s}
              onClick={() => setAgentFilter(s)}
            >
              {s}
            </button>
          ))}
          <button onClick={() => setAllFolders(true)}>Expand all</button>
          <button onClick={() => setAllFolders(false)}>Collapse all</button>
          <label>
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />{" "}
            Show resolved
          </label>
        </div>
        <div className="ticker-folders">
          {folders.map((f) => {
            const open = folderOpen(f.key);
            const isGeneral = f.key === GENERAL_FOLDER;
            return (
              <section className="ticker-folder" key={f.key}>
                <header className="ticker-folder-head">
                  <button
                    className="ticker-folder-toggle"
                    aria-expanded={open}
                    onClick={() => toggleFolder(f.key)}
                  >
                    <span className="ticker-folder-caret" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                    <strong>{f.key}</strong>
                    <small>
                      {isGeneral ? "apply to every stock · " : ""}
                      {f.suggestions.length} suggestion
                      {f.suggestions.length === 1 ? "" : "s"} · {f.items.length}{" "}
                      tracked
                    </small>
                  </button>
                  {!isGeneral && (
                    <button className="text-button" onClick={() => newItem(f.key)}>
                      + Add item
                    </button>
                  )}
                </header>
                {open && (
                  <div className="ticker-folder-body">
                    <section className="ticker-folder-section">
                      <h3>Daily discovery</h3>
                      {f.suggestions.length ? (
                        <div className="suggestion-grid">
                          {f.suggestions.map((s) => (
                            <article key={s.id}>
                              <strong>{s.title}</strong>
                              <small>
                                {s.symbol} · {s.sentiment}
                              </small>
                              <button onClick={() => trackSuggestion(s)}>
                                + Track
                              </button>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="subtle">No AI suggestions for {f.key} yet.</p>
                      )}
                    </section>
                    <section className="ticker-folder-section">
                      <h3>Tracked items</h3>
                      <div className="tracker-columns">
                        {["Bullish", "Neutral", "Bearish"].map((group) => {
                          const groupItems = f.items.filter((i) =>
                            i.sentiment.toLowerCase().includes(group.toLowerCase()),
                          );
                          return (
                            <section key={group} className={`panel ${tone(group)}`}>
                              <h2>
                                {group} <small>({groupItems.length})</small>
                              </h2>
                              {groupItems.map(trackedRow)}
                            </section>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <p className="subtle">
          Resolved items stay until removed. Resolution and directional impact
          are separate. Removing an item never disables discovery.
        </p>
      </div>
    );
  }
  function stockAnalysis() {
    const symbols = [
      ...new Set([...strategy.symbols, ...rows.map((r) => r.symbol)]),
    ];
    return (
      <div className="stock-analysis-page">
        <div className="page-title">
          <div>
            <span className="eyebrow">AI RESEARCH</span>
            <h1>AI stock analysis</h1>
            <p>
              Full TradingAgents research per stock in this strategy —
              rating, price target and the evidence behind it. Run research
              for each stock individually below.
            </p>
          </div>
        </div>
        {!agentAvailable && (
          <div className="panel">
            <p className="subtle">
              Set TRADINGAGENTS_URL on the server to connect TradingAgents
              and populate this page.
            </p>
          </div>
        )}
        {agent?.error && <p className="negative">{agent.error}</p>}
        <div className="stock-analysis-grid">
          {symbols.map((s) => {
            const v = agentResult(agent, s);
            const evidence = (agent?.suggestions ?? []).filter(
              (i) => i.symbol === s,
            );
            const symStatus = agent?.runsBySymbol?.[s]?.status;
            const symRunning =
              researchingSymbols.has(s) ||
              (symStatus && !["completed", "completed_with_errors", "failed", "stopped"].includes(symStatus));
            return (
              <section className="panel stock-analysis-card" key={s}>
                <header className="panel-head">
                  <h2>{s}</h2>
                  <div className="stock-analysis-card-actions">
                    <Badge>{v?.rating ?? "No research yet"}</Badge>
                    {agent?.runsBySymbol?.[s] && (
                      <button
                        className="icon-button"
                        title="Check status / pull the latest result — does not start a new run"
                        aria-label={`Check research status for ${s}`}
                        disabled={symRunning}
                        onClick={() => checkAgentSymbol(s)}
                      >
                        <Icon name="refresh" size={14} />
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={symRunning}
                      onClick={() => refreshAgentSymbol(s)}
                    >
                      {symRunning
                        ? "Researching…"
                        : v
                          ? "Re-run for " + s
                          : "Run AI research"}
                    </button>
                  </div>
                </header>
                {v ? (
                  <>
                    <div className="target">
                      <strong>{money(v.priceTarget)}</strong>
                      <span className="subtle">
                        Price target · {sourceDate(v.asOf)}
                      </span>
                    </div>
                    <AgentReport text={v.report} className="report-text" />
                  </>
                ) : (
                  <p className="subtle">
                    No TradingAgents report for {s} yet. Run AI research for
                    this stock.
                  </p>
                )}
                {evidence.length > 0 && (
                  <div className="stock-analysis-evidence">
                    <h3>Supporting evidence</h3>
                    <div className="tracker-columns">
                      {["Bullish", "Neutral", "Bearish"].map((group) => {
                        const groupItems = evidence.filter((i) =>
                          i.sentiment.toLowerCase().includes(group.toLowerCase()),
                        );
                        return (
                          <section key={group} className={`panel ${tone(group)}`}>
                            <h2>
                              {group} <small>({groupItems.length})</small>
                            </h2>
                            {groupItems.map((i) => (
                              <details key={i.id} className="evidence-item">
                                <summary>{i.title}</summary>
                                {i.rationale ? (
                                  <p>{i.rationale}</p>
                                ) : (
                                  <p className="subtle">No detail provided.</p>
                                )}
                              </details>
                            ))}
                          </section>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    );
  }
  function economy() {
    if (demo)
      return (
        <div className="notice">
          The economy dashboard uses live macro data. Sign in to view it.
        </div>
      );
    if (macroError) return <div className="notice">{macroError}</div>;
    if (!macro) return <div className="studio-loading">Loading economy dashboard…</div>;
    return (
      <Suspense fallback={<div className="studio-loading">Loading economy dashboard…</div>}>
        <MacroHeatmapDashboard macroDashboard={macro} theme={layout.theme} />
      </Suspense>
    );
  }
  function backtests() {
    return (
      <div className="backtest-page">
        <div className="page-title">
          <div>
            <span className="eyebrow">STRATEGY LAB</span>
            <h1>Test past performance</h1>
            <p>
              Repeated daily rules, historical stock prices, and explicitly
              modeled options.
            </p>
          </div>
        </div>
        <section className="panel">
          <div className="test-form">
            {[
              ["start", "Start date", "date"],
              ["end", "End date", "date"],
              ["capital", "Capital per stock", "number"],
              ["rollDays", "Roll before expiry (days)", "number"],
              ["stopLoss", "Stop loss (% capital)", "number"],
              ["takeProfit", "Take profit (% capital)", "number"],
              ["optionSlippage", "Option slippage (%)", "number"],
              ["stockSlippage", "Stock slippage (bps)", "number"],
              ["rate", "Constant rate (%)", "number"],
            ].map(([key, label, type]) => (
              <Field key={key} label={label}>
                <input
                  type={type}
                  value={testSettings[key]}
                  onChange={(e) =>
                    setTestSettings((s) => ({
                      ...s,
                      [key]:
                        type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    }))
                  }
                />
              </Field>
            ))}
          </div>
          <div className="test-actions">
            <span>
              {TEMPLATES[strategy.template]} · {strategy.symbols.join(", ")}
            </span>
            <button onClick={() => setModal({ type: "strategy" })}>
              Edit rules & stocks
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => run("backtest")}
            >
              {busy ? "Running…" : "Run backtest"}
            </button>
          </div>
          <p className="subtle">
            Each stock is a separate account. Synthetic strikes/expiries;
            20-session historical volatility. Close signals fill next session
            open. No dividends, early exercise or historical news.
            Provider-adjusted prices; these are simulations, not historical
            option fills.
          </p>
        </section>
        {tests.map((t) => (
          <section className="panel" key={t.symbol}>
            <header className="panel-head">
              <h2>
                {t.symbol} · {t.trades.length} trades
              </h2>
              <Badge value={t.returnPct}>{pct(t.returnPct)}</Badge>
            </header>
            <div className="metrics">
              {[
                ["Final equity", money(t.final)],
                ["Max drawdown", pct(t.maxDrawdown)],
                ["Win rate", pct(t.winRate)],
                ["Sharpe", num(t.sharpe, 2)],
              ].map(([k, v]) => (
                <div key={k}>
                  <span>{k}</span>
                  <strong>{v}</strong>
                </div>
              ))}
            </div>
            <Sparkline
              series={[
                t.equity.map((e) => e.value),
                t.equity.map((e) => e.benchmark),
              ]}
              dates={[t.equity.map((e) => e.date)]}
              format={(v) => money(v, 0)}
              labels={["Strategy equity", "Buy & hold"]}
            />
            <div className="results-scroll">
              <table className="results-table">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Entry price</th>
                    <th>Exit price</th>
                    <th>Reason</th>
                    <th>P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {t.trades.map((v, i) => (
                    <tr key={i}>
                      <td>{v.entryDate}</td>
                      <td>{v.exitDate}</td>
                      <td>{money(v.entrySpot, 2)}</td>
                      <td>{money(v.exitSpot, 2)}</td>
                      <td>{v.reason}</td>
                      <td className={tone(v.pnl)}>{money(v.pnl, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div
      className={`studio ${presentation ? "momentum-ui" : ""}`}
      data-theme={layout.theme}
    >
      {presentation ? (
        presentation.renderWorkspace({
          demo,
          user,
          logout,
          view,
          navigate,
          layout,
          updateLayout,
          strategy,
          symbol,
          row,
          selected,
          rows,
          items,
          dataset,
          dirty,
          busy,
          error,
          notice,
          phase,
          job,
          cancel,
          setError,
          setNotice,
          setModal,
          save,
          run,
          content,
          panelHeader,
          tracker,
          backtests,
          economy,
          stockAnalysis,
          Icon,
          PANELS,
          visibleItems,
          agentFilter,
          setAgentFilter,
          showResolved,
          setShowResolved,
          newItem,
          refreshAgent,
          agent,
          agentAvailable,
          selectSymbol: (s) => {
            const r = rows.find((r) => r.symbol === s);
            if (r) setSelectedId(r.id);
          },
        })
      ) : (
        <>
          <header className="studio-nav">
            <a
              className="studio-brand"
              href={demo ? "/builder?demo=1" : "/builder"}
            >
              <Icon name="chart" size={25} />
              HedgeHub
            </a>
            <nav>
              <button
                className={view === "workspace" ? "active" : ""}
                onClick={() => navigate("workspace")}
              >
                Workspace
              </button>
            </nav>
            <span className="spacer" />
            <span className="mode-label">
              {demo ? "Interactive demo · Sample data" : "Strategy Studio"}
            </span>
            <a href="/">Classic UI ↗</a>
            {!demo && user?.role === "admin" ? (
              <a href="/admin/users">Admin ↗</a>
            ) : null}
            <button
              aria-label="Toggle theme"
              onClick={() =>
                updateLayout({
                  theme: layout.theme === "light" ? "dark" : "light",
                })
              }
            >
              <Icon name="sun" />
            </button>
            <button
              className="avatar"
              title={demo ? "Switch to live data" : "Sign out"}
              onClick={() => (demo ? location.assign("/builder") : logout())}
            >
              {user.username.slice(0, 2).toUpperCase()}
            </button>
          </header>
          <div
            className="studio-shell"
            style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
          >
            <div
              className="sidebar-resizer"
              style={{ left: sidebarWidth - 3 }}
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize · double-click to reset"
              onPointerDown={startSidebarResize}
              onDoubleClick={() => {
                setSidebarWidth(184);
                try {
                  localStorage.removeItem("studio-sidebar-width");
                } catch {}
              }}
            />
            <aside className="studio-sidebar">
              <MonitoredStocksPanel
                demo={demo}
                selectedStock={selectedMonitoredStock}
                onSelectStock={(stock) => {
                  setSelectedMonitoredStock(stock);
                  if (stock === null) {
                    navigate("workspace");
                  } else {
                    const r = rows.find((r) => r.symbol === stock);
                    if (r) setSelectedId(r.id);
                    navigate("workspace");
                  }
                }}
              />
              <TigerSubscriptions demo={demo} />
              <span className="eyebrow">ANALYSIS</span>
              <button
                className={view === "backtests" ? "active" : ""}
                onClick={() => navigate("backtests")}
              >
                <Icon name="trend" />
                Backtests
              </button>
              <button
                className={view === "economy" ? "active" : ""}
                onClick={() => navigate("economy")}
              >
                <Icon name="trend" />
                Economy
              </button>
              <span className="eyebrow">YOUR WORKSPACE</span>
              {PANELS.filter(([id]) => !layout.hidden.includes(id)).map(
                ([id, title, icon]) => (
                  <button
                    key={id}
                    onClick={() => {
                      if (id === "tracking") {
                        navigate("tracker");
                        return;
                      }
                      if (id === "ai-stock-analysis") {
                        navigate("stock-analysis");
                        return;
                      }
                      navigate("workspace");
                      setTimeout(
                        () =>
                          document
                            .getElementById("studio-" + id)
                            ?.scrollIntoView({
                              behavior: "smooth",
                              block: "center",
                            }),
                        30,
                      );
                    }}
                  >
                    <Icon name={icon} />
                    {title}
                  </button>
                ),
              )}
              <div className="sidebar-bottom">
                <button onClick={() => setModal({ type: "layout" })}>
                  <Icon name="plus" />
                  Add panel
                </button>
                <button
                  onClick={() => {
                    updateLayout(DEFAULT_LAYOUT);
                    setNotice("Default layout restored. Save to keep it.");
                  }}
                >
                  Reset layout
                </button>
                <p>
                  Make it yours.
                  <br />
                  Add metrics, rearrange panels, save your workspace.
                </p>
              </div>
            </aside>
            <main className="studio-main">
              <div className="studio-toolbar">
                <span className="toolbar-label">Strategy</span>
                <button
                  className="strategy-picker"
                  onClick={() => setModal({ type: "strategy" })}
                >
                  {strategy.name} <span>⌄</span>
                </button>
                <span className="spacer" />
                <button onClick={() => setModal({ type: "layout" })}>
                  <Icon name="settings" />
                  Customize
                </button>
                <button
                  onClick={() => save().catch((e) => setError(e.message))}
                >
                  {dirty ? "Save changes" : "Save layout"}
                </button>
                <button
                  className="primary"
                  onClick={() => run("scan", selectedMonitoredStock)}
                  disabled={busy || Boolean(history)}
                  title={history ? "Go back to live to scan" : undefined}
                >
                  <Icon name="search" />
                  {busy
                    ? "Scanning…"
                    : selectedMonitoredStock
                      ? `Scan ${selectedMonitoredStock}`
                      : "Scan stocks"}
                </button>
                {selectedMonitoredStock && (
                  <button onClick={() => run()} disabled={busy || hedgeScan.busy || Boolean(history)}>
                    <Icon name="search" />
                    Scan all tickers
                  </button>
                )}
              </div>
              {selectedMonitoredStock && (
                <div className="filter-breadcrumb">
                  <span>📊 Filtered to: <strong>{selectedMonitoredStock}</strong></span>
                  <span className="breadcrumb-actions">
                    {!demo && (
                      <label
                        className="snapshot-picker"
                        title="Each scan is saved (the latest per market day) and kept for 30 days."
                      >
                        View
                        <select
                          aria-label="Live data or a saved snapshot"
                          value={history?.id ?? ""}
                          disabled={snapshotBusy || busy}
                          onChange={(e) => openSnapshot(e.target.value)}
                        >
                          <option value="">Live</option>
                          {snapshotList.length ? (
                            <optgroup label="Saved scans · last 30 days">
                              {snapshotList.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {snapshotLabel(s)}
                                </option>
                              ))}
                            </optgroup>
                          ) : (
                            <option disabled>No saved scans yet</option>
                          )}
                        </select>
                      </label>
                    )}
                    <button
                      className="clear-filter"
                      onClick={() => setSelectedMonitoredStock(null)}
                      title="Clear filter"
                    >
                      ✕ Clear filter
                    </button>
                  </span>
                </div>
              )}
              {history && (
                <div className="snapshot-banner" role="status">
                  <span>
                    <strong>Historical snapshot</strong> · {history.symbol} as scanned{" "}
                    {sourceDate(history.capturedAt)} ({daysAgo(history.capturedAt)}). Panels show
                    saved data only; nothing is fetched live.
                    {!history.distribution && " The option chain was not saved for this scan."}
                  </span>
                  <button className="primary" onClick={() => openSnapshot("")}>
                    Back to live
                  </button>
                </div>
              )}
              {selectedMonitoredStock && !dataset && (
                <div className="notice error" role="alert">
                  No scan data for {selectedMonitoredStock}. Click Scan
                  {selectedMonitoredStock} to scan it; panels stay empty
                  instead of showing another ticker.
                </div>
              )}
              {demo && (
                <div className="notice demo-notice">
                  Illustrative data only. Changes are local to this demo.{" "}
                  <a href="/builder">Use live data →</a>
                </div>
              )}
              {error && (
                <div className="notice error" role="alert">
                  {error}
                  <button
                    aria-label="Dismiss error"
                    onClick={() => setError("")}
                  >
                    ×
                  </button>
                </div>
              )}
              {notice && (
                <div className="notice" role="status">
                  {notice}
                  <button
                    aria-label="Dismiss notice"
                    onClick={() => setNotice("")}
                  >
                    ×
                  </button>
                </div>
              )}
              {phase && (
                <div className="notice" role="status">
                  {phase}
                  <progress value={job?.progress ?? 0} max="100" />
                  <button onClick={cancel}>Cancel</button>
                </div>
              )}
              {view === "tracker" ? (
                tracker()
              ) : view === "backtests" ? (
                backtests()
              ) : view === "economy" ? (
                economy()
              ) : view === "stock-analysis" ? (
                stockAnalysis()
              ) : selectedMonitoredStock === null ? (
                <MonitoredStocksTileGrid demo={demo} onSelectStock={setSelectedMonitoredStock} />
              ) : (
                <>
                  <div className="studio-grid">
                    {layout.order
                      .filter((id) => !layout.hidden.includes(id))
                      .map((id) => {
                        const p = PANELS.find((p) => p[0] === id);
                        if (!p) return null;
                        return (
                          <section
                            id={"studio-" + id}
                            key={id}
                            className={`panel panel-${id} ${layout.collapsed.includes(id) ? "is-collapsed" : ""}`}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => dropPanel(e, id)}
                          >
                            {id === "results" || id === "strategy-score" ? null : panelHeader(...p)}
                            {!layout.collapsed.includes(id) && content(id)}
                          </section>
                        );
                      })}
                  </div>
                </>
              )}
            </main>
          </div>
        </>
      )}
      {modal && (
        <Drawer
          title={
            modal.type === "item"
              ? modal.item.id
                ? "Tracking item"
                : "Add a tracking item"
              : modal.type === "strategy"
                ? "Strategy settings"
                : modal.type === "layout"
                  ? "Customize workspace"
                  : modal.type === "rating"
                    ? "Why this rating?"
                    : modal.type === "panel"
                      ? "Panel settings"
                      : modal.type === "result"
                        ? "Option result details"
                        : modal.type === "valuation"
                          ? "TradingAgents research"
                          : modal.type === "columns"
                            ? "Result columns"
                            : modal.type === "suggestions"
                              ? "AI suggestions"
                              : modal.type === "addCalendarItem"
                                ? "Add calendar events"
                                : modal.type === "events"
                                  ? "Calendar coverage"
                                  : "Event details"
          }
          onClose={() => setModal(null)}
          wide={modal.type === "valuation"}
        >
          {modal.type === "strategy" && (
            <>
              <Field label="Saved strategy">
                <select
                  value={strategyId}
                  onChange={(e) => {
                    loadStrategy(e.target.value);
                    setModal(null);
                  }}
                >
                  <option value="default">Default workspace</option>
                  {saved
                    .filter((s) => s.id !== "default")
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.definition.name}
                      </option>
                    ))}
                </select>
              </Field>
              <StrategyForm value={strategy} onChange={updateStrategy} />
              <div className="dialog-actions">
                <button
                  onClick={() =>
                    save(true)
                      .then(() => setModal(null))
                      .catch((e) => setError(e.message))
                  }
                >
                  Save as new
                </button>
                <button
                  className="primary"
                  onClick={() =>
                    save()
                      .then(() => setModal(null))
                      .catch((e) => setError(e.message))
                  }
                >
                  Save strategy
                </button>
              </div>
            </>
          )}
          {modal.type === "item" && (
            <ItemForm
              item={modal.item}
              onSave={persistItem}
              onRemove={() => removeItem(modal.item.id)}
            />
          )}
          {modal.type === "layout" && (
            <>
              <p className="subtle">
                {presentation
                  ? "Choose visible panels. Use the arrows to change panel order within each view."
                  : "Drag panel handles to rearrange, or use these keyboard-accessible controls."}
              </p>
              {layout.order.map((id) => (
                <div className="layout-row" key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!layout.hidden.includes(id)}
                      onChange={() => togglePanel(id)}
                    />
                    {PANELS.find((p) => p[0] === id)?.[1]}
                  </label>
                  <button
                    aria-label={`Move ${id} up`}
                    onClick={() => movePanel(id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`Move ${id} down`}
                    onClick={() => movePanel(id, 1)}
                  >
                    ↓
                  </button>
                </div>
              ))}
              <button
                className="primary"
                onClick={() =>
                  save()
                    .then(() => setModal(null))
                    .catch((e) => setError(e.message))
                }
              >
                Save layout
              </button>
            </>
          )}
          {modal.type === "panel" && (
            <>
              <p>Choose the sub-items visible in this panel.</p>
              {(METRICS[modal.id] ?? []).map((label) => (
                <label className="check-row" key={label}>
                  <input
                    type="checkbox"
                    checked={!metricHidden(modal.id, label)}
                    onChange={() =>
                      updateLayout({
                        metrics: {
                          ...layout.metrics,
                          [modal.id]: metricHidden(modal.id, label)
                            ? layout.metrics[modal.id].filter(
                                (x) => x !== label,
                              )
                            : [...(layout.metrics[modal.id] ?? []), label],
                        },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
              {!METRICS[modal.id] && (
                <p className="subtle">
                  Use the panel’s item or date controls to change its contents.
                </p>
              )}
              <div className="dialog-actions">
                <button onClick={() => movePanel(modal.id, -1)}>Move up</button>
                <button onClick={() => movePanel(modal.id, 1)}>
                  Move down
                </button>
                <button
                  onClick={() => {
                    togglePanel(modal.id);
                    setModal(null);
                  }}
                >
                  Remove panel
                </button>
              </div>
            </>
          )}
          {modal.type === "columns" &&
            ["risk", "iv", "oi"].map((c) => (
              <label key={c} className="check-row">
                <input
                  type="checkbox"
                  checked={!layout.hiddenColumns?.includes(c)}
                  onChange={() =>
                    updateLayout({
                      hiddenColumns: layout.hiddenColumns?.includes(c)
                        ? layout.hiddenColumns.filter((x) => x !== c)
                        : [...(layout.hiddenColumns ?? []), c],
                    })
                  }
                />
                {
                  {
                    risk: "Debit/credit, max profit and max loss",
                    iv: "Implied volatility",
                    oi: "Open interest",
                  }[c]
                }
              </label>
            ))}
          {modal.type === "rating" && <RatingDetails row={modal.row} />}
          {modal.type === "result" && (
            <>
              <h3>
                {modal.row.symbol} · {modal.row.name}
              </h3>
              <p>
                {modal.row.shares} shares · {modal.row.expiry}
              </p>
              {modal.row.legs.map((l, i) => (
                <article className="detail-box" key={i}>
                  <strong>
                    {l.quantity > 0 ? "Buy" : "Sell"} {Math.abs(l.quantity)} ×{" "}
                    {money(l.strike)} {l.type}
                  </strong>
                  <dl>
                    <dt>Contract</dt>
                    <dd>{l.contract}</dd>
                    <dt>Entry price / share</dt>
                    <dd>{money(l.price, 2)}</dd>
                    <dt>Bid / ask</dt>
                    <dd>
                      {money(l.bid, 2)} / {money(l.ask, 2)}
                    </dd>
                    <dt>IV</dt>
                    <dd>{pct(l.iv * 100)}</dd>
                    <dt>Open interest</dt>
                    <dd>{num(l.oi, 0)}</dd>
                    <dt>Source</dt>
                    <dd>{l.source}</dd>
                    <dt>Quote timestamp</dt>
                    <dd>{sourceDate(l.quoteTimestamp)}</dd>
                  </dl>
                </article>
              ))}
              <p>
                Required capital {money(modal.row.capital)} · Entry fees{" "}
                {money(modal.row.fees, 2)} · Net delta {num(modal.row.delta)}
              </p>
              <RatingDetails row={modal.row} />
            </>
          )}
          {modal.type === "valuation" && (
            <>
              <Badge>{valuation?.rating ?? "Unrated"}</Badge>
              <p>AI research · {sourceDate(valuation?.asOf)}</p>
              <AgentReport text={valuation?.report} />
            </>
          )}
          {modal.type === "suggestions" && (
            <SuggestionsPanel
              topics={marketTopics}
              suggestions={agent?.suggestions ?? []}
              items={items}
              onRemoveItem={(id) => removeItem(id, true)}
              symbol={symbol}
              agentAvailable={agentAvailable}
              onRefreshAgent={refreshAgent}
              scheduleHref={!demo && user?.role === "admin" ? "/admin/analysis-tasks" : null}
              onAddTopic={(topic) =>
                setModal({
                  type: "item",
                  item: {
                    ...topicToItem(topic, symbol),
                    impactUntil: addDays(dateOnly(Date.now()), 30),
                  },
                })
              }
              onAddSuggestion={(s) =>
                setModal({
                  type: "item",
                  item: {
                    ...s,
                    id: undefined,
                    impactUntil: addDays(dateOnly(Date.now()), 30),
                  },
                })
              }
            />
          )}
          {modal.type === "addCalendarItem" && (
            <div className="extra-picker">
              <p className="subtle">
                Corporate earnings and high-importance US macro data are always shown. Use these to add more.
              </p>
              {EVENT_EXTRA_GROUPS.map((group) => (
                <div key={group.id} className="extra-group">
                  <h4>{group.label}</h4>
                  {group.items.map((item) => {
                    const active = eventExtras.includes(item.key);
                    return (
                      <label key={item.key} className="extra-row">
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => {
                            const next = active
                              ? eventExtras.filter((k) => k !== item.key)
                              : [...eventExtras, item.key];
                            setEventExtras(next);
                            try { localStorage.setItem("studio-event-extras", JSON.stringify(next)); } catch {}
                          }}
                        />
                        <span>
                          <strong>{item.label}</strong>
                          <small>{item.desc}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
              {eventExtras.length > 0 && (
                <button
                  className="text-button"
                  onClick={() => {
                    setEventExtras([]);
                    try { localStorage.removeItem("studio-event-extras"); } catch {}
                  }}
                >
                  Clear all extras
                </button>
              )}
            </div>
          )}
          {modal.type === "event" && (
            <>
              <h3>{modal.event.title}</h3>
              <p>
                {modal.event.date}
                {modal.event.period ? ` · ${modal.event.period}` : ""}
                {modal.event.dateStatus ? ` · ${modal.event.dateStatus}` : ""}
              </p>
              {(modal.event.actual != null || modal.event.forecast != null || modal.event.previous != null ||
                modal.event.revenueActual != null || modal.event.revenueEstimate != null) && (
                <dl className="event-data-grid">
                  {modal.event.actual != null && (
                    <>
                      <dt>Actual</dt>
                      <dd className="positive">{modal.event.actual}{modal.event.unit ?? ""}</dd>
                    </>
                  )}
                  {modal.event.forecast != null && (
                    <>
                      <dt>Forecast</dt>
                      <dd>{modal.event.forecast}{modal.event.unit ?? ""}</dd>
                    </>
                  )}
                  {modal.event.previous != null && (
                    <>
                      <dt>Previous{modal.event.period ? ` (${modal.event.period})` : ""}</dt>
                      <dd>{modal.event.previous}{modal.event.unit ?? ""}</dd>
                    </>
                  )}
                  {modal.event.revenueActual != null && (
                    <>
                      <dt>Revenue actual</dt>
                      <dd className="positive">{modal.event.revenueActual}</dd>
                    </>
                  )}
                  {modal.event.revenueEstimate != null && (
                    <>
                      <dt>Revenue est.</dt>
                      <dd>{modal.event.revenueEstimate}</dd>
                    </>
                  )}
                </dl>
              )}
              <p>{modal.event.priceImpactNote}</p>
              {modal.event.observedMove != null && (
                <strong>{pct(modal.event.observedMove)}</strong>
              )}
              {modal.event.sourceUrl &&
                /^https?:\/\//.test(modal.event.sourceUrl) && (
                  <p>
                    <a
                      href={modal.event.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View source ↗
                    </a>
                  </p>
                )}
              <EventScenario event={modal.event} row={row} />
            </>
          )}
          {modal.type === "events" && (
            <>
              <p>
                {modal.data?.from} – {modal.data?.to}
              </p>
              <p className="subtle">
                Coverage is partial. Empty results never mean there are no
                events.
              </p>
              {modal.data?.warnings?.map((w, i) => (
                <p key={i} className="negative">
                  {w}
                </p>
              ))}
              {(() => {
                const isPast = modal.direction === "past";
                const events = isPast
                  ? [...(modal.data?.events ?? [])].sort((a, b) => String(b.date).localeCompare(String(a.date)))
                  : modal.data?.events ?? [];
                const groups = [
                  { label: "Company Earnings", items: events.filter(e => e.type === "earnings" || e.category === "earnings") },
                  { label: "Economic Releases", items: events.filter(e => e.type === "economic" || e.category === "economic" || (e.country != null && e.type !== "earnings" && e.category !== "earnings")) },
                  { label: "Other", items: events.filter(e => !e.type && !e.category && e.country == null) },
                ].filter(g => g.items.length > 0);
                return groups.length > 0 ? groups.map(g => (
                  <div key={g.label} className="event-category-group">
                    <p className="event-cat-label">{g.label}</p>
                    {g.items.map((e, i) => (
                      <button
                        className="event-row"
                        key={i}
                        onClick={() => setModal({ type: "event", event: e })}
                      >
                        <span>{e.title}</span>
                        <small className="event-row-meta">
                          <span>{e.date}{e.period ? ` · ${e.period}` : ""}</span>
                          {isPast
                            ? e.actual != null
                              ? <span className="event-values">A: <strong>{e.actual}{e.unit ?? ""}</strong>{e.forecast != null ? ` · F: ${e.forecast}${e.unit ?? ""}` : ""}</span>
                              : e.dateStatus ? <span>{e.dateStatus}</span> : null
                            : (e.forecast != null || e.previous != null)
                              ? <span className="event-values">
                                  {e.forecast != null ? `F: ${e.forecast}${e.unit ?? ""}` : ""}
                                  {e.previous != null ? `${e.forecast != null ? " · " : ""}P: ${e.previous}${e.unit ?? ""}` : ""}
                                </span>
                              : e.dateStatus ? <span>{e.dateStatus}</span> : null}
                        </small>
                      </button>
                    ))}
                  </div>
                )) : events.map((e, i) => (
                  <button
                    className="event-row"
                    key={i}
                    onClick={() => setModal({ type: "event", event: e })}
                  >
                    <span>{e.title}</span>
                    <small>{e.date} · {e.dateStatus}</small>
                  </button>
                ));
              })()}
            </>
          )}
        </Drawer>
      )}
    </div>
  );
}
function StrategyForm({ value: s, onChange }) {
  const [symbols, setSymbols] = useState(s.symbols.join(", "));
  return (
    <>
      <Field label="Name">
        <input
          value={s.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </Field>
      <Field label="Stocks / watchlist (comma separated)">
        <textarea
          value={symbols}
          onChange={(e) => {
            setSymbols(e.target.value);
            onChange({
              symbols: e.target.value
                .toUpperCase()
                .split(/[\s,]+/)
                .filter(Boolean),
            });
          }}
        />
      </Field>
      <Field label="Backtest template">
        <select
          value={s.template}
          onChange={(e) => onChange({ template: e.target.value })}
        >
          {Object.entries(TEMPLATES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-grid">
        {[
          ["shares", "Shares (multiples of 100)"],
          ["putPct", "Put strike (% of spot)"],
          ["callPct", "Call strike (% of spot)"],
          ["dte", "Target days to expiry"],
          ["fee", "Entry fee / contract"],
          ["minPrice", "Minimum stock price"],
          ["minVolume", "Minimum daily volume"],
        ].map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              type="number"
              value={s[key]}
              onChange={(e) => onChange({ [key]: Number(e.target.value) })}
            />
          </Field>
        ))}
      </div>
      <Field label="Stock trend filter">
        <select
          value={s.trend}
          onChange={(e) => onChange({ trend: e.target.value })}
        >
          <option value="any">Any trend</option>
          <option value="above50">Above 50-day average</option>
          <option value="below50">Below 50-day average</option>
        </select>
      </Field>
      <Field label="Pricing source">
        <select
          value={s.pricingMode}
          onChange={(e) => onChange({ pricingMode: e.target.value })}
        >
          <option value="market">Available market option quotes</option>
          <option value="modeled">
            Modeled options (historical volatility)
          </option>
        </select>
      </Field>
      <p className="subtle">
        Scans compare all supported hedge templates. Backtests use the selected
        template. Modeled options have synthetic strikes and expiries; liquidity
        remains unknown.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.dailyResearch}
          onChange={(e) => onChange({ dailyResearch: e.target.checked })}
        />
        Daily TradingAgents discovery when configured (may use model credits)
      </label>
    </>
  );
}
// Analysis history of the AI topic an item is linked to (kept while the topic is active, 30 days of silence archives it).
function TopicHistory({ eventKey }) {
  const topicId = /^market topic (\d+)$/.exec(eventKey ?? "")?.[1];
  const [history, setHistory] = useState(null);
  useEffect(() => {
    if (!topicId) return;
    let live = true;
    api(`/builder/market-topics/${topicId}/history`)
      .then((d) => live && setHistory(d.history ?? []))
      .catch(() => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [topicId]);
  if (!topicId) return null;
  return (
    <div className="topic-history">
      <h3>Analysis history</h3>
      {history === null ? (
        <p className="subtle">Loading…</p>
      ) : history.length ? (
        history.map((h, i) => (
          <details key={h.id} open={i === 0}>
            <summary>
              {sourceDate(h.recordedAt)} · weight {h.weight} · bullish {h.bullishScore} · bearish {h.bearishScore}
            </summary>
            <p className="topic-summary">{h.summary}</p>
          </details>
        ))
      ) : (
        <p className="subtle">No history recorded for this topic yet, or it has been removed.</p>
      )}
    </div>
  );
}
function ItemForm({ item, onSave, onRemove }) {
  const [form, setForm] = useState(item);
  useEffect(() => setForm(item), [item]);
  const set = (key, v) => setForm((f) => ({ ...f, [key]: v }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <Field label="Tracking item">
        <input
          required
          maxLength={240}
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
        />
      </Field>
      <Field label="Condition to track">
        <textarea
          required
          value={form.condition}
          onChange={(e) => set("condition", e.target.value)}
        />
      </Field>
      <Field label="What counts as resolved?">
        <textarea
          required
          value={form.resolution}
          onChange={(e) => set("resolution", e.target.value)}
        />
      </Field>
      <div className="form-grid">
        <Field label="Stock (blank = all)">
          <input
            value={form.symbol}
            onChange={(e) => set("symbol", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Strategy scope">
          <select
            value={form.template}
            onChange={(e) => set("template", e.target.value)}
          >
            <option value="">All templates</option>
            {Object.entries(TEMPLATES).map(([k, v]) => (
              <option value={k} key={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sentiment">
          <select
            value={form.sentiment}
            onChange={(e) => set("sentiment", e.target.value)}
          >
            {SENTIMENTS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Rating contribution (−5 to +5)">
          <input
            type="number"
            min="-5"
            max="5"
            step="1"
            value={form.points}
            onChange={(e) => set("points", Number(e.target.value))}
          />
        </Field>
        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) => set("status", e.target.value)}
          >
            <option value="monitoring">Monitoring</option>
            <option value="resolved">Resolved</option>
          </select>
        </Field>
        <Field label="Impact valid through">
          <input
            type="date"
            value={form.impactUntil ?? ""}
            onChange={(e) => set("impactUntil", e.target.value)}
          />
        </Field>
      </div>
      <Field label="Source URLs (optional, one per line)">
        <textarea
          value={(form.sources ?? []).join("\n")}
          onChange={(e) =>
            set("sources", e.target.value.split("\n").filter(Boolean))
          }
        />
      </Field>
      <div className="source-links">
        {(form.sources ?? [])
          .filter((url) => /^https?:\/\//.test(url))
          .map((url, i) => (
            <p key={i}>
              <a href={url} target="_blank" rel="noreferrer">
                Evidence source {i + 1} ↗
              </a>
            </p>
          ))}
      </div>
      <Field label="Why does this affect the strategy?">
        <textarea
          value={form.rationale}
          onChange={(e) => set("rationale", e.target.value)}
        />
      </Field>
      <label className="check-row">
        <input
          type="checkbox"
          checked={form.verified}
          onChange={(e) => set("verified", e.target.checked)}
        />
        I reviewed the evidence for this status and contribution
      </label>
      <p className="subtle">
        Unverified or stale evidence contributes zero. Reviewed contributions
        expire after 30 days unless refreshed, and never accumulate on repeated
        scans. Resolved is a status, not automatically bullish.
      </p>
      <TopicHistory eventKey={item.eventKey} />
      {item.agentUpdate && (
        <div className="notice">
          New agent evidence: {item.agentUpdate.status} ·{" "}
          {sourceDate(item.agentUpdate.checkedAt)}. Review before changing the
          saved status.
        </div>
      )}
      <div className="dialog-actions">
        {item.id && (
          <button type="button" className="danger" onClick={onRemove}>
            Remove from strategy
          </button>
        )}
        <button className="primary" type="submit">
          Save tracking item
        </button>
      </div>
      {item.history?.length > 0 && (
        <>
          <h3>History</h3>
          {item.history.map((h, i) => (
            <p key={i} className="subtle">
              {sourceDate(h.at)} · {h.note}
            </p>
          ))}
        </>
      )}
    </form>
  );
}
// Maps a scanned Polymarket + options candidate onto the shared result-row shape, so it can
// drive the payoff heatmap, position panel and risk boxes like any option row.
function polymarketTableRow(r, scannedAt) {
  const asOf = scannedAt ?? new Date().toISOString();
  const optionExpiry = r.optionExpiry ?? "";
  const iv = r.avgIv ?? 0.4;
  const row = {
    id: `pm:${r.id}`,
    kind: "polymarket",
    pm: r,
    symbol: r.symbol,
    template: "polymarket",
    name: `PM ${r.pmSide} + ${r.strategyType}`,
    asOf,
    expiry: optionExpiry,
    dte: optionExpiry
      ? Math.max(Math.round((Date.parse(optionExpiry) - Date.parse(dateOnly(asOf))) / DAY), 0)
      : null,
    spot: r.spot ?? null,
    shares: 0,
    fees: 0,
    iv,
    hv: null,
    legs: r.legs.map((l) => ({
      quantity: l.action === "Buy" ? (l.quantity ?? 0) : -(l.quantity ?? 0),
      strike: l.strike,
      type: l.optionType,
      price: l.price,
      iv: l.iv ?? iv,
      contract: l.contract,
      bid: l.bid ?? null,
      ask: l.ask ?? null,
      bidSize: l.bidSize ?? null,
      askSize: l.askSize ?? null,
      volume: l.volume ?? null,
    })),
    binary: {
      outcome: r.pmSide,
      quantity: r.pmShares ?? 0,
      entryPrice: r.pmPrice ?? 0,
      target: r.pmTarget,
      direction: r.pmDirection === "down" ? "down" : "up",
      resolution: r.pmResolves,
      yesNow: r.pmYes,
      iv,
      spotNow: r.spot,
      asOf,
    },
    netDebit: (r.pmCost ?? 0) + (r.optionDebit ?? 0),
    annRetPct: null,
    evPerBp: null,
    ivRank: r.ivRank ?? null,
    liquidity: r.liquidity ?? null,
    earnings: r.earnings ?? null,
    minOi: r.minOpenInterest ?? null,
    overall: null,
    catalystImpact: 0,
    modeled: false,
  };
  const canModel = r.pmTarget > 0 && r.spot > 0 && r.pmResolves && optionExpiry;
  if (canModel) Object.assign(row, summarizePosition(row));
  else {
    // Without a threshold or dates the Polymarket leg cannot be modeled; fall back to the scanner's own numbers.
    delete row.binary;
    Object.assign(row, { maxProfit: null, maxLoss: r.maxLoss, breakevens: r.breakevens ?? [] });
  }
  row.downBreakeven = row.breakevens?.length ? Math.min(...row.breakevens) : null;
  return row;
}
function PolymarketNotes({ result, busy }) {
  if (!result && !busy) return null;
  return (
    <div className="polymarket-notes">
      {busy && !result && <p className="subtle">Scanning Polymarket + options…</p>}
      {result?.status === "error" && <p className="negative">{result.error}</p>}
      {(result?.notes ?? []).map((n) => (
        <p className="subtle" key={n}>
          {n}
        </p>
      ))}
      {result?.rows?.length > 0 && (
        <p className="subtle">
          Polymarket + option rows are unscored (shown last): tightest option spread first, then Polymarket liquidity.
        </p>
      )}
    </div>
  );
}
const signed1 = (v) => `${v > 0 ? "+" : ""}${num(v, 1)}`;
function RiskDetails({ risk, expiry }) {
  const sr = risk.supportResistance,
    cal = risk.calendar;
  return (
    <>
      <article className="detail-box">
        <strong>
          Support / resistance{" "}
          <span className={tone(sr.points)}>{signed1(sr.points)}</span>
        </strong>
        {sr.status === "scored" ? (
          sr.legs.map((l, i) => (
            <p key={i}>
              Short {num(l.strike, 2)}
              {l.type === "put" ? "P" : "C"} vs{" "}
              {l.type === "put" ? "support" : "resistance"} {money(l.level, 2)}
              {l.confidence != null && ` (confidence ${num(l.confidence, 0)})`}:{" "}
              {num(Math.abs(l.cushionAtr), 2)} ATR{" "}
              {l.cushionAtr >= 0 ? "beyond" : "inside"} the level ·{" "}
              <span className={tone(l.points)}>{signed1(l.points)}</span>
            </p>
          ))
        ) : (
          <p>
            {sr.status === "no-short-legs"
              ? "No short legs, so levels are not scored."
              : "No usable support/resistance level on the correct side of price."}
          </p>
        )}
      </article>
      <article className="detail-box">
        <strong>
          Calendar risk <span className="neutral">{delta(cal.points)}</span>
        </strong>
        <p>
          {cal.status === "awaiting-ai"
            ? "Awaiting AI event analysis; events below are shown but do not change the score yet."
            : "Scored from AI event analysis."}
        </p>
        <p>
          Earnings in window: {cal.earningsDate ?? "none known"}
          {cal.volSensitivity != null &&
            ` · volatility sensitivity ${num(cal.volSensitivity, 2)}×`}
        </p>
        <p>
          High-importance US macro before expiry:{" "}
          {cal.macro == null
            ? "unavailable"
            : cal.macro.length
              ? cal.macro
                  .slice(0, 8)
                  .map((e) => `${e.date} ${e.title}`)
                  .join(" · ") +
                ((cal.macroCount ?? cal.macro.length) > 8
                  ? ` · +${(cal.macroCount ?? cal.macro.length) - 8} more`
                  : "")
              : "none found"}
          {cal.macro != null &&
            cal.macroCoveredUntil &&
            cal.macroCoveredUntil < expiry &&
            ` (calendar checked through ${cal.macroCoveredUntil})`}
        </p>
      </article>
    </>
  );
}
function RatingDetails({ row: r }) {
  return (
    <>
      <h3>
        {r.symbol} · {r.name}
      </h3>
      <p>
        Version {r.version}. A strategy-quality heuristic, not a probability of
        profit.
      </p>
      <dl>
        {Object.entries(r.parts).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v == null ? "Unknown" : num(v, 1)}</dd>
          </div>
        ))}
      </dl>
      <p>
        Base {r.baseScore ?? r.scoreRange.join("–")} + catalysts{" "}
        {delta(r.catalystImpact)}
        {r.riskAdjustment && <> + risk {delta(r.riskAdjustment.total)}</>} ={" "}
        <strong>{r.overall ?? r.adjustedRange.join("–")}</strong>
      </p>
      <p className="subtle">
        Protection 35, option cost 25, upside capture 20, quote liquidity 20.
        Missing liquidity produces a range and excludes the result from
        exact-score ranking.
      </p>
      {r.riskAdjustment && (
        <RiskDetails risk={r.riskAdjustment} expiry={r.expiry} />
      )}
      {r.contributions.map((c) => (
        <article className="detail-box" key={c.id}>
          <strong>
            {c.title} <span className={tone(c.points)}>{delta(c.points)}</span>
          </strong>
          <p>{c.reason || "Reviewed strategy-specific contribution"}</p>
        </article>
      ))}
      <p className="subtle">
        Catalyst adjustment is capped at ±15 points. Related events count once.
        These contributions are not measured statistical correlations.
      </p>
    </>
  );
}

function EventScenario({ event, row }) {
  const [shock, setShock] = useState(5);
  if (!row || event.date < row.asOf.slice(0, 10))
    return (
      <p className="subtle">
        Historical reactions provide context; they do not establish causation.
      </p>
    );
  if (event.date > row.expiry)
    return (
      <p className="subtle">
        This event is after the selected option expiry. Select a longer-dated
        result to model its payoff.
      </p>
    );
  return (
    <section className="detail-box">
      <h3>Payoff on the event date</h3>
      <Field label="Stock move scenario (%)">
        <input
          type="number"
          min="0"
          max="99"
          value={shock}
          onChange={(e) =>
            setShock(Math.max(0, Math.min(99, Number(e.target.value))))
          }
        />
      </Field>
      <table className="mini-table">
        <thead>
          <tr>
            <th>Stock move</th>
            <th>Price</th>
            <th>Modeled P&L</th>
          </tr>
        </thead>
        <tbody>
          {[-shock, 0, shock].map((move, i) => (
            <tr key={i}>
              <td>
                {move > 0 ? "+" : ""}
                {move}%
              </td>
              <td>{money(row.spot * (1 + move / 100), 2)}</td>
              <td>
                {money(payoff(row, row.spot * (1 + move / 100), event.date), 2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="subtle">
        Your scenario, not an AI forecast. Volatility is held constant at the
        selected result’s pricing input.
      </p>
    </section>
  );
}
