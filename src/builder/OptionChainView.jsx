import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  buildChain,
  chainExpiries,
  contractKey,
  earningsForExpiry,
  indexCandidates,
  nearestExpiry,
  scoreLabel,
  scoreRank,
} from "../../shared/optionChain.js";
import { money, num, pct, pillTone } from "./format.js";
import "../styles/option-chain.css";

const dash = "—";
const pill = (tone, text) => <span className={`pill ${tone}`}>{text}</span>;
const quotePair = (a, b) => (
  <span className="quote-list">
    <span>
      <b className="positive">{a}</b>/<b className="negative">{b}</b>
    </span>
  </span>
);
// "10/23" within the current year, "2027/01/15" beyond it, as in the broker chains.
const tabDate = (date, today) =>
  date.slice(0, 4) === today.slice(0, 4) ? date.slice(5).replace("-", "/") : date.replaceAll("-", "/");

// The results-table columns that make sense for one contract, in the table's order. `group` ties a column to the
// "Columns" dialog toggles. Symbol, Strategy, Hedge choices and Legs to trade describe a whole position, so they
// have no per-contract value; Expiry and DTE are the tabs above the chain.
const COLUMNS = [
  {
    id: "price",
    label: "Bid/ask price",
    cell: (m) => quotePair(m.bid != null ? num(m.bid, 2) : dash, m.ask != null ? num(m.ask, 2) : dash),
  },
  {
    id: "size",
    label: "Bid/ask size",
    cell: (m) => quotePair(m.bidSize ?? dash, m.askSize ?? dash),
  },
  {
    id: "breakeven",
    label: "Breakeven",
    hint: "Underlying price at expiry where buying this contract breaks even, fees included",
    cell: (m) => (m.priced ? money(m.downBreakeven, 2) : dash),
  },
  {
    id: "maxProfit",
    label: "Max profit",
    group: "risk",
    cell: (m) =>
      m.priced ? <span className="positive">{m.maxProfit == null ? "Unlimited" : money(m.maxProfit)}</span> : dash,
  },
  {
    id: "maxLoss",
    label: "Max loss",
    group: "risk",
    cell: (m) =>
      m.priced ? <span className="negative">{m.maxLoss == null ? "Unlimited" : money(m.maxLoss)}</span> : dash,
  },
  {
    id: "annRet",
    label: "Ann ret %",
    hint: "An income yield: only credit positions have one, so it is blank for a bought contract",
    cell: (m) => pill(pillTone(m.annRetPct, 24, 8), m.annRetPct == null ? dash : `${num(m.annRetPct, 2)}%`),
  },
  {
    id: "ev",
    label: "EV/BP",
    hint: "Model expected P&L as a share of the premium at risk, at this contract's IV",
    cell: (m) => pill(pillTone(m.evPerBp, 1, 0.3), m.evPerBp == null ? dash : `${num(m.evPerBp, 2)}%`),
  },
  {
    id: "ivRank",
    label: "IV rank",
    hint: "The stock's IV rank, the same for every contract",
    cell: (m, x) => pill(pillTone(x.ivRank, 50, 25), x.ivRank == null ? dash : `${num(x.ivRank, 2)}%`),
  },
  {
    id: "liquidity",
    label: "Liquidity",
    cell: (m) => pill(pillTone(m.liquidity, 70, 55), m.liquidity ?? dash),
  },
  {
    id: "cost",
    label: "Debit / credit",
    group: "risk",
    hint: "Cost of 1 contract at the ask",
    cell: (m) => (m.priced ? `${money(m.netDebit)} debit` : dash),
  },
  {
    id: "iv",
    label: "IV",
    group: "iv",
    cell: (m) =>
      m.iv == null ? (
        dash
      ) : (
        <span title={m.ivDerived ? "Implied from the bid/ask mid (provider IV unavailable)" : undefined}>
          {pct(m.iv * 100)}
          {m.ivDerived && "*"}
        </span>
      ),
  },
  { id: "oi", label: "OI", group: "oi", cell: (m) => num(m.openInterest, 0) },
  {
    id: "earnings",
    label: "Earnings",
    hint: "Earnings before this expiry, derived from the scanned results",
    cell: (m, x) => pill(x.earnings === "Clear" ? "good" : x.earnings === "Before expiry" ? "bad" : "mid", x.earnings ?? dash),
  },
  {
    id: "data",
    label: "Data",
    hint: "Quoted: the provider returned a live two-sided bid/ask in this chain snapshot",
    cell: (m, x) => <span className="data-label">{x.sample ? "Sample" : m.quoted ? "Quoted" : "Unverified"}</span>,
  },
  {
    id: "score",
    label: "Score",
    hint: "Best score among scanned results that trade this contract",
    cell: (m, x) => {
      const rows = x.candidates.get(contractKey(m.expiry, m.type, m.strike));
      if (!rows?.length) return <span className="subtle">{dash}</span>;
      const best = rows.reduce((a, r) => (scoreRank(r) > scoreRank(a) ? r : a)),
        label = scoreLabel(best),
        names = rows.map((r) => r.name).join(", ");
      if (label == null)
        return (
          <button className="text-button" title={`${names}. Not scored yet; select it`} onClick={() => x.onSelectRow(best.id)}>
            Unscored
          </button>
        );
      return (
        <button
          className={`rating ${best.catalystImpact > 0 ? "positive" : best.catalystImpact < 0 ? "negative" : "neutral"}`}
          title={`${names}. Selects the best of ${rows.length} scanned result${rows.length > 1 ? "s" : ""} using this contract`}
          onClick={() => x.onSelectRow(best.id)}
        >
          {label}
          {rows.length > 1 && <small>×{rows.length}</small>}
        </button>
      );
    },
  },
];

