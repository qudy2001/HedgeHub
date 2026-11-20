import { useMemo, useState } from "react";
import { DAY, binaryPnl, payoff } from "../../shared/builderEngine.js";
import { money, num } from "./format.js";

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const signed = (v) => (v < 0 ? `-${money(-v, 2)}` : money(v, 2));
const tone = (v) => (v > 0.005 ? "positive" : v < -0.005 ? "negative" : "");

// What-if repricing of the selected hedge position: same model as the payoff heatmap
// (payoff()/binaryPnl()), driven by date, underlying price and volatility sliders.
export default function HedgePriceSlider({ row }) {
  const start = Date.parse(String(row.asOf).slice(0, 10));
  const end = Date.parse(row.expiry);
  const days = Math.max(0, Math.round((end - start) / DAY));
  const baseVol = useMemo(() => {
    if (row.iv > 0) return row.iv;
    const ivs = row.legs.map((l) => l.iv).filter((v) => v > 0);
    if (ivs.length) return ivs.reduce((a, b) => a + b, 0) / ivs.length;
    return row.binary?.iv ?? row.hv ?? 0.3;
  }, [row]);
  const [day, setDay] = useState(0);
  const [spot, setSpot] = useState(row.spot);
  const [vol, setVol] = useState(null); // null = each leg keeps its own IV

  const date = isoDay(start + Math.min(day, days) * DAY);
  const volPct = Math.round((vol ?? baseVol) * 1000) / 10;
  const lo = Math.floor(row.spot * 0.6);
  const hi = Math.ceil(row.spot * 1.4);
  const step = row.spot >= 100 ? 0.5 : 0.01;

  const r = useMemo(() => {
    const bare = { ...row, shares: 0, binary: null, fees: 0 };
    const legs = row.legs.map((l) => ({
      leg: l,
      pnl: payoff({ ...bare, legs: [l] }, spot, date, vol),
    }));
    const binary = row.binary
      ? binaryPnl(vol == null ? row.binary : { ...row.binary, iv: vol }, spot, date)
      : 0;
    const stock = row.shares * (spot - row.spot);
    const options = legs.reduce((s, x) => s + x.pnl, 0);
    const total = stock + options + binary - row.fees;
    const cost = row.netDebit + row.fees;
    return { legs, binary, stock, options, total, cost, marked: cost + total };
  }, [row, spot, date, vol]);

  return (
    <div className="hedge-slider">
      <label className="hs-row">
        <span className="hs-head">
          <small>Valuation date</small>
          <strong>{shortDate(date)}</strong>
        </span>
        <input type="range" min={0} max={days} step={1} value={Math.min(day, days)} onChange={(e) => setDay(+e.target.value)} />
        <span className="hs-ends">
          <small>{shortDate(isoDay(start))}</small>
          <small>{shortDate(row.expiry)}</small>
        </span>
      </label>
      <label className="hs-row">
        <span className="hs-head">
          <small>{row.symbol} price</small>
          <input
            type="number"
            className="hs-num"
            step={step}
            value={Math.round(spot * 100) / 100}
            onChange={(e) => e.target.value !== "" && setSpot(Math.max(0, +e.target.value))}
          />
        </span>
        <input type="range" min={lo} max={hi} step={step} value={Math.min(hi, Math.max(lo, spot))} onChange={(e) => setSpot(+e.target.value)} />
        <span className="hs-ends">
          <small>{money(lo, 0)}</small>
          <button type="button" className="text-button" onClick={() => setSpot(row.spot)}>
            Today {money(row.spot, 2)}
          </button>
          <small>{money(hi, 0)}</small>
        </span>
      </label>
      <label className="hs-row">
        <span className="hs-head">
          <small>Volatility{vol == null ? " (each leg's IV)" : ""}</small>
          <strong>{num(volPct, 1)}%</strong>
        </span>
        <input type="range" min={5} max={150} step={0.5} value={volPct} onChange={(e) => setVol(+e.target.value / 100)} />
        <span className="hs-ends">
          <small>5%</small>
          {vol != null && (
            <button type="button" className="text-button" onClick={() => setVol(null)}>
              Reset to market IV
            </button>
          )}
          <small>150%</small>
        </span>
      </label>

      <div className="hs-metrics">
        <div>
          <small>Net initial cost</small>
          <strong>{signed(r.cost)}</strong>
        </div>
        <div>
          <small>Marked value</small>
          <strong>{signed(r.marked)}</strong>
        </div>
        <div>
          <small>Options P&amp;L</small>
          <strong className={tone(r.options)}>{signed(r.options)}</strong>
        </div>
        {row.binary ? (
          <div>
            <small>Polymarket P&amp;L</small>
            <strong className={tone(r.binary)}>{signed(r.binary)}</strong>
          </div>
        ) : row.shares ? (
          <div>
            <small>Stock P&amp;L</small>
            <strong className={tone(r.stock)}>{signed(r.stock)}</strong>
          </div>
        ) : null}
        <div className="hs-total">
          <small>Total profit / loss{row.fees ? " (after fees)" : ""}</small>
          <strong className={tone(r.total)}>{signed(r.total)}</strong>
        </div>
      </div>

      <div className="hs-legs">
        {row.binary && (
          <p>
            <span>
              Polymarket {row.binary.outcome} · {num(row.binary.quantity, 0)} @ {money(row.binary.entryPrice, 3)}
            </span>
            <strong className={tone(r.binary)}>{signed(r.binary)}</strong>
          </p>
        )}
        {row.shares > 0 && (
          <p>
            <span>
              {row.shares} {row.symbol} shares
            </span>
            <strong className={tone(r.stock)}>{signed(r.stock)}</strong>
          </p>
        )}
        {r.legs.map(({ leg: l, pnl }, i) => (
          <p key={i}>
            <span>
              {l.quantity > 0 ? "Buy" : "Sell"} {Math.abs(l.quantity)} × {num(l.strike, 2)} {l.type}
              {l.expiry && l.expiry !== row.expiry ? ` ${l.expiry}` : ""} @ {money(l.price, 2)}
            </span>
            <strong className={tone(pnl)}>{signed(pnl)}</strong>
          </p>
        ))}
      </div>
      <p className="subtle hs-note">
        Same model as the payoff heatmap.{row.binary ? " Polymarket fees not included." : ""}
      </p>
    </div>
  );
}
