import { useEffect, useState } from "react";

function slugifyAssetId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toQueryText(queries) {
  return Array.isArray(queries) ? queries.join("\n") : "";
}

function buildDraft(asset = null, compareModes = ["price"]) {
  return {
    id: asset?.id ?? "",
    label: asset?.label ?? "",
    optionSymbol: asset?.optionSymbol ?? "",
    underlyingSymbol: asset?.underlyingSymbol ?? "",
    referenceSymbol: asset?.referenceSymbol ?? "",
    conversionFallback: asset?.conversionFallback ?? 1,
    fallbackVolatility: asset?.fallbackVolatility ?? "",
    polymarketEventUrl: asset?.polymarketEventUrl ?? "",
    polymarketQueriesText: toQueryText(asset?.polymarketQueries),
    compareMode: asset?.compareMode ?? compareModes[0] ?? "price",
    optionQuoteProvider: asset?.optionQuoteProvider ?? "stooq",
    optionQuoteSourceSymbol: asset?.optionQuoteSourceSymbol ?? "",
    underlyingQuoteProvider: asset?.underlyingQuoteProvider ?? asset?.optionQuoteProvider ?? "stooq",
    underlyingQuoteSourceSymbol:
      asset?.underlyingQuoteSourceSymbol ?? asset?.optionQuoteSourceSymbol ?? "",
    quoteGroup: asset?.quoteGroup ?? "Strategy Assets",
    finderEnabled: asset?.finderEnabled !== false,
    screenerEnabled: asset?.screenerEnabled !== false,
    settlementType: asset?.settlementType ?? "physical",
    exerciseStyle: asset?.exerciseStyle ?? "american",
    preferenceRank: asset?.preferenceRank ?? 2,
    isCustom: asset?.isCustom === true
  };
}

function buildEmptyDraft(compareModes = ["price"]) {
  return buildDraft(
    {
      id: "",
      label: "",
      optionSymbol: "",
      underlyingSymbol: "",
      referenceSymbol: "",
      conversionFallback: 1,
      fallbackVolatility: "",
      polymarketEventUrl: "",
      polymarketQueries: [],
      compareMode: compareModes[0] ?? "price",
      optionQuoteProvider: "stooq",
      optionQuoteSourceSymbol: "",
      underlyingQuoteProvider: "stooq",
      underlyingQuoteSourceSymbol: "",
      quoteGroup: "Strategy Assets",
      finderEnabled: true,
      screenerEnabled: true,
      settlementType: "physical",
      exerciseStyle: "american",
      preferenceRank: 2,
      isCustom: true
    },
    compareModes
  );
}

function normalizeDraftForSave(draft) {
  const optionSymbol = String(draft.optionSymbol ?? "").trim().toUpperCase();
  const label = String(draft.label ?? "").trim();
  const id = String(draft.id ?? "").trim() || slugifyAssetId(optionSymbol || label);

  return {
    id,
    label: label || optionSymbol,
    optionSymbol,
    underlyingSymbol: String(draft.underlyingSymbol ?? "").trim().toUpperCase() || optionSymbol,
    referenceSymbol: String(draft.referenceSymbol ?? "").trim(),
    conversionFallback: draft.conversionFallback,
    fallbackVolatility: draft.fallbackVolatility,
    polymarketEventUrl: String(draft.polymarketEventUrl ?? "").trim(),
    polymarketQueries: String(draft.polymarketQueriesText ?? "")
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
    compareMode: draft.compareMode,
    optionQuoteProvider: draft.optionQuoteProvider,
    optionQuoteSourceSymbol: String(draft.optionQuoteSourceSymbol ?? "").trim(),
    underlyingQuoteProvider: draft.underlyingQuoteProvider,
    underlyingQuoteSourceSymbol: String(draft.underlyingQuoteSourceSymbol ?? "").trim(),
    quoteGroup: String(draft.quoteGroup ?? "").trim(),
    finderEnabled: draft.finderEnabled === true,
    screenerEnabled: draft.screenerEnabled === true,
    settlementType: draft.settlementType,
    exerciseStyle: draft.exerciseStyle,
    preferenceRank: draft.preferenceRank,
    isCustom: draft.isCustom === true
  };
}

