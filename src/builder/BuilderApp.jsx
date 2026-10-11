import OptionDistribution from "./OptionDistribution.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AuthScreen from "../components/AuthScreen.jsx";
import ScenarioHeatmap, {
  buildScenarioHeatmapSnapshot,
} from "../components/ScenarioHeatmap.jsx";
import {
  DEFAULT_STRATEGY,
  TEMPLATES,
  SENTIMENTS,
  applyCatalysts,
  payoff,
  technicals,
  realizedVol,
  addDays,
  dateOnly,
  backtest,
  validateStrategy,
} from "../../shared/builderEngine.js";
import { demoWorkspace } from "./demo.js";
import "./builder.css";

const PANELS = [
  ["payoff", "Profit & loss", "chart"],
  ["hedges", "Hedge choices", "shield"],
  ["technicals", "Stock technicals", "trend"],
  ["options", "Options analytics", "pie"],
  ["valuation", "Agent valuation", "bulb"],
  ["oi-distribution", "Open interest distribution", "chart"],
  ["volume-distribution", "Volume distribution", "chart"],
  ["past", "Past events", "calendar"],
  ["future", "Upcoming events", "calendar"],
  ["tracking", "AI tracking", "target"],
  ["results", "Scan results", "search"],
];
const DEFAULT_LAYOUT = {
  order: [
    "payoff",
    "hedges",
    "tracking",
    "results",
    "technicals",
    "options",
    "valuation",
    "oi-distribution",
    "volume-distribution",
    "past",
    "future",
  ],
  hidden: [],
  collapsed: [],
  metrics: {},
  theme: "light",
};
function restoreLayout(saved = {}) {
  const order = Array.isArray(saved.order)
    ? saved.order.filter((id) => DEFAULT_LAYOUT.order.includes(id))
    : DEFAULT_LAYOUT.order;
  return {
    ...DEFAULT_LAYOUT,
    ...saved,
    order: [...new Set([...order, ...DEFAULT_LAYOUT.order])],
  };
}
const METRICS = {
  payoff: ["Net option cost", "Max loss", "Max gain", "Breakeven"],
  technicals: ["RSI", "50-day average", "Support", "Resistance"],
  options: ["IV", "HV", "IV rank", "Min OI"],
  valuation: ["Target", "Agent view"],
};
const money = (v, d = 0) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: d,
      }).format(v);
const num = (v, d = 1) =>
  v == null
    ? "—"
    : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
