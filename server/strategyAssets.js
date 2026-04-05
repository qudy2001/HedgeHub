import {
  quoteWatchlist,
  strategyAssetUniverse as baseStrategyAssetUniverse,
  strategyScreenerV2AssetUniverse as baseStrategyScreenerV2AssetUniverse
} from "./marketCatalog.js";
import { getPolymarketEventUrl } from "./providers/polymarket.js";

export const STRATEGY_COMPARE_MODES = ["price"];
const DEFAULT_QUOTE_GROUP = "Strategy Assets";
const WATCHLIST_BY_SYMBOL = new Map(
  quoteWatchlist.map((item) => [String(item.symbol ?? "").trim().toUpperCase(), item])
);

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source ?? {}, key);
}

function readOwn(source, key, fallback) {
  return hasOwn(source, key) ? source[key] : fallback;
}

function toOptionalNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeSymbol(value, fallback = "") {
  return String(value ?? fallback)
    .trim()
    .toUpperCase();
}

function normalizeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizePolymarketEventUrl(value, fallback = "") {
  const normalizedValue = String(value ?? fallback).trim();
  return normalizedValue.startsWith("https://polymarket.com/event/") ? normalizedValue : "";
}

function normalizeQueryList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : fallback;

  return [...new Set(
    source
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
  )];
}

function normalizeCompareMode(value, fallback = "price") {
  return STRATEGY_COMPARE_MODES.includes(value) ? value : fallback;
}

function deriveDefaultQuoteProvider(symbol, fallback = "stooq") {
  const watchlistItem = WATCHLIST_BY_SYMBOL.get(String(symbol ?? "").trim().toUpperCase());
  return watchlistItem?.provider ?? fallback;
}

function deriveDefaultQuoteSourceSymbol(symbol, provider = "stooq") {
  const normalizedSymbol = String(symbol ?? "").trim();
  const watchlistItem = WATCHLIST_BY_SYMBOL.get(normalizedSymbol.toUpperCase());
  if (watchlistItem?.sourceSymbol) {
    return watchlistItem.sourceSymbol;
  }

  if (!normalizedSymbol) {
    return "";
  }

  if (provider === "coingecko") {
    return normalizedSymbol.toLowerCase().replace(/-usd$/i, "");
  }

  if (normalizedSymbol.startsWith("^") || normalizedSymbol.includes(".")) {
    return normalizedSymbol.toLowerCase();
  }

  return `${normalizedSymbol.toLowerCase()}.us`;
}

function buildBaseSettingsSignature(asset = {}) {
  return [
    normalizeSymbol(asset.optionSymbol),
    normalizeSymbol(asset.underlyingSymbol),
    normalizeText(asset.referenceSymbol).toUpperCase()
  ].join("|");
}

function buildBaseSettingsAsset(asset, existing = {}, { finderEnabled = false, screenerEnabled = false } = {}) {
  const optionWatch = WATCHLIST_BY_SYMBOL.get(String(asset.optionSymbol ?? "").trim().toUpperCase());
  const underlyingWatch = WATCHLIST_BY_SYMBOL.get(String(asset.underlyingSymbol ?? "").trim().toUpperCase());
  const optionQuoteProvider =
    existing.optionQuoteProvider ?? optionWatch?.provider ?? deriveDefaultQuoteProvider(asset.optionSymbol);
  const underlyingQuoteProvider =
    existing.underlyingQuoteProvider ??
    underlyingWatch?.provider ??
    (String(asset.underlyingSymbol ?? "").trim() === String(asset.optionSymbol ?? "").trim()
      ? optionQuoteProvider
      : deriveDefaultQuoteProvider(asset.underlyingSymbol));

  return {
    id: existing.id || asset.id,
    label: existing.label || asset.label,
    optionSymbol: existing.optionSymbol || asset.optionSymbol,
    underlyingSymbol: existing.underlyingSymbol || asset.underlyingSymbol,
    referenceSymbol: existing.referenceSymbol || asset.referenceSymbol,
    conversionFallback:
      toOptionalNumber(existing.conversionFallback, null) ??
      toOptionalNumber(asset.conversionFallback, null) ??
      1,
    polymarketQueries:
      existing.polymarketQueries && existing.polymarketQueries.length > 0
        ? existing.polymarketQueries
        : normalizeQueryList(asset.polymarketQueries),
    polymarketEventUrl: existing.polymarketEventUrl || "",
    compareMode: existing.compareMode ?? "price",
    fallbackVolatility: existing.fallbackVolatility ?? null,
    optionQuoteProvider,
    optionQuoteSourceSymbol:
      existing.optionQuoteSourceSymbol ??
      optionWatch?.sourceSymbol ??
      deriveDefaultQuoteSourceSymbol(asset.optionSymbol, optionQuoteProvider),
    underlyingQuoteProvider,
    underlyingQuoteSourceSymbol:
      existing.underlyingQuoteSourceSymbol ??
      underlyingWatch?.sourceSymbol ??
      (String(asset.underlyingSymbol ?? "").trim() === String(asset.optionSymbol ?? "").trim()
        ? optionWatch?.sourceSymbol ?? deriveDefaultQuoteSourceSymbol(asset.optionSymbol, optionQuoteProvider)
        : ""),
    quoteGroup: existing.quoteGroup ?? optionWatch?.group ?? underlyingWatch?.group ?? DEFAULT_QUOTE_GROUP,
    finderEnabled: existing.finderEnabled === true || finderEnabled,
    screenerEnabled: existing.screenerEnabled === true || screenerEnabled,
    settlementType: existing.settlementType ?? asset.settlementType ?? "physical",
    exerciseStyle: existing.exerciseStyle ?? asset.exerciseStyle ?? "american",
    preferenceRank:
      Math.max(
        Math.round(toOptionalNumber(existing.preferenceRank, asset.preferenceRank ?? 2) ?? asset.preferenceRank ?? 2),
        1
      ) || 2,
    isCustom: false
  };
}

