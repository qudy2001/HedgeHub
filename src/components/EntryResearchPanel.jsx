import { useEffect, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import CatalystChecklist from './CatalystChecklist.jsx';

const n = (v, digits = 2) => v == null || !Number.isFinite(Number(v)) ? 'Unavailable' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits });
const pct = v => v == null ? 'Unavailable' : `${n(v)}%`;
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

function Metric({ label, value }) { return <div className="entry-research__metric"><dt>{label}</dt><dd>{value}</dd></div>; }
function Chart({ data, series, support, resistance }) {
  if (!data?.length) return <p className="entry-research__muted">No verified history available.</p>;
  return <div style={{ height: 210, width: '100%', minWidth: 0 }}>
    <ResponsiveContainer><LineChart data={data}>
      <CartesianGrid strokeDasharray="3 3" opacity={0.2} /><XAxis dataKey="date" minTickGap={60} tick={{ fontSize: 10 }} />
      <YAxis domain={['auto', 'auto']} width={45} tick={{ fontSize: 10 }} /><Tooltip />
      {series.map(([key, color]) => <Line key={key} dataKey={key} stroke={color} dot={false} connectNulls={false} isAnimationActive={false} />)}
      {support > 0 && <ReferenceLine y={support} stroke="#22c55e" strokeDasharray="4 4" label="Support" />}
      {resistance > 0 && <ReferenceLine y={resistance} stroke="#f59e0b" strokeDasharray="4 4" label="Resistance" />}
    </LineChart></ResponsiveContainer>
  </div>;
}