const pct = (v) => (v == null ? "—" : `${num(v)}%`);
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
function Sparkline({ series, labels = [] }) {
  const values = series.flatMap((s) => s.filter(Number.isFinite));
  if (values.length < 2)
    return <div className="empty-chart">Historical data unavailable</div>;
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  return (
    <div className="spark">
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
            stroke={k ? "#9770db" : "#087e63"}
            strokeWidth="2.2"
            points={s
              .map(
                (v, i) =>
                  `${(i * 480) / (s.length - 1 || 1)},${82 - ((v - min) / range) * 72}`,
              )
              .join(" ")}
          />
        ))}
      </svg>
      <div className="chart-labels">
        {labels.map((s, i) => (
          <span key={s} style={{ color: i ? "#9770db" : "#087e63" }}>
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
function Field({ label, children }) {
  return (
    <label className="studio-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function sourceDate(v) {
  return v
    ? new Date(v).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not checked";
}
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
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
        ]
      : ["tracker", "backtests"]
    ).includes(tail)
      ? tail
      : "workspace";
  };
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
  const [rows, setRows] = useState(sample?.rows ?? []),
    [datasets, setDatasets] = useState(sample?.datasets ?? {}),
    [items, setItems] = useState(sample?.items ?? []),
    [agent, setAgent] = useState(sample?.agent ?? null),
    [agentAvailable, setAgentAvailable] = useState(false);
  const [selectedId, setSelectedId] = useState(sample?.rows[0]?.id ?? ""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [job, setJob] = useState(null),
    [busy, setBusy] = useState(false),
    [research, setResearch] = useState(null),
    [researchError, setResearchError] = useState("");
  const [modal, setModal] = useState(null),
    [includeCatalysts, setIncludeCatalysts] = useState(true),
    [filter, setFilter] = useState(""),
    [templateFilter, setTemplateFilter] = useState("all"),
    [minRating, setMinRating] = useState(""),
    [expiryFilter, setExpiryFilter] = useState("all"),
    [sort, setSort] = useState("overall"),
    [page, setPage] = useState(0),
    [expanded, setExpanded] = useState(false);
  const [view, setView] = useState(routeView);
  const [agentFilter, setAgentFilter] = useState("All"),
    [showResolved, setShowResolved] = useState(true),
    [volDays, setVolDays] = useState(60),
    [past, setPast] = useState(30),
    [future, setFuture] = useState(30),
    [events, setEvents] = useState({ past: null, future: null }),
    [tests, setTests] = useState([]);
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
    selectionRequest = useRef(0);
  const row = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );
  const ratedRows = useMemo(
    () => rows.map((r) => applyCatalysts(r, items, includeCatalysts)),
    [rows, items, includeCatalysts],
  );
  const selected = ratedRows.find((r) => r.id === row?.id),
    symbol = row?.symbol ?? strategy.symbols[0],
    dataset = datasets[symbol],
    tech = useMemo(() => technicals(dataset?.bars ?? []), [dataset]);
  const filtered = useMemo(
    () =>
      ratedRows
        .filter(
          (r) =>
            (!filter ||
              `${r.symbol} ${r.name} ${r.legs.map((l) => l.contract).join(" ")}`
                .toLowerCase()
                .includes(filter.toLowerCase())) &&
            (templateFilter === "all" || r.template === templateFilter) &&
            (expiryFilter === "all" || r.expiry === expiryFilter) &&
            (!minRating ||
              (r.overall != null && r.overall >= Number(minRating))),
        )
        .sort((a, b) =>
          sort === "symbol"
            ? a.symbol.localeCompare(b.symbol)
            : sort === "cost"
              ? a.netDebit - b.netDebit
              : (b.overall ?? -1) - (a.overall ?? -1),
        ),
    [ratedRows, filter, templateFilter, expiryFilter, minRating, sort],
  );
  const valuation = agent?.valuations?.find((v) => v.symbol === symbol),
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
  }, [symbol, dataset?.asOf, demo, distributionDays]);
  function navigate(next) {
    const p = next === "workspace" ? basePath : `${basePath}/${next}`;
    history.pushState({}, "", p + (demo ? "?demo=1" : ""));
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
  async function run(kind = "scan") {
    setError("");
    setBusy(true);
    setNotice("");
    try {
      if (demo) {
        validateStrategy(strategy);
        if (kind === "scan") {
          const d = demoWorkspace(strategy);
          setRows(d.rows);
          setPage(0);
          setDatasets(d.datasets);
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
        strategy,
        strategyId: id,
        includeCatalysts,
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
              setRows(next.result.rows);
              setPage(0);
              setDatasets(next.result.datasets);
              setSelectedId(next.result.rows[0]?.id ?? "");
              setNotice(
                `${next.result.rows.length} candidates scanned. ${next.result.warnings.join(" · ")}`,
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
  }, [filter, templateFilter, minRating, expiryFilter]);
  useEffect(() => {
    const request = ++selectionRequest.current;
    setResearch(null);
    setResearchError("");
    if (!dataset || demo) return;
    api(`/builder/research/${symbol}`)
      .then((r) => {
        if (request === selectionRequest.current) setResearch(r);
      })
      .catch((e) => {
        if (request === selectionRequest.current) setResearchError(e.message);
      });
  }, [symbol, dataset?.asOf, demo]);
  useEffect(() => {
    if (!dataset || demo) return;
    let live = true;
    setEvents({ past: null, future: null });
    for (const [direction, days] of [
      ["past", past],
      ["future", future],
    ])
      api(`/builder/events/${symbol}?direction=${direction}&days=${days}`)
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
  }, [symbol, past, future, dataset?.asOf, demo]);
  const getPnl = useCallback(
    ({ spot, date }) => (row ? payoff(row, spot, date) : 0),
    [row],
  );
  const heatmap = useMemo(
    () =>
      row
        ? buildScenarioHeatmapSnapshot({
            startDate: row.asOf.slice(0, 10),
            endDate: row.expiry,
            currentPrice: row.spot,
            volatility: row.iv ?? row.hv ?? 0.2,
            rowCount: 7,
            columnCount: 6,
            getCellPnL: getPnl,
          })
        : null,
    [row, getPnl],
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
  async function removeItem(id) {
    try {
      if (!demo)
        await api(
          `/builder/strategies/${strategyId}/items/${id}`,
          undefined,
          "DELETE",
        );
      setItems((v) => v.filter((i) => i.id !== id));
      setModal(null);
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
  function newItem() {
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
        symbol,
        template: row?.template ?? strategy.template,
        sources: [],
        impactUntil: addDays(dateOnly(Date.now()), 30),
        rationale: "",
      },
    });
  }
  function exportRows() {
    const columns = [
      "symbol",
      "name",
      "expiry",
      "netDebit",
      "fees",
      "maxProfit",
      "maxLoss",
      "minOi",
      "baseScore",
      "catalystImpact",
      "overall",
    ];
    const blob = new Blob(
      [
        [
          columns.join(","),
          ...filtered.map((r) => columns.map((c) => csvCell(r[c])).join(",")),
        ].join("\n"),
      ],
      { type: "text/csv" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hedgehub-option-results.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const phase = busy
    ? `${job?.kind === "backtest" ? "Backtesting" : "Scanning"} · ${job?.progress ?? 0}%`
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
            onClick={() => setModal({ type: "panel", id })}
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
              {data.events.slice(0, 2).map((e, i) => (
                <tr key={i}>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => setModal({ type: "event", event: e })}
                    >
                      {e.title}
                    </button>
                  </td>
                  <td>{e.date}</td>
                  <td>
                    {direction === "past" ? pct(e.observedMove) : e.dateStatus}
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
          <span className={tone(selected?.catalystImpact)}>
            Net {delta(selected?.catalystImpact ?? 0)}
          </span>
          <span className="spacer" />
          <button onClick={newItem}>+ Add</button>
          <button
            className="badge neutral"
            onClick={() => setModal({ type: "suggestions" })}
          >
            {agent?.suggestions?.length ?? 0} suggestions
          </button>
          <button className="text-button" onClick={() => navigate("tracker")}>
            Open tracker ↗
          </button>
        </div>
        <div className="catalyst-chips">
          {visibleItems.length ? (
            visibleItems.map((item) => {
              const c = selected?.contributions.find((c) => c.id === item.id);
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
  function resultsTable() {
    return (
      <div className={expanded ? "results-fullscreen" : ""}>
        <div className="results-toolbar">
          <strong>
            Scanned option results <small>{filtered.length} matches</small>
          </strong>
          <input
            aria-label="Search results"
            placeholder="Search stock or strategy…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            aria-label="Filter strategy"
            value={templateFilter}
            onChange={(e) => setTemplateFilter(e.target.value)}
          >
            <option value="all">All strategies</option>
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
            {[...new Set(rows.map((r) => r.expiry))].map((d) => (
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
          <label className="switch">
            <input
              type="checkbox"
              checked={includeCatalysts}
              onChange={(e) => setIncludeCatalysts(e.target.checked)}
            />
            Catalysts
          </label>
          <button onClick={() => setModal({ type: "columns" })}>Columns</button>
          <button onClick={exportRows} disabled={!filtered.length}>
            Export
          </button>
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? "Close expanded" : "Expand"}
          </button>
        </div>
        <div className="results-scroll">
          <table className="results-table">
            <thead>
              <tr>
                <th />
                <th>
                  <button onClick={() => setSort("symbol")}>
                    Stock / Strategy
                  </button>
                </th>
                <th>Option legs</th>
                <th>Expiry</th>
                <th>
                  <button onClick={() => setSort("cost")}>
                    Option debit / credit
                  </button>
                </th>
                {!layout.hiddenColumns?.includes("risk") && (
                  <>
                    <th>Max profit</th>
                    <th>Max loss</th>
                    <th>Breakeven</th>
                  </>
                )}
                {!layout.hiddenColumns?.includes("iv") && <th>IV</th>}
                {!layout.hiddenColumns?.includes("oi") && <th>Min OI</th>}
                <th>Data</th>
                <th>
                  <button onClick={() => setSort("overall")}>Rating ↓</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(page * 8, page * 8 + 8).map((r) => (
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
                    <span className="subtle"> · {r.name}</span>
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(r.id);
                        setModal({ type: "result", row: r });
                      }}
                    >
                      {r.legs
                        .map(
                          (l) =>
                            `${l.quantity > 0 ? "Buy" : "Sell"} ${l.strike}${l.type === "put" ? "P" : "C"}`,
                        )
                        .join(" · ") || `${r.shares} shares`}
                    </button>
                  </td>
                  <td>{r.expiry}</td>
                  <td>
                    {money(Math.abs(r.netDebit))}{" "}
                    {r.netDebit < 0 ? "credit" : "debit"}
                  </td>
                  {!layout.hiddenColumns?.includes("risk") && (
                    <>
                      <td className="positive">
                        {r.maxProfit == null ? "Unlimited" : money(r.maxProfit)}
                      </td>
                      <td className="negative">
                        {r.maxLoss == null ? "Unlimited" : money(r.maxLoss)}
                      </td>
                      <td>
                        {r.breakevens.map((v) => money(v, 2)).join(" / ") ||
                          "—"}
                      </td>
                    </>
                  )}
                  {!layout.hiddenColumns?.includes("iv") && (
                    <td>{pct(r.iv == null ? null : r.iv * 100)}</td>
                  )}
                  {!layout.hiddenColumns?.includes("oi") && (
                    <td>{num(r.minOi, 0)}</td>
                  )}
                  <td>
                    <span
                      className={`data-label ${r.modeled ? "modeled" : ""}`}
                    >
                      {demo
                        ? "Sample"
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
                    <button
                      className={`rating ${tone(r.catalystImpact)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setModal({ type: "rating", row: r });
                      }}
                    >
                      {r.overall ??
                        `${r.adjustedRange[0]}–${r.adjustedRange[1]}`}{" "}
                      <small>({delta(r.catalystImpact)})</small>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                ? `${page * 8 + 1}–${Math.min(page * 8 + 8, filtered.length)} of ${filtered.length}`
                : "0 results"}
            </span>
            <button
              disabled={(page + 1) * 8 >= filtered.length}
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
              ["Net option cost", money(row.netDebit + row.fees, 2)],
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
              snapshot={heatmap}
              key={row.id}
              title="Option payoff heatmap"
              description="Stock price × date · modeled P&L"
              startDate={row.asOf.slice(0, 10)}
              endDate={row.expiry}
              currentPrice={row.spot}
              volatility={row.iv ?? row.hv ?? 0.2}
              rowCount={7}
              columnCount={6}
              getCellPnL={getPnl}
              theme={layout.theme}
            />
            <p className="subtle">
              European reference pricing; fees included. Catalysts affect
              ratings, not contractual payoffs.
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
            <button className="primary" onClick={() => run()} disabled={busy}>
              Run first scan
            </button>
          </Empty>
        );
      case "hedges":
        return (
          <>
            <div className="hedge-choices">
              {["protective_put", "collar", "covered_call", "put_credit"].map(
                (t) => (
                  <button
                    key={t}
                    className={
                      (row?.template ?? strategy.template) === t ? "active" : ""
                    }
                    onClick={() => {
                      updateStrategy({ template: t });
                      const found = rows.find(
                        (r) => r.symbol === symbol && r.template === t,
                      );
                      if (found) setSelectedId(found.id);
                    }}
                  >
                    <Icon name="shield" />
                    <span>
                      <strong>{TEMPLATES[t]}</strong>
                      <small>
                        {
                          {
                            protective_put: "Keep upside · Pay for protection",
                            collar: "Lower hedge cost · Cap upside",
                            covered_call: "Earn premium · Keep stock risk",
                            put_credit: "Defined risk · Earn premium",
                          }[t]
                        }
                      </small>
                    </span>
                  </button>
                ),
              )}
            </div>
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
                  {row.legs.map((l, i) => (
                    <p key={i}>
                      <span
                        className={l.quantity > 0 ? "positive" : "negative"}
                      >
                        {l.quantity > 0 ? "↗ Buy" : "↘ Sell"}
                      </span>{" "}
                      {Math.abs(l.quantity)} × {money(l.strike)} {l.type}
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
            <Sparkline
              series={[(dataset?.bars ?? []).slice(-120).map((b) => b.close)]}
              labels={[symbol + " price"]}
            />
            {metrics("technicals", [
              ["RSI", num(tech.rsi)],
              ["50-day average", money(tech.sma50, 2)],
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
        const from = addDays(dateOnly(Date.now()), -volDays),
          ivs = (research?.volatility?.history ?? []).filter(
            (b) => b.date >= from,
          ),
          hv = (dataset?.bars ?? [])
            .map((b, i, a) => ({
              date: b.date,
              value: realizedVol(a.slice(0, i + 1)),
            }))
            .filter((b) => b.date >= from && b.value != null)
            .map((b) => b.value);
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
            <Sparkline
              series={ivs.length ? [ivs.map((b) => b.iv), hv] : [hv]}
              labels={
                ivs.length
                  ? ["IV history", "HV history"]
                  : ["Realized volatility history"]
              }
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
      case "valuation":
        return (
          <div className="valuation">
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
                    ? "Request research for your stock list."
                    : "Connect the optional TradingAgents service to see price targets and evidence."}
                </p>
              </>
            )}
            <button onClick={refreshAgent}>
              {" "}
              {agent?.status && !["completed", "failed"].includes(agent.status)
                ? "Check research"
                : "Run AI research"}
            </button>
            {agent?.error && <p className="negative">{agent.error}</p>}
            {researchError && (
              <p className="subtle">Additional research: {researchError}</p>
            )}
          </div>
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
              : "Set TRADINGAGENTS_URL and TRADINGAGENTS_TOKEN on the server to enable daily AI research."}{" "}
            Sources and completion claims require review.
          </p>
          {agent?.error && <p className="negative">{agent.error}</p>}
          <div className="suggestion-grid">
            {agent?.suggestions?.length ? (
              agent.suggestions.map((s) => (
                <article key={s.id}>
                  <strong>{s.title}</strong>
                  <small>
                    {s.symbol} · {s.sentiment}
                  </small>
                  <button
                    onClick={() =>
                      setModal({
                        type: "item",
                        item: {
                          ...s,
                          id: undefined,
                          impactUntil: addDays(dateOnly(Date.now()), 30),
                        },
                      })
                    }
                  >
                    + Track
                  </button>
                </article>
              ))
            ) : (
              <Empty>
                No AI suggestions yet. Add a manual topic or request research.
              </Empty>
            )}
          </div>
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
          <label>
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />{" "}
            Show resolved
          </label>
        </div>
        <div className="tracker-columns">
          {["Bullish", "Neutral", "Bearish"].map((group) => (
            <section key={group} className={`panel ${tone(group)}`}>
              <h2>{group}</h2>
              {visibleItems
                .filter((i) =>
                  i.sentiment.toLowerCase().includes(group.toLowerCase()),
                )
                .map((i) => (
                  <button
                    key={i.id}
                    className="tracker-row"
                    onClick={() => setModal({ type: "item", item: i })}
                  >
                    <span
                      className={`status-dot ${i.status === "resolved" ? "resolved" : ""}`}
                    >
                      {i.status === "resolved" ? "✓" : "○"}
                    </span>
                    <span>
                      <strong>{i.title}</strong>
                      <small>
                        {i.status} ·{" "}
                        {i.verified ? "Evidence reviewed" : "Unverified"}
                      </small>
                      <small>{i.condition}</small>
                      <small>{sourceDate(i.checkedAt)}</small>
                    </span>
                    <b>{delta(i.points)}</b>
                  </button>
                ))}
            </section>
          ))}
        </div>
        <p className="subtle">
          Resolved items stay until removed. Resolution and directional impact
          are separate. Removing an item never disables discovery.
        </p>
      </div>
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
              <button
                onClick={() => {
                  navigate("workspace");
                  setTimeout(
                    () =>
                      document
                        .getElementById("studio-results")
                        ?.scrollIntoView({ behavior: "smooth" }),
                    30,
                  );
                }}
              >
                Scanner
              </button>
              <button
                className={view === "backtests" ? "active" : ""}
                onClick={() => navigate("backtests")}
              >
                Backtests
              </button>
            </nav>
            <span className="spacer" />
            <span className="mode-label">
              {demo ? "Interactive demo · Sample data" : "Strategy Studio"}
            </span>
            <a href="/">Classic UI ↗</a>
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
          <div className="studio-shell">
            <aside className="studio-sidebar">
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
                <select
                  aria-label="Selected stock"
                  value={symbol}
                  onChange={(e) => {
                    const r = rows.find((r) => r.symbol === e.target.value);
                    if (r) setSelectedId(r.id);
                  }}
                >
                  {[
                    ...new Set([
                      ...strategy.symbols,
                      ...rows.map((r) => r.symbol),
                    ]),
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <strong>{money(row?.spot ?? dataset?.spot, 2)}</strong>
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
                  onClick={() => run()}
                  disabled={busy}
                >
                  <Icon name="search" />
                  {busy ? "Scanning…" : "Scan stocks"}
                </button>
              </div>
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
              ) : (
                <>
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
                            {id === "results" ? null : panelHeader(...p)}
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
                    risk: "Profit, loss and breakevens",
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
              <pre className="report-text">
                {valuation?.report || "No report available."}
              </pre>
            </>
          )}
          {modal.type === "suggestions" && (
            <>
              <p>
                {agentAvailable
                  ? "Suggested checkpoints from the latest agent reports. Review sources before enabling rating contributions."
                  : "TradingAgents is not configured. Manual tracking is available."}
              </p>
              <button onClick={refreshAgent}>Refresh AI suggestions</button>
              {agent?.suggestions?.map((s) => (
                <article className="detail-box" key={s.id}>
                  <strong>{s.title}</strong>
                  <p>
                    {s.symbol} · {s.sentiment}
                  </p>
                  <button
                    onClick={() =>
                      setModal({
                        type: "item",
                        item: {
                          ...s,
                          id: undefined,
                          impactUntil: addDays(dateOnly(Date.now()), 30),
                        },
                      })
                    }
                  >
                    Add to strategy
                  </button>
                </article>
              ))}
            </>
          )}
          {modal.type === "event" && (
            <>
              <h3>{modal.event.title}</h3>
              <p>
                {modal.event.date} · {modal.event.dateStatus}
              </p>
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
              {modal.data?.events?.map((e, i) => (
                <button
                  className="event-row"
                  key={i}
                  onClick={() => setModal({ type: "event", event: e })}
                >
                  <span>{e.title}</span>
                  <small>
                    {e.date} · {e.dateStatus}
                  </small>
                </button>
              ))}
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
      <Field label="Source URLs (one per line)">
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
        expire after 7 days unless refreshed, and never accumulate on repeated
        scans. Resolved is a status, not automatically bullish.
      </p>
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
        {delta(r.catalystImpact)} ={" "}
        <strong>{r.overall ?? r.adjustedRange.join("–")}</strong>
      </p>
      <p className="subtle">
        Protection 35, option cost 25, upside capture 20, quote liquidity 20.
        Missing liquidity produces a range and excludes the result from
        exact-score ranking.
      </p>
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
