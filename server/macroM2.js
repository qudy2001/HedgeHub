// Live broad-money (M2) levels for the Money Supply heatmap, converted to USD.
// Every series comes from an official publisher; nothing here is simulated.
//   US     FRED M2SL (Federal Reserve), monthly, USD billions
//   Euro   ECB BSI M2 outstanding via DBnomics, monthly, EUR millions
//   Japan  Bank of Japan time-series API (MD02 M2 average), monthly, 100 million yen
//   China  PBoC M2 via NBS on DBnomics, monthly, 100 million yuan (the mirror keeps ~13 months)
// FX is FRED daily H.10 (DEXUSEU, DEXJPUS, DEXCHUS).

const FETCH_TIMEOUT_MS = 30000;
const HISTORY_START = "2020-09-01";

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }

  return response.text();
}

async function getJson(url) {
  return JSON.parse(await getText(url));
}

function fredUrl(seriesId) {
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${HISTORY_START}`;
}

function parseFredCsv(text) {
  return text
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [date, raw] = line.split(",");
      return { date, value: Number(raw) };
    })
    .filter((row) => row.date && Number.isFinite(row.value));
}

async function fetchFredSeries(seriesId) {
  return parseFredCsv(await getText(fredUrl(seriesId)));
}

async function fetchDailyFx(seriesId) {
  const rows = await fetchFredSeries(seriesId);
  const byMonth = new Map();

  for (const row of rows) {
    byMonth.set(row.date.slice(0, 7), row.value);
  }

  return { byMonth };
}

async function fetchDbnomicsSeries(path) {
  const json = await getJson(`https://api.db.nomics.world/v22/series/${path}?observations=1`);
  const doc = json?.series?.docs?.[0];

  if (!doc) {
    throw new Error(`DBnomics series ${path} not found`);
  }

  return doc.period
    .map((ym, index) => ({ ym, value: Number(doc.value[index]) }))
    .filter((row) => Number.isFinite(row.value));
}

async function fetchBojM2() {
  const json = await getJson(
    "https://www.stat-search.boj.or.jp/api/v1/getDataCode?format=json&lang=en&db=MD02&code=MAM1NAM2M2MO&startDate=202009"
  );
  const series = json?.RESULTSET?.[0]?.VALUES;

  if (!series?.SURVEY_DATES) {
    throw new Error("BoJ M2 response had no values");
  }

  return series.SURVEY_DATES.map((date, index) => ({
    ym: `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}`,
    value: Number(series.VALUES[index])
  })).filter((row) => Number.isFinite(row.value));
}

// levels: [{ym, value}] in local currency; toUsd(localValue, rate) converts.
// Each point uses the last FX print of its own month, so the headline value and
// every period change are priced at the same date as the M2 observation.
function buildUsdMonthly(levels, fx, toUsd) {
  const points = [];

  levels.forEach((level) => {
    const rate = fx.byMonth.get(level.ym);

    if (rate) {
      points.push({ ym: level.ym, usd: toUsd(level.value, rate) });
    }
  });

  return points;
}

function finish(id, source, monthly) {
  if (monthly.length < 2) {
    throw new Error(`${id}: not enough observations`);
  }

  return { id, source, asOf: monthly.at(-1).ym, valueUsd: monthly.at(-1).usd, monthly };
}

const loaders = {
  "m2-us": async () => {
    const rows = await fetchFredSeries("M2SL");
    const monthly = rows.map((row) => ({ ym: row.date.slice(0, 7), usd: row.value * 1e9 }));
    return finish("m2-us", "Federal Reserve M2SL via FRED", monthly);
  },
  "m2-euro": async () => {
    const [levels, fx] = await Promise.all([
      fetchDbnomicsSeries("ECB/BSI/M.U2.Y.V.M20.X.1.U2.2300.Z01.E"),
      fetchDailyFx("DEXUSEU")
    ]);
    return finish("m2-euro", "ECB euro area M2, FX FRED", buildUsdMonthly(levels, fx, (eurMillions, usdPerEur) => eurMillions * 1e6 * usdPerEur));
  },
  "m2-japan": async () => {
    const [levels, fx] = await Promise.all([fetchBojM2(), fetchDailyFx("DEXJPUS")]);
    return finish("m2-japan", "Bank of Japan M2, FX FRED", buildUsdMonthly(levels, fx, (hundredMillionYen, jpyPerUsd) => (hundredMillionYen * 1e8) / jpyPerUsd));
  },
  "m2-china": async () => {
    const [levels, fx] = await Promise.all([fetchDbnomicsSeries("NBS/M_A0D01/A0D0101"), fetchDailyFx("DEXCHUS")]);
    return finish("m2-china", "PBoC M2 via NBS, FX FRED", buildUsdMonthly(levels, fx, (hundredMillionCny, cnyPerUsd) => (hundredMillionCny * 1e8) / cnyPerUsd));
  }
};

// Resolves to { tiles: { [tileId]: {...} }, errors: { [tileId]: message } }.
// A failing source drops only its own tile back to the static estimate.
export async function fetchLiveM2() {
  const ids = Object.keys(loaders);
  const results = await Promise.allSettled(ids.map((id) => loaders[id]()));
  const tiles = {};
  const errors = {};

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      tiles[ids[index]] = result.value;
    } else {
      errors[ids[index]] = result.reason?.message ?? String(result.reason);
    }
  });

  return { tiles, errors, fetchedAt: new Date().toISOString() };
}

// Months of history each display range needs; a range is only offered when the
// series is long enough, so short sources (China) show n/a rather than a guess.
export const LIVE_LOOKBACK_MONTHS = { "30D": 1, "180D": 6, "365D": 12, "730D": 24, MAX: 60 };

export function buildLiveSparklines(monthly) {
  const sparklines = {};

  for (const [lookback, months] of Object.entries(LIVE_LOOKBACK_MONTHS)) {
    if (monthly.length > months) {
      sparklines[lookback] = monthly.slice(-(months + 1)).map((point) => Math.round(point.usd));
    }
  }

  return sparklines;
}
