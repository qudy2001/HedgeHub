import crypto from "node:crypto";
import { DAY, dateOnly } from "../../shared/builderEngine.js";
export const agentConfigured = () => Boolean(process.env.TRADINGAGENTS_URL);
const ratings = {
  Buy: "Strong bullish",
  Overweight: "Bullish",
  Hold: "Neutral",
  Underweight: "Bearish",
  Sell: "Strong bearish",
};
const safeUrl = (v) => {
  try {
    const u = new URL(v);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
};
// Technical-analysis findings (the Market Analyst's indicator/price-level report) are not tracked as topics.
const EXCLUDED_SUGGESTION_SECTIONS = new Set(["market_report"]);
// How many of a job's report sections TradingAgents has written so far.
const sectionProgress = (job) => {
  const sections = Object.values(job.report_sections ?? {});
  return { done: sections.filter(Boolean).length, total: sections.length };
};
// Per-stock state of a run (status, failure reason, progress), kept apart from
// the saved research so an unfinished or failed run can be shown without
// replacing the last good result.
export const jobStates = (extracted) =>
  Object.fromEntries(
    extracted.valuations.map((v) => [
      v.symbol,
      { status: v.status, error: v.error, progress: v.progress, at: v.asOf },
    ]),
  );
export function extractAgent(run) {
  const suggestions = [],
    valuations = [];
  for (const [symbol, job] of Object.entries(run.jobs ?? {})) {
    const report = job.report_sections?.final_trade_decision ?? "";
    const priceTarget = report.match(
      /\*?\*?Price Target\*?\*?\s*:\s*\$?([\d,]+(?:\.\d+)?)/i,
    );
    valuations.push({
      symbol,
      rating: ratings[job.decision] ?? null,
      priceTarget: priceTarget
        ? Number(priceTarget[1].replaceAll(",", ""))
        : null,
      report,
      asOf: job.finished_at ?? run.requested_at,
      sourceRun: run.id,
      status: job.status,
      error: job.error ? String(job.error) : null,
      progress: sectionProgress(job),
    });
    for (const [section, summary] of Object.entries(
      job.section_summaries ?? {},
    ))
      if (!EXCLUDED_SUGGESTION_SECTIONS.has(section))
      for (const [category, group] of Object.entries(summary.categories ?? {}))
        for (const item of group.items ?? []) {
          const text = job.report_sections?.[section] ?? "";
          const sources = [
            ...new Set(
              (text.match(/https?:\/\/[^\s<>\]\)"']+/g) ?? [])
                .map(safeUrl)
                .filter(Boolean),
            ),
          ].slice(0, 8);
          const key = String(item.label ?? "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
          if (!key) continue;
          const id = crypto
            .createHash("sha256")
            .update(symbol + ":" + key)
            .digest("hex")
            .slice(0, 24);
          suggestions.push({
            id,
            eventKey: key,
            title: item.label,
            symbol,
            template: "",
            condition: item.label,
            resolution: "Review the cited evidence against this condition.",
            sentiment:
              category === "bullish"
                ? "Bullish"
                : category === "bearish"
                  ? "Bearish"
                  : "Neutral",
            points:
              category === "bullish" ? 2 : category === "bearish" ? -2 : 0,
            status: "monitoring",
            verified: false,
            sources,
            sourceSection: section,
            sourceRun: run.id,
            checkedAt: summary.generated_at ?? run.requested_at,
            agentStatus: item.status,
            agentResolved: item.completed === true,
            rationale: group.rationale ?? "",
            history: [],
            impactUntil: null,
          });
        }
  }
  return {
    suggestions: [...new Map(suggestions.map((i) => [i.id, i])).values()],
    valuations,
  };
}
async function request(route, body) {
  if (!agentConfigured())
    throw new Error(
      "Configure TRADINGAGENTS_URL on the HedgeHub server to enable AI research.",
    );
  const response = await fetch(
    `${process.env.TRADINGAGENTS_URL.replace(/\/$/, "")}/api${route}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        ...(process.env.TRADINGAGENTS_TOKEN
          ? { authorization: `Bearer ${process.env.TRADINGAGENTS_TOKEN}` }
          : {}),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(`TradingAgents returned HTTP ${response.status}`);
  return response.json();
}
function applyTrackedItemEvidence(store, owner, strategyId, extracted, checkedAt) {
  // Never replace a user's tracked condition or silently convert AI completion to verification.
  for (const tracked of store.items(owner, strategyId)) {
    const match = extracted.suggestions.find(
      (i) => i.eventKey === tracked.eventKey && i.symbol === tracked.symbol,
    );
    if (match && match.sourceRun !== tracked.latestAgentRun)
      store.putItem(owner, strategyId, {
        ...tracked,
        latestAgentRun: match.sourceRun,
        agentUpdate: {
          status: match.agentStatus,
          completed: match.agentResolved,
          sources: match.sources,
          checkedAt,
        },
        history: [
          ...(tracked.history ?? []),
          { at: checkedAt, note: "New agent evidence available for review" },
        ].slice(-100),
      });
  }
}
// Merge a run's extracted results into aggregate state. Only stocks whose job
// completed replace their saved research; a running or failed job leaves the
// previous result in place, as does every stock the run did not cover.
export function mergeExtracted(state, extracted) {
  const done = new Set(
    extracted.valuations
      .filter((v) => v.status === "completed")
      .map((v) => v.symbol),
  );
  const keep = (arr) => (arr ?? []).filter((x) => !done.has(x.symbol));
  const fresh = (arr) => arr.filter((x) => done.has(x.symbol));
  return {
    ...state,
    valuations: [...keep(state.valuations), ...fresh(extracted.valuations)],
    suggestions: [
      ...keep(state.suggestions),
      ...fresh(extracted.suggestions),
    ].filter((x) => !EXCLUDED_SUGGESTION_SECTIONS.has(x.sourceSection)),
  };
}
// `optionContext(owner, symbol)` returns { text, meta } built from cached option data, or null. It is
// optional and best-effort: a run starts without it when nothing is cached or the lookup fails.
export function createAgentService(store, { optionContext = null } = {}) {
  const locks = new Set();
  // The cached option briefs for a run's tickers: the request field TradingAgents reads, plus what was sent.
  function optionBriefs(owner, tickers) {
    const text = {},
      meta = {};
    for (const ticker of tickers) {
      let brief = null;
      try {
        brief = optionContext?.(owner, ticker) ?? null;
      } catch (e) {
        console.warn(`[builder] option context for ${ticker} skipped: ${e.message}`);
      }
      if (!brief?.text) continue;
      text[ticker] = brief.text;
      meta[ticker] = brief.meta ?? {};
    }
    return {
      body: Object.keys(text).length ? { options_context: text } : {},
      meta,
    };
  }
  async function refresh(owner, strategy, force = false) {
    const key = owner + ":" + strategy.id;
    if (locks.has(key)) return store.agent(owner, strategy.id);
    locks.add(key);
    let state = store.agent(owner, strategy.id) || {
      suggestions: [],
      valuations: [],
    };
    try {
      if (
        state.runId &&
        !["completed", "completed_with_errors", "failed", "stopped"].includes(
          state.status,
        )
      ) {
        const run = await request(`/runs/${encodeURIComponent(state.runId)}`);
        const extracted = extractAgent(run);
        state = {
          ...mergeExtracted(state, extracted),
          jobs: jobStates(extracted),
          status: run.status,
          lastChecked: new Date().toISOString(),
          error: null,
        };
        applyTrackedItemEvidence(
          store,
          owner,
          strategy.id,
          extracted,
          state.lastChecked,
        );
      } else if (
        force ||
        !state.lastStarted ||
        Date.now() - Date.parse(state.lastStarted) >= DAY
      ) {
        const tickers = strategy.definition.symbols.slice(0, 10),
          briefs = optionBriefs(owner, tickers);
        const run = await request("/runs", {
          tickers,
          analysis_date: dateOnly(Date.now()),
          look_back_days: 365,
          look_forward_days: 365,
          ...briefs.body,
        });
        state = {
          ...state,
          runId: run.id,
          status: run.status,
          jobs: {},
          optionContext: briefs.meta,
          lastStarted: new Date().toISOString(),
          error: null,
        };
      }
    } catch (e) {
      state = {
        ...state,
        error: e.message,
        lastChecked: new Date().toISOString(),
      };
    } finally {
      locks.delete(key);
    }
    return store.saveAgent(owner, strategy.id, state);
  }
  // Same lifecycle as refresh(), but scoped to a single stock: starts (or
  // polls) its own TradingAgents run and merges the result into the shared
  // valuations/suggestions without touching other stocks' saved research.
  async function refreshSymbol(owner, strategy, symbol, force = false) {
    const key = owner + ":" + strategy.id + ":" + symbol;
    if (locks.has(key)) return store.agent(owner, strategy.id);
    locks.add(key);
    let state = store.agent(owner, strategy.id) || {
      suggestions: [],
      valuations: [],
    };
    const runs = { ...(state.runsBySymbol ?? {}) };
    let symState = runs[symbol] ?? {};
    try {
      if (
        symState.runId &&
        !["completed", "completed_with_errors", "failed", "stopped"].includes(
          symState.status,
        )
      ) {
        const run = await request(
          `/runs/${encodeURIComponent(symState.runId)}`,
        );
        const extracted = extractAgent(run);
        const checkedAt = new Date().toISOString();
        symState = {
          ...symState,
          status: run.status,
          job: jobStates(extracted)[symbol] ?? null,
          lastChecked: checkedAt,
          error: null,
        };
        state = mergeExtracted(state, extracted);
        applyTrackedItemEvidence(store, owner, strategy.id, extracted, checkedAt);
      } else if (
        force ||
        !symState.lastStarted ||
        Date.now() - Date.parse(symState.lastStarted) >= DAY
      ) {
        const briefs = optionBriefs(owner, [symbol]);
        const run = await request("/runs", {
          tickers: [symbol],
          analysis_date: dateOnly(Date.now()),
          look_back_days: 365,
          look_forward_days: 365,
          ...briefs.body,
        });
        symState = {
          ...symState,
          runId: run.id,
          status: run.status,
          job: null,
          optionContext: briefs.meta[symbol] ?? null,
          lastStarted: new Date().toISOString(),
          error: null,
        };
      }
    } catch (e) {
      symState = { ...symState, error: e.message, lastChecked: new Date().toISOString() };
    } finally {
      locks.delete(key);
    }
    runs[symbol] = symState;
    state = { ...state, runsBySymbol: runs };
    return store.saveAgent(owner, strategy.id, state);
  }
  let ticking = false;
  async function tick() {
    if (ticking || !agentConfigured()) return;
    ticking = true;
    try {
      for (const strategy of store
        .allStrategies()
        .filter((s) => s.definition.dailyResearch)) {
        const prev = store.agent(strategy.owner, strategy.id);
        if (
          prev?.error &&
          Date.now() - Date.parse(prev.lastChecked) < 15 * 60000
        )
          continue;
        await refresh(strategy.owner, strategy);
      }
    } finally {
      ticking = false;
    }
  }
  return { refresh, refreshSymbol, tick };
}