export default function EntryResearchPanel({ initialSymbol = '', threshold = false }) {
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState(initialSymbol);
  const [peers, setPeers] = useState('');
  const [fee, setFee] = useState('0');
  const [assetType, setAssetType] = useState('stock');
  const [sectorSymbol, setSectorSymbol] = useState('');
  const [expiry, setExpiry] = useState('');
  const [lookbackDays, setLookbackDays] = useState('30');
  const [payload, setPayload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [snapshots, setSnapshots] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [watchlist, setWatchlist] = useState([]);
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState('structure');
  const requestId = useRef(0);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(id); }, []);
  useEffect(() => { if (initialSymbol) setSymbol(initialSymbol); }, [initialSymbol]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.all([api('/api/research/snapshots'), api('/api/research/watchlist'), api('/api/settings/market-data')])
      .then(([s, w, d]) => { if (active) { setSnapshots(s); setWatchlist(w); setStatus(d); } })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open]);
  const settings = { peers, feePerContract: Number(fee), assetType, sectorSymbol, expiry, lookbackDays };
  async function load(refresh = false) {
    const id = ++requestId.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const query = new URLSearchParams({ ...settings, refresh: String(refresh) });
      const data = await api(`/api/research/${encodeURIComponent(symbol.trim().toUpperCase())}?${query}`);
      if (id === requestId.current) setPayload(data);
    } catch (e) { if (id === requestId.current) setError(e.message); }
    finally { if (id === requestId.current) setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try {
      await api(`/api/research/${payload.symbol}/snapshots`, post({ researchId: payload.researchId }));
      setSnapshots(await api('/api/research/snapshots'));
      setNotice('Research snapshot saved with source timestamps and calculation version.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function watch(remove = false) {
    setBusy(true); setError('');
    try {
      if (remove) await api(`/api/research/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
      else await api('/api/research/watchlist', post({ symbol, ...settings }));
      setWatchlist(await api('/api/research/watchlist'));
      setNotice(remove ? 'Scheduled collection stopped for this symbol.' : 'Saved: refresh every 15 minutes during US session hours. Dataset caches and quotas apply.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function compare(id) {
    if (!id) { setComparison(null); return; }
    try { setComparison(await api(`/api/research/snapshots/${id}`)); } catch (e) { setError(e.message); }
  }
  const p = payload;
  const activeMetrics = p && [
    ['Stock price', p.stockPrice, comparison?.research.stockPrice],
    ['Support', p.structure.supportPrice, comparison?.research.structure.supportPrice],
    ['IV (decimal)', p.volatility.iv, comparison?.research.volatility.iv],
    ['20-session relative strength (pp)', p.demand.relativeStrength20Points, comparison?.research.demand.relativeStrength20Points],
    ['P/E', p.valuation.pe, comparison?.research.valuation.pe]
  ];
  const quoteStale = !p?.quoteTimestamp || clock - Date.parse(p.quoteTimestamp) > 90_000;
  return <section className="entry-research insight-card">
    <div className="entry-research__heading">
      <div><span className="brand__eyebrow">Entry Research</span><h3>Price, business value and option premium</h3></div>
      <button className="finder-action" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Collapse research' : 'Research an entry'}</button>
    </div>
    {open && <>
      <p>Compare evidence for stocks you would consider owning. Data gaps and conflicting signals remain visible.</p>
      {threshold && <p className="entry-research__notice">Threshold Hedge: touch-event payoff charts are conditional endpoint approximations, not path probabilities. Settlement requires the exact market’s rules and official outcome; quote references are not executable cross-venue prices.</p>}
      <form className="entry-research__controls" onSubmit={e => { e.preventDefault(); load(); }}>
        <label>Symbol<input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} maxLength={16} required /></label>
        <label>Asset<select value={assetType} onChange={e => setAssetType(e.target.value)}><option value="stock">Company</option><option value="etf">ETF</option></select></label>
        <label>Sector ETF (optional)<input value={sectorSymbol} maxLength={16} onChange={e => setSectorSymbol(e.target.value.toUpperCase())} placeholder="e.g. XLK" /></label>
        <label>Comparable peers (up to 5)<input value={peers} onChange={e => setPeers(e.target.value.toUpperCase())} placeholder="Same industry and business model" /></label>
        <label>Entry fee / contract<input type="number" min="0" max="100" step="0.01" value={fee} onChange={e => setFee(e.target.value)} /></label>
        <label>Option expiry<input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></label>
        <label>Past days<input type="number" min="7" max="90" value={lookbackDays} onChange={e => setLookbackDays(e.target.value)} /></label>
        <button className="finder-action" disabled={busy}>{busy ? 'Collecting…' : 'Research'}</button>
        <button className="finder-action" type="button" disabled={busy || !symbol} onClick={() => load(true)}>Refresh market data</button>
        <button className="finder-action" type="button" disabled={busy || !symbol} onClick={() => watch(watchlist.some(w => w.symbol === symbol))}>{watchlist.some(w => w.symbol === symbol) ? 'Stop scheduled collection' : 'Save research routine'}</button>
      </form>
      {watchlist.length > 0 && <div className="entry-research__controls">Saved routines: {watchlist.map(w => <button type="button" className="chart-toggle" key={w.symbol} onClick={() => { setSymbol(w.symbol); setPeers(w.peers.join(',')); setFee(String(w.feePerContract)); setAssetType(w.assetType); setSectorSymbol(w.sectorSymbol ?? ''); setExpiry(w.expiry ?? ''); setLookbackDays(String(w.lookbackDays ?? 30)); }}>{w.symbol}</button>)}</div>}
      {error && <p role="alert" className="entry-research__notice">{error}{p ? ' Previous research is retained below.' : ''}</p>}
      {notice && <p role="status">{notice}</p>}
      {status && <details><summary>Data connection: {status.provider} · {status.configured ? 'bridge token configured' : 'Tiger not configured'}</summary>
        <p>Tiger requires API market-data permissions. Current quotes are never replaced by invented prices. Fundamentals and IV history may require additional access.</p>
        <button type="button" className="finder-action" disabled={busy} onClick={async () => { try { const d = await api('/api/research/permissions'); setNotice(JSON.stringify(d.data)); } catch (e) { setError(e.message); } }}>Check Tiger permissions / quotas</button>
        <p>Collection status: {status.running ? 'running' : 'idle'}. Last successful collections: {(status.jobs ?? []).map(j => `${j.symbol}: ${j.last_success ?? 'none'}${j.error ? ` (${j.error})` : ''}`).join('; ') || 'None yet'}</p>
      </details>}
      {p && <>
        <div className="entry-research__heading"><h3>{p.symbol} · ${n(p.stockPrice)}</h3><span>{p.version} · {new Date(p.generatedAt).toLocaleString()}</span></div>
        <p className="entry-research__notice">{quoteStale ? 'Underlying quote is stale or undated. Refresh before an entry review.' : 'Underlying timestamp verified.'} Quotes: {p.quoteTimestamp ?? 'unknown'}. This view does not refresh automatically.</p>
        {symbol.trim().toUpperCase() !== p.symbol && <p role="status">Showing {p.symbol}; press Research to load {symbol}.</p>}
        <div className="entry-research__tabs" role="tablist" aria-label="Research evidence">
          {[['structure', 'Price structure'], ['fundamentals', 'Business quality'], ['valuation', 'Valuation'], ['volatility', 'Volatility'], ['demand', 'Market demand'], ['catalysts', 'Events & sentiment'], ['entries', 'Entry comparison']].map(([key, label]) =>
            <button type="button" role="tab" aria-selected={tab === key} key={key} className={`chart-toggle ${tab === key ? 'chart-toggle--active' : ''}`} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        <div className="entry-research__content" role="tabpanel">
          {tab === 'catalysts' && <CatalystChecklist research={p.catalysts} />}
          {tab === 'structure' && <>
            <Chart data={p.structure.bars} series={[["close", '#60a5fa']]} support={p.structure.supportPrice} resistance={p.structure.resistancePrice} />
            <dl className="entry-research__metrics"><Metric label="Support / invalidation reference" value={n(p.structure.supportPrice)} /><Metric label="Resistance" value={n(p.structure.resistancePrice)} /><Metric label="Weekly support / resistance" value={`${n(p.structure.weekly?.supportPrice)} / ${n(p.structure.weekly?.resistancePrice)}`} /><Metric label="ATR 14" value={n(p.structure.atr14)} /><Metric label="Technical range (not business value)" value={`${n(p.structure.technicalRange?.lower)} – ${n(p.structure.technicalRange?.upper)}`} /></dl>
            <p>Support evidence: {(p.structure.supportSources ?? []).join(', ') || 'Insufficient history'}. These overlapping indicators are heuristic evidence, not independent probabilities.</p>
          </>}
          {tab === 'fundamentals' && <>
            {!p.fundamentals.applicable ? <p>Company financial statements do not apply to an ETF.</p> : <>
              <dl className="entry-research__metrics"><Metric label="Market capitalisation" value={n(p.fundamentals.current?.marketCapUsd, 0)} /><Metric label="Dividend yield" value={pct(p.fundamentals.current?.dividendYield)} /></dl>
              {Object.entries(p.fundamentals.fields ?? {}).map(([field, points]) => <div key={field}><h4>{field.replaceAll('_', ' ')}</h4><Chart data={points} series={[["value", '#2dd4bf']]} /><p>Last published: {points.at(-1)?.filed ?? 'Unknown'} · Currency: {points.at(-1)?.currency ?? 'Unknown'}</p></div>)}
              {!Object.keys(p.fundamentals.fields ?? {}).length && <p>No verified financial-report history. Additional Tiger fundamental permission may be required.</p>}
              <p>{p.fundamentals.unpublishedOrUndatedCount ?? 0} records excluded because their publication date was unavailable or later than this research.</p>
            </>}
          </>}
          {tab === 'valuation' && <>
            {!p.valuation.applicable ? <p>Company valuation multiples are not applicable to this ETF.</p> : <><dl className="entry-research__metrics"><Metric label="Positive trailing P/E" value={n(p.valuation.pe)} /><Metric label="P/E historical percentile" value={pct(p.valuation.historical.percentile)} /><Metric label="Selected-peer median P/E" value={n(p.valuation.peerMedian)} /><Metric label="Price / levered free cash flow" value={n(p.valuation.pfcf)} /><Metric label="Cash-flow multiple historical percentile" value={pct(p.valuation.fcfHistorical?.percentile)} /><Metric label="Peer cash-flow multiple median" value={n(p.valuation.peerFcfMedian)} /><Metric label="Premium / discount to peers" value={pct(p.valuation.relativeToPeersPct)} /></dl>
              <p>{p.valuation.note} A minimum of 60 historical observations and 3 positive peer multiples is required for comparisons.</p>
              <p>Historical observations: {p.valuation.historical.sampleCount}. Peers: {p.valuation.peers.map(v => `${v.symbol} ${n(v.pe)}${v.error ? ' (unavailable/stale)' : ''}`).join(', ') || 'Select comparable businesses above.'}</p></>}
          </>}
          {tab === 'volatility' && <>
            <Chart data={p.volatility.history.map(v => ({ ...v, iv: v.iv == null ? null : v.iv * 100, hv: v.hv == null ? null : v.hv * 100 }))} series={[["iv", '#a78bfa'], ['hv', '#2dd4bf']]} />
            <dl className="entry-research__metrics"><Metric label="Underlying composite IV" value={pct(p.volatility.iv == null ? null : p.volatility.iv * 100)} /><Metric label="20-session realised volatility" value={pct(p.volatility.rv20 == null ? null : p.volatility.rv20 * 100)} /><Metric label="IV change 5 / 20 sessions (points)" value={`${n(p.volatility.change5Points)} / ${n(p.volatility.change20Points)}`} /><Metric label="Historical percentile / rank" value={`${n(p.volatility.historical.percentile)} / ${n(p.volatility.historical.rank)}`} /></dl>
            <p>{p.volatility.historical.sampleCount} daily IV observations; fewer than 60 disables local percentile/rank. Composite underlying IV is separate from contract IV.</p>
            <div className="entry-research__table"><table><thead><tr><th>Expiry</th><th>Near-ATM IV</th><th>25-delta put–call IV (points)</th></tr></thead><tbody>{p.volatility.termStructure.map(t => <tr key={t.expiry}><td>{t.expiry}</td><td>{pct(t.atmIv * 100)}</td><td>{n(t.skew25)}</td></tr>)}</tbody></table></div>
          </>}
          {tab === 'demand' && <>
            <dl className="entry-research__metrics"><Metric label="20-session return" value={pct(p.demand.return20Pct)} /><Metric label="Relative strength vs SPY (points)" value={n(p.demand.relativeStrength20Points)} /><Metric label={`Relative strength vs ${p.demand.sectorSymbol ?? "sector (not selected)"} (points)`} value={n(p.demand.relativeStrengthSectorPoints)} /><Metric label="Last complete session relative volume" value={n(p.demand.relativeVolume)} /></dl>
            <Chart data={p.demand.flowHistory.map(v => ({ ...v, date: v.time ?? v.timestamp }))} series={[["net_inflow", '#2dd4bf']]} />
            <p>{p.demand.flowLabel}. Broad-market breadth is not available from this selected-symbol sample.</p>
            {p.demand.distribution && <dl className="entry-research__metrics">{['in_big', 'out_big', 'in_mid', 'out_mid', 'in_small', 'out_small'].map(k => <Metric key={k} label={k.replaceAll('_', ' ')} value={n(p.demand.distribution[k], 0)} />)}</dl>}
          </>}
          {tab === 'entries' && <>
            <p className="entry-research__notice">Review “Events &amp; sentiment” through seven days after your option expiry. Quote eligibility does not establish event clearance.</p>
            <p>Earnings: {p.events.events?.length ? p.events.events.map(e => e.date).join(', ') : 'Unknown; an empty calendar does not establish clearance.'}</p>
            <p>Reported dividends: {p.dividends?.length ? p.dividends.map(d => `${d.currency ?? ''} ${n(d.amount)} · ex-date ${d.exDate ?? 'unknown'} · paid ${d.payDate ?? 'unknown'}`).join('; ') : 'No verified dividend events available.'} Dividend dates do not predict early assignment.</p>
            <p>Buying 100 shares now: ${n(p.stockPrice * 100)} before fees. Puts below use bid credits and ${n(p.feePerContract)} entry fee per contract. Rows marked “needs review” have not passed eligibility.</p>
            <div className="entry-research__table"><table><thead><tr><th>Expiry</th><th>Strike</th><th>Net credit</th><th>Net entry</th><th>Cash secured</th><th>Period return</th><th>Support buffer (ATR)</th><th>P&amp;L at −10% / −20% / −30%</th><th>Eligibility</th></tr></thead><tbody>
              {p.entries.map(e => <tr key={e.contract}><td>{e.expiry}</td><td>{n(e.strike)}</td><td>{n(e.credit)}</td><td>{n(e.entryPrice)}</td><td>{n(e.capital)}</td><td>{pct(e.premiumReturnPct)}</td><td>{n(e.supportBufferAtr)}</td><td>{e.stress.map(s => n(s.pnl)).join(' / ')}</td><td>{quoteStale || !e.quoteTimestamp || clock - Date.parse(e.quoteTimestamp) > 90_000 ? 'Refresh quotes; ' : ''}{e.status}: {e.reasons.join(', ')}</td></tr>)}
            </tbody></table></div>
            {!p.entries.length && <p>No contracts available in the put-delta range 0.15–0.30. Research remains available independently of trade eligibility.</p>}
          </>}
        </div>
        <details><summary>Data coverage, timestamps and assumptions</summary>
          <div className="entry-research__table"><table><thead><tr><th>Dataset</th><th>Provider</th><th>Last successful fetch</th><th>Status</th></tr></thead><tbody>{Object.entries(p.statuses).map(([key, d]) => <tr key={key}><td>{key}</td><td>{d.source}</td><td>{d.updatedAt ?? 'Never'}</td><td>{d.error || (d.stale ? 'Stale' : 'Collected')}</td></tr>)}</tbody></table></div>
          <ul>{p.assumptions.map(a => <li key={a}>{a}</li>)}</ul>
        </details>
        <div className="entry-research__controls"><button type="button" className="finder-action" disabled={busy} onClick={save}>Save research snapshot</button>
          <label>Compare / what changed<select onChange={e => compare(e.target.value)} defaultValue=""><option value="">Select saved research</option>{snapshots.map(s => <option key={s.id} value={s.id}>{s.symbol} · {new Date(s.createdAt).toLocaleString()}</option>)}</select></label></div>
        {comparison && <div className="entry-research__table"><p>Current {p.symbol} versus saved {comparison.symbol} · {new Date(comparison.createdAt).toLocaleString()}. Cross-symbol price differences are not valuation rankings.</p><table><thead><tr><th>Measure</th><th>Current</th><th>Saved</th><th>Change</th></tr></thead><tbody>{activeMetrics.map(([label, value, prev]) => <tr key={label}><td>{label}</td><td>{n(value, 4)}</td><td>{n(prev, 4)}</td><td>{n(value != null && prev != null ? value - prev : null, 4)}</td></tr>)}</tbody></table></div>}
      </>}
    </>}
  </section>;
}
