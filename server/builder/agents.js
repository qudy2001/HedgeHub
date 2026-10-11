import crypto from "node:crypto";
import { DAY, dateOnly } from "../../shared/builderEngine.js";
export const agentConfigured = () =>
  Boolean(process.env.TRADINGAGENTS_URL && process.env.TRADINGAGENTS_TOKEN);
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
    });
    for (const [section, summary] of Object.entries(
      job.section_summaries ?? {},
    ))
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
      "Configure TRADINGAGENTS_URL and TRADINGAGENTS_TOKEN on the HedgeHub server to enable AI research.",
    );
  const response = await fetch(
    `${process.env.TRADINGAGENTS_URL.replace(/\/$/, "")}/api${route}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${process.env.TRADINGAGENTS_TOKEN}`,
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
export function createAgentService(store) {
  const locks = new Set();
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
          ...state,
          ...extracted,
          status: run.status,
          lastChecked: new Date().toISOString(),
          error: null,
        };
        // Never replace a user's tracked condition or silently convert AI completion to verification.
        for (const tracked of store.items(owner, strategy.id)) {
          const match = extracted.suggestions.find(
            (i) =>
              i.eventKey === tracked.eventKey && i.symbol === tracked.symbol,
          );
          if (match && match.sourceRun !== tracked.latestAgentRun)
            store.putItem(owner, strategy.id, {
              ...tracked,
              latestAgentRun: match.sourceRun,
              agentUpdate: {
                status: match.agentStatus,
                completed: match.agentResolved,
                sources: match.sources,
                checkedAt: state.lastChecked,
              },
              history: [
                ...(tracked.history ?? []),
                {
                  at: state.lastChecked,
                  note: "New agent evidence available for review",
                },
              ].slice(-100),
            });
        }
      } else if (
        force ||
        !state.lastStarted ||
        Date.now() - Date.parse(state.lastStarted) >= DAY
      ) {
        const run = await request("/runs", {
          tickers: strategy.definition.symbols.slice(0, 10),
          analysis_date: dateOnly(Date.now()),
          look_back_days: 365,
          look_forward_days: 365,
        });
        state = {
          ...state,
          runId: run.id,
          status: run.status,
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
  return { refresh, tick };
}