function buildBaseSettingsCatalog() {
  const settingsAssetsById = new Map();
  const settingsIdByAssetId = new Map();
  const assetVariantsBySettingsId = new Map();
  const signatureToSettingsId = new Map();

  function registerAssetVariant(asset, channel) {
    const signature = buildBaseSettingsSignature(asset);
    const settingsId = signatureToSettingsId.get(signature) ?? asset.id;
    const existing = settingsAssetsById.get(settingsId) ?? {};

    if (!signatureToSettingsId.has(signature)) {
      signatureToSettingsId.set(signature, settingsId);
    }

    settingsAssetsById.set(
      settingsId,
      buildBaseSettingsAsset(asset, existing, {
        finderEnabled: channel === "finder",
        screenerEnabled: channel === "screener"
      })
    );
    settingsIdByAssetId.set(asset.id, settingsId);

    const currentVariants = assetVariantsBySettingsId.get(settingsId) ?? [];
    if (!currentVariants.some((variant) => variant.id === asset.id && variant.channel === channel)) {
      currentVariants.push({
        id: asset.id,
        channel
      });
    }
    assetVariantsBySettingsId.set(settingsId, currentVariants);
  }

  baseStrategyAssetUniverse.forEach((asset) => {
    registerAssetVariant(asset, "finder");
  });

  baseStrategyScreenerV2AssetUniverse.forEach((asset) => {
    registerAssetVariant(asset, "screener");
  });

  return {
    settingsAssetsById,
    settingsIdByAssetId,
    assetVariantsBySettingsId
  };
}

export function resolveStrategySettingsAssetId(assetId = "") {
  const normalizedAssetId = normalizeText(assetId);
  if (!normalizedAssetId) {
    return "";
  }

  const { settingsIdByAssetId } = buildBaseSettingsCatalog();
  return settingsIdByAssetId.get(normalizedAssetId) ?? normalizedAssetId;
}

