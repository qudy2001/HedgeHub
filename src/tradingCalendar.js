const MS_PER_DAY = 24 * 60 * 60 * 1000;
const US_MARKET_HOLIDAYS_BY_YEAR = new Map();

export function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toIsoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : "";
}

function addCalendarDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

function nthWeekdayOfMonth(year, monthIndex, weekday, occurrence) {
  const date = new Date(Date.UTC(year, monthIndex, 1));

  while (date.getUTCDay() !== weekday) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  date.setUTCDate(date.getUTCDate() + ((occurrence - 1) * 7));
  return toIsoDate(date);
}

function lastWeekdayOfMonth(year, monthIndex, weekday) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));

  while (date.getUTCDay() !== weekday) {
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return toIsoDate(date);
}

function getObservedFixedHoliday(year, monthIndex, dayOfMonth) {
  const date = new Date(Date.UTC(year, monthIndex, dayOfMonth));
  const day = date.getUTCDay();

  if (day === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  } else if (day === 0) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return toIsoDate(date);
}

function calculateEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + (2 * e) + (2 * i) - h - k) % 7;
  const m = Math.floor((a + (11 * h) + (22 * l)) / 451);
  const month = Math.floor((h + l - (7 * m) + 114) / 31) - 1;
  const day = ((h + l - (7 * m) + 114) % 31) + 1;

  return new Date(Date.UTC(year, month, day));
}

function getUsMarketHolidaysForYear(year) {
  if (US_MARKET_HOLIDAYS_BY_YEAR.has(year)) {
    return US_MARKET_HOLIDAYS_BY_YEAR.get(year);
  }

  const easterSunday = calculateEasterSunday(year);
  const goodFriday = addCalendarDays(easterSunday, -2);
  const holidays = new Set([
    getObservedFixedHoliday(year, 0, 1),
    nthWeekdayOfMonth(year, 0, 1, 3),
    nthWeekdayOfMonth(year, 1, 1, 3),
    toIsoDate(goodFriday),
    lastWeekdayOfMonth(year, 4, 1),
    getObservedFixedHoliday(year, 6, 4),
    nthWeekdayOfMonth(year, 8, 1, 1),
    nthWeekdayOfMonth(year, 10, 4, 4),
    getObservedFixedHoliday(year, 11, 25)
  ]);

  if (year >= 2022) {
    holidays.add(getObservedFixedHoliday(year, 5, 19));
  }

  US_MARKET_HOLIDAYS_BY_YEAR.set(year, holidays);
  return holidays;
}

export function isTradingDay(value) {
  const date = parseIsoDate(value);

  if (!date) {
    return false;
  }

  const day = date.getUTCDay();

  if (day === 0 || day === 6) {
    return false;
  }

  const isoDate = toIsoDate(date);
  const year = date.getUTCFullYear();

  return ![year - 1, year, year + 1].some((candidateYear) =>
    getUsMarketHolidaysForYear(candidateYear).has(isoDate)
  );
}

export function countTradingDaysBetween(
  startValue,
  endValue,
  { includeStart = false, includeEnd = true } = {}
) {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);

  if (!start || !end || start.getTime() > end.getTime()) {
    return 0;
  }

  let count = 0;
  const cursor = new Date(start);
  const startIso = toIsoDate(start);
  const endIso = toIsoDate(end);

  while (cursor.getTime() <= end.getTime()) {
    const cursorIso = toIsoDate(cursor);
    const isBoundaryStart = cursorIso === startIso;
    const isBoundaryEnd = cursorIso === endIso;

    if (
      isTradingDay(cursorIso) &&
      (includeStart || !isBoundaryStart) &&
      (includeEnd || !isBoundaryEnd)
    ) {
      count += 1;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return count;
}

export function buildTradingDateRange(startValue, endValue) {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);

  if (!start || !end || start.getTime() > end.getTime()) {
    return [];
  }

  const dates = [];
  const cursor = new Date(start);

  while (cursor.getTime() <= end.getTime()) {
    const cursorIso = toIsoDate(cursor);

    if (isTradingDay(cursorIso)) {
      dates.push(cursorIso);
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

export function coerceToTradingDate(value, tradingDates, direction = "previous") {
  if (!Array.isArray(tradingDates) || !tradingDates.length) {
    return value || "";
  }

  if (!value) {
    return tradingDates[0];
  }

  if (tradingDates.includes(value)) {
    return value;
  }

  if (direction === "next") {
    return tradingDates.find((date) => date >= value) ?? tradingDates[tradingDates.length - 1];
  }

  let previousTradingDate = "";

  for (const tradingDate of tradingDates) {
    if (tradingDate > value) {
      break;
    }

    previousTradingDate = tradingDate;
  }

  return previousTradingDate || tradingDates[0];
}

export function buildTradingDateColumns(startValue, endValue, columnCount) {
  const tradingDates = buildTradingDateRange(startValue, endValue);

  if (!tradingDates.length) {
    return [];
  }

  if (tradingDates.length === 1) {
    return [
      {
        date: tradingDates[0],
        offsetDays: 0,
        isStart: true,
        isEnd: true,
        index: 0,
        size: 1
      }
    ];
  }

  const targetCount = Math.min(tradingDates.length, Math.max(columnCount, 2));
  const dateIndexes = Array.from({ length: targetCount }, (_value, index) =>
    Math.round(((tradingDates.length - 1) * index) / (targetCount - 1))
  );
  const uniqueIndexes = dateIndexes.filter((index, position, array) => array.indexOf(index) === position);

  if (uniqueIndexes[0] !== 0) {
    uniqueIndexes.unshift(0);
  }

  if (uniqueIndexes[uniqueIndexes.length - 1] !== tradingDates.length - 1) {
    uniqueIndexes.push(tradingDates.length - 1);
  }

  return uniqueIndexes.map((dateIndex, index, array) => ({
    date: tradingDates[dateIndex],
    offsetDays: dateIndex,
    isStart: dateIndex === 0,
    isEnd: dateIndex === tradingDates.length - 1,
    index,
    size: array.length
  }));
}

export function tradingDaysToYears(days) {
  return Math.max(Number(days) || 0, 0) / 252;
}

export function tradingDayStepCount(startValue, endValue) {
  const tradingDates = buildTradingDateRange(startValue, endValue);
  return Math.max(tradingDates.length - 1, 0);
}
