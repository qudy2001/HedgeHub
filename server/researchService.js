import { fetchStockDailyOhlcHistory } from './stockOhlcHistory.js';
import { fetchStockFundamentals } from './stockFundamentals.js';
import { fetchQuotes, fetchOptionChain } from './providers/marketData.js';
import { tigerEnabled, tigerRequest, tigerDiagnostics, tigerEarnings } from './providers/tiger.js';
import { buildEntryResearch } from './entryResearch.js';
import { fetchCompanyEventsCalendar, fetchEconomicCalendarWindow } from './providers/tradingViewCalendars.js';
import { researchWindow, curatedCatalysts, buildCatalystChecklist } from './researchCatalysts.js';
import { fetchResearchSocial } from './providers/researchSocial.js';
import crypto from 'node:crypto';

export function validResearchSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)) throw new Error('A valid US stock/ETF symbol is required');
  return symbol;
}

export function researchSettings(input = {}) {
  const peers = [...new Set(String(input.peers ?? '').split(/[ ,]+/).filter(Boolean).map(validResearchSymbol))].slice(0, 5);
  const fee = Number(input.feePerContract ?? 0);
  if (!Number.isFinite(fee) || fee < 0 || fee > 100) throw new Error('Fee must be between 0 and 100 per contract');
  const window = researchWindow(input.expiry || null, input.lookbackDays ?? 30);
  return { peers, feePerContract: fee, assetType: input.assetType === 'etf' ? 'etf' : 'stock', sectorSymbol: input.sectorSymbol ? validResearchSymbol(input.sectorSymbol) : null,
    expiry: input.expiry || null, lookbackDays: window.lookbackDays };
}

