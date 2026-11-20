import test from "node:test";
import assert from "node:assert/strict";
import { binaryPnl, binaryYesPrice, payoff, summarizePosition } from "../shared/builderEngine.js";

const asOf = "2026-10-13T12:00:00Z";
const binary = (extra = {}) => ({
  outcome: "NO",
  quantity: 1000,
  entryPrice: 0.9665,
  target: 184,
  direction: "down",
  resolution: "2026-11-01",
  yesNow: 0.0335,
  iv: 0.4656,
  spotNow: 228.52,
  asOf,
  ...extra,
});
const row = (extra = {}) => ({
  asOf,
  expiry: "2026-11-06",
  spot: 228.52,
  shares: 0,
  fees: 0,
  iv: 0.4656,
  legs: [{ type: "put", strike: 185, quantity: 28, price: 0.36, iv: 0.4656 }],
  binary: binary(),
  netDebit: 1000 * 0.9665 + 28 * 100 * 0.36,
  ...extra,
});

test("the modeled Yes price equals the market price today, at today's spot", () => {
  assert.ok(Math.abs(binaryYesPrice(binary(), 228.52, "2026-10-13") - 0.0335) < 1e-9);
  const up = binary({ direction: "up", target: 260, yesNow: 0.22, outcome: "YES", entryPrice: 0.22 });
  assert.ok(Math.abs(binaryYesPrice(up, 228.52, "2026-10-13") - 0.22) < 1e-9);
});

test("Yes price moves the right way with the stock and settles to 1 or 0 at resolution", () => {
  const down = binary();
  assert.ok(binaryYesPrice(down, 190, "2026-10-20") > binaryYesPrice(down, 228.52, "2026-10-20")); // closer to a dip = likelier
  assert.equal(binaryYesPrice(down, 183, "2026-11-02"), 1);
  assert.equal(binaryYesPrice(down, 184, "2026-11-02"), 1);
  assert.equal(binaryYesPrice(down, 200, "2026-11-02"), 0);
  const up = binary({ direction: "up", target: 260, yesNow: 0.22 });
  assert.ok(binaryYesPrice(up, 250, "2026-10-20") > binaryYesPrice(up, 228.52, "2026-10-20"));
  assert.equal(binaryYesPrice(up, 261, "2026-11-02"), 1);
  assert.equal(binaryYesPrice(up, 259, "2026-11-02"), 0);
  assert.ok(binaryYesPrice(down, 0, "2026-10-20") > 0.99);
  assert.ok(binaryYesPrice(up, 0, "2026-10-20") < 0.01);
});

test("binary P&L is symmetric between Yes and No legs", () => {
  const no = binaryPnl(binary(), 200, "2026-11-02");
  const yes = binaryPnl(binary({ outcome: "YES", entryPrice: 0.0335 }), 200, "2026-11-02");
  assert.equal(no, 1000 * (1 - 0.9665)); // never dipped to 184: NO pays 1
  assert.equal(yes, 1000 * (0 - 0.0335));
  assert.equal(binaryPnl(binary(), 183, "2026-11-02"), 1000 * (0 - 0.9665));
});

test("payoff adds the Polymarket leg to the option legs", () => {
  const withBinary = row();
  const optionsOnly = row({ binary: undefined });
  const spot = 200;
  const delta = payoff(withBinary, spot) - payoff(optionsOnly, spot);
  assert.ok(Math.abs(delta - binaryPnl(withBinary.binary, spot, withBinary.expiry)) < 1e-9);
  assert.equal(payoff(optionsOnly, spot), payoff({ ...optionsOnly }, spot));
});

test("a hedged NO + long put position has a bounded loss and a breakeven below the threshold", () => {
  const sp = summarizePosition(row());
  // Worst case: stock stays above the put strike and the dip market never triggers.
  assert.ok(Math.abs(sp.maxLoss - (-(28 * 100 * 0.36) + 1000 * (1 - 0.9665))) < 1e-6);
  assert.ok(sp.maxProfit > 0);
  assert.ok(sp.breakevens.length >= 1);
  assert.ok(sp.breakevens.every((b) => b < 228.52));
  // Either side of the threshold is a well-defined value (the profile jumps there, it is not smoothed away).
  assert.ok(Number.isFinite(payoff(row(), 183.99, "2026-11-06")));
  assert.ok(Number.isFinite(payoff(row(), 184.01, "2026-11-06")));
  assert.ok(payoff(row(), 183.99, "2026-11-06") !== payoff(row(), 184.01, "2026-11-06"));
});

test("rows without a Polymarket leg are unaffected", () => {
  const plain = row({ binary: undefined, netDebit: 1008 });
  assert.equal(summarizePosition(plain).maxLoss, -1008);
  assert.equal(payoff(plain, 228.52, "2026-11-06") < 0, true);
});
