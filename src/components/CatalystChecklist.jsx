import { useState } from 'react';

export default function CatalystChecklist({ research }) {
  const [phase, setPhase] = useState('all');
  const [country, setCountry] = useState('all');
  const [visibleCount, setVisibleCount] = useState(100);
  if (!research) return <p>This saved research predates the event checklist. Refresh research to collect it.</p>;
  const { window, checklist, social } = research;
  const countries = [...new Set(research.events.filter(e => e.category === 'economic').map(e => e.country).filter(Boolean))].sort();
  const events = research.events.filter(e => (phase === 'all' || e.phase === phase) && (country === 'all' || e.category !== 'economic' || e.country === country));
  return <>
    <h4>Event risk and discussion checklist</h4>
    <p><strong>{window.from} through {window.to}</strong> · Option expiry {window.expiry} · Includes seven calendar days after expiry.
      {!window.explicitExpiry && ' No expiry selected: using the scanner’s 38-day outer window. Set the actual expiry above for a contract-specific review.'}</p>
    <p className="entry-research__notice">{research.note} Status: {research.status.replaceAll('-', ' ')}.</p>
    <div className="entry-research__table"><table><thead><tr><th>Check</th><th>Coverage</th><th>Last collection</th><th>What remains to verify</th></tr></thead><tbody>
      {checklist.map(c => <tr key={c.key}><td>{c.label}</td><td>{c.status === 'gap' ? 'Missing / stale' : 'Partial — review required'}</td><td>{c.checkedAt ?? 'Never'}</td><td>{c.note}</td></tr>)}
    </tbody></table></div>
    <div className="entry-research__controls">
      <label>Timeline<select value={phase} onChange={e => setPhase(e.target.value)}><option value="all">Full research window</option><option value="recent-past">Recent past</option><option value="through-expiry">Today through expiry</option><option value="post-expiry-buffer">Seven days after expiry</option><option value="date-unconfirmed">Date unconfirmed</option></select></label>
      <label>Economic region<select value={country} onChange={e => setCountry(e.target.value)}><option value="all">All available countries</option>{countries.map(c => <option key={c}>{c}</option>)}</select></label>
    </div>
    <div className="entry-research__table"><table><thead><tr><th>Date / window</th><th>Event</th><th>Category</th><th>Date evidence</th><th>Source / context</th></tr></thead><tbody>
      {events.slice(0, visibleCount).map((e, i) => <tr key={`${e.category}:${e.id ?? ''}:${e.date}:${i}`}><td>{e.date ?? 'TBA'}{e.scheduledAt && <><br />{e.scheduledAt} (UTC)</>}<br />{e.phase.replaceAll('-', ' ')}</td><td>{e.title}{e.country && ` (${e.country})`}</td><td>{e.category}</td><td>{e.dateStatus}{e.verifiedAt && <><br />Checked {e.verifiedAt}</>}</td><td>{e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.source || 'Source'}</a> : e.source || 'Source link unavailable'}{e.actual != null && <><br />Actual: {String(e.actual)}</>}{e.forecast != null && <> · Forecast: {String(e.forecast)}</>}{e.note && <p>{e.note}</p>}</td></tr>)}
    </tbody></table></div>
    {events.length > visibleCount && <p>Showing {visibleCount} of {events.length} events. Filter the timeline or region, or <button className="finder-action" type="button" onClick={() => setVisibleCount(n => n + 100)}>Show 100 more</button></p>}
    {!events.length && <p>No collected events in this selection. This is not confirmation that no events are scheduled.</p>}
    <h4>Current social discussion</h4>
    <p>Future posts and sentiment cannot be collected. This section covers recent discussion, including expectations about future catalysts.</p>
    {!social ? <p>No connected social sample. Tiger order flow is not a substitute for social sentiment.</p> : <>
      <p>{social.sampleCount} sampled posts; {social.last7DaysCount} from the last seven days. {social.sentimentStatus}</p>
      <p>{social.method}</p>
      <ul>{social.sources.map(s => <li key={s.name}>{s.name}: {s.error || `${s.from} → ${s.to}. ${s.note}${s.truncated ? ' More results exist; sample is capped.' : ''}`}</li>)}</ul>
      <p>Discussion topics: {social.topics.map(t => `${t.label} (${t.mentions})`).join('; ') || 'No matches in this sample.'}</p>
      <ul>{social.posts.map(p => <li key={`${p.source}:${p.id}`}><a href={p.url} target="_blank" rel="noreferrer">{p.source} · {p.date}</a> — {p.excerpt}</li>)}</ul>
    </>}
  </>;
}
