// Strategies that can be enabled in the Builder "Hedge choices" panel.
// status "planned" strategies render disabled and are skipped by the scan.
export const HEDGE_SCAN_STRATEGIES = [
  { id: "vanilla", label: "Vanilla", hint: "Standard listed calls & puts", status: "ready" },
  { id: "polymarket_hedge", label: "Polymarket Hedge", hint: "Threshold hedge · binary + options", status: "ready" },
  { id: "probability_mismatch", label: "Probability Mismatch", hint: "Execution-ranked edges", status: "ready" },
  { id: "volume_crash", label: "Volume Crash", hint: "Vol crush into earnings", status: "ready" },
  { id: "macro_breakout", label: "Macro Breakout", hint: "Planned", status: "planned" },
  { id: "delta_hedge", label: "Delta Hedge", hint: "Straddle liquidity · gamma", status: "ready" },
  { id: "calendar_spread", label: "Calendar Spread", hint: "Planned", status: "planned" },
  { id: "cash_covered_put", label: "Cash-Covered Put", hint: "Covered income scanner", status: "ready" },
];

export const HEDGE_SCAN_IDS = HEDGE_SCAN_STRATEGIES.map((s) => s.id);

// TradingView only returns exchange-listed options, so every row is vanilla
// except calendars/diagonals, which belong to the separate Calendar Spread strategy.
export function isVanillaTradingViewRow(row) {
  const key = String(row?.strategyTypeKey ?? "").toLowerCase();
  return !key.includes("calendar") && !key.includes("diagonal");
}

// Hedge choices that produce rows in the Builder results table, and the option
// templates each one scans. Other choices only return a summary in the panel.
export const HEDGE_TEMPLATES = {
  vanilla: ["collar", "protective_put", "covered_call", "put_credit", "put_debit"],
  cash_covered_put: ["cash_put"],
};

// "stock" is always scanned so the "Stock only" toggle has rows to show.
export function templatesForHedgeChoices(ids) {
  const templates = [...new Set((ids ?? []).flatMap((id) => HEDGE_TEMPLATES[id] ?? []))];
  return templates.length ? [...templates, "stock"] : [];
}

export function hedgeChoicesForRow(row) {
  if (!row?.legs?.length) return [];
  const id = row.template === "cash_put" ? "cash_covered_put" : "vanilla";
  return [HEDGE_SCAN_STRATEGIES.find((s) => s.id === id).label];
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function summarizeRows(rows, limit = 3) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    count: list.length,
    top: list.slice(0, limit).map((r) => ({
      id: String(r?.id ?? ""),
      label: String(r?.assetLabel ?? r?.symbol ?? r?.title ?? r?.question ?? r?.id ?? "—"),
      detail: String(
        r?.strategyTypeLabel ?? r?.strategyType ?? r?.strategyClass ?? r?.strategyName ?? "",
      ),
      score: finite(r?.compositeScore ?? r?.score?.finalStrategyScore ?? r?.score),
    })),
  };
}
