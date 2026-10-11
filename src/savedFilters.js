const DEFAULT_FILTERS_VERSION = 1;

function canUseLocalStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

export function loadSavedFilters(storageKey) {
  if (!canUseLocalStorage()) {
    return null;
  }

  const rawValue = window.localStorage.getItem(storageKey);
  const parsed = safeJsonParse(rawValue);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (parsed.version === DEFAULT_FILTERS_VERSION && parsed.filters && typeof parsed.filters === "object") {
    return parsed.filters;
  }

  return null;
}

export function persistSavedFilters(storageKey, filters) {
  if (!canUseLocalStorage()) {
    return false;
  }

  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: DEFAULT_FILTERS_VERSION,
        savedAt: new Date().toISOString(),
        filters
      })
    );
    return true;
  } catch (_error) {
    return false;
  }
}

