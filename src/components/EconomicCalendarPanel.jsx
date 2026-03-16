function formatEventTime(dateValue) {
  if (!dateValue) {
    return "TBA";
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(dateValue));
}

function formatEventDay(dateValue) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date(dateValue));
}

function formatCompactNumber(value) {
  const absoluteValue = Math.abs(value);
  const formatter =
    absoluteValue >= 1000
      ? new Intl.NumberFormat("en-GB", {
          notation: "compact",
          maximumFractionDigits: 2
        })
      : new Intl.NumberFormat("en-GB", {
          maximumFractionDigits: 2
        });

  return formatter.format(value);
}

function formatCalendarValue(event, field) {
  const displayValue = event[field];
  const rawValue = event[`${field}Raw`];

  if (typeof displayValue === "string" && displayValue.trim()) {
    return displayValue;
  }

  const numericValue = typeof displayValue === "number" ? displayValue : typeof rawValue === "number" ? rawValue : null;

  if (numericValue == null) {
    return "\u2014";
  }

  const renderedValue = formatCompactNumber(numericValue);
  return event.unit ? `${renderedValue}${event.unit === "%" ? "%" : ` ${event.unit}`}` : renderedValue;
}

function groupByDay(events) {
  const groups = new Map();

  for (const event of events) {
    const key = event.date ? new Date(event.date).toISOString().slice(0, 10) : "unknown";
    const currentGroup = groups.get(key) ?? [];
    currentGroup.push(event);
    groups.set(key, currentGroup);
  }

  return [...groups.entries()].map(([day, groupEvents]) => ({
    day,
    label: groupEvents[0]?.date ? formatEventDay(groupEvents[0].date) : "Upcoming",
    events: groupEvents
  }));
}

export default function EconomicCalendarPanel({ data }) {
  const events = data?.events ?? [];
  const groupedEvents = groupByDay(events);

  return (
    <article className="calendar-panel">
      <div className="section-heading">
        <span>Financial calendar</span>
        <span className="pill pill--ghost">TradingView economic source</span>
      </div>

      <div className="calendar-panel__meta">
        <span className="pill pill--live">High importance</span>
        <span className="pill pill--ghost">All categories</span>
        <span className="pill pill--ghost">{events.length} events</span>
      </div>

      {groupedEvents.length ? (
        <div className="calendar-table">
          <div className="calendar-table__header calendar-table__header--economic">
            <span>Time</span>
            <span>Event</span>
            <span>Actual</span>
            <span>Forecast</span>
            <span>Prior</span>
          </div>

          <div className="calendar-table__body">
            {groupedEvents.map((group) => (
              <section key={group.day} className="calendar-day-group">
                <div className="calendar-day-group__label">{group.label}</div>
                {group.events.map((event) => (
                  <div key={event.id} className="calendar-row calendar-row--economic">
                    <div className="calendar-row__time">{formatEventTime(event.date)}</div>
                    <div className="calendar-row__event">
                      <div className="calendar-row__event-main">
                        <span className="country-badge">{event.country || "GL"}</span>
                        <strong>{event.title}</strong>
                      </div>
                      <span className="calendar-row__event-copy">
                        {[event.indicator, event.period].filter(Boolean).join(" • ") || "Macro release"}
                      </span>
                    </div>
                    <div className="calendar-row__stat">{formatCalendarValue(event, "actual")}</div>
                    <div className="calendar-row__stat">{formatCalendarValue(event, "forecast")}</div>
                    <div className="calendar-row__stat">{formatCalendarValue(event, "previous")}</div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="calendar-empty">No high-importance macro events were returned for this window.</div>
      )}
    </article>
  );
}
