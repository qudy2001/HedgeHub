import { useCallback, useEffect, useState } from "react";
import StrategySettingsMenu from "./StrategySettingsMenu.jsx";

function formatCountLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default function StrategySettingsWorkspace({
  strategyPayload,
  onSaveStrategyAssetMapping = null,
  onDeleteStrategyAssetMapping = null,
  isAdmin = false,
  onAuthRequired = null
}) {
  const strategySettingsAssets = strategyPayload?.strategySettings?.assets ?? [];
  const strategyCompareModes = strategyPayload?.strategySettings?.compareModes ?? ["price"];
  const exactEventCount = strategySettingsAssets.filter((asset) => String(asset?.polymarketEventUrl ?? "").trim()).length;
  const customAssetCount = strategySettingsAssets.filter((asset) => asset?.isCustom === true).length;
  const finderEnabledCount = strategySettingsAssets.filter((asset) => asset?.finderEnabled !== false).length;
  const screenerEnabledCount = strategySettingsAssets.filter((asset) => asset?.screenerEnabled !== false).length;
  const [bridgeStatus, setBridgeStatus] = useState(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState("");

  const loadBridgeStatus = useCallback(async () => {
    if (!isAdmin) {
      setBridgeStatus(null);
      setBridgeError("");
      return;
    }

    setBridgeLoading(true);
    setBridgeError("");

    try {
      const response = await fetch("/api/admin/docker-diagnostics-bridge");
      const payload = await response.json().catch(() => null);

      if (response.status === 401) {
        onAuthRequired?.("Session expired");
        return;
      }

      if (!response.ok) {
        throw new Error(payload?.error || `Failed to load Docker diagnostics bridge (${response.status})`);
      }

      setBridgeStatus(payload ?? null);
    } catch (error) {
      setBridgeError(error.message);
    } finally {
      setBridgeLoading(false);
    }
  }, [isAdmin, onAuthRequired]);

  useEffect(() => {
    void loadBridgeStatus();
  }, [loadBridgeStatus]);

  async function handleBridgeToggle(event) {
    const enabled = Boolean(event.target.checked);
    setBridgeBusy(true);
    setBridgeError("");

    try {
      const response = await fetch("/api/admin/docker-diagnostics-bridge", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          enabled
        })
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 401) {
        onAuthRequired?.("Session expired");
        return;
      }

      if (!response.ok) {
        throw new Error(payload?.error || `Failed to update Docker diagnostics bridge (${response.status})`);
      }

      setBridgeStatus(payload ?? null);
    } catch (error) {
      setBridgeError(error.message);
    } finally {
      setBridgeBusy(false);
    }
  }

  function formatTimestamp(value) {
    if (!value) {
      return "n/a";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "n/a";
    }

    return date.toLocaleString("en-GB");
  }

  return (
    <main className="workspace workspace--strategy-settings">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Strategy settings</span>
          <h2>Asset mappings and source rules</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--live">{formatCountLabel(strategySettingsAssets.length, "tracked asset")}</span>
            <span className="pill pill--ghost">{formatCountLabel(exactEventCount, "exact event")}</span>
          </div>
          <span className="timestamp">
            {strategyPayload?.lastUpdated
              ? `Updated ${new Date(strategyPayload.lastUpdated).toLocaleString("en-GB")}`
              : "Waiting for refresh"}
          </span>
        </div>
      </header>

      <section className="hero-stats strategy-settings__summary">
        <article className="metric-card metric-card--teal">
          <span>Finder enabled</span>
          <strong>{finderEnabledCount}</strong>
        </article>
        <article className="metric-card metric-card--sky">
          <span>Screener enabled</span>
          <strong>{screenerEnabledCount}</strong>
        </article>
        <article className="metric-card metric-card--amber">
          <span>Exact event links</span>
          <strong>{exactEventCount}</strong>
        </article>
        <article className="metric-card metric-card--rose">
          <span>Custom assets</span>
          <strong>{customAssetCount}</strong>
        </article>
      </section>

      <article className="insight-card strategy-settings__panel">
        <div className="strategy-settings__page-head">
          <div>
            <span className="brand__eyebrow">Manual mappings</span>
            <h3>Map each asset to the right Polymarket source</h3>
          </div>
          <p className="card-copy">
            Use exact event URLs when you want Strategy 1 to stay locked to a specific Polymarket page, or add query
            terms and custom tickers for broader screening.
          </p>
        </div>

        <StrategySettingsMenu
          assets={strategySettingsAssets}
          compareModes={strategyCompareModes}
          onSaveAsset={onSaveStrategyAssetMapping}
          onDeleteAsset={onDeleteStrategyAssetMapping}
        />
      </article>

      {isAdmin ? (
        <article className="insight-card strategy-settings__panel">
          <div className="strategy-settings__page-head">
            <div>
              <span className="brand__eyebrow">Admin diagnostics</span>
              <h3>Docker diagnostics bridge</h3>
            </div>
            <p className="card-copy">
              Enable a read-only localhost TCP bridge that Codex can use to inspect this Docker Compose stack without
              touching container files.
            </p>
          </div>

          <div className="strategy-settings__bridge-card">
            <div className="strategy-settings__bridge-actions">
              <label className="strategy-settings__toggle">
                <input
                  type="checkbox"
                  checked={bridgeStatus?.enabled === true}
                  onChange={handleBridgeToggle}
                  disabled={bridgeBusy || bridgeLoading}
                />
                <span>Bridge enabled</span>
              </label>

              <button type="button" className="chart-toggle" onClick={() => void loadBridgeStatus()} disabled={bridgeBusy}>
                Refresh status
              </button>

              <span className={`pill ${bridgeStatus?.running ? "pill--live" : "pill--warning"}`}>
                {bridgeLoading ? "Loading…" : bridgeStatus?.running ? "Running" : "Stopped"}
              </span>
            </div>

            <div className="strategy-settings__bridge-grid">
              <div>
                <span>Bridge address</span>
                <strong>{bridgeStatus?.bridgeUrl ?? "n/a"}</strong>
              </div>
              <div>
                <span>Host port</span>
                <strong>{bridgeStatus?.port ?? "n/a"}</strong>
              </div>
              <div>
                <span>Last health check</span>
                <strong>{formatTimestamp(bridgeStatus?.lastHealthCheckAt)}</strong>
              </div>
              <div className="strategy-settings__wide">
                <span>Last error</span>
                <strong>{bridgeError || bridgeStatus?.lastError || "n/a"}</strong>
              </div>
            </div>
          </div>
        </article>
      ) : null}
    </main>
  );
}
