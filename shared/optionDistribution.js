const DAY = 86400000;
const iso = (value) => new Date(value).toISOString().slice(0, 10);
export function expiryBucket(date, grouping) {
  if (grouping === "month") return date.slice(0, 7);
  if (grouping === "week") {
    const day = new Date(date + "T00:00:00Z").getUTCDay();
    return iso(Date.parse(date) - ((day + 6) % 7) * DAY);
  }
  return date;
}
export function distribution(
  contracts,
  metric,
  {
    asOf = iso(Date.now()),
    grouping = "auto",
    axis = "strike",
    maxBars = 48,
  } = {},
) {
  const seen = new Set();
  let missing = 0;
  const valid = contracts.filter((c) => {
    if (
      !["call", "put"].includes(c.optionType) ||
      !(c.strike > 0) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(c.expiration) ||
      !Number.isFinite(Date.parse(c.expiration)) ||
      c.expiration < asOf
    )
      return false;
    const id =
      c.contractSymbol || `${c.expiration}:${c.strike}:${c.optionType}`;
    if (seen.has(id)) return false;
    seen.add(id);
    if (
      c[metric] == null ||
      !Number.isFinite(Number(c[metric])) ||
      Number(c[metric]) < 0
    ) {
      missing++;
      return false;
    }
    return true;
  });
  const dates = [...new Set(valid.map((c) => c.expiration))].sort();
  const resolvedGrouping =
    grouping === "auto"
      ? dates.length <= 12
        ? "day"
        : new Set(dates.map((d) => expiryBucket(d, "week"))).size <= 24
          ? "week"
          : "month"
      : grouping;
  const strikes = [...new Set(valid.map((c) => c.strike))].sort(
      (a, b) => a - b,
    ),
    step = Math.max(1, Math.ceil(strikes.length / maxBars));
  const strikeIndices = new Map(
      strikes.map((s, i) => [s, Math.floor(i / step)]),
    ),
    buckets = new Map();
  let total = 0,
    near = 0,
    mid = 0,
    far = 0;
  for (const c of valid) {
    const value = Number(c[metric]),
      dte = (Date.parse(c.expiration) - Date.parse(asOf)) / DAY;
    total += value;
    if (dte <= 30) near += value;
    else if (dte <= 90) mid += value;
    else far += value;
    const index = strikeIndices.get(c.strike),
      lo = strikes[index * step],
      hi = strikes[Math.min(strikes.length - 1, (index + 1) * step - 1)];
    const key =
      axis === "strike"
        ? String(index)
        : expiryBucket(c.expiration, resolvedGrouping);
    if (!buckets.has(key))
      buckets.set(key, {
        key,
        sort: axis === "strike" ? lo : key,
        label:
          axis === "strike" ? (lo === hi ? `$${lo}` : `$${lo}–${hi}`) : key,
        lowStrike: lo,
        highStrike: hi,
        call: 0,
        put: 0,
        dates: new Map(),
        from: c.expiration,
        to: c.expiration,
      });
    const b = buckets.get(key);
    b[c.optionType] += value;
    b.from = b.from < c.expiration ? b.from : c.expiration;
    b.to = b.to > c.expiration ? b.to : c.expiration;
    const dk = expiryBucket(
      c.expiration,
      axis === "strike" ? resolvedGrouping : "day",
    );
    if (!b.dates.has(dk)) b.dates.set(dk, { date: dk, call: 0, put: 0 });
    b.dates.get(dk)[c.optionType] += value;
  }
  const bars = [...buckets.values()]
    .sort((a, b) => (a.sort < b.sort ? -1 : 1))
    .map((b) => ({
      ...b,
      topDates: [...b.dates.values()]
        .sort(
          (a, b) =>
            b.call + b.put - (a.call + a.put) || a.date.localeCompare(b.date),
        )
        .filter((d) => d.call + d.put > 0)
        .slice(0, 5),
      dates: undefined,
    }));
  return {
    bars,
    total,
    near,
    mid,
    far,
    missing,
    contracts: valid.length,
    grouping: resolvedGrouping,
    from: dates[0],
    to: dates.at(-1),
    strikeGrouped: step > 1,
  };
}
