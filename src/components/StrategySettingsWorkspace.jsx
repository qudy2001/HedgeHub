import StrategySettingsMenu from "./StrategySettingsMenu.jsx";

function formatCountLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default function StrategySettingsWorkspace({
  strategyPayload,
  onSaveStrategyAssetMapping = null,
  onDeleteStrategyAssetMapping = null
}) {
  const strategySettingsAssets = strategyPayload?.strategySettings?.assets ?? [];
  const strategyCompareModes = strategyPayload?.strategySettings?.compareModes ?? ["price"];
  const exactEventCount = strategySettingsAssets.filter((asset) => String(asset?.polymarketEventUrl ?? "").trim()).length;
  const customAssetCount = strategySettingsAssets.filter((asset) => asset?.isCustom === true).length;
  const finderEnabledCount = strategySettingsAssets.filter((asset) => asset?.finderEnabled !== false).length;
  const screenerEnabledCount = strategySettingsAssets.filter((asset) => asset?.screenerEnabled !== false).length;

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
    </main>
  );
}
