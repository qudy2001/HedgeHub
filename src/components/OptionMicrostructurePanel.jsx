import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

function formatNumber(value, digits = 2) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(digits) : "n/a";
}

function formatInteger(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(numericValue);
}

function formatAge(ms) {
  const numericValue = Number(ms);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "n/a";
  }

  const minutes = Math.round(numericValue / 60000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "n/a";
  }

  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildContractOptions(contracts = []) {
  return (Array.isArray(contracts) ? contracts : [])
    .filter((contract) => contract?.contractSymbol)
    .map((contract) => ({
      contractSymbol: String(contract.contractSymbol).trim(),
      label: contract.label || contract.contractSymbol,
      anchorAt: contract.anchorAt ?? null
    }));
}

function SummaryCard({ label, value, hint = "" }) {
  return (
    <div className="microstructure-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function renderEmptyState(message) {
  return <div className="microstructure-empty">{message}</div>;
}

export default function OptionMicrostructurePanel({
  title = "Execution Quality",
  contracts = [],
  anchorAt = null,
  anchorLabel = "",
  emptyMessage = "No intraday observation history yet. Add to watchlist or keep it active in paper trading to start collecting.",
  orderId = null
}) {
  const contractOptions = useMemo(() => buildContractOptions(contracts), [contracts]);
  const [selectedContractSymbol, setSelectedContractSymbol] = useState(contractOptions[0]?.contractSymbol ?? "");
  const [windowKey, setWindowKey] = useState(anchorAt ? "anchor" : "today");
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSelectedContractSymbol((current) => {
      if (contractOptions.some((option) => option.contractSymbol === current)) {
        return current;
      }
      return contractOptions[0]?.contractSymbol ?? "";
    });
  }, [contractOptions]);

  useEffect(() => {
    if (orderId) {
      let cancelled = false;
      setLoading(true);
      setError("");
      fetch(`/api/options/paper-order-execution-review/${encodeURIComponent(orderId)}`)
        .then(async (response) => {
          const json = await response.json();
          if (!response.ok) {
            throw new Error(json?.error || "Unable to load execution review.");
          }
          if (!cancelled) {
            setPayload(json);
          }
        })
        .catch((nextError) => {
          if (!cancelled) {
            setError(nextError.message);
            setPayload(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }

    if (!selectedContractSymbol) {
      setPayload(null);
      return;
    }

    const selectedContract = contractOptions.find((option) => option.contractSymbol === selectedContractSymbol) ?? null;
    const resolvedAnchorAt = windowKey === "anchor" ? selectedContract?.anchorAt ?? anchorAt ?? null : null;
    const query = new URLSearchParams({
      contractSymbol: selectedContractSymbol,
      window: windowKey,
      limit: "100"
    });

    if (resolvedAnchorAt) {
      query.set("anchorAt", resolvedAnchorAt);
    }

    let cancelled = false;
    setLoading(true);
    setError("");

    fetch(`/api/options/shortlist-observations?${query.toString()}`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json?.error || "Unable to load option observations.");
        }
        if (!cancelled) {
          setPayload(json);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError.message);
          setPayload(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [anchorAt, contractOptions, orderId, selectedContractSymbol, windowKey]);

  const legPayload = useMemo(() => {
    if (!orderId) {
      return payload;
    }

    const legs = Array.isArray(payload?.legs) ? payload.legs : [];
    return legs.find((leg) => leg.contractSymbol === selectedContractSymbol) ?? legs[0] ?? null;
  }, [orderId, payload, selectedContractSymbol]);

  const orderLegOptions = useMemo(
    () =>
      orderId
        ? (payload?.legs ?? []).map((leg) => ({
            contractSymbol: String(leg.contractSymbol ?? "").trim(),
            label: leg.label || leg.contractSymbol,
            anchorAt: leg.anchorAt ?? null
          }))
        : [],
    [orderId, payload]
  );

  useEffect(() => {
    if (!orderId) {
      return;
    }

    setSelectedContractSymbol((current) => {
      if (orderLegOptions.some((option) => option.contractSymbol === current)) {
        return current;
      }
      return orderLegOptions[0]?.contractSymbol ?? "";
    });
  }, [orderId, orderLegOptions]);

  const activePayload = orderId ? legPayload : payload;
  const observations = [...(activePayload?.observations ?? [])].reverse();
  const summary = activePayload?.summary ?? null;
  const diagnostics = activePayload?.diagnostics ?? null;
  const series = activePayload?.series ?? [];

  return (
    <section className="microstructure-panel">
      <div className="microstructure-panel__header">
        <div>
          <h4>{title}</h4>
          {diagnostics?.reason ? <p>{diagnostics.reason}</p> : null}
        </div>
        {diagnostics?.status ? (
          <span className={`pill microstructure-pill microstructure-pill--${diagnostics.tone || "neutral"}`}>
            {diagnostics.status}
          </span>
        ) : null}
      </div>

      {contractOptions.length > 1 || orderLegOptions.length > 1 ? (
        <label className="microstructure-panel__selector">
          <span>Leg</span>
          <select value={selectedContractSymbol} onChange={(event) => setSelectedContractSymbol(event.target.value)}>
            {(orderId ? orderLegOptions : contractOptions).map((option) => (
              <option key={option.contractSymbol} value={option.contractSymbol}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {!orderId ? (
        <div className="microstructure-panel__windows">
          <button
            type="button"
            className={windowKey === "30m" ? "microstructure-window microstructure-window--active" : "microstructure-window"}
            onClick={() => setWindowKey("30m")}
          >
            30m
          </button>
          <button
            type="button"
            className={windowKey === "2h" ? "microstructure-window microstructure-window--active" : "microstructure-window"}
            onClick={() => setWindowKey("2h")}
          >
            2h
          </button>
          <button
            type="button"
            className={windowKey === "today" ? "microstructure-window microstructure-window--active" : "microstructure-window"}
            onClick={() => setWindowKey("today")}
          >
            Today
          </button>
          {anchorAt ? (
            <button
              type="button"
              className={windowKey === "anchor" ? "microstructure-window microstructure-window--active" : "microstructure-window"}
              onClick={() => setWindowKey("anchor")}
            >
              {anchorLabel || "Since anchor"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="microstructure-panel__windows">
          <span className="microstructure-window microstructure-window--active">{anchorLabel || "Since entry"}</span>
        </div>
      )}

      {loading ? (
        renderEmptyState("Loading execution-quality history…")
      ) : error ? (
        renderEmptyState(error)
      ) : !summary || Number(summary.observationCount ?? 0) === 0 ? (
        renderEmptyState(emptyMessage)
      ) : (
        <>
          <div className="microstructure-summary-grid">
            <SummaryCard label="Current spread %" value={formatNumber(summary.currentSpreadPct)} />
            <SummaryCard label="Best spread" value={formatNumber(summary.bestSpreadPct)} />
            <SummaryCard label="Median spread" value={formatNumber(summary.medianSpreadPct)} />
            <SummaryCard
              label="Displayed size"
              value={`${formatInteger(summary.currentBidSize)} / ${formatInteger(summary.currentAskSize)}`}
              hint={`Min ${formatInteger(summary.currentDisplayedSize)}`}
            />
            <SummaryCard label="Last trade age" value={formatAge(summary.lastTradeAgeMs)} />
          </div>

          <div className="microstructure-chart-card">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={series}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis
                  dataKey="time"
                  tickFormatter={(value) =>
                    new Date(value).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit"
                    })
                  }
                />
                <YAxis yAxisId="spread" orientation="left" />
                <YAxis yAxisId="mark" orientation="right" />
                <Tooltip
                  labelFormatter={(value) => formatTimestamp(value)}
                  formatter={(value, name) => {
                    if (name === "Spread %") {
                      return [`${formatNumber(value)}%`, name];
                    }
                    if (name === "Bid size" || name === "Ask size") {
                      return [formatInteger(value), name];
                    }
                    return [formatNumber(value, 4), name];
                  }}
                />
                <Legend />
                <Area yAxisId="spread" type="monotone" dataKey="bidSize" name="Bid size" fillOpacity={0.08} stroke="#1d4ed8" />
                <Area yAxisId="spread" type="monotone" dataKey="askSize" name="Ask size" fillOpacity={0.08} stroke="#dc2626" />
                <Line yAxisId="spread" type="monotone" dataKey="spreadPct" name="Spread %" stroke="#2563eb" dot={false} strokeWidth={2} />
                <Line yAxisId="mark" type="monotone" dataKey="mark" name="Mark" stroke="#111827" dot={false} strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="microstructure-table-card">
            <div className="microstructure-table-card__header">
              <strong>Recent observations</strong>
              <span>{observations.length} rows</span>
            </div>
            <div className="microstructure-table-wrap">
              <table className="microstructure-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Bid</th>
                    <th>Ask</th>
                    <th>Spread %</th>
                    <th>Bid size</th>
                    <th>Ask size</th>
                    <th>Mark</th>
                    <th>Last trade</th>
                    <th>Trade size</th>
                    <th>Volume</th>
                    <th>OI</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {observations.map((row) => (
                    <tr key={`${row.observedAt}:${row.contractSymbol}:${row.id ?? row.quoteTimestamp ?? row.source}`}>
                      <td>{formatTimestamp(row.observedAt)}</td>
                      <td>{formatNumber(row.bid, 4)}</td>
                      <td>{formatNumber(row.ask, 4)}</td>
                      <td>{formatNumber(((Number(row.ask) - Number(row.bid)) / Math.max((Number(row.ask) + Number(row.bid)) / 2, 0.0001)) * 100)}</td>
                      <td>{formatInteger(row.bidSize)}</td>
                      <td>{formatInteger(row.askSize)}</td>
                      <td>{formatNumber(row.mark, 4)}</td>
                      <td>{formatNumber(row.lastTradePrice, 4)}</td>
                      <td>{formatInteger(row.lastTradeSize)}</td>
                      <td>{formatInteger(row.volume)}</td>
                      <td>{formatInteger(row.openInterest)}</td>
                      <td>{row.source || "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