export function normalizeStrategyAssetMapping(rawAsset = {}, defaults = {}) {
  const optionSymbol = normalizeSymbol(readOwn(rawAsset, "optionSymbol", defaults.optionSymbol));
  const underlyingSymbol = normalizeSymbol(
    readOwn(rawAsset, "underlyingSymbol", defaults.underlyingSymbol ?? optionSymbol)
  ) || optionSymbol;
  const optionQuoteProvider =
    normalizeText(readOwn(rawAsset, "optionQuoteProvider", defaults.optionQuoteProvider)).toLowerCase() === "coingecko"
      ? "coingecko"
      : "stooq";
  const underlyingQuoteProvider =
    normalizeText(readOwn(rawAsset, "underlyingQuoteProvider", defaults.underlyingQuoteProvider)).toLowerCase() ===
    "coingecko"
      ? "coingecko"
      : optionQuoteProvider;
  const label = normalizeText(readOwn(rawAsset, "label", defaults.label ?? optionSymbol));
  const id = normalizeText(
    readOwn(rawAsset, "id", defaults.id ?? optionSymbol.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
  );

  return {
    id,
    label: label || optionSymbol || defaults.label || "Asset",
    optionSymbol,
    underlyingSymbol,
    referenceSymbol: normalizeText(readOwn(rawAsset, "referenceSymbol", defaults.referenceSymbol)),
    conversionFallback: toOptionalNumber(
      readOwn(rawAsset, "conversionFallback", defaults.conversionFallback),
      1
    ) ?? 1,
    fallbackVolatility: toOptionalNumber(
      readOwn(rawAsset, "fallbackVolatility", defaults.fallbackVolatility),
      null
    ),
    polymarketQueries: normalizeQueryList(
      readOwn(rawAsset, "polymarketQueries", defaults.polymarketQueries),
      defaults.polymarketQueries ?? []
    ),
    polymarketEventUrl: normalizePolymarketEventUrl(
      readOwn(rawAsset, "polymarketEventUrl", defaults.polymarketEventUrl),
      defaults.polymarketEventUrl ?? ""
    ),
    compareMode: normalizeCompareMode(
      readOwn(rawAsset, "compareMode", defaults.compareMode),
      defaults.compareMode ?? "price"
    ),
    optionQuoteProvider,
    optionQuoteSourceSymbol: normalizeText(
      readOwn(
        rawAsset,
        "optionQuoteSourceSymbol",
        defaults.optionQuoteSourceSymbol ?? deriveDefaultQuoteSourceSymbol(optionSymbol, optionQuoteProvider)
      )
    ),
    underlyingQuoteProvider,
    underlyingQuoteSourceSymbol: normalizeText(
      readOwn(
        rawAsset,
        "underlyingQuoteSourceSymbol",
        defaults.underlyingQuoteSourceSymbol ??
          (underlyingSymbol === optionSymbol
            ? deriveDefaultQuoteSourceSymbol(optionSymbol, optionQuoteProvider)
            : "")
      )
    ),
    quoteGroup: normalizeText(readOwn(rawAsset, "quoteGroup", defaults.quoteGroup ?? DEFAULT_QUOTE_GROUP)),
    finderEnabled: normalizeBoolean(
      readOwn(rawAsset, "finderEnabled", defaults.finderEnabled),
      defaults.finderEnabled ?? true
    ),
    screenerEnabled: normalizeBoolean(
      readOwn(rawAsset, "screenerEnabled", defaults.screenerEnabled),
      defaults.screenerEnabled ?? true
    ),
    settlementType:
      normalizeText(readOwn(rawAsset, "settlementType", defaults.settlementType)).toLowerCase() === "cash"
        ? "cash"
        : "physical",
    exerciseStyle:
      normalizeText(readOwn(rawAsset, "exerciseStyle", defaults.exerciseStyle)).toLowerCase() === "european"
        ? "european"
        : "american",
    preferenceRank: Math.max(
      Math.round(
        toOptionalNumber(readOwn(rawAsset, "preferenceRank", defaults.preferenceRank), defaults.preferenceRank ?? 2)
      ) || 2,
      1
    ),
    isCustom: normalizeBoolean(readOwn(rawAsset, "isCustom", defaults.isCustom), defaults.isCustom ?? true)
  };
}

function toFinderAsset(asset, runtimeId = asset.id) {
  return {
    id: runtimeId,
    label: asset.label,
    optionSymbol: asset.optionSymbol,
    underlyingSymbol: asset.underlyingSymbol,
    referenceSymbol: asset.referenceSymbol,
    conversionFallback: asset.conversionFallback,
    fallbackVolatility: asset.fallbackVolatility,
    polymarketQueries: asset.polymarketQueries,
    polymarketEventUrl: asset.polymarketEventUrl,
    compareMode: asset.compareMode
  };
}

function toScreenerAsset(asset, runtimeId = asset.id) {
  return {
    ...toFinderAsset(asset, runtimeId),
    settlementType: asset.settlementType,
    exerciseStyle: asset.exerciseStyle,
    preferenceRank: asset.preferenceRank
  };
}

export function buildEffectiveStrategyAssets(mappingRecords = []) {
  const { settingsAssetsById, settingsIdByAssetId, assetVariantsBySettingsId } = buildBaseSettingsCatalog();
  const orderedMappingRecords = [...mappingRecords].sort((left, right) => {
    return String(left?.updatedAt ?? left?.createdAt ?? "").localeCompare(String(right?.updatedAt ?? right?.createdAt ?? ""));
  });

  for (const mappingRecord of orderedMappingRecords) {
    const normalizedRecordId = normalizeText(mappingRecord?.id);
    const settingsId = settingsIdByAssetId.get(normalizedRecordId) ?? normalizedRecordId;
    const existing = settingsAssetsById.get(settingsId) ?? {};
    const normalized = normalizeStrategyAssetMapping(
      {
        ...(mappingRecord ?? {}),
        id: settingsId
      },
      {
        ...existing,
        id: settingsId || existing.id,
        isCustom: !existing.id
      }
    );
    settingsAssetsById.set(settingsId, normalized);
  }

  const settingsAssets = [...settingsAssetsById.values()]
    .filter((asset) => asset.id && asset.optionSymbol)
    .sort((left, right) => {
      if (left.isCustom !== right.isCustom) {
        return left.isCustom ? 1 : -1;
      }

      return left.label.localeCompare(right.label);
    });

  return {
    settingsAssets,
    finderAssets: settingsAssets.flatMap((asset) => {
      if (!asset.finderEnabled) {
        return [];
      }

      const variants = assetVariantsBySettingsId.get(asset.id)?.filter((variant) => variant.channel === "finder") ?? [];
      if (variants.length === 0) {
        return [toFinderAsset(asset)];
      }

      return variants.map((variant) => toFinderAsset(asset, variant.id));
    }),
    screenerAssets: settingsAssets.flatMap((asset) => {
      if (!asset.screenerEnabled) {
        return [];
      }

      const variants = assetVariantsBySettingsId.get(asset.id)?.filter((variant) => variant.channel === "screener") ?? [];
      if (variants.length === 0) {
        return [toScreenerAsset(asset)];
      }

      return variants.map((variant) => toScreenerAsset(asset, variant.id));
    })
  };
}

function pushWatchlistItem(items, seenSymbols, symbol, provider, sourceSymbol, label, group) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol || !provider || !sourceSymbol || seenSymbols.has(normalizedSymbol)) {
    return;
  }

  seenSymbols.add(normalizedSymbol);
  items.push({
    symbol: normalizedSymbol,
    sourceSymbol,
    label: label || normalizedSymbol,
    group: group || DEFAULT_QUOTE_GROUP,
    provider
  });
}

