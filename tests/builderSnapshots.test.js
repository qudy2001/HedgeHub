import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshotStore, marketDay, afterMarketOpen } from "../server/builder/snapshotStore.js";

const DAY = 86400000;
// 15:00 UTC is mid-morning in New York, so adding whole days moves exactly one market day at a time.
const T0 = Date.parse("2026-11-10T15:00:00Z");
const clock = (start = T0) => {
  let at = start;
  return { now: () => at, set: (v) => void (at = v), add: (ms) => void (at += ms) };
};
const scan = (n, extra = {}) => ({
  rows: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, symbol: "TSLA" })),
  dataset: { symbol: "TSLA", spot: 400, asOf: "2026-11-10T15:00:00Z", bars: [], chain: [] },
  ...extra,
});

test("snapshot store saves a scan with its panel data and loads it back unchanged", () => {
  const time = clock(),
    store = createSnapshotStore(":memory:", { now: time.now });
  const chain = Array.from({ length: 3448 }, (_, i) => ({
    contractSymbol: `TSLA${i}`,
    optionType: i % 2 ? "put" : "call",
    strike: 100 + i,
    expiration: "2026-12-18",
    openInterest: i,
    volume: i * 2,
  }));
  const saved = store.saveScan("a", "TSLA", scan(2), { spot: 400 });
  assert.equal(saved.replaced, false);
  assert.equal(store.attach("a", "TSLA", "distribution", { contracts: chain, asOf: "x" }, { meta: { days: 365 } }), true);
  assert.equal(store.attach("a", "TSLA", "stockVolume:60min:365", { interval: "60min", days: 365, result: { bins: [1] } }), true);
  const [listed] = store.list("a", "TSLA");
  assert.equal(listed.id, saved.id);
  assert.equal(listed.day, marketDay(T0));
  assert.equal(listed.rows, 2);
  assert.deepEqual(listed.parts, ["distribution", "scan", "stockVolume:60min:365"]);
  assert.ok(listed.bytes > 0 && listed.bytes < 400_000, `compressed size ${listed.bytes}`);
  const loaded = store.get("a", saved.id);
  assert.deepEqual(loaded.parts.scan.data, scan(2));
  assert.deepEqual(loaded.parts.distribution.data.contracts, chain);
  assert.equal(loaded.parts.distribution.meta.days, 365);
  // Another user sees nothing.
  assert.deepEqual(store.list("b"), []);
  assert.equal(store.get("b", saved.id), null);
  store.close();
});

test("one snapshot per symbol per market day: a rescan replaces it, an empty rescan does not", () => {
  const time = clock(),
    store = createSnapshotStore(":memory:", { now: time.now });
  const first = store.saveScan("a", "TSLA", scan(2));
  store.attach("a", "TSLA", "distribution", { contracts: [1] });
  time.add(3600000);
  const second = store.saveScan("a", "TSLA", scan(5));
  assert.equal(second.id, first.id);
  assert.equal(second.replaced, true);
  assert.equal(store.list("a").length, 1);
  assert.equal(store.get("a", first.id).parts.scan.data.rows.length, 5);
  // Panel data from earlier in the day stays until something newer replaces it.
  assert.deepEqual(store.get("a", first.id).parts.distribution.data, { contracts: [1] });
  time.add(3600000);
  assert.equal(store.saveScan("a", "TSLA", scan(0)).kept, true);
  assert.equal(store.get("a", first.id).parts.scan.data.rows.length, 5);
  // The next market day gets its own snapshot; other symbols are separate too.
  time.add(DAY);
  assert.notEqual(store.saveScan("a", "TSLA", scan(1)).id, first.id);
  store.saveScan("a", "AAPL", scan(1));
  assert.equal(store.list("a").length, 3);
  assert.equal(store.list("a", "TSLA").length, 2);
  assert.equal(store.list("a", "TSLA")[0].rows, 1, "newest first");
  store.close();
});

test("panel data never lands in a previous day's snapshot, and waits briefly for its own scan", () => {
  const time = clock(),
    store = createSnapshotStore(":memory:", { now: time.now });
  const monday = store.saveScan("a", "TSLA", scan(2));
  store.attach("a", "TSLA", "distribution", { contracts: ["monday"] });
  time.add(DAY);
  // Tuesday: the page is still open and reloads the chain before any Tuesday scan.
  assert.equal(store.attach("a", "TSLA", "distribution", { contracts: ["tuesday"] }), false);
  assert.deepEqual(store.get("a", monday.id).parts.distribution.data, { contracts: ["monday"] });
  time.add(60000);
  const tuesday = store.saveScan("a", "TSLA", scan(3));
  assert.deepEqual(store.get("a", tuesday.id).parts.distribution.data, { contracts: ["tuesday"] });
  // Data that waited too long is dropped rather than attached to a later scan.
  assert.equal(store.attach("a", "NVDA", "hedges", { results: {} }), false);
  time.add(11 * 60000);
  const late = store.saveScan("a", "NVDA", scan(1));
  assert.equal(store.get("a", late.id).parts.hedges, undefined);
  store.close();
});

