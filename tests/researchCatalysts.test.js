import test from 'node:test';
import assert from 'node:assert/strict';
import { researchWindow, buildCatalystChecklist, safeSourceUrl } from '../server/researchCatalysts.js';
import { summarizeSocial, fetchResearchSocial } from '../server/providers/researchSocial.js';

const now = '2026-10-04T12:00:00.000Z';
test('research window includes 30 days past and the full seven-day expiry buffer', () => {
  const window = researchWindow('2026-10-16', 30, now);
  assert.equal(window.from, '2026-09-04');
  assert.equal(window.to, '2026-10-23');
  assert.throws(() => researchWindow('2026-02-31', 30, now));
  assert.throws(() => researchWindow('2026-10-03', 30, now));
  assert.throws(() => researchWindow('2026-10-16', 0, now));
  const datasets = { macro: { data: ['2026-09-03', '2026-09-04', '2026-10-16', '2026-10-17', '2026-10-23', '2026-10-24'].map(date => ({ title: 'Economic release', date: `${date}T14:00:00Z` })) } };
  const p = buildCatalystChecklist({ datasets, window, now });
  assert.equal(p.events.length, 4);
  assert.deepEqual(p.events.map(e => e.phase), ['recent-past', 'through-expiry', 'post-expiry-buffer', 'post-expiry-buffer']);
  assert.equal(p.events[0].scheduledAt, '2026-09-04T14:00:00.000Z');
  assert.equal(p.status, 'coverage-gaps');
});

test('unconfirmed company schedules remain visible and stale curated reviews are gaps', () => {
  const p = buildCatalystChecklist({ window: researchWindow('2026-10-16', 30, now), now,
    datasets: { catalysts: { data: { reviewedAt: '2026-09-01', events: [{ title: 'Regional registrations', date: null, dateStatus: 'unconfirmed', category: 'operating-update', sourceUrl: 'javascript:alert(1)' }] } } } });
  assert.equal(p.events[0].date, null);
  assert.equal(p.events[0].phase, 'date-unconfirmed');
  assert.equal(p.events[0].sourceUrl, null);
  assert.equal(p.checklist.find(c => c.key === 'catalysts').status, 'gap');
  assert.equal(safeSourceUrl('https://user:password@example.com'), null);
});

test('social topics are deduplicated, windowed and never mislabeled as sentiment scores', () => {
  const post = { source: 'X', id: '1', date: '2026-10-03T12:00:00Z', text: 'Deliveries and earnings guidance', url: 'https://x.com/i/status/1' };
  const p = summarizeSocial([post, post, { ...post, id: '2', date: '2026-10-05T12:00:00Z' }, { ...post, id: '3', date: '2026-09-20T12:00:00Z' }], now);
  assert.equal(p.sampleCount, 2);
  assert.equal(p.last7DaysCount, 1);
  assert.equal(p.sentiment, null);
  assert.equal(p.topics.find(t => t.label === 'sales / deliveries').mentions, 1);
});

test('social access is opt-in and does not make network calls when disabled', async () => {
  const before = process.env.RESEARCH_SOCIAL_ENABLED;
  delete process.env.RESEARCH_SOCIAL_ENABLED;
  try { await assert.rejects(fetchResearchSocial('TSLA', researchWindow('2026-10-16', 30, now)), /disabled/); }
  finally { if (before != null) process.env.RESEARCH_SOCIAL_ENABLED = before; }
});

test('economic collection splits large ranges and retains the final buffer day', async () => {
  const { fetchEconomicCalendarWindow } = await import('../server/providers/tradingViewCalendars.js');
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async raw => {
    const url = new URL(raw), from = url.searchParams.get('from'), to = url.searchParams.get('to');
    requests.push([from, to]);
    return { ok: true, json: async () => ({ status: 'ok', result: [{ id: to, title: 'Release', date: `${to}T12:00:00Z`, importance: 0 }] }) };
  };
  try {
    const rows = await fetchEconomicCalendarWindow({ from: new Date('2026-10-01'), to: new Date('2026-10-23T23:59:59Z') });
    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1)[1], '2026-10-23');
    assert.equal(rows.at(-1).date, '2026-10-23T12:00:00Z');
  } finally { globalThis.fetch = original; }
});
