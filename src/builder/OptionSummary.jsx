import { useMemo } from "react";
import { optionSummary } from "../../shared/optionSummary.js";
import { money } from "./format.js";

export const SUMMARY_SECTIONS = ["Signals", "Key levels", "What stands out"];

// Condensed read of the option chain and price panels: signal tiles, a price ladder of the levels
// that matter, and plain-language takeaways. All figures come from shared/optionSummary.js.
export default function OptionSummary({ data, loading, error, spot, stats, symbol, hidden = () => false }) {
  const summary = useMemo(
    () =>
      optionSummary({
        contracts: data?.contracts ?? [],
        spot,
        asOf: data?.asOf?.slice(0, 10),
        stats,
      }),
    [data, spot, stats],
  );
  if (!(spot > 0))
    return <p className="subtle">Select a stock to summarize its options and price.</p>;
  const { signals, levels, takeaways, expected } = summary,
    showLevels = !hidden("Key levels") && levels.length > 1,
    showTakeaways = !hidden("What stands out") && takeaways.length > 0;
  return (
    <div className="option-summary">
      {!hidden("Signals") && signals.length > 0 && (
        <div className="summary-signals">
          {signals.map((s) => (
            <div key={s.key} className={`summary-signal ${s.tone}`}>
              <span>{s.key}</span>
              <strong>{s.label}</strong>
              <small>{s.detail}</small>
            </div>
          ))}
          {expected && (
            <div className="summary-signal neutral">
              <span>Expected move</span>
              <strong>±{expected.pct.toFixed(1)}%</strong>
              <small>
                ±{money(expected.amount, 2)} by {expected.expiration}
              </small>
            </div>
          )}
        </div>
      )}
      {(showLevels || showTakeaways) && (
        <div className="summary-body">
          {showLevels && (
            <section>
              <h4>Key levels</h4>
              <table className="summary-levels">
                <tbody>
                  {levels.map((l) => (
                    <tr key={l.label} className={l.spot ? "spot" : ""}>
                      <th scope="row">{l.label}</th>
                      <td>{money(l.value, 2)}</td>
                      <td className={l.spot ? "" : l.distancePct >= 0 ? "positive" : "negative"}>
                        {l.spot ? "" : `${l.distancePct >= 0 ? "+" : ""}${l.distancePct.toFixed(1)}%`}
                      </td>
                      <td className="subtle">{l.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {showTakeaways && (
            <section>
              <h4>What stands out</h4>
              <ul className="summary-takeaways">
                {takeaways.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      <small className="subtle">
        {loading
          ? "Loading the option chain… price signals shown first."
          : error
            ? `Option chain unavailable (${error}); price signals only.`
            : summary.contracts
              ? `Rule-based read of ${symbol ?? "the"} chain (${summary.contracts.toLocaleString("en-US")} contracts, ${data?.source ?? "provider"}) and price history. Walls use open interest within 90 days. Descriptive, not advice.`
              : "No option chain returned; price signals only."}
      </small>
    </div>
  );
}
