import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveSparklines } from "../server/macroM2.js";
import { buildMacroDashboardPayload, setLiveM2 } from "../server/macroDashboard.js";

// 73 months of steady 1% monthly growth ending at 100T.
function growthSeries(months, endUsd = 100e12) {
  return Array.from({ length: months }, (_value, index) => ({
    ym: `m${index}`,
    usd: endUsd / Math.pow(1.01, months - 1 - index)
  }));
}

function m2Tiles() {
  const payload = buildMacroDashboardPayload();
  const section = payload.sections.find((item) => item.id === "money-and-reserves");
  return section.groups.find((group) => group.id === "m2").tiles;
}

test("sparklines only exist for ranges the series is long enough to cover", () => {
  const long = buildLiveSparklines(growthSeries(73));
  assert.deepEqual(Object.keys(long).sort(), ["180D", "30D", "365D", "730D", "MAX"]);
  assert.equal(long["365D"].length, 13);
  assert.equal(long.MAX.length, 61);

  const short = buildLiveSparklines(growthSeries(13));
  assert.deepEqual(Object.keys(short).sort(), ["180D", "30D", "365D"]);
  assert.equal(short["24H"], undefined);
});

test("period changes come from the real series, so 1Y, 2Y and 5Y differ and are not capped", () => {
  setLiveM2({
    tiles: {
      "m2-china": { id: "m2-china", source: "test", asOf: "2026-02", valueUsd: 100e12, monthly: growthSeries(73) }
    }
  });

  const china = m2Tiles().find((tile) => tile.id === "m2-china");
  const pct = (key) => {
    const series = china.sparklines[key];
    return ((series.at(-1) - series[0]) / series[0]) * 100;
  };

  assert.equal(china.quality, "live");
  assert.equal(china.dataAsOf, "2026-02");
  assert.ok(Math.abs(pct("365D") - (Math.pow(1.01, 12) - 1) * 100) < 0.01);
  assert.ok(pct("730D") > pct("365D"));
  assert.ok(pct("MAX") > pct("730D"));
  assert.ok(pct("MAX") > 36, "5Y change is no longer clamped at 36%");
  assert.ok(Math.abs(china.changePct - 1) < 0.01, "headline change is the 1-month change");

  setLiveM2(null);
});

test("tiles without a live source are flagged estimates with no invented change", () => {
  setLiveM2(null);

  for (const tile of m2Tiles()) {
    assert.equal(tile.quality, "estimate", tile.id);
    assert.equal(tile.changePct, null, tile.id);
    assert.deepEqual(tile.sparklines, {}, tile.id);
  }
});

test("estimate tiles do not dilute the weighted change of the group", () => {
  setLiveM2({
    tiles: {
      "m2-us": { id: "m2-us", source: "test", asOf: "2026-09", valueUsd: 20e12, monthly: growthSeries(13, 20e12) }
    }
  });

  const payload = buildMacroDashboardPayload();
  const group = payload.sections
    .find((item) => item.id === "money-and-reserves")
    .groups.find((item) => item.id === "m2");
  const us = group.tiles.find((tile) => tile.id === "m2-us");

  assert.equal(group.weightedChangePct, us.changePct);

  setLiveM2(null);
});