export function createResearchService(store) {
  const pending = new Map();
  const failures = new Map();
  let running = false;
  async function dataset(symbol, kind, ttl, loader, force = false) {
    const provider = tigerEnabled() ? 'tiger' : 'legacy';
    const key = `${provider}:${symbol}:${kind}`;
    const cached = store.get(symbol, kind, provider);
    const age = cached ? Date.now() - Date.parse(cached.updatedAt) : Infinity;
    const failure = failures.get(key);
    if (failure && Date.now() < failure.retryAt) return { data: cached?.data ?? null, updatedAt: cached?.updatedAt ?? null, source: provider, stale: true, error: failure.error };
    if (!force && age < ttl) return { ...cached, source: provider, stale: false };
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const data = await loader();
        const updatedAt = new Date().toISOString();
        store.put(symbol, kind, provider, data, updatedAt);
        failures.delete(key);
        return { data, updatedAt, source: provider, stale: false };
      } catch (error) {
        const attempts = (failure?.attempts ?? 0) + 1;
        failures.set(key, { error: error.message, attempts, retryAt: Date.now() + Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3600_000) });
        return { data: cached?.data ?? null, updatedAt: cached?.updatedAt ?? null, source: provider, stale: true, error: error.message };
      }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  const tigerOnly = async (endpoint, symbol) => {
    if (!tigerEnabled()) throw new Error('Requires Tiger provider and endpoint entitlement');
    return (await tigerRequest(endpoint, { symbol }, 0)).data;
  };

  async function events(symbol, window = null) {
    if (tigerEnabled()) return tigerEarnings(symbol, window);
    const from = window ? new Date(`${window.from}T00:00:00Z`) : new Date(), to = window ? new Date(`${window.to}T23:59:59Z`) : new Date(Date.now() + 100 * 86400_000);
    // The source returns one release per symbol: query past and future separately.
    const ranges = window ? [[from, new Date(Date.now() - 1)], [new Date(), to]] : [[from, to]];
    const rows = (await Promise.all(ranges.map(([a, b]) => fetchCompanyEventsCalendar({ from: a, to: b, minMarketCapUsd: 0, symbols: [symbol] })))).flat();
    const selected = rows.filter(e => String(e.shortSymbol ?? e.symbol).toUpperCase() === symbol)
      .map(e => ({ ...e, date: new Date(e.timestamp).toISOString().slice(0, 10) })).sort((a, b) => a.date.localeCompare(b.date));
    const next = selected.find(e => e.date >= new Date().toISOString().slice(0, 10));
    return { source: 'tradingview', from: from.toISOString().slice(0, 10), to: next?.date ?? to.toISOString().slice(0, 10),
      complete: Boolean(next), events: selected, status: selected.length ? 'event-found' : 'unknown' };
  }

  async function earningsCoverage(symbols) {
    const result = {};
    for (const symbol of symbols.slice(0, 20)) {
      const r = await dataset(symbol, 'events', 3600_000, () => events(symbol));
      result[symbol] = r.stale ? { ...r.data, complete: false, error: r.error } : r.data;
    }
    return result;
  }

  async function research(rawSymbol, settings = {}, force = false) {
    const symbol = validResearchSymbol(rawSymbol);
    const window = researchWindow(settings.expiry, settings.lookbackDays ?? 30);
    store.job(symbol, null, true);
    const loaders = {
      bars: [6 * 3600_000, () => fetchStockDailyOhlcHistory({ symbol, lookbackPoints: 1200 })],
      quote: [15_000, () => fetchQuotes([{ symbol, sourceSymbol: `${symbol.toLowerCase()}.us`, provider: 'stooq' }])],
      fundamentals: [24 * 3600_000, () => fetchStockFundamentals({ symbol })],
      iv: [6 * 3600_000, () => tigerOnly('/options/analysis', symbol)],
      financials: [24 * 3600_000, () => tigerOnly('/financials', symbol)],
      valuation: [24 * 3600_000, () => tigerOnly('/valuation', symbol)],
      flow: [15 * 60_000, () => tigerOnly('/flow', symbol)],
      events: [3600_000, () => events(symbol)]
    };
    loaders.dividends = [24 * 3600_000, () => tigerOnly('/dividends', symbol)];
    const datasets = Object.fromEntries(await Promise.all(Object.entries(loaders).map(async ([kind, [ttl, loader]]) =>
      [kind, await dataset(symbol, kind, ttl, loader, force && ['quote', 'events', 'iv', 'flow'].includes(kind))])));
    datasets.benchmark = await dataset('SPY', 'bars', 6 * 3600_000, () => fetchStockDailyOhlcHistory({ symbol: 'SPY', lookbackPoints: 320 }));
    if (settings.sectorSymbol) datasets.sector = await dataset(settings.sectorSymbol, 'bars', 6 * 3600_000, () => fetchStockDailyOhlcHistory({ symbol: settings.sectorSymbol, lookbackPoints: 320 }));
    const spot = datasets.quote.data?.[0]?.regularMarketPrice ?? datasets.bars.data?.points?.at(-1)?.close;
    datasets.options = await dataset(symbol, `options${settings.expiry ? ':' + settings.expiry : ''}`, 15 * 60_000, async () => {
      const expirationFrom = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
      const expirationTo = new Date(Date.now() + 38 * 86400_000).toISOString().slice(0, 10);
      const chains = await Promise.all(['put', 'call'].map(optionType => fetchOptionChain({ symbol, expiration: settings.expiry || undefined, expirationFrom, expirationTo, optionType, currentSpot: spot, limit: 0 })));
      return { contracts: chains.flatMap(c => c.contracts ?? []), warnings: chains.flatMap(c => c.warnings ?? []) };
    }, force);
    const peers = [];
    for (const peer of (settings.peers ?? []).filter(p => p !== symbol).slice(0, 5)) {
      const r = await dataset(peer, 'fundamentals', 24 * 3600_000, () => fetchStockFundamentals({ symbol: peer }));
      const v = await dataset(peer, 'valuation', 24 * 3600_000, () => tigerOnly('/valuation', peer));
      const series = (v.data ?? []).filter(x => x.field === 'market_cap_to_ltm_levered_fcf').sort((a, b) => String(a.date).localeCompare(String(b.date)));
      peers.push({ symbol: peer, ...r, pfcf: v.stale ? null : series.at(-1)?.value });
    }
    const payload = buildEntryResearch({ symbol, datasets, peers, feePerContract: settings.feePerContract ?? 0, assetType: settings.assetType });
    const windowKey = `${window.from}:${window.to}`;
    const extra = await Promise.all([
      dataset('GLOBAL', `macro:${windowKey}`, 3600_000, () => fetchEconomicCalendarWindow({ from: new Date(`${window.from}T00:00:00Z`), to: new Date(`${window.to}T23:59:59Z`) })),
      dataset(symbol, `catalysts:${windowKey}`, 15 * 60_000, () => curatedCatalysts(symbol, window)),
      dataset(symbol, `social:${window.from}`, 3600_000, () => fetchResearchSocial(symbol, window)),
      dataset(symbol, `event-window:${windowKey}`, 3600_000, () => events(symbol, window))
    ]);
    [datasets.macro, datasets.catalysts, datasets.social] = extra;
    payload.catalysts = buildCatalystChecklist({ datasets: { ...datasets, events: extra[3] }, window, earnings: extra[3].data ?? {}, financials: payload.fundamentals, dividends: payload.dividends });
    for (const key of ['macro', 'catalysts', 'social']) {
      const { source, updatedAt, stale, error } = datasets[key];
      payload.statuses[key] = { source: key === 'macro' ? 'TradingView' : key === 'social' ? 'X / Reddit' : 'Source-backed calendar', updatedAt, stale, error };
    }
    payload.researchSettings = { ...settings, expiry: window.explicitExpiry ? window.expiry : null, lookbackDays: window.lookbackDays };
    store.put(symbol, 'features-daily', tigerEnabled() ? 'tiger' : 'legacy', {
      version: payload.version, stockPrice: payload.stockPrice, iv: payload.volatility.iv, rv20: payload.volatility.rv20,
      pe: payload.valuation.pe, pfcf: payload.valuation.pfcf, support: payload.structure.supportPrice, statuses: payload.statuses
    }, payload.generatedAt.slice(0, 10));
    const failed = Object.entries(datasets).filter(([, d]) => d.stale).map(([k]) => k);
    store.job(symbol, failed.length ? `Unavailable/stale: ${failed.join(', ')}` : null);
    return payload;
  }

  async function tick() {
    if (running) return;
    // Session context only; weekends off. Provider calendars/coverage remain visible.
    const date = new Date();
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const day = et.find(p => p.type === 'weekday')?.value, hour = Number(et.find(p => p.type === 'hour')?.value);
    if (['Sat', 'Sun'].includes(day) || hour < 9 || hour > 17) return;
    running = true;
    try {
      if (tigerEnabled()) {
        const session = (await tigerRequest('/session', {}, 60_000)).data;
        if (!(session ?? []).some(s => ['TRADING', 'POST_HOUR_TRADING'].includes(String(s.trading_status).toUpperCase()))) return;
      }
      for (const watch of store.watches().slice(0, 20)) {
        try { await research(watch.symbol, watch); } catch (e) { store.job(watch.symbol, e.message); }
      }
    } finally { running = false; }
  }
  return { research, earningsCoverage, tick, status: () => ({ provider: tigerEnabled() ? 'tiger' : 'legacy', configured: Boolean(process.env.TIGER_BRIDGE_TOKEN),
    running, jobs: store.jobs(), endpoints: tigerDiagnostics }), permissions: () => tigerRequest('/permissions', {}, 60_000) };
}