function AssetCard({
  title,
  draft,
  busy,
  onChange,
  onReset,
  onSave,
  onDelete = null
}) {
  return (
    <article className="strategy-settings__card">
      <div className="strategy-settings__card-head">
        <div>
          <strong>{title}</strong>
          <div className="strategy-settings__badges">
            {draft.isCustom ? <span className="source-pill source-pill--custom">Custom</span> : null}
            {draft.finderEnabled ? <span className="source-pill source-pill--live">Finder</span> : null}
            {draft.screenerEnabled ? <span className="source-pill source-pill--mapped">Screener</span> : null}
          </div>
        </div>
        <div className="strategy-settings__actions">
          <button type="button" className="finder-menu__reset" onClick={onReset} disabled={busy}>
            Reset
          </button>
          {onDelete ? (
            <button type="button" className="finder-menu__reset" onClick={onDelete} disabled={busy}>
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <div className="strategy-settings__grid">
        <label>
          <span>Label</span>
          <input value={draft.label} onChange={(event) => onChange("label", event.target.value)} />
        </label>
        <label>
          <span>Asset id</span>
          <input
            value={draft.id}
            onChange={(event) => onChange("id", slugifyAssetId(event.target.value))}
            disabled={!draft.isCustom}
          />
        </label>
        <label>
          <span>Option ticker</span>
          <input value={draft.optionSymbol} onChange={(event) => onChange("optionSymbol", event.target.value.toUpperCase())} />
        </label>
        <label>
          <span>Underlying ticker</span>
          <input
            value={draft.underlyingSymbol}
            onChange={(event) => onChange("underlyingSymbol", event.target.value.toUpperCase())}
            placeholder={draft.optionSymbol || "TSLA"}
          />
        </label>
        <label>
          <span>Reference symbol</span>
          <input value={draft.referenceSymbol} onChange={(event) => onChange("referenceSymbol", event.target.value)} />
        </label>
        <label>
          <span>Compare mode</span>
          <select value={draft.compareMode} onChange={(event) => onChange("compareMode", event.target.value)}>
            <option value="price">Compare by price</option>
          </select>
        </label>
        <label>
          <span>Event URL</span>
          <input
            value={draft.polymarketEventUrl}
            onChange={(event) => onChange("polymarketEventUrl", event.target.value)}
            placeholder="https://polymarket.com/event/..."
          />
        </label>
        <label className="strategy-settings__wide">
          <span>Search queries</span>
          <textarea
            rows="3"
            value={draft.polymarketQueriesText}
            onChange={(event) => onChange("polymarketQueriesText", event.target.value)}
            placeholder={"spx above\ns&p 500 above"}
          />
        </label>
        <label>
          <span>Option quote provider</span>
          <select value={draft.optionQuoteProvider} onChange={(event) => onChange("optionQuoteProvider", event.target.value)}>
            <option value="stooq">Stooq</option>
            <option value="coingecko">CoinGecko</option>
          </select>
        </label>
        <label>
          <span>Option quote source</span>
          <input
            value={draft.optionQuoteSourceSymbol}
            onChange={(event) => onChange("optionQuoteSourceSymbol", event.target.value)}
            placeholder="tsla.us"
          />
        </label>
        <label>
          <span>Underlying quote provider</span>
          <select
            value={draft.underlyingQuoteProvider}
            onChange={(event) => onChange("underlyingQuoteProvider", event.target.value)}
          >
            <option value="stooq">Stooq</option>
            <option value="coingecko">CoinGecko</option>
          </select>
        </label>
        <label>
          <span>Underlying quote source</span>
          <input
            value={draft.underlyingQuoteSourceSymbol}
            onChange={(event) => onChange("underlyingQuoteSourceSymbol", event.target.value)}
            placeholder={draft.optionQuoteSourceSymbol || "tsla.us"}
          />
        </label>
        <label>
          <span>Quote group</span>
          <input value={draft.quoteGroup} onChange={(event) => onChange("quoteGroup", event.target.value)} />
        </label>
        <label>
          <span>Conversion fallback</span>
          <input
            type="number"
            min="0.0001"
            step="0.0001"
            value={draft.conversionFallback}
            onChange={(event) => onChange("conversionFallback", event.target.value)}
          />
        </label>
        <label>
          <span>Fallback volatility</span>
          <input
            type="number"
            min="0.01"
            max="5"
            step="0.01"
            value={draft.fallbackVolatility}
            onChange={(event) => onChange("fallbackVolatility", event.target.value)}
            placeholder="0.24"
          />
        </label>
        <label>
          <span>Preference rank</span>
          <input
            type="number"
            min="1"
            step="1"
            value={draft.preferenceRank}
            onChange={(event) => onChange("preferenceRank", event.target.value)}
          />
        </label>
        <label>
          <span>Settlement</span>
          <select value={draft.settlementType} onChange={(event) => onChange("settlementType", event.target.value)}>
            <option value="physical">Physical</option>
            <option value="cash">Cash</option>
          </select>
        </label>
        <label>
          <span>Exercise</span>
          <select value={draft.exerciseStyle} onChange={(event) => onChange("exerciseStyle", event.target.value)}>
            <option value="american">American</option>
            <option value="european">European</option>
          </select>
        </label>
      </div>

      <div className="strategy-settings__toggles">
        <label className="strategy-settings__toggle">
          <input
            type="checkbox"
            checked={draft.finderEnabled}
            onChange={(event) => onChange("finderEnabled", event.target.checked)}
          />
          <span>Enable in finder</span>
        </label>
        <label className="strategy-settings__toggle">
          <input
            type="checkbox"
            checked={draft.screenerEnabled}
            onChange={(event) => onChange("screenerEnabled", event.target.checked)}
          />
          <span>Enable in screener</span>
        </label>
      </div>

      <div className="strategy-settings__footer">
        <button type="button" className={`chart-toggle ${busy ? "chart-toggle--active" : ""}`} onClick={onSave} disabled={busy}>
          {busy ? "Saving..." : "Save mapping"}
        </button>
      </div>
    </article>
  );
}

export default function StrategySettingsMenu({
  assets = [],
  compareModes = ["price"],
  onSaveAsset = null,
  onDeleteAsset = null
}) {
  const [drafts, setDrafts] = useState({});
  const [newAssetDraft, setNewAssetDraft] = useState(() => buildEmptyDraft(compareModes));
  const [busyAssetId, setBusyAssetId] = useState("");
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    setDrafts(
      Object.fromEntries(assets.map((asset) => [asset.id, buildDraft(asset, compareModes)]))
    );
  }, [assets, compareModes]);

  useEffect(() => {
    setNewAssetDraft(buildEmptyDraft(compareModes));
  }, [compareModes]);

  function updateDraft(assetId, field, value) {
    setDrafts((current) => ({
      ...current,
      [assetId]: {
        ...(current[assetId] ?? buildDraft(assets.find((asset) => asset.id === assetId), compareModes)),
        [field]: value
      }
    }));
  }

  function resetDraft(assetId) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) {
      return;
    }

    setDrafts((current) => ({
      ...current,
      [assetId]: buildDraft(asset, compareModes)
    }));
  }

  async function handleSave(assetId) {
    const draft = drafts[assetId];
    if (!draft || !onSaveAsset) {
      return;
    }

    setBusyAssetId(assetId);
    setFeedback(null);
    try {
      await onSaveAsset(normalizeDraftForSave(draft));
      setFeedback({
        tone: "success",
        message: `Saved mapping for ${draft.label || draft.optionSymbol || assetId}.`
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error.message
      });
    } finally {
      setBusyAssetId("");
    }
  }

  async function handleDelete(assetId) {
    if (!onDeleteAsset) {
      return;
    }

    setBusyAssetId(assetId);
    setFeedback(null);
    try {
      await onDeleteAsset(assetId);
      setFeedback({
        tone: "success",
        message: `Removed custom mapping ${assetId}.`
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error.message
      });
    } finally {
      setBusyAssetId("");
    }
  }

  async function handleCreate() {
    if (!onSaveAsset) {
      return;
    }

    const normalizedDraft = normalizeDraftForSave({
      ...newAssetDraft,
      id: newAssetDraft.id || slugifyAssetId(newAssetDraft.optionSymbol || newAssetDraft.label)
    });

    if (!normalizedDraft.id || !normalizedDraft.label || !normalizedDraft.optionSymbol) {
      setFeedback({
        tone: "error",
        message: "A custom asset needs an id, label, and option ticker."
      });
      return;
    }

    setBusyAssetId(normalizedDraft.id);
    setFeedback(null);
    try {
      await onSaveAsset({
        ...normalizedDraft,
        isCustom: true
      });
      setFeedback({
        tone: "success",
        message: `Added custom asset ${normalizedDraft.label}.`
      });
      setNewAssetDraft(buildEmptyDraft(compareModes));
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error.message
      });
    } finally {
      setBusyAssetId("");
    }
  }

  return (
    <div className="strategy-settings">
      <p className="strategy-settings__intro">
        Map assets to exact Polymarket event pages or query terms, and add new tickers like TSLA for price-based screening.
      </p>

      {feedback ? (
        <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
          <span>{feedback.message}</span>
        </div>
      ) : null}

      <section className="strategy-settings__section">
        <div className="strategy-settings__section-head">
          <strong>Tracked assets</strong>
          <span>{assets.length}</span>
        </div>
        <div className="strategy-settings__stack">
          {assets.map((asset) => {
            const draft = drafts[asset.id] ?? buildDraft(asset, compareModes);
            return (
              <AssetCard
                key={asset.id}
                title={asset.label}
                draft={draft}
                busy={busyAssetId === asset.id}
                onChange={(field, value) => updateDraft(asset.id, field, value)}
                onReset={() => resetDraft(asset.id)}
                onSave={() => handleSave(asset.id)}
                onDelete={asset.isCustom ? () => handleDelete(asset.id) : null}
              />
            );
          })}
        </div>
      </section>

      <section className="strategy-settings__section">
        <div className="strategy-settings__section-head">
          <strong>Add custom asset</strong>
          <span>Manual mapping</span>
        </div>
        <AssetCard
          title="New asset"
          draft={newAssetDraft}
          busy={busyAssetId === (newAssetDraft.id || slugifyAssetId(newAssetDraft.optionSymbol || newAssetDraft.label))}
          onChange={(field, value) => setNewAssetDraft((current) => ({ ...current, [field]: value }))}
          onReset={() => setNewAssetDraft(buildEmptyDraft(compareModes))}
          onSave={handleCreate}
        />
      </section>
    </div>
  );
}
