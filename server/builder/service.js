import { createStockVolumeService } from "./stockVolume.js";
import { createDistributionLoader } from "./distributions.js";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { createBuilderStore } from "./store.js";
import { createAgentService, agentConfigured } from "./agents.js";
import {
  DEFAULT_STRATEGY,
  TEMPLATES,
  validateStrategy,
  buildCandidates,
  applyCatalysts,
  DAY,
  dateOnly,
  addDays,
  number,
} from "../../shared/builderEngine.js";
import { fetchQuotes, fetchOptionChain } from "../providers/marketData.js";
import { fetchStockDailyOhlcHistory } from "../stockOhlcHistory.js";
import {
  fetchCompanyEventsCalendar,
  fetchEconomicCalendarWindow,
} from "../providers/tradingViewCalendars.js";
import { curatedCatalysts } from "../researchCatalysts.js";
const defaultData = async (symbol, s) => {
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
  if (s.pricingMode === "market")
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
  if (p.verified && !sources.length)
    throw new Error("Add supporting sources before verifying an item");
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
    store = createBuilderStore(),
    loadData = defaultData,
    researchService = null,
  } = {},
) {
  let stockVolume;
  app.post("/api/builder/stock-volume", (req, res) => {
    try {
      stockVolume ??= createStockVolumeService();
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
  const loadDistribution = createDistributionLoader();
  app.get("/api/builder/distributions/:symbol", async (req, res) => {
    try {
      const symbol = validateStrategy({ symbols: [req.params.symbol] })
          .symbols[0],
        days = Number(req.query.days ?? 365);
      if (![365, 730].includes(days))
        throw new Error("Unsupported expiry horizon");
      res.json(await loadDistribution(symbol, days));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  const agents = createAgentService(store),
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
      }),
    ),
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
  app.get(
    "/api/builder/jobs/:id",
    route((req, res) => {
      const j = store.getJob(req.user.id, req.params.id);
      if (!j) return res.status(404).json({ error: "Run not found" });
      res.json(j);
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
          const snapshot = await loadData(symbol, strategy);
          if (control.cancelled) break;
          datasets[symbol] = snapshot;
          cache.set(owner + ":" + symbol, snapshot);
          if (cache.size > 100) cache.delete(cache.keys().next().value);
          warnings.push(
            ...(snapshot.warnings ?? []).map((w) => `${symbol}: ${w}`),
          );
          if (kind === "scan")
            rows.push(
              ...buildCandidates(snapshot, strategy).map((r) =>
                applyCatalysts(r, job.items, job.includeCatalysts),
              ),
            );
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
          items,
          includeCatalysts: req.body.includeCatalysts !== false,
          settings: req.body.settings ?? {},
          createdAt: new Date().toISOString(),
        });
        res.status(202).json(job);
        void runJob(req.user.id, job, strategy, kind);
      }),
    );
  app.get(
    "/api/builder/research/:symbol",
    route(async (req, res) => {
      const symbol = validateStrategy({ symbols: [req.params.symbol] })
        .symbols[0];
      if (!researchService) throw new Error("Research service unavailable");
      res.json(await researchService.research(symbol, { lookbackDays: 30 }));
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
      const requests = await Promise.allSettled([
        fetchCompanyEventsCalendar({
          from: new Date(from),
          to: new Date(to),
          minMarketCapUsd: 0,
          symbols: [symbol],
        }),
        fetchEconomicCalendarWindow({ from: new Date(from), to: new Date(to) }),
        curatedCatalysts(symbol, window),
      ]);
      const events = [],
        warnings = [];
      requests.forEach((r, i) => {
        if (r.status === "rejected") {
          warnings.push(r.reason.message);
          return;
        }
        for (const e of (i === 2 ? r.value.events : r.value) ?? []) {
          const raw = e.date ?? e.timestamp;
          const d = raw ? dateOnly(raw) : null;
          if (d && d >= from && d <= to)
            events.push({
              ...e,
              date: d,
              title:
                e.title ??
                e.name ??
                (i === 0 ? "Company earnings" : "Economic release"),
              dateStatus: e.dateStatus ?? "provider-scheduled",
              category:
                i === 0 ? "earnings" : i === 1 ? "economic" : e.category,
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
      res.json({
        events: events.sort((a, b) => a.date.localeCompare(b.date)),
        warnings,
        from,
        to,
        complete: false,
      });
    }),
  );
  const timer = setInterval(() => agents.tick().catch(() => {}), 60000);
  timer.unref();
  return {
    store,
    agents,
    close: () => {
      clearInterval(timer);
      stockVolume?.close();
      for (const c of active.values()) {
        c.cancelled = true;
        c.worker?.terminate();
      }
      store.close();
    },
  };
}
