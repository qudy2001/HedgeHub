import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createResearchStore } from '../server/researchStore.js';
import { registerResearchRoutes, researchSettings, createResearchService } from '../server/researchService.js';

test('research API saves the reviewed preview, rejects other users, validates inputs and enforces routine limits', async () => {
  const store = createResearchStore(':memory:');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: req.headers['test-owner'] || 'a' }; next(); });
  let calls = 0;
  const service = { research: async symbol => ({ symbol, version: 'test', value: ++calls }), status: () => ({}), permissions: async () => ({}) };
  registerResearchRoutes(app, store, service);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (value, owner = 'a') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'test-owner': owner }, body: JSON.stringify(value) });
  try {
    const preview = await (await fetch(`${url}/api/research/AAPL`)).json();
    const saved = await fetch(`${url}/api/research/AAPL/snapshots`, post({ researchId: preview.researchId }));
    assert.equal(saved.status, 201);
    assert.equal(calls, 1, 'saving must not reprice a reviewed preview');
    const id = (await saved.json()).id;
    const read = await (await fetch(`${url}/api/research/snapshots/${id}`)).json();
    assert.equal(read.research.value, preview.value);
    assert.equal((await fetch(`${url}/api/research/snapshots/${id}`, { headers: { 'test-owner': 'b' } })).status, 404);
    assert.equal((await fetch(`${url}/api/research/AAPL/snapshots`, post({ researchId: preview.researchId }, 'b'))).status, 400);
    assert.equal((await fetch(`${url}/api/research/watchlist`, post({ symbol: 'AAPL', feePerContract: -1 }))).status, 400);
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${url}/api/research/watchlist`, post({ symbol: `S${i}` }))).status, 200);
    assert.equal((await fetch(`${url}/api/research/watchlist`, post({ symbol: 'OVER' }))).status, 400);
    assert.equal((await fetch(`${url}/api/research/watchlist`, post({ symbol: 'S0', peers: 'AMD,NVDA' }))).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('failed collection retains last-good data and last-success time; repeated reads back off', async () => {
  const oldProvider = process.env.MARKET_DATA_PROVIDER, oldToken = process.env.TIGER_BRIDGE_TOKEN;
  process.env.MARKET_DATA_PROVIDER = 'tiger';
  process.env.TIGER_BRIDGE_TOKEN = 'test-only';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('fixture outage'); };
  const store = createResearchStore(':memory:');
  const at = '2025-01-01T00:00:00.000Z';
  store.put('ZZTEST', 'fundamentals', 'tiger', { peTtm: 15 }, at);
  try {
    const service = createResearchService(store);
    const first = await service.research('ZZTEST');
    assert.equal(first.statuses.fundamentals.stale, true);
    assert.equal(first.statuses.fundamentals.updatedAt, at);
    const count = calls;
    await service.research('ZZTEST');
    assert.equal(calls, count, 'negative cache must prevent repeated provider requests');
    assert.equal(store.get('ZZTEST', 'fundamentals', 'tiger').updatedAt, at);
  } finally {
    globalThis.fetch = originalFetch; store.close();
    if (oldProvider == null) delete process.env.MARKET_DATA_PROVIDER; else process.env.MARKET_DATA_PROVIDER = oldProvider;
    if (oldToken == null) delete process.env.TIGER_BRIDGE_TOKEN; else process.env.TIGER_BRIDGE_TOKEN = oldToken;
  }
});

test('research settings reject malformed symbols and fees', () => {
  assert.throws(() => researchSettings({ peers: '../../private' }));
  assert.throws(() => researchSettings({ feePerContract: 'NaN' }));
  assert.deepEqual(researchSettings({ peers: 'AMD, NVDA AMD' }).peers, ['AMD', 'NVDA']);
});
