function formatDay(dateValue) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date(dateValue));
}

function formatTime(dateValue, isExactTime, releaseSession) {
  if (!dateValue) {
    return "TBA";
  }

  if (!isExactTime) {
    return releaseSession || "Time TBA";
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(dateValue));
}

function formatFinancialValue(value, currency = "USD", digits = 2) {
  if (value == null || Number.isNaN(value)) {
    return "\u2014";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    notation: Math.abs(value) >= 1_000_000_000 ? "compact" : "standard",
    maximumFractionDigits: digits
  }).format(value);
}

function formatEstimate(value) {
  if (value == null || Number.isNaN(value)) {
    return "\u2014";
  }

  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 2
  }).format(value);
}

function groupByDay(events) {
  const groups = new Map();

  for (const event of events) {
    const key = new Date(event.timestamp).toISOString().slice(0, 10);
    const currentGroup = groups.get(key) ?? [];
    currentGroup.push(event);
    groups.set(key, currentGroup);
  }

  return [...groups.entries()].map(([day, groupEvents]) => ({
    day,
    label: formatDay(groupEvents[0].timestamp),
    events: groupEvents
  }));
}

export default function CompanyEventsPanel({ data }) {
  const events = data?.events ?? [];
  const groupedEvents = groupByDay(events);

  return (
    <article className="calendar-panel">
      <div className="section-heading">
        <span>Statement and earnings events</span>
        <span className="pill pill--ghost">US companies &gt; $30B</span>
      </div>

      <div className="calendar-panel__meta">
        <span className="pill pill--live">Next 30 days</span>
        <span className="pill pill--ghost">NASDAQ / NYSE / AMEX</span>
        <span className="pill pill--ghost">{events.length} companies</span>
      </div>

      {groupedEvents.length ? (
        <div className="calendar-table">
          <div className="calendar-table__header calendar-table__header--companies">
            <span>Time</span>
            <span>Company</span>
            <span>EPS est</span>
            <span>Revenue est</span>
            <span>Market cap</span>
          </div>

          <div className="calendar-table__body">
            {groupedEvents.map((group) => (
              <section key={group.day} className="calendar-day-group">
                <div className="calendar-day-group__label">{group.label}</div>
                {group.events.map((event) => (
                  <div key={event.symbol} className="calendar-row calendar-row--companies">
                    <div className="calendar-row__time calendar-row__time--stack">
                      <strong>{formatTime(event.timestamp, event.isExactTime, event.releaseSession)}</strong>
                      <span>{event.releaseSession}</span>
                    </div>
                    <div className="calendar-row__event">
                      <div className="calendar-row__event-main">
                        <span className="ticker-badge">{event.shortSymbol}</span>
                        <strong>{event.description}</strong>
                      </div>
                      <span className="calendar-row__event-copy">
                        {[event.exchange, event.type === "dr" ? "ADR" : "Common stock"].filter(Boolean).join(" • ")}
                      </span>
                    </div>
                    <div className="calendar-row__stat">{formatEstimate(event.earningsEstimate)}</div>
                    <div className="calendar-row__stat">{formatFinancialValue(event.revenueEstimate, "USD", 2)}</div>
                    <div className="calendar-row__stat">{formatFinancialValue(event.marketCapUsd, "USD", 2)}</div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="calendar-empty">No US-listed companies above $30B were found in the next 30 days.</div>
      )}
    </article>
  );
}
