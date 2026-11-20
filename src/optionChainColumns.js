export const OPTION_CHAIN_BASE_SIDE_COLUMNS = [
  { key: "bid", label: "Bid", kind: "price" },
  { key: "ask", label: "Ask", kind: "price" },
  { key: "bidSize", label: "Bid x", kind: "count" },
  { key: "askSize", label: "Ask x", kind: "count" },
  { key: "mark", label: "Mark", kind: "select" },
  { key: "changePercent", label: "Chg%", kind: "percent" },
  { key: "volume", label: "Vol", kind: "count" },
  { key: "openInterest", label: "OI", kind: "count" },
  { key: "impliedVolatility", label: "IV", kind: "percent", scale: 100, digits: 2 },
  { key: "delta", label: "Δ", kind: "number", digits: 3 },
  { key: "gamma", label: "Γ", kind: "number", digits: 4 },
  { key: "theta", label: "Θ", kind: "number", digits: 3 },
  { key: "vega", label: "Vega", kind: "number", digits: 3 },
  { key: "rho", label: "Rho", kind: "number", digits: 3 },
  { key: "intrinsicValue", label: "Intrinsic", kind: "price" },
  { key: "timeValue", label: "Time", kind: "price" },
  { key: "premiumPercent", label: "Premium%", kind: "percent" },
  { key: "lastPrice", label: "Last", kind: "price" }
];

function normalizeExtensionColumns(extensionColumns) {
  return Array.isArray(extensionColumns) ? extensionColumns.filter(Boolean) : [];
}

export function buildOptionChainSideColumns(extensionColumns = []) {
  const normalizedExtensions = normalizeExtensionColumns(extensionColumns);
  if (!normalizedExtensions.length) {
    return OPTION_CHAIN_BASE_SIDE_COLUMNS.slice();
  }

  const nextColumns = OPTION_CHAIN_BASE_SIDE_COLUMNS.slice();
  const markIndex = nextColumns.findIndex((column) => column.key === "mark");
  if (markIndex < 0) {
    return [...nextColumns, ...normalizedExtensions];
  }

  nextColumns.splice(markIndex + 1, 0, ...normalizedExtensions);
  return nextColumns;
}

export function buildOptionChainCallColumns(extensionColumns = []) {
  return [...buildOptionChainSideColumns(extensionColumns)].reverse();
}
