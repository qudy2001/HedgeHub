export const STOCK_INTERVALS = {
  "1min": 1,
  "15min": 15,
  "30min": 30,
  "60min": 60,
  "4hour": 240,
  day: 390,
};
export const STOCK_INTERVAL_LABELS = {
  "1min": "1 min",
  "15min": "15 mins",
  "30min": "30 mins",
  "60min": "1 hour",
  "4hour": "4 hours",
  day: "1 day",
};
const DAY = 86400000;
export const dateString = (ms) => new Date(ms).toISOString().slice(0, 10);
export const shiftDate = (date, days) =>
  dateString(Date.parse(date) + days * DAY);
export function latestMarketDate(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  let date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) * 60 + Number(parts.minute) < 570)
    date = shiftDate(date, -1);
  while ([0, 6].includes(new Date(date).getUTCDay()))
    date = shiftDate(date, -1);
  return date;
}
export function validateStockProfile(input, now = Date.now()) {
  const symbol = String(input.symbol ?? "").toUpperCase(),
    interval = input.interval ?? "60min",
    days = Number(input.days ?? 30);
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol))
    throw new Error("Invalid stock symbol");
  if (
    !Object.hasOwn(STOCK_INTERVALS, interval) ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365
  )
    throw new Error("Choose a supported interval and 1–365 calendar days");
  const buckets = input.buckets;
  if (!Array.isArray(buckets) || !buckets.length || buckets.length > 120)
    throw new Error("Price ranges are required (maximum 120)");
  const clean = buckets.map((b, i) => {
    const low = Number(b.lowStrike),
      high = Number(b.highStrike);
    if (
      !Number.isFinite(low) ||
      low <= 0 ||
      !Number.isFinite(high) ||
      high < low ||
      high > 1e7 ||
      (i && low <= Number(buckets[i - 1].highStrike))
    )
      throw new Error(
        "Price ranges must be positive and ordered without overlaps",
      );
    return { key: String(i), lowStrike: low, highStrike: high };
  });
  const to = latestMarketDate(now),
    from = shiftDate(to, 1 - days);
  return { symbol, interval, days, from, to, buckets: clean };
}
export function profileWindows({ from, to, interval }) {
  const windows = [];
  if (interval === "1min") {
    for (let date = from; date <= to; date = shiftDate(date, 1))
      if (![0, 6].includes(new Date(date).getUTCDay()))
        windows.push({ from: date, to: date });
  } else {
    for (let date = from; date <= to; ) {
      const next = new Date(date + "T00:00:00Z");
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      const end = shiftDate(dateString(next), -1);
      windows.push({ from: date, to: end < to ? end : to });
      date = shiftDate(end, 1);
    }
  }
  return windows.reverse(); // recent coverage arrives first during long backfills
}
export function priceRanges(buckets) {
  return buckets.map((b, i) => {
    const left = i
      ? (buckets[i - 1].highStrike + b.lowStrike) / 2
      : b.lowStrike -
        (buckets.length > 1
          ? (buckets[1].lowStrike - b.highStrike) / 2
          : Math.max(1, b.lowStrike * 0.025));
    const right =
      i < buckets.length - 1
        ? (b.highStrike + buckets[i + 1].lowStrike) / 2
        : b.highStrike +
          (buckets.length > 1
            ? (b.lowStrike - buckets[i - 1].highStrike) / 2
            : Math.max(1, b.highStrike * 0.025));
    return { ...b, min: Math.max(0, left), max: right, volume: 0, bars: 0 };
  });
}
export function createProfileAccumulator(buckets) {
  const ranges = priceRanges(buckets);
  let total = 0,
    outside = 0,
    missing = 0,
    count = 0,
    first = null,
    last = null;
  return {
    add(bar) {
      const close = Number(bar.close),
        volume = bar.volume == null ? NaN : Number(bar.volume);
      if (
        !Number.isFinite(close) ||
        close <= 0 ||
        !Number.isFinite(volume) ||
        volume < 0
      ) {
        missing++;
        return;
      }
      const time = Number(bar.time);
      count++;
      total += volume;
      if (Number.isFinite(time)) {
        first = first == null ? time : Math.min(first, time);
        last = last == null ? time : Math.max(last, time);
      }
      let lo = 0,
        hi = ranges.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (close < ranges[mid].min) hi = mid;
        else lo = mid + 1;
      }
      const r = ranges[lo - 1];
      if (!r || close > r.max || (close === r.max && lo < ranges.length)) {
        outside += volume;
        return;
      }
      r.volume += volume;
      r.bars++;
    },
    result() {
      return {
        bins: ranges,
        totalShares: total,
        displayedShares: total - outside,
        outsideShares: outside,
        barCount: count,
        missingBars: missing,
        firstBar: first,
        lastBar: last,
      };
    },
  };
}
// Explicit demo fixtures only. Intraday bars are never inferred in the live path.
export function demoStockProfile(dailyBars, settings) {
  const acc = createProfileAccumulator(settings.buckets),
    minutes = STOCK_INTERVALS[settings.interval];
  for (const day of dailyBars.filter(
    (b) => b.date >= settings.from && b.date <= settings.to,
  )) {
    const count = Math.ceil(390 / minutes);
    let assigned = 0;
    for (let i = 0; i < count; i++) {
      const duration = Math.min(minutes, 390 - i * minutes),
        volume =
          i === count - 1
            ? day.volume - assigned
            : Math.floor((day.volume * duration) / 390);
      assigned += volume;
      acc.add({
        time: Date.parse(day.date + "T14:30:00Z") + i * minutes * 60000,
        close:
          i === count - 1
            ? day.close
            : day.close *
              (1 + 0.007 * Math.sin(i * 1.7 + Date.parse(day.date) / DAY)),
        volume,
      });
    }
  }
  return {
    ...acc.result(),
    sample: true,
    source: "Illustrative intraday bars",
    interval: settings.interval,
    from: settings.from,
    to: settings.to,
    cacheHits: 0,
    requestedWindows: 0,
    warnings: [],
    complete: true,
  };
}