export function buildStrategyQuoteWatchlist(settingsAssets = []) {
  const items = [...quoteWatchlist];
  const seenSymbols = new Set(items.map((item) => normalizeSymbol(item.symbol)));

  settingsAssets
    .filter((asset) => asset.finderEnabled || asset.screenerEnabled)
    .forEach((asset) => {
      pushWatchlistItem(
        items,
        seenSymbols,
        asset.optionSymbol,
        asset.optionQuoteProvider,
        asset.optionQuoteSourceSymbol,
        asset.label,
        asset.quoteGroup
      );
      pushWatchlistItem(
        items,
        seenSymbols,
        asset.underlyingSymbol,
        asset.underlyingQuoteProvider,
        asset.underlyingQuoteSourceSymbol,
        `${asset.label} underlying`,
        asset.quoteGroup
      );
    });

  return items;
}

export function collectStrategyPolymarketQueries(assets = []) {
  return [...new Set(
    assets.flatMap((asset) =>
      normalizePolymarketEventUrl(asset?.polymarketEventUrl)
        ? []
        : normalizeQueryList(asset.polymarketQueries)
    )
  )];
}

export function collectStrategyPolymarketEventUrls(assets = []) {
  return [...new Set(
    assets
      .map((asset) => normalizePolymarketEventUrl(asset.polymarketEventUrl))
      .filter(Boolean)
  )];
}

export function strategyAssetMatchesMarket(asset, market) {
  const eventUrl = normalizePolymarketEventUrl(asset?.polymarketEventUrl);
  const marketEventUrl = normalizePolymarketEventUrl(getPolymarketEventUrl(market));
  if (eventUrl) {
    return Boolean(marketEventUrl) && eventUrl === marketEventUrl;
  }

  const question = String(market?.question ?? "").toLowerCase();
  return normalizeQueryList(asset?.polymarketQueries).some((query) =>
    question.includes(String(query).toLowerCase().split(" ")[0])
  );
}
