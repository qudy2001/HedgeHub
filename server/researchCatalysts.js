import fs from 'node:fs/promises';
import { timestampIso } from './quoteQuality.js';

const DAY = 86400_000;
const day = value => timestampIso(value)?.slice(0, 10) ?? null;
export const addDays = (date, count) => new Date(Date.parse(`${date}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
export function researchWindow(expiry, lookbackDays = 30, now = new Date().toISOString()) {
  const today = now.slice(0, 10);
  const selected = expiry || addDays(today, 38);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || day(selected) !== selected || selected < today || selected > addDays(today, 366)) throw new Error('Research expiry must be a valid date within the next year');
  const lookback = Number(lookbackDays);
  if (!Number.isInteger(lookback) || lookback < 7 || lookback > 90) throw new Error('Lookback must be 7–90 days');
  return { from: addDays(today, -lookback), to: addDays(selected, 7), expiry: selected, explicitExpiry: Boolean(expiry), lookbackDays: lookback, today };
}
export function safeSourceUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}

// An optional locally maintained source-backed calendar supplements calendars which
// cannot know every product announcement, operating update or regulatory deadline.
// Never infer a confirmed schedule from a recurring historical release pattern.
export async function curatedCatalysts(symbol, window) {
  if (!process.env.RESEARCH_CATALYST_FILE) throw new Error('Company/industry announcement feed not configured; source review required');
  const payload = JSON.parse(await fs.readFile(process.env.RESEARCH_CATALYST_FILE, 'utf8'));
  if (!Array.isArray(payload.events)) throw new Error('Catalyst file must contain an events array');
  const events = payload.events.filter(e => Array.isArray(e.symbols) && e.symbols.includes(symbol)).map(e => ({
    id: String(e.id ?? ''), title: String(e.title ?? '').slice(0, 500), category: ['operating-update', 'announcement', 'regulatory'].includes(e.category) ? e.category : 'announcement',
    date: day(e.date), dateStatus: ['confirmed', 'estimated', 'unconfirmed'].includes(e.dateStatus) ? e.dateStatus : 'unconfirmed',
    source: String(e.source ?? ''), sourceUrl: safeSourceUrl(e.sourceUrl), verifiedAt: timestampIso(e.verifiedAt),
    note: String(e.note ?? '').slice(0, 1000)
  })).filter(e => e.title && e.sourceUrl && (!e.date || e.date >= window.from && e.date <= window.to));
  return { events, reviewedAt: timestampIso(payload.reviewedAt), complete: false };
}

export function buildCatalystChecklist({ datasets, window, earnings = {}, financials = {}, dividends = [], now = new Date().toISOString() }) {
  const rows = [];
  const push = e => { const date = day(e.date); if (date && (date < window.from || date > window.to)) return;
    rows.push({ ...e, scheduledAt: e.category === 'economic' ? timestampIso(e.date) : null, date, sourceUrl: safeSourceUrl(e.sourceUrl), phase: !date ? 'date-unconfirmed' : date < window.today ? 'recent-past' : date <= window.expiry ? 'through-expiry' : 'post-expiry-buffer' }); };
  for (const e of datasets.macro?.data ?? []) push({ ...e, category: 'economic', dateStatus: 'provider-scheduled', source: e.source || 'TradingView economic calendar' });
  for (const e of earnings.events ?? []) push({ title: 'Company earnings / results', date: e.date ?? e.timestamp, category: 'earnings', dateStatus: 'provider-scheduled', source: earnings.source, sourceUrl: e.sourceUrl });
  const filingDates = [...new Set(Object.values(financials.fields ?? {}).flat().map(p => p.filed).filter(Boolean))];
  for (const date of filingDates) push({ title: 'Published financial statement', date, category: 'financial-statement', dateStatus: 'published', source: 'Financial report publication date' });
  for (const d of dividends) push({ title: `Ex-dividend: ${d.currency ?? ''} ${d.amount ?? ''}`, date: d.exDate, category: 'dividend', dateStatus: 'provider-scheduled', source: datasets.dividends?.source });
  for (const e of datasets.catalysts?.data?.events ?? []) push(e);
  rows.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.title.localeCompare(b.title));
  const sourceState = (key, label, note) => { const s = datasets[key]; return { key, label, status: !s || s.stale || s.error ? 'gap' : 'partial', checkedAt: s?.updatedAt ?? null, note: s?.error || note }; };
  const checklist = [
    sourceState('macro', 'Economic releases and central-bank decisions', 'Provider calendar queried across the full window; verify changes and relevant countries.'),
    sourceState('events', 'Earnings and results', 'Earnings calendar is separate from filing dates; an empty calendar does not establish clearance.'),
    sourceState('financials', 'Published financial statements', 'Publication-dated statements only; filing coverage may be incomplete.'),
    sourceState('catalysts', 'Operating updates, company announcements and regulatory dates', 'Source-backed supplemental calendar; not an exhaustive announcement schedule.'),
    sourceState('dividends', 'Dividends and corporate actions', 'Dividend dates only; other corporate actions require separate review.'),
    sourceState('social', 'Social sentiment and discussion topics', 'Historical sample only. No future sentiment is available; verify topics against primary sources.')
  ];
  if (datasets.social?.data && datasets.social.data.sentiment == null) {
    checklist.at(-1).status = 'gap';
    checklist.at(-1).note = 'Discussion sample available; validated sentiment scoring is not configured. Source-specific gaps are listed below.';
  }
  const verified = datasets.catalysts?.data?.reviewedAt;
  if (datasets.catalysts?.data && (!verified || Date.parse(now) - Date.parse(verified) > 7 * DAY || Date.parse(verified) > Date.parse(now))) {
    checklist[3].status = 'gap';
    checklist[3].note = 'Supplemental calendar has no valid review within seven days. Recheck original sources.';
  }
  return { window, events: rows, checklist, social: datasets.social?.data ?? null,
    status: checklist.some(c => c.status === 'gap') ? 'coverage-gaps' : 'review-required',
    note: 'Collected does not mean exhaustive or safe to trade. Review events before expiry and the following seven days, especially if shares may be assigned.', generatedAt: now };
}
