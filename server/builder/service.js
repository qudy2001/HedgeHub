import { createStockVolumeService } from "./stockVolume.js";
import { createDistributionLoader } from "./distributions.js";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { createBuilderStore } from "./store.js";
import { createSnapshotStore } from "./snapshotStore.js";
import { createAgentService, agentConfigured } from "./agents.js";
import { CONTENT_LANGUAGES, normalizeContentLanguage } from "../../shared/contentLanguage.js";
import { createOptionContext } from "./optionContext.js";
import {
  DEFAULT_STRATEGY,
  TEMPLATES,
  validateStrategy,
  buildCandidates,
  applyCatalysts,
  riskAdjustment,
  DAY,
  dateOnly,
  addDays,
  number,
} from "../../shared/builderEngine.js";
import { fetchQuotes, fetchOptionChain } from "../providers/marketData.js";
import { getTigerRateLimitState, withRateLimitWaiting } from "../providers/tiger.js";
import { fetchStockDailyOhlcHistory } from "../stockOhlcHistory.js";
import { buildPriceZones } from "../coveredIncomeScanner.js";
import {
  fetchCompanyEventsCalendar,
  fetchEconomicCalendar,
  fetchEconomicCalendarWindow,
} from "../providers/tradingViewCalendars.js";
import { curatedCatalysts } from "../researchCatalysts.js";
import { getCalendarCache, upsertCalendarCache, getLatestIvRankDaily, listMarketTopics, listMarketTopicHistory } from "../db.js";
import { TOPIC_ITEM_KEY, refreshItemFromTopic } from "../../shared/marketTopics.js";
const defaultData = async (symbol, s, { needsChain = true } = {}) => {
  const from = addDays(dateOnly(Date.now()), Math.max(1, s.dte - 21)),
    to = addDays(dateOnly(Date.now()), s.dte + 21);
  const [q, h] = await Promise.allSettled([
    fetchQuotes([
      { symbol, sourceSymbol: `${symbol.toLowerCase()}.us`, provider: "stooq" },
    ]),
    fetchStockDailyOhlcHistory({ symbol, lookbackPoints: 1500 }),
  ]);
  const quote = q.status === "fulfilled" ? q.value[0] : null,
    history = h.status === "fulfilled" ? h.value : null;
  const spot = quote?.regularMarketPrice ?? history?.points.at(-1)?.close;
  if (!(spot > 0)) throw new Error(`No stock price available for ${symbol}`);
  const warnings = [q, h]
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason.message);
  let chain = [];
  if (s.pricingMode === "market" && needsChain)
    for (const type of ["put", "call"]) {
      try {
        const c = await fetchOptionChain({
          symbol,
          expirationFrom: from,
          expirationTo: to,
          optionType: type,
          currentSpot: spot,
          limit: 200,
        });
        chain.push(...(c.contracts ?? []));
        warnings.push(...(c.warnings ?? []));
      } catch (e) {
        warnings.push(e.message);
      }
    }
  return {
    symbol,
    spot,
    asOf: new Date().toISOString(),
    quoteTimestamp: quote?.regularMarketTime ?? null,
    source: quote?.source ?? history?.source,
    bars: history?.points ?? [],
    adjustment:
      history?.adjustment ??
      "Provider-adjusted series; dividends not reconstructed",
    chain,
    warnings,
  };
};
// TradingView caps each economic-calendar response at about four weeks, so fetch in 14-day
// chunks. `coveredUntil` is the end of the contiguous range that actually loaded.
const MACRO_DAYS = 120;
const defaultMacro = async () => {
  const start = Date.now(),
    events = new Map();
  let coveredUntil = null;
  for (let offset = 0; offset < MACRO_DAYS; offset += 14) {
    const from = new Date(start + offset * DAY),
      to = new Date(start + Math.min(offset + 14, MACRO_DAYS) * DAY - 1);
    let rows;
    for (let attempt = 0; attempt < 2 && !rows; attempt++)
      rows = await fetchEconomicCalendar({ from, to, importance: 1 }).catch(
        () => null,
      );
    if (!rows) break;
    for (const e of rows)
      if (e.country === "US" && e.date)
        events.set(e.id || `${e.date}:${e.title}`, {
          date: dateOnly(e.date),
          title: e.title,
        });
    coveredUntil = dateOnly(to);
  }
  if (!coveredUntil) throw new Error("Macro calendar unavailable");
  return {
    events: [...events.values()].sort((a, b) => a.date.localeCompare(b.date)),
    coveredUntil,
  };
};
export function validateItem(input, old = {}) {
  const p = { ...old, ...input };
  if (
    !String(p.title ?? "").trim() ||
    String(p.title).length > 240 ||
    !String(p.condition ?? "").trim() ||
    !String(p.resolution ?? "").trim()
  )
    throw new Error(
      "Title, tracking condition and resolution rule are required.",
    );
  if (
    !["monitoring", "resolved"].includes(p.status) ||
    ![
      "Strong bullish",
      "Bullish",
      "Neutral",
      "Bearish",
      "Strong bearish",
    ].includes(p.sentiment)
  )
    throw new Error("Invalid status or sentiment");
  const points = number(p.points);
  if (points == null || points < -5 || points > 5)
    throw new Error("Contribution must be between −5 and +5");
  const sources = (Array.isArray(p.sources) ? p.sources : [])
    .map((v) => {
      const u = new URL(v);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw new Error("Invalid source URL");
      return u.href;
    })
    .slice(0, 10);
  if (p.template && !TEMPLATES[p.template])
    throw new Error("Invalid strategy scope");
  if (p.symbol && !/^[A-Z][A-Z0-9.-]{0,14}$/.test(p.symbol))
    throw new Error("Invalid symbol");
  if (
    p.impactUntil &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(p.impactUntil) ||
      dateOnly(p.impactUntil) !== p.impactUntil)
  )
    throw new Error("Invalid impact end date");
  return {
    id: old.id ?? crypto.randomUUID(),
    eventKey: String(p.eventKey || p.title)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " "),
    title: String(p.title).trim(),
    condition: String(p.condition).slice(0, 1000),
    resolution: String(p.resolution).slice(0, 1000),
    symbol: p.symbol || "",
    template: p.template || "",
    status: p.status,
    sentiment: p.sentiment,
    points,
    verified: p.verified === true,
    sources,
    rationale: String(p.rationale ?? "").slice(0, 2000),
    impactUntil: p.impactUntil || null,
    checkedAt: new Date().toISOString(),
    createdAt: old.createdAt ?? new Date().toISOString(),
    agentUpdate: old.agentUpdate ?? null,
    history: [
      ...(old.history ?? []),
      {
        at: new Date().toISOString(),
        note: old.id
          ? `${p.status}; impact ${points}; evidence ${p.verified ? "reviewed" : "unverified"}`
          : "Added to strategy",
      },
    ].slice(-100),
  };
}
export function registerBuilderRoutes(
  app,
  {
    store: injectedStore = null,
    snapshots: injectedSnapshots = null,
    loadData = defaultData,
    researchService = null,
    loadMacro = defaultMacro,
    loadDistribution = createDistributionLoader(),
    // Fetch the full option chain as part of a single-stock scan, so its snapshot does not depend on the browser.
    captureChainOnScan = false,
  } = {},
) {
  const store = injectedStore ?? createBuilderStore();
  // A caller that brings its own store (tests) gets a throwaway snapshot store, never the real data file.
  const snapshots =
    injectedSnapshots ?? createSnapshotStore(injectedStore ? ":memory:" : undefined);
  // Snapshots are a by-product: a failure to save one must never fail the scan or the panel request.
  const capture = (fn) => {
    try {
      return fn();
    } catch (e) {
      console.warn(`[builder] snapshot not saved: ${e.message}`);
      return null;
    }
  };
  const saveDistribution = (owner, symbol, days, data) =>
    capture(() =>
      snapshots.attach(owner, symbol, "distribution", { ...data, days }, {
        meta: { days, asOf: data.asOf, contracts: data.contracts?.length ?? 0 },
        unless: (old, snapshot) =>
          (old.meta.asOf === data.asOf && old.meta.days === days) ||
          (old.meta.contracts > 0 && !data.contracts?.length) ||
          // A wider chain loaded since the last scan already covers this horizon.
          (old.meta.days > days && old.capturedAt >= snapshot.capturedAt),
      }),
    );
  let stockVolume;
  app.post("/api/builder/stock-volume", (req, res) => {
    try {
      stockVolume ??= createStockVolumeService({
        onResult: (owner, settings, result) =>
          capture(() =>
            snapshots.attach(
              owner,
              settings.symbol,
              `stockVolume:${settings.interval}:${settings.days}`,
              { interval: settings.interval, days: settings.days, buckets: settings.buckets, result },
              { variants: 6 },
            ),
          ),
      });
      res.status(202).json(stockVolume.start(req.user.id, req.body));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.get("/api/builder/stock-volume/:id", (req, res) => {
    const job = stockVolume?.get(req.user.id, req.params.id);
    res
      .status(job ? 200 : 404)
      .json(job ?? { error: "History request not found" });
  });
  app.post("/api/builder/stock-volume/:id/cancel", (req, res) => {
    const job = stockVolume?.cancel(req.user.id, req.params.id);
    res
      .status(job ? 200 : 404)
      .json(job ?? { error: "History request not found" });
  });
  app.get("/api/builder/distributions/:symbol", async (req, res) => {
    try {
      const symbol = validateStrategy({ symbols: [req.params.symbol] })
          .symbols[0],
        days = Number(req.query.days ?? 365);
      if (![365, 730].includes(days))
        throw new Error("Unsupported expiry horizon");
      const data = await loadDistribution(symbol, days);
      saveDistribution(req.user.id, symbol, days, data);
      res.json(data);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  // Preferences that apply to everything a user does in the Builder. Unknown keys are dropped, bad values fall back.
  const preferences = (owner) => ({ contentLanguage: normalizeContentLanguage(store.prefs(owner).contentLanguage) });
  const agents = createAgentService(store, {
      optionContext: createOptionContext(snapshots),
      language: (owner) => preferences(owner).contentLanguage,
    }),
    active = new Map(),
    cache = new Map();
  let running = 0;
  const route = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status ?? 400).json({ error: e.message });
    }
  };
  const getStrategy = (req) => {
    const s = store.strategy(req.user.id, req.params.id);
    if (!s)
      throw Object.assign(new Error("Strategy not found"), { status: 404 });
    return s;
  };
  app.get(
    "/api/builder/strategies",
    route((req, res) =>
      res.json({
        strategies: store.strategies(req.user.id),
        defaults: DEFAULT_STRATEGY,
        agentConfigured: agentConfigured(),
        preferences: preferences(req.user.id),
      }),
    ),
  );
  app.get(
    "/api/builder/preferences",
    route((req, res) => res.json(preferences(req.user.id))),
  );
  app.put(
    "/api/builder/preferences",
    route((req, res) => {
      const wanted = req.body?.contentLanguage;
      if (!CONTENT_LANGUAGES.some(([key]) => key === wanted))
        throw Object.assign(new Error("contentLanguage must be en or zh"), { status: 400 });
      store.savePrefs(req.user.id, { ...store.prefs(req.user.id), contentLanguage: wanted });
      res.json(preferences(req.user.id));
    }),
  );
  // AI market topics (written through the MCP connector) for the "AI suggestions" view. Postgres only.
  app.get(
    "/api/builder/market-topics",
    route((req, res) => {
      try {
        res.json({ available: true, topics: listMarketTopics().filter((topic) => topic.status === "active") });
      } catch (error) {
        if (!/DB_TYPE=postgres/.test(String(error.message))) throw error;
        res.json({ available: false, topics: [] });
      }
    }),
  );
  app.get(
    "/api/builder/market-topics/:id/history",
    route((req, res) => {
      try {
        res.json({ history: listMarketTopicHistory(Number(req.params.id)) });
      } catch (error) {
        if (!/DB_TYPE=postgres/.test(String(error.message))) throw error;
        res.json({ history: [] });
      }
    }),
  );
  app.put(
    "/api/builder/strategies/:id",
    route((req, res) => {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(req.params.id))
        throw new Error("Invalid strategy ID");
      const definition = validateStrategy(req.body.definition);
      const old = store.strategy(req.user.id, req.params.id);
      res.json(
        store.save(req.user.id, req.params.id, {
          definition,
          layout: req.body.layout ?? old?.layout ?? {},
          revision: (old?.revision ?? 0) + 1,
        }),
      );
    }),
  );
  app.get(
    "/api/builder/strategies/:id",
    route((req, res) => {
      const s = getStrategy(req);
      res.json({
        ...s,
        items: store.items(req.user.id, s.id),
        agent: store.agent(req.user.id, s.id),
        agentConfigured: agentConfigured(),
      });
    }),
  );
  app.post(
    "/api/builder/strategies/:id/items",
    route((req, res) => {
      getStrategy(req);
      const old = req.body.id
        ? store.item(req.user.id, req.params.id, req.body.id)
        : null;
      if (req.body.id && !old)
        throw Object.assign(new Error("Item not found"), { status: 404 });
      res
        .status(old ? 200 : 201)
        .json(
          store.putItem(
            req.user.id,
            req.params.id,
            validateItem(req.body, old ?? {}),
          ),
        );
    }),
  );
  app.delete(
    "/api/builder/strategies/:id/items/:item",
    route((req, res) => {
      getStrategy(req);
      store.removeItem(req.user.id, req.params.id, req.params.item);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/builder/strategies/:id/research",
    route(async (req, res) => {
      const s = getStrategy(req);
      res.json(await agents.refresh(req.user.id, s, true));
    }),
  );
  app.get(
    "/api/builder/strategies/:id/research",
    route(async (req, res) => {
      const s = getStrategy(req);
      const state = store.agent(req.user.id, s.id);
      const data =
        state?.runId &&
        !["completed", "completed_with_errors", "failed", "stopped"].includes(
          state.status,
        )
          ? await agents.refresh(req.user.id, s)
          : (state ?? {
              suggestions: [],
              valuations: [],
              status: "not-started",
            });
      res.json({ ...data, trackedItems: store.items(req.user.id, s.id) });
    }),
  );
  app.post(
    "/api/builder/strategies/:id/research/:symbol",
    route(async (req, res) => {
      const s = getStrategy(req);
      const symbol = String(req.params.symbol || "").toUpperCase();
      if (!symbol) throw Object.assign(new Error("Symbol required"), { status: 400 });
      const state = await agents.refreshSymbol(req.user.id, s, symbol, true);
      res.json({ ...state, trackedItems: store.items(req.user.id, s.id) });
    }),
  );
  app.get(
    "/api/builder/strategies/:id/research/:symbol",
    route(async (req, res) => {
      const s = getStrategy(req);
      const symbol = String(req.params.symbol || "").toUpperCase();
      const state = store.agent(req.user.id, s.id);
      const symState = state?.runsBySymbol?.[symbol];
      const data =
        symState?.runId &&
        !["completed", "completed_with_errors", "failed", "stopped"].includes(
          symState.status,
        )
          ? await agents.refreshSymbol(req.user.id, s, symbol)
          : (state ?? { suggestions: [], valuations: [] });
      res.json({ ...data, trackedItems: store.items(req.user.id, s.id) });
    }),
  );
  app.get(
    "/api/builder/jobs/:id",
    route((req, res) => {
      const j = store.getJob(req.user.id, req.params.id);
      if (!j) return res.status(404).json({ error: "Run not found" });
      // A running scan that is waiting out the data provider's rate limit says so (and resumes by itself).
      res.json(
        ["queued", "running"].includes(j.status)
          ? { ...j, waitingUntil: getTigerRateLimitState().waitingUntil }
          : j,
      );
    }),
  );
  app.get(
    "/api/builder/jobs",
    route((req, res) =>
      res.json(store.jobs(req.user.id).map(({ result, ...j }) => j)),
    ),
  );
  app.post(
    "/api/builder/jobs/:id/cancel",
    route((req, res) => {
      const j = store.getJob(req.user.id, req.params.id);
      if (!j) return res.status(404).json({ error: "Run not found" });
      const control = active.get(j.id);
      if (control) {
        control.cancelled = true;
        control.worker?.terminate();
      }
      res.json(
        ["running", "queued"].includes(j.status)
          ? store.job(req.user.id, { ...j, status: "cancelled" })
          : j,
      );
    }),
  );
  // IV rank and next earnings are best-effort context; a failure leaves the cell blank.
  async function scanExtras(symbol, snapshot) {
    const today = dateOnly(Date.now());
    let ivRank = null,
      nextEarnings = null,
      complete = false;
    try {
      ivRank = number(getLatestIvRankDaily(symbol, today)?.ivRank52w);
    } catch {}
    try {
      // researchService falls back Tiger -> TradingView -> Yahoo.
      const c = (await researchService?.earningsCoverage([symbol]))?.[symbol];
      nextEarnings = c?.events?.find((e) => e.date >= today)?.date ?? null;
      complete = Boolean(nextEarnings);
    } catch {}
    let zones = null;
    try {
      zones = buildPriceZones(snapshot?.bars ?? [], snapshot?.spot);
    } catch {}
    return { ivRank, nextEarnings, complete, zones };
  }
  // High-importance US macro events (FOMC/CPI/NFP...) for the risk-layer event window.
  // Market-wide, so cached and shared by concurrent scans. A failed refresh keeps the last good list.
  let macroCache = { at: 0, data: null, failed: false },
    macroPending = null;
  async function macroEvents(until) {
    const stale =
      Date.now() - macroCache.at > (macroCache.failed ? 5 * 60_000 : 3600_000);
    if (stale) {
      macroPending ??= Promise.race([
        loadMacro(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Macro calendar timed out")), 20_000).unref(),
        ),
      ])
        .then((data) => {
          if (!Array.isArray(data?.events)) throw new Error("Invalid macro data");
          macroCache = { at: Date.now(), data, failed: false };
        })
        .catch(() => {
          macroCache = { ...macroCache, at: Date.now(), failed: true };
        })
        .finally(() => {
          macroPending = null;
        });
      await macroPending;
    } else if (macroPending) await macroPending;
    const data = macroCache.data;
    if (!data) return null;
    const events = data.events.filter((e) => e.date <= until);
    return {
      events: events.slice(0, 12),
      count: events.length,
      coveredUntil: data.coveredUntil,
    };
  }
  async function riskFor(row, snapshot, extras) {
    const macro = await macroEvents(row.expiry);
    return riskAdjustment(row, {
      zones: extras.zones,
      calendar: {
        earningsDate:
          extras.nextEarnings && extras.nextEarnings <= row.expiry
            ? extras.nextEarnings
            : null,
        macro: macro?.events ?? null,
        macroCount: macro?.count ?? null,
        macroCoveredUntil: macro?.coveredUntil ?? null,
      },
    });
  }
  const earningsStatus = (next, complete, row) =>
    next && next <= row.expiry ? "Before expiry" : next || complete ? "Clear" : "Unknown";
  function saveScanSnapshots(owner, job, strategy, rows, datasets, warnings) {
    const valuations = job.strategyId
      ? (capture(() => store.agent(owner, job.strategyId))?.valuations ?? [])
      : [];
    for (const [symbol, dataset] of Object.entries(datasets)) {
      const own = rows.filter((r) => r.symbol === symbol);
      capture(() =>
        snapshots.saveScan(
          owner,
          symbol,
          {
            rows: own,
            dataset,
            warnings: warnings.filter((w) => w.startsWith(symbol + ": ")),
            items: (job.items ?? []).filter((i) => !i.symbol || i.symbol === symbol),
            includeCatalysts: job.includeCatalysts,
            templates: job.templates ?? null,
            strategy,
            valuation:
              valuations.find(
                (v) => v.symbol === symbol && (!v.status || v.status === "completed"),
              ) ?? null,
          },
          { spot: dataset.spot ?? null, strategy: strategy.name ?? null },
        ),
      );
    }
    if (captureChainOnScan && strategy.symbols.length === 1 && datasets[strategy.symbols[0]]) {
      const symbol = strategy.symbols[0];
      loadDistribution(symbol, 365)
        .then((data) => saveDistribution(owner, symbol, 365, data))
        .catch(() => {});
    }
  }
  // Hedge-choice scans (Polymarket and the like) run beside the Builder scan; their results join the snapshot.
  function attachHedgeScan(owner, symbols, result) {
    for (const symbol of symbols ?? [])
      capture(() =>
        snapshots.attach(owner, symbol, "hedges", {
          generatedAt: result.generatedAt ?? new Date().toISOString(),
          results: Object.fromEntries(
            Object.entries(result.results ?? {}).map(([id, r]) => [
              id,
              Array.isArray(r?.rows)
                ? { ...r, rows: r.rows.filter((x) => !x.symbol || x.symbol === symbol) }
                : r,
            ]),
          ),
        }),
      );
  }
  const snapshotView = (s) => {
    const part = (name) => s.parts[name]?.data ?? null;
    return {
      id: s.id,
      symbol: s.symbol,
      day: s.day,
      capturedAt: s.capturedAt,
      scan: part("scan"),
      distribution: part("distribution"),
      stockVolume: Object.entries(s.parts)
        .filter(([name]) => name.startsWith("stockVolume:"))
        .map(([, p]) => p.data),
      research: part("research"),
      events: { past: part("events:past"), future: part("events:future") },
      hedges: part("hedges"),
      savedAt: Object.fromEntries(Object.entries(s.parts).map(([name, p]) => [name, p.capturedAt])),
    };
  };
  app.get(
    "/api/builder/snapshots",
    route((req, res) => {
      const symbol = req.query.symbol
        ? validateStrategy({ symbols: [req.query.symbol] }).symbols[0]
        : null;
      res.json({
        retentionDays: snapshots.retentionDays,
        snapshots: snapshots.list(req.user.id, symbol),
      });
    }),
  );
  app.get(
    "/api/builder/snapshots/:id",
    route((req, res) => {
      const s = snapshots.get(req.user.id, req.params.id);
      if (!s) throw Object.assign(new Error("Snapshot not found"), { status: 404 });
      res.json(snapshotView(s));
    }),
  );
  async function runJob(owner, job, strategy, kind) {
    const control = { cancelled: false, worker: null };
    active.set(job.id, control);
    running++;
    const rows = [],
      datasets = {},
      warnings = [];
    const update = (patch) => {
      if (!control.cancelled) job = store.job(owner, { ...job, ...patch });
    };
    try {
      update({ status: "running" });
      for (const symbol of strategy.symbols) {
        if (control.cancelled) break;
        try {
          // A stock-only scan (used to load analytics when only non-option hedge choices are ticked) skips option chains.
          const needsChain = !(Array.isArray(job.templates) && job.templates.every((t) => t === "stock"));
          const snapshot = await loadData(symbol, strategy, { needsChain });
          if (control.cancelled) break;
          datasets[symbol] = snapshot;
          cache.set(owner + ":" + symbol, snapshot);
          if (cache.size > 100) cache.delete(cache.keys().next().value);
          warnings.push(
            ...(snapshot.warnings ?? []).map((w) => `${symbol}: ${w}`),
          );
          if (kind === "scan") {
            const candidates = buildCandidates(snapshot, strategy, job.templates);
            const extras = candidates.length
              ? await scanExtras(symbol, snapshot)
              : null;
            for (const r of candidates)
              rows.push(
                applyCatalysts(
                  {
                    ...r,
                    ivRank: extras.ivRank,
                    earnings: earningsStatus(extras.nextEarnings, extras.complete, r),
                    riskAdjustment: await riskFor(r, snapshot, extras),
                  },
                  job.items,
                  job.includeCatalysts,
                ),
              );
          }
          else {
            const result = await new Promise((resolve, reject) => {
              const worker = new Worker(
                new URL("./worker.js", import.meta.url),
                {
                  workerData: {
                    bars: snapshot.bars,
                    strategy: { ...strategy, symbols: [symbol] },
                    settings: job.settings,
                  },
                },
              );
              control.worker = worker;
              worker.once("message", (m) =>
                m.error
                  ? reject(new Error(m.error))
                  : resolve({
                      ...m.result,
                      source: snapshot.source,
                      adjustment: snapshot.adjustment,
                    }),
              );
              worker.once("error", reject);
              worker.once("exit", (code) => {
                reject(
                  new Error(
                    control.cancelled
                      ? "Backtest cancelled"
                      : `Backtest exited (${code}) without a result`,
                  ),
                );
              });
            });
            rows.push(result);
          }
        } catch (e) {
          warnings.push(`${symbol}: ${e.message}`);
        }
        update({
          progress: Math.round(
            (Object.keys(datasets).length / strategy.symbols.length) * 100,
          ),
        });
      }
      if (!control.cancelled) {
        rows.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
        if (kind === "scan") saveScanSnapshots(owner, job, strategy, rows, datasets, warnings);
        update({
          status: "completed",
          progress: 100,
          result: {
            rows,
            datasets,
            warnings,
            generatedAt: new Date().toISOString(),
          },
        });
      }
    } catch (e) {
      update({ status: "failed", error: e.message });
    } finally {
      active.delete(job.id);
      running--;
    }
  }
  for (const kind of ["scan", "backtest"])
    app.post(
      `/api/builder/${kind}`,
      route((req, res) => {
        if (running >= 2)
          return res.status(429).json({
            error: "Two scans/tests are already running. Try again shortly.",
          });
        const strategy = validateStrategy(req.body.strategy);
        if (kind === "backtest" && strategy.symbols.length > 10)
          throw new Error("Backtests support up to 10 symbols.");
        if (kind === "backtest") strategy.pricingMode = "modeled";
        const items = req.body.strategyId
          ? store.items(req.user.id, req.body.strategyId)
          : [];
        const job = store.job(req.user.id, {
          kind,
          status: "queued",
          progress: 0,
          strategy,
          strategyId: typeof req.body.strategyId === "string" ? req.body.strategyId : null,
          items,
          includeCatalysts: req.body.includeCatalysts !== false,
          templates: Array.isArray(req.body.templates)
            ? req.body.templates.filter((t) => TEMPLATES[t])
            : undefined,
          settings: req.body.settings ?? {},
          createdAt: new Date().toISOString(),
        });
        res.status(202).json(job);
        void withRateLimitWaiting(() => runJob(req.user.id, job, strategy, kind));
      }),
    );
  app.get(
    "/api/builder/research/:symbol",
    route(async (req, res) => {
      const symbol = validateStrategy({ symbols: [req.params.symbol] })
        .symbols[0];
      if (!researchService) throw new Error("Research service unavailable");
      const data = await researchService.research(symbol, { lookbackDays: 30 });
      capture(() => snapshots.attach(req.user.id, symbol, "research", data));
      res.json(data);
    }),
  );
  app.get(
    "/api/builder/events/:symbol",
    route(async (req, res) => {
      const symbol = validateStrategy({ symbols: [req.params.symbol] })
          .symbols[0],
        days = Number(req.query.days ?? 30),
        direction = req.query.direction === "past" ? "past" : "future";
      if (![30, 60, 180, 365].includes(days))
        throw new Error("Unsupported event window");
      const today = dateOnly(Date.now()),
        from = direction === "past" ? addDays(today, -days) : today,
        to = direction === "past" ? today : addDays(today, days),
        window = { from, to, today };

      // Extra event categories requested via "+ Item" picks
      const extras = new Set((req.query.extras ?? "").split(",").filter(Boolean));

      // Countries included by default — US only; others added via extras
      const CORE_COUNTRIES = new Set(["US"]);
      const COUNTRY_EXTRAS = {
        country_eu: ["EU", "DE", "FR", "IT", "ES", "PT", "AT", "BE", "NL"],
        country_uk: ["GB"],
        country_cn: ["CN", "HK"],
        country_jp: ["JP"],
        country_ca: ["CA"],
        country_au: ["AU", "NZ"],
      };
      const allowedCountries = extras.has("mkt_global_all") ? null : new Set(CORE_COUNTRIES);
      for (const [key, codes] of Object.entries(COUNTRY_EXTRAS)) {
        if (extras.has(key)) codes.forEach((c) => allowedCountries?.add(c));
      }

      // Peer earnings: symbol-only by default; large-cap peers when opted in
      const peerSymbols = extras.has("peers_largecap") ? [] : [symbol];
      const peerMinCap = extras.has("peers_largecap") ? 100_000_000_000 : 0;
      // For the single-symbol case, extend the search window to 180 days so the
      // next earnings is always found even when it falls outside the display window.
      const earningsTo = direction === "future" && peerSymbols.length === 1
        ? addDays(today, 180) : to;

      // Cache keys are date-scoped — the DB row's fetched_date column ensures one
      // refresh per calendar day regardless of intraday calls.
      const extrasTag = [...extras].sort().join(",");
      const earningsKey = `earnings:${peerSymbols.join(",")}:${direction}:${days}:${extrasTag}`;
      const economicKey = `economic:${from}:${to}:${extrasTag}`;

      async function cachedFetch(key, fetcher) {
        try {
          const hit = getCalendarCache(key);
          if (hit?.payload) return { status: "fulfilled", value: hit.payload };
        } catch { /* cache miss — proceed to fetch */ }
        const result = await fetcher().then(
          value => { try { upsertCalendarCache(key, value); } catch { /* non-fatal */ } return { status: "fulfilled", value }; },
          reason => ({ status: "rejected", reason })
        );
        return result;
      }

      const requests = await Promise.all([
        cachedFetch(earningsKey, () => fetchCompanyEventsCalendar({
          from: new Date(from),
          to: new Date(earningsTo),
          minMarketCapUsd: peerMinCap,
          symbols: peerSymbols,
        })),
        cachedFetch(economicKey, () => fetchEconomicCalendarWindow({ from: new Date(from), to: new Date(to) })),
        curatedCatalysts(symbol, window).then(
          value => ({ status: "fulfilled", value }),
          reason => ({ status: "rejected", reason })
        ),
      ]);
      const events = [],
        warnings = [];
      requests.forEach((r, i) => {
        if (r.status === "rejected") {
          // curatedCatalysts (i===2) fails silently when not configured — it's optional
          if (i !== 2) warnings.push(r.reason.message);
          return;
        }
        for (const e of (i === 2 ? r.value.events : r.value) ?? []) {
          const raw = e.date ?? e.timestamp;
          const d = raw ? dateOnly(raw) : null;
          // For the target symbol's earnings (i===0, single-symbol mode), always include
          // the next event even if beyond the display window — earnings don't always fall
          // within the selected day range.
          const isTargetEarnings = i === 0 && peerSymbols.length === 1 &&
            String(e.shortSymbol ?? e.symbol ?? "").toUpperCase() === symbol;
          if (!d || d < from || (!isTargetEarnings && d > to)) continue;
          // Economic events: filter by country and importance by default
          if (i === 1) {
            const countryOk = !allowedCountries || allowedCountries.has(e.country);
            const highOnly = !extras.has("ind_medium") && !extras.has("ind_all") && !extras.has("mkt_global_all");
            const importanceOk = !highOnly || e.importance === 1;
            if (!countryOk || !importanceOk) continue;
          }
          const fmtM = (v) => v != null ? `$${(Number(v) / 1e6).toFixed(0)}M` : null;
          events.push({
            ...e,
            date: d,
            title: i === 0
              ? `${e.description ?? e.shortSymbol ?? e.name ?? "Company"} Earnings`
              : (e.title ?? e.name ?? "Economic release"),
            dateStatus: e.dateStatus ?? "provider-scheduled",
            category: i === 0 ? "earnings" : i === 1 ? "economic" : e.category,
            // Map earnings EPS/revenue to generic display fields
            ...(i === 0 ? {
              actual: e.earningsActual != null ? `$${Number(e.earningsActual).toFixed(2)} EPS` : null,
              forecast: e.earningsEstimate != null ? `$${Number(e.earningsEstimate).toFixed(2)} EPS est.` : null,
              revenueActual: e.revenueActual != null ? fmtM(e.revenueActual) : null,
              revenueEstimate: e.revenueEstimate != null ? fmtM(e.revenueEstimate) : null,
            } : {}),
          });
        }
      });
      const bars = cache.get(req.user.id + ":" + symbol)?.bars ?? [];
      for (const event of events) {
        const before = bars.findLast((b) => b.date < event.date),
          after = bars.find((b) => b.date > event.date);
        event.observedMove =
          direction === "past" && before && after
            ? (after.close / before.close - 1) * 100
            : null;
        event.priceImpactNote =
          direction === "past"
            ? "Previous-session close to next-session close; association, not causation"
            : "Scenario input required; no forecast is implied by the calendar";
      }
      const payload = {
        events: events.sort((a, b) => a.date.localeCompare(b.date)),
        warnings,
        from,
        to,
        complete: false,
      };
      capture(() =>
        snapshots.attach(req.user.id, symbol, `events:${direction}`, { ...payload, days }),
      );
      res.json(payload);
    }),
  );
  const timer = setInterval(() => agents.tick().catch(() => {}), 60000);
  timer.unref();
  // Snapshots older than the retention window go at start-up, every six hours, and whenever one is saved.
  capture(() => snapshots.prune());
  const pruneTimer = setInterval(() => capture(() => snapshots.prune()), 6 * 3600000);
  pruneTimer.unref();
  // Keeps tracking items that were created from AI market topics in step with those topics.
  const syncMarketTopics = (topics) => {
    const byId = new Map(topics.map((topic) => [String(topic.id), topic]));
    let updated = 0;
    for (const { owner, strategy, item } of store.allItems()) {
      const topic = byId.get(TOPIC_ITEM_KEY.exec(item.eventKey ?? "")?.[1]);
      if (!topic) continue;
      store.putItem(owner, strategy, refreshItemFromTopic(item, topic));
      updated += 1;
    }
    return updated;
  };
  // Catch up on topics that changed while the server was down (Postgres only; ignored otherwise).
  setTimeout(() => {
    try {
      syncMarketTopics(listMarketTopics());
    } catch {
      /* no topics available */
    }
  }, 15000).unref();
  return {
    store,
    snapshots,
    attachHedgeScan,
    agents,
    syncMarketTopics,
    close: () => {
      clearInterval(timer);
      clearInterval(pruneTimer);
      snapshots.close();
      stockVolume?.close();
      for (const c of active.values()) {
        c.cancelled = true;
        c.worker?.terminate();
      }
      store.close();
    },
  };
}