const NO_CONTRACTS = [];

export default function OptionChainView({
  symbol,
  spot,
  data,
  loading,
  error,
  fee,
  hv,
  scanRows,
  selectedRow,
  onSelectRow,
  hiddenColumns = [],
}) {
  const contracts = data?.contracts ?? NO_CONTRACTS,
    asOf = data?.asOf,
    today = (asOf ?? new Date().toISOString()).slice(0, 10);
  const expiries = useMemo(() => chainExpiries(contracts, today), [contracts, today]);
  const [picked, setPicked] = useState(null);
  // Opens on the selected result's expiry (or the closest listed one) until a tab is picked.
  const active = expiries.find((e) => e.date === picked) ?? nearestExpiry(expiries, selectedRow?.expiry) ?? null;
  const chain = useMemo(
    () => (active && spot > 0 ? buildChain(contracts, active.date, { spot, asOf, fee, hv }) : null),
    [contracts, active?.date, spot, asOf, fee, hv],
  );
  const candidates = useMemo(() => indexCandidates(scanRows), [scanRows]),
    ivRank = useMemo(() => scanRows.find((r) => r.ivRank != null)?.ivRank ?? null, [scanRows]),
    selectedKeys = useMemo(
      () => new Set((selectedRow?.legs ?? []).map((l) => contractKey(selectedRow.expiry, l.type, l.strike))),
      [selectedRow],
    );
  const tabsRef = useRef(null),
    scrollRef = useRef(null),
    spotRef = useRef(null);
  // Open on the active expiry's tab and with the spot divider mid-view, like the broker chains do.
  useEffect(() => {
    const tabs = tabsRef.current,
      tab = tabs?.querySelector('[aria-selected="true"]');
    if (tabs && tab) tabs.scrollLeft = tab.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2;
  }, [active?.date]);
  useEffect(() => {
    const box = scrollRef.current,
      mark = spotRef.current;
    if (box && mark) box.scrollTop = Math.max(0, mark.offsetTop - box.clientHeight / 2);
  }, [active?.date, chain?.strikes.length]);

  if (error) return <div className="studio-empty negative">Option chain unavailable: {error}</div>;
  if (!contracts.length)
    return (
      <div className="studio-empty">
        {loading ? (
          <>Loading every expiry and strike for {symbol}. The first load can take a minute.</>
        ) : !data ? (
          <>Run a scan to load the option chain for {symbol}.</>
        ) : (
          <>
            No listed option contracts were returned for {symbol}.
            {(data.warnings ?? []).slice(0, 3).map((w) => (
              <p key={w} className="subtle">
                {w}
              </p>
            ))}
          </>
        )}
      </div>
    );
  if (!active || !chain) return <div className="studio-empty">No unexpired option contracts for {symbol}.</div>;

  const cols = COLUMNS.filter((c) => !c.group || !hiddenColumns.includes(c.group)),
    callCols = [...cols].reverse(),
    span = cols.length * 2 + 1,
    { callVolume, putVolume } = chain.totals,
    volumeKnown = callVolume != null && putVolume != null && callVolume + putVolume > 0;
  const shared = {
    ivRank,
    earnings: earningsForExpiry(scanRows, active.date),
    sample: data.sample === true,
    candidates,
    onSelectRow,
  };
  function sideCells(m, type, list, itm) {
    if (!m)
      return (
        <td colSpan={list.length} className={`chain-cell none ${type}${itm ? " itm" : ""}`}>
          {dash}
        </td>
      );
    const sel = selectedKeys.has(contractKey(m.expiry, type, m.strike));
    return list.map((c) => (
      <td key={c.id} className={`chain-cell ${type}${itm ? " itm" : ""}${sel ? " sel" : ""}`}>
        {c.cell(m, shared)}
      </td>
    ));
  }
  const spotRow = (
    <tr className="chain-spot" ref={spotRef}>
      <td colSpan={span}>
        <span>
          <b>{symbol}</b> {money(spot, 2)}
          <small>spot at scan time</small>
        </span>
      </td>
    </tr>
  );
  return (
    <div className="chain-view">
      <div className="chain-tabs" role="tablist" aria-label="Expiry date" ref={tabsRef}>
        {expiries.map((e) => (
          <button
            key={e.date}
            role="tab"
            aria-selected={e.date === active.date}
            className="chain-tab"
            title={e.date === selectedRow?.expiry ? `${e.date} · expiry of the selected result` : e.date}
            onClick={() => setPicked(e.date)}
          >
            {tabDate(e.date, today)}
            {e.weekly && <sup>W</sup>}
            <small>({e.dte}d)</small>
            {e.date === selectedRow?.expiry && <i className="chain-tab-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div className="chain-summary">
        <span className="chain-total call">
          Call <b>{num(callVolume, 0)}</b>
        </span>
        <span className="chain-ratio">
          C/P volume ratio <b>{volumeKnown && putVolume > 0 ? num(callVolume / putVolume, 2) : dash}</b>
        </span>
        <span className="chain-total put">
          Put <b>{num(putVolume, 0)}</b>
        </span>
      </div>
      <div className={`chain-bar${volumeKnown ? "" : " unknown"}`} aria-hidden="true">
        <i style={{ width: `${volumeKnown ? (callVolume / (callVolume + putVolume)) * 100 : 50}%` }} />
      </div>
      {data.complete === false && (
        <p className="subtle chain-warning">
          Some expiries could not be loaded{data.warnings?.[0] ? `: ${data.warnings[0]}` : "."}
        </p>
      )}
      <div className="results-scroll chain-scroll" ref={scrollRef}>
        <table className="results-table chain-table" aria-label={`${symbol} option chain, ${active.date}`}>
          <thead>
            <tr className="chain-groups">
              <th colSpan={cols.length} className="call">
                <span>Calls</span>
              </th>
              <th />
              <th colSpan={cols.length} className="put">
                <span>Puts</span>
              </th>
            </tr>
            <tr>
              {callCols.map((c) => (
                <th key={`call-${c.id}`} title={c.hint}>
                  {c.label}
                </th>
              ))}
              <th className="chain-strike-head">Strike</th>
              {cols.map((c) => (
                <th key={`put-${c.id}`} title={c.hint}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chain.strikes.map((r, i) => (
              <Fragment key={r.strike}>
                {i === chain.spotIndex && spotRow}
                <tr>
                  {sideCells(r.call, "call", callCols, r.strike < spot)}
                  <td className="chain-strike">{num(r.strike, 2)}</td>
                  {sideCells(r.put, "put", cols, r.strike > spot)}
                </tr>
              </Fragment>
            ))}
            {chain.spotIndex === chain.strikes.length && spotRow}
          </tbody>
        </table>
      </div>
      <footer className="results-footer">
        <span>
          {chain.strikes.length} strikes · each contract is evaluated as buying 1 at the ask, fees included. Shaded =
          in the money; outlined = a leg of the selected result.
          {data.asOf &&
            ` Chain snapshot ${new Date(data.asOf).toLocaleTimeString()}${data.source ? ` from ${data.source}` : ""}.`}
        </span>
      </footer>
    </div>
  );
}