test("attach can veto a replacement and caps stored variants", () => {
  const time = clock(),
    store = createSnapshotStore(":memory:", { now: time.now });
  const { id } = store.saveScan("a", "TSLA", scan(1));
  store.attach("a", "TSLA", "distribution", { contracts: [1, 2] }, { meta: { contracts: 2 } });
  const keepGood = { meta: { contracts: 0 }, unless: (old) => old.meta.contracts > 0 };
  assert.equal(store.attach("a", "TSLA", "distribution", { contracts: [] }, keepGood), false);
  assert.deepEqual(store.get("a", id).parts.distribution.data.contracts, [1, 2]);
  for (let days = 1; days <= 8; days++) {
    time.add(1000);
    store.attach("a", "TSLA", `stockVolume:60min:${days}`, { days }, { variants: 6 });
  }
  const kept = Object.keys(store.get("a", id).parts).filter((p) => p.startsWith("stockVolume:"));
  assert.deepEqual(kept, [3, 4, 5, 6, 7, 8].map((d) => `stockVolume:60min:${d}`));
  assert.ok(store.get("a", id).parts.distribution, "other parts are untouched by the cap");
  store.close();
});

test("snapshots older than 30 days are pruned, on save and on demand", () => {
  const time = clock(),
    store = createSnapshotStore(":memory:", { now: time.now });
  const old = store.saveScan("a", "TSLA", scan(2));
  store.attach("a", "TSLA", "distribution", { contracts: [1] });
  time.add(29 * DAY);
  const recent = store.saveScan("a", "TSLA", scan(3));
  assert.equal(store.list("a").length, 2, "29 days old is still kept");
  time.add(DAY + 60000); // the first is now just over 30 days old
  assert.equal(store.get("a", old.id), null, "expired snapshots are not served even before pruning runs");
  assert.equal(store.list("a").length, 1);
  assert.equal(store.prune(), 1);
  assert.equal(store.prune(), 0);
  assert.ok(store.get("a", recent.id));
  // Saving a scan prunes too.
  time.add(30 * DAY);
  const latest = store.saveScan("b", "AAPL", scan(1));
  assert.equal(store.prune(), 0);
  assert.deepEqual(store.list("a"), []);
  assert.ok(store.get("b", latest.id));
  assert.equal(createSnapshotStore(":memory:").retentionDays, 30);
  store.close();
});


test("the next market day's copy of a panel can be read on its own, skipping copies saved before the open", () => {
  const time = clock(),
    store = createSnapshotStore(":memory:", { now: time.now });
  assert.equal(afterMarketOpen(T0), true);
  assert.equal(afterMarketOpen(Date.parse("2026-11-10T14:29:00Z")), false, "09:29 in New York");
  assert.equal(afterMarketOpen(Date.parse("2026-11-14T16:00:00Z")), false, "Saturday");
  const chain = (oi) => ({ contracts: [{ contractSymbol: "A", openInterest: oi }] });
  store.saveScan("a", "TSLA", scan(1));
  store.attach("a", "TSLA", "distribution", chain(10));
  const day1 = marketDay(T0);
  assert.equal(store.nextPart("a", "TSLA", day1, "distribution"), null);
  // Day 2 was only scanned before the open; day 3 was scanned during the session.
  time.set(Date.parse("2026-11-11T12:00:00Z"));
  store.saveScan("a", "TSLA", scan(1));
  store.attach("a", "TSLA", "distribution", chain(11));
  time.set(T0 + 2 * DAY);
  store.saveScan("a", "TSLA", scan(1));
  store.attach("a", "TSLA", "distribution", chain(25));
  store.saveScan("a", "NVDA", scan(1));
  store.attach("a", "NVDA", "distribution", chain(99));
  assert.equal(store.nextPart("a", "TSLA", day1, "distribution").data.contracts[0].openInterest, 11);
  const next = store.nextPart("a", "TSLA", day1, "distribution", afterMarketOpen);
  assert.equal(next.day, marketDay(T0 + 2 * DAY));
  assert.equal(next.data.contracts[0].openInterest, 25);
  assert.equal(store.nextPart("a", "TSLA", next.day, "distribution"), null);
  assert.equal(store.nextPart("b", "TSLA", day1, "distribution"), null);
  assert.equal(store.nextPart("a", "TSLA", day1, "research"), null);
  store.close();
});