export function registerResearchRoutes(app, store, service) {
  const previews = new Map();
  const route = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.get('/api/settings/market-data', (_req, res) => res.json(service.status()));
  app.get('/api/research/permissions', route(async (_req, res) => res.json(await service.permissions())));
  app.get('/api/research/snapshots', (req, res) => res.json(store.snapshots(req.user.id)));
  app.get('/api/research/snapshots/:id', (req, res) => {
    const value = store.snapshot(req.user.id, req.params.id);
    res.status(value ? 200 : 404).json(value ?? { error: 'Snapshot not found' });
  });
  app.get('/api/research/watchlist', (req, res) => res.json(store.watches(req.user.id)));
  app.post('/api/research/watchlist', route(async (req, res) => {
    const symbol = validResearchSymbol(req.body.symbol), list = store.watches(req.user.id);
    if (list.length >= 10 && !list.some(w => w.symbol === symbol)) throw new Error('Pilot limit: 10 watched symbols');
    store.watch(req.user.id, symbol, researchSettings(req.body));
    res.json({ ok: true });
  }));
  app.delete('/api/research/watchlist/:symbol', route(async (req, res) => {
    store.unwatch(req.user.id, validResearchSymbol(req.params.symbol)); res.json({ ok: true });
  }));
  app.get('/api/research/:symbol', route(async (req, res) => {
    const payload = await service.research(req.params.symbol, researchSettings(req.query), req.query.refresh === 'true');
    payload.researchId = crypto.randomUUID();
    previews.set(payload.researchId, { owner: req.user.id, payload, at: Date.now() });
    if (previews.size > 200) previews.delete(previews.keys().next().value);
    res.json(payload);
  }));
  app.get('/api/research/:symbol/history', route(async (req, res) => {
    const payload = await service.research(req.params.symbol);
    res.json({ symbol: payload.symbol, iv: payload.volatility.history, bars: payload.structure.bars, flow: payload.demand.flowHistory });
  }));
  app.post('/api/research/:symbol/snapshots', route(async (req, res) => {
    const preview = previews.get(req.body.researchId);
    if (!preview || preview.owner !== req.user.id || preview.payload.symbol !== validResearchSymbol(req.params.symbol) || Date.now() - preview.at > 30 * 60_000) throw new Error('Research preview expired; refresh before saving');
    res.status(201).json(store.save(req.user.id, preview.payload));
  }));
}
