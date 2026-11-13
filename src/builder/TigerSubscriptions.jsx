import { useEffect, useState } from "react";
import { describeSubscriptions } from "./subscriptions.js";

const REFRESH_MS = 10 * 60_000;

async function getJson(path) {
  const response = await fetch("/api" + path, { credentials: "same-origin" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

// Sidebar block: when each Tiger market-data subscription expires. Renders nothing unless Tiger is the provider.
export default function TigerSubscriptions({ demo }) {
  const [state, setState] = useState(null); // null = hidden, { rows } or { error }
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (demo) return undefined;
    let cancelled = false;
    async function load() {
      try {
        const settings = await getJson("/settings/market-data");
        if (settings?.provider !== "tiger") return;
        const result = await getJson("/research/permissions");
        if (!cancelled) setState({ permissions: result?.data?.permissions ?? [] });
      } catch (e) {
        if (!cancelled) setState({ error: e.message });
      }
      if (!cancelled) setNow(Date.now());
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [demo]);

  if (!state) return null;
  const rows = describeSubscriptions(state.permissions, now);
  return (
    <div className="sidebar-subscriptions">
      <span className="eyebrow">TIGER SUBSCRIPTIONS</span>
      {state.error ? (
        <p className="sub-note" title={state.error}>Could not read subscriptions</p>
      ) : rows.length === 0 ? (
        <p className="sub-note">No subscriptions found</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.name} className={`sub-${row.status}`} title={row.name}>
              <strong>{row.label}</strong>
              <span>{row.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
