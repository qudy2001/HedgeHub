import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AuthScreen from "./components/AuthScreen.jsx";
import CompanyEventsPanel from "./components/CompanyEventsPanel.jsx";
import EconomicCalendarPanel from "./components/EconomicCalendarPanel.jsx";
import StrategyRail from "./components/StrategyRail.jsx";
import TradingViewWidget from "./components/TradingViewWidget.jsx";
import { createMarketTimerContext } from "./marketTimers.js";
import { getInitialTheme, THEME_STORAGE_KEY } from "./theme.js";

const AdminUsersWorkspace = lazy(() => import("./components/AdminUsersWorkspace.jsx"));
const DeltaHedgeScannerWorkspace = lazy(() => import("./components/DeltaHedgeScannerWorkspace.jsx"));
const IbkrOrderManagementWorkspace = lazy(() => import("./components/IbkrOrderManagementWorkspace.jsx"));
const MacroHeatmapDashboard = lazy(() => import("./components/MacroHeatmapDashboard.jsx"));
const PaperTradingWorkspace = lazy(() => import("./components/PaperTradingWorkspace.jsx"));
const CoveredIncomeScannerWorkspace = lazy(() => import("./components/CoveredIncomeScannerWorkspace.jsx"));
const StrategyFinderWorkspace = lazy(() => import("./components/StrategyFinderWorkspace.jsx"));
const StrategySettingsWorkspace = lazy(() => import("./components/StrategySettingsWorkspace.jsx"));
const StrategyWatchlistWorkspace = lazy(() => import("./components/StrategyWatchlistWorkspace.jsx"));
const StrategyScreeningWorkspace = lazy(() => import("./components/StrategyScreeningWorkspace.jsx"));
const TradingViewStrategyWorkspace = lazy(() => import("./components/TradingViewStrategyWorkspace.jsx"));
const VolCrushEarningsWorkspace = lazy(() => import("./components/VolCrushEarningsWorkspace.jsx"));

function readRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  const strategyMatch = pathname.match(/^\/strategies\/([^/]+)$/);

  if (pathname === "/paper-trading") {
    return {
      activeView: "paper",
      selectedStrategyId: "strategy-1"
    };
  }

  if (pathname === "/order-management") {
    return {
      activeView: "orders",
      selectedStrategyId: "strategy-1"
    };
  }

  if (pathname === "/screening") {
    return {
      activeView: "screening",
      selectedStrategyId: "strategy-1"
    };
  }

  if (pathname === "/watchlist") {
    return {
      activeView: "watchlist",
      selectedStrategyId: "strategy-1"
    };
  }

  if (pathname === "/strategy-settings") {
    return {
      activeView: "settings",
      selectedStrategyId: "strategy-1"
    };
  }

  if (pathname === "/admin/users") {
    return {
      activeView: "admin-users",
      selectedStrategyId: "strategy-1"
    };
  }

  if (strategyMatch) {
    return {
      activeView: "strategy",
      selectedStrategyId: decodeURIComponent(strategyMatch[1])
    };
  }

  return {
    activeView: "dashboard",
    selectedStrategyId: "strategy-1"
  };
}

function buildPath(activeView, strategyId) {
  if (activeView === "paper") {
    return "/paper-trading";
  }

  if (activeView === "orders") {
    return "/order-management";
  }

  if (activeView === "screening") {
    return "/screening";
  }

  if (activeView === "watchlist") {
    return "/watchlist";
  }

  if (activeView === "settings") {
    return "/strategy-settings";
  }

  if (activeView === "admin-users") {
    return "/admin/users";
  }

  if (activeView === "strategy" && strategyId) {
    return `/strategies/${encodeURIComponent(strategyId)}`;
  }

  return "/";
}

function isTimestampStale(timestamp, maxAgeMs) {
  if (!timestamp) {
    return true;
  }

  const parsedTimestamp = new Date(timestamp).getTime();
  if (Number.isNaN(parsedTimestamp)) {
    return true;
  }

  return Date.now() - parsedTimestamp > maxAgeMs;
}

const ROUTE_REFRESH_STALE_MS = 6 * 60 * 1000;
const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 1920px)";
const DESKTOP_SIDEBAR_STORAGE_KEY = "hedgehub.desktopSidebarVisible";

function matchesMobileSidebarViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches;
}

function readDesktopSidebarPreference() {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    const storedValue = window.localStorage.getItem(DESKTOP_SIDEBAR_STORAGE_KEY);
    if (storedValue === null) {
      return true;
    }

    return storedValue !== "false";
  } catch (_error) {
    return true;
  }
}

function buildPaperPortfolioPreview(paperPortfolio) {
  if (!paperPortfolio) {
    return null;
  }

  return {
    summary: paperPortfolio.summary ?? null,
    brokerStatus: paperPortfolio.brokerStatus ?? null
  };
}

function buildFallbackMarketTimerContext(strategyPayload) {
  const preferredFinderRow =
    strategyPayload?.primaryStrategy?.finder?.rows?.find(
      (row) => row?.assetLabel && (row?.optionExpiry || row?.marketContext?.proxySymbol)
    ) ?? null;

  if (preferredFinderRow) {
    return createMarketTimerContext({
      source: "fallback-finder",
      label: preferredFinderRow.assetLabel,
      optionSymbol: preferredFinderRow.marketContext?.proxySymbol ?? "",
      underlyingSymbol: preferredFinderRow.marketContext?.underlyingSymbol ?? "",
      referenceSymbol: preferredFinderRow.optionReference ?? "",
      optionExpiries: [preferredFinderRow.optionExpiry]
    });
  }

  const preferredAsset =
    strategyPayload?.strategySettings?.assets?.find((asset) => asset?.label && asset?.optionSymbol) ?? null;

  if (preferredAsset) {
    return createMarketTimerContext({
      source: "fallback-settings",
      label: preferredAsset.label,
      optionSymbol: preferredAsset.optionSymbol,
      underlyingSymbol: preferredAsset.underlyingSymbol,
      referenceSymbol: preferredAsset.referenceSymbol
    });
  }

  return null;
}

function WorkspaceLoadingFallback() {
  return (
    <main className="workspace">
      <div className="app-state app-state--inline">Loading workspace…</div>
    </main>
  );
}

export default function App() {
  const initialRoute = readRoute();
  const [theme, setTheme] = useState(() => getInitialTheme());
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authNeedsBootstrap, setAuthNeedsBootstrap] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [isMobileViewport, setIsMobileViewport] = useState(() => matchesMobileSidebarViewport());
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !matchesMobileSidebarViewport());
  const [isDesktopSidebarVisible, setIsDesktopSidebarVisible] = useState(() => readDesktopSidebarPreference());
  const [dashboard, setDashboard] = useState(null);
  const [streamDiagnostics, setStreamDiagnostics] = useState(null);
  const [marketStatusPayload, setMarketStatusPayload] = useState(null);
  const [strategyPayload, setStrategyPayload] = useState(null);
  const [paperPortfolioPreview, setPaperPortfolioPreview] = useState(null);
  const [paperPortfolio, setPaperPortfolio] = useState(null);
  const [paperPortfolioLastUpdated, setPaperPortfolioLastUpdated] = useState(null);
  const [activeView, setActiveView] = useState(initialRoute.activeView);
  const [selectedStrategyId, setSelectedStrategyId] = useState(initialRoute.selectedStrategyId);
  const [finderAutoOpenRowId, setFinderAutoOpenRowId] = useState("");
  const [marketTimerContext, setMarketTimerContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState(null);
  const [error, setError] = useState("");
  const strategyRefreshKeyRef = useRef(null);

  const resetApplicationState = useCallback(() => {
    setDashboard(null);
    setStreamDiagnostics(null);
    setMarketStatusPayload(null);
    setStrategyPayload(null);
    setPaperPortfolioPreview(null);
    setPaperPortfolio(null);
    setPaperPortfolioLastUpdated(null);
    setRefreshNotice(null);
    setFinderAutoOpenRowId("");
    setError("");
    setLoading(true);
    strategyRefreshKeyRef.current = null;
  }, []);

  const applyAppState = useCallback((dashboardJson, strategyJson) => {
    setDashboard(dashboardJson);
    setStreamDiagnostics(dashboardJson?.streamDiagnostics ?? null);
    setStrategyPayload(strategyJson);
    setPaperPortfolioPreview(strategyJson.paperPortfolioPreview ?? null);
    setSelectedStrategyId((current) => current || strategyJson.strategies[0]?.id || "strategy-1");
    setError("");
  }, []);

  const loadAuthConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/config");
      const payload = await response.json().catch(() => null);
      setAuthNeedsBootstrap(payload?.needsBootstrap === true);
      return payload;
    } catch (_error) {
      setAuthNeedsBootstrap(false);
      return null;
    }
  }, []);

  const handleAuthRequired = useCallback(
    (message = "Authentication required") => {
      setAuthUser(null);
      setAuthError(message);
      resetApplicationState();
      void loadAuthConfig();
    },
    [loadAuthConfig, resetApplicationState]
  );

  const handleLogin = useCallback(
    async (username, password) => {
      setAuthBusy(true);
      setAuthError("");

      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            username,
            password
          })
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Login failed (${response.status})`);
        }

        setAuthUser(payload?.user ?? null);
        setAuthNeedsBootstrap(false);
        resetApplicationState();
      } catch (error) {
        setAuthError(error.message);
      } finally {
        setAuthBusy(false);
      }
    },
    [resetApplicationState]
  );

  const handleBootstrap = useCallback(
    async (username, password) => {
      setAuthBusy(true);
      setAuthError("");

      try {
        const response = await fetch("/api/auth/bootstrap", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            username,
            password
          })
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Bootstrap failed (${response.status})`);
        }

        setAuthUser(payload?.user ?? null);
        setAuthNeedsBootstrap(false);
        resetApplicationState();
      } catch (error) {
        setAuthError(error.message);
      } finally {
        setAuthBusy(false);
      }
    },
    [resetApplicationState]
  );

  const handleLogout = useCallback(async () => {
    setAuthBusy(true);
    setAuthError("");

    try {
      await fetch("/api/auth/logout", {
        method: "POST"
      });
    } catch (_error) {
      // ignore
    } finally {
      setAuthUser(null);
      resetApplicationState();
      await loadAuthConfig();
      setAuthBusy(false);
    }
  }, [loadAuthConfig, resetApplicationState]);

  useEffect(() => {
    let isActive = true;

    async function loadAuth() {
      setAuthError("");

      try {
        const response = await fetch("/api/auth/me");
        const payload = await response.json().catch(() => null);

        if (!isActive) {
          return;
        }

        if (response.ok) {
          setAuthUser(payload?.user ?? null);
          setAuthNeedsBootstrap(false);
          return;
        }

        if (response.status === 401) {
          setAuthUser(null);
          await loadAuthConfig();
          return;
        }

        setAuthUser(null);
        setAuthError(payload?.error || `Authentication check failed (${response.status})`);
        await loadAuthConfig();
      } catch (error) {
        if (isActive) {
          setAuthUser(null);
          setAuthError(error.message);
          await loadAuthConfig();
        }
      } finally {
        if (isActive) {
          setAuthReady(true);
        }
      }
    }

    void loadAuth();

    return () => {
      isActive = false;
    };
  }, [loadAuthConfig]);

  const fetchAppState = useCallback(async () => {
    const [dashboardResponse, strategyResponse] = await Promise.all([
      fetch("/api/dashboard"),
      fetch("/api/strategies")
    ]);

    if (dashboardResponse.status === 401 || strategyResponse.status === 401) {
      handleAuthRequired("Session expired");
      const error = new Error("Authentication required");
      error.code = "AUTH_REQUIRED";
      throw error;
    }

    if (!dashboardResponse.ok || !strategyResponse.ok) {
      throw new Error("Failed to load dashboard state");
    }

    const [dashboardJson, strategyJson] = await Promise.all([
      dashboardResponse.json(),
      strategyResponse.json()
    ]);

    return { dashboardJson, strategyJson };
  }, [handleAuthRequired]);

  const syncAppState = useCallback(async () => {
    const { dashboardJson, strategyJson } = await fetchAppState();
    applyAppState(dashboardJson, strategyJson);
    return { dashboardJson, strategyJson };
  }, [applyAppState, fetchAppState]);

  const applyPaperPortfolioUpdate = useCallback((nextPaperPortfolio, lastUpdated = null) => {
    setPaperPortfolio(nextPaperPortfolio ?? null);
    setPaperPortfolioPreview(buildPaperPortfolioPreview(nextPaperPortfolio));
    setPaperPortfolioLastUpdated(lastUpdated ?? new Date().toISOString());
  }, []);

  const fetchPaperPortfolio = useCallback(async () => {
    const response = await fetch("/api/paper-portfolio");
    const payload = await response.json().catch(() => null);

    if (response.status === 401) {
      handleAuthRequired("Session expired");
      const error = new Error("Authentication required");
      error.code = "AUTH_REQUIRED";
      throw error;
    }

    if (!response.ok) {
      throw new Error(payload?.error || "Failed to load paper portfolio");
    }

    applyPaperPortfolioUpdate(payload?.paperPortfolio ?? null, payload?.lastUpdated ?? null);
    return payload;
  }, [applyPaperPortfolioUpdate, handleAuthRequired]);

  const navigateTo = useCallback((nextView, strategyId = selectedStrategyId) => {
    setActiveView(nextView);
    if (strategyId) {
      setSelectedStrategyId(strategyId);
    }

    if (isMobileViewport) {
      setIsSidebarOpen(false);
    }

    const nextPath = buildPath(nextView, strategyId);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ activeView: nextView, strategyId }, "", nextPath);
    }
  }, [isMobileViewport, selectedStrategyId]);

  const handleOpenFinderRowFromWatchlist = useCallback((rowId) => {
    const normalizedRowId = String(rowId ?? "").trim();
    if (!normalizedRowId) {
      return;
    }

    setFinderAutoOpenRowId(normalizedRowId);
    navigateTo("strategy", "strategy-1");
  }, [navigateTo]);

  const runStrategyRefresh = useCallback(async ({ announceStart = true } = {}) => {
    setRefreshing(true);
    if (announceStart) {
      setRefreshNotice({
        tone: "info",
        message: "Refreshing live strategy data..."
      });
    }

    try {
      const refreshResponse = await fetch("/api/refresh", {
        method: "POST"
      });

      const refreshPayload = await refreshResponse.json().catch(() => null);

      if (refreshResponse.status === 401) {
        handleAuthRequired("Session expired");
        const error = new Error("Authentication required");
        error.code = "AUTH_REQUIRED";
        throw error;
      }

      if (!refreshResponse.ok) {
        throw new Error(refreshPayload?.error || "Manual refresh failed");
      }

      const { dashboardJson, strategyJson } = await syncAppState();
      const warnings = [
        ...(refreshPayload?.warnings ?? []),
        ...(dashboardJson?.warnings ?? []),
        ...(strategyJson?.warnings ?? [])
      ].filter(Boolean);

      if (announceStart || warnings.length) {
        setRefreshNotice({
          tone: warnings.length ? "warning" : "success",
          message: warnings.length
            ? `Refresh complete with warnings: ${warnings.join(" | ")}`
            : `Refresh complete at ${new Date(
                refreshPayload?.lastUpdated ?? strategyJson?.lastUpdated ?? new Date().toISOString()
              ).toLocaleString("en-GB")}`
        });
      }
    } catch (refreshError) {
      if (String(refreshError?.code ?? "") !== "AUTH_REQUIRED") {
        setRefreshNotice({
          tone: "error",
          message: refreshError.message
        });
      }
    } finally {
      setRefreshing(false);
    }
  }, [handleAuthRequired, syncAppState]);

  const handleManualRefresh = useCallback(() => {
    return runStrategyRefresh({ announceStart: true });
  }, [runStrategyRefresh]);

  const mutatePaperOrders = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });
    let payload = null;
    let rawBody = "";

    try {
      rawBody = await response.text();
    } catch (_error) {
      rawBody = "";
    }

    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch (_error) {
        payload = null;
      }
    }

    if (response.status === 401) {
      handleAuthRequired("Session expired");
      const error = new Error("Authentication required");
      error.code = "AUTH_REQUIRED";
      throw error;
    }

    if (!response.ok) {
      if (payload?.paperPortfolio) {
        applyPaperPortfolioUpdate(payload.paperPortfolio, new Date().toISOString());
      }
      const errorMessage =
        payload?.error ||
        payload?.message ||
        (rawBody && typeof rawBody === "string" ? rawBody.trim() : "") ||
        `Paper-trading request failed (${response.status})`;
      throw new Error(errorMessage);
    }

    if (payload?.paperPortfolio) {
      applyPaperPortfolioUpdate(payload.paperPortfolio, new Date().toISOString());
    } else {
      await syncAppState();
    }

    return payload;
  }, [applyPaperPortfolioUpdate, handleAuthRequired, syncAppState]);

  const handleCreatePaperOrder = useCallback((orderPayload) => {
    return mutatePaperOrders("/api/paper-orders", {
      method: "POST",
      body: JSON.stringify(orderPayload)
    });
  }, [mutatePaperOrders]);

  const handleUpdatePaperOrder = useCallback((orderId, patch) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }, [mutatePaperOrders]);

  const handleDeletePaperOrder = useCallback((orderId) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}`, {
      method: "DELETE"
    });
  }, [mutatePaperOrders]);

  const handleClosePaperOrder = useCallback((orderId, patch) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/close`, {
      method: "POST",
      body: JSON.stringify(patch ?? {})
    });
  }, [mutatePaperOrders]);

  const handleClosePaperOrderLeg = useCallback((orderId, legId, payload) => {
    return mutatePaperOrders(
      `/api/paper-orders/${encodeURIComponent(orderId)}/legs/${encodeURIComponent(legId)}/close`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {})
      }
    );
  }, [mutatePaperOrders]);

  const handleRevivePaperOrderLeg = useCallback((orderId, legId, payload) => {
    return mutatePaperOrders(
      `/api/paper-orders/${encodeURIComponent(orderId)}/legs/${encodeURIComponent(legId)}/revive`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {})
      }
    );
  }, [mutatePaperOrders]);

  const handleAddPaperHedge = useCallback((orderId, payload = {}) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/hedge`, {
      method: "POST",
      body: JSON.stringify(payload ?? {})
    });
  }, [mutatePaperOrders]);

  const handleSaveCalculatorSnapshot = useCallback((orderId, snapshotPayload) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/calculator-snapshots`, {
      method: "POST",
      body: JSON.stringify(snapshotPayload)
    });
  }, [mutatePaperOrders]);

  const handleExecutePaperOrder = useCallback((orderId, payload = {}) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/execute`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }, [mutatePaperOrders]);

  const handleConfirmPaperExecution = useCallback((orderId, payload = {}) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/confirm-execution`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }, [mutatePaperOrders]);

  const handleSyncPaperExecution = useCallback((orderId) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/sync-execution`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }, [mutatePaperOrders]);

  const handleCancelPaperExecution = useCallback((orderId) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/cancel-execution`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }, [mutatePaperOrders]);

  const mutateStrategyAssets = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || "Strategy settings request failed");
    }

    await syncAppState();
    return payload;
  }, [syncAppState]);

  const applyStrategyWatchlistUpdate = useCallback((watchlist) => {
    setStrategyPayload((currentPayload) =>
      currentPayload
        ? {
            ...currentPayload,
            strategyWatchlist: Array.isArray(watchlist) ? watchlist : []
          }
        : currentPayload
    );
  }, []);

  const mutateStrategyWatchlist = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || "Watchlist request failed");
    }

    if (payload?.watchlist) {
      applyStrategyWatchlistUpdate(payload.watchlist);
    } else {
      await syncAppState();
    }

    return payload;
  }, [applyStrategyWatchlistUpdate, syncAppState]);

  const handleAddStrategyToWatchlist = useCallback((strategyId) => {
    return mutateStrategyWatchlist("/api/strategy-watchlist", {
      method: "POST",
      body: JSON.stringify({
        strategyId
      })
    });
  }, [mutateStrategyWatchlist]);

  const handleRemoveStrategyFromWatchlist = useCallback((strategyId) => {
    return mutateStrategyWatchlist(`/api/strategy-watchlist/${encodeURIComponent(strategyId)}`, {
      method: "DELETE"
    });
  }, [mutateStrategyWatchlist]);

  const applySetupWatchlistUpdate = useCallback((watchlist) => {
    setStrategyPayload((currentPayload) =>
      currentPayload
        ? {
            ...currentPayload,
            setupWatchlist: Array.isArray(watchlist) ? watchlist : []
          }
        : currentPayload
    );
  }, []);

  const mutateSetupWatchlist = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || "Setup watchlist request failed");
    }

    if (payload?.watchlist) {
      applySetupWatchlistUpdate(payload.watchlist);
    } else {
      await syncAppState();
    }

    return payload;
  }, [applySetupWatchlistUpdate, syncAppState]);

  const handleUpsertSetupWatchlistItem = useCallback((item) => {
    return mutateSetupWatchlist("/api/setup-watchlist", {
      method: "POST",
      body: JSON.stringify(item ?? {})
    });
  }, [mutateSetupWatchlist]);

  const handleDeleteSetupWatchlistItem = useCallback((id) => {
    return mutateSetupWatchlist(`/api/setup-watchlist/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  }, [mutateSetupWatchlist]);

  const handleSaveStrategyAssetMapping = useCallback((assetConfig) => {
    return mutateStrategyAssets(`/api/strategy-assets/${encodeURIComponent(assetConfig.id)}`, {
      method: "PUT",
      body: JSON.stringify(assetConfig)
    });
  }, [mutateStrategyAssets]);

  const handleDeleteStrategyAssetMapping = useCallback((assetId) => {
    return mutateStrategyAssets(`/api/strategy-assets/${encodeURIComponent(assetId)}`, {
      method: "DELETE"
    });
  }, [mutateStrategyAssets]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (_error) {
      // Ignore storage failures and keep the theme in memory.
    }

    return () => {
      if (root.dataset.theme === theme) {
        delete root.dataset.theme;
      }
    };
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DESKTOP_SIDEBAR_STORAGE_KEY, String(isDesktopSidebarVisible));
    } catch (_error) {
      // Ignore storage failures and keep the preference in memory.
    }
  }, [isDesktopSidebarVisible]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY);

    function handleViewportChange(event) {
      setIsMobileViewport(event.matches);
      if (event.matches) {
        setIsSidebarOpen(false);
      }
    }

    handleViewportChange(mediaQuery);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleViewportChange);
      return () => {
        mediaQuery.removeEventListener("change", handleViewportChange);
      };
    }

    mediaQuery.addListener(handleViewportChange);
    return () => {
      mediaQuery.removeListener(handleViewportChange);
    };
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;

    if (isMobileViewport && isSidebarOpen) {
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileViewport, isSidebarOpen]);

  useEffect(() => {
    if (!(isMobileViewport && isSidebarOpen)) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsSidebarOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileViewport, isSidebarOpen]);

  useEffect(() => {
    if (!authUser) {
      return undefined;
    }

    let isActive = true;

    async function load() {
      try {
        const { dashboardJson, strategyJson } = await fetchAppState();

        if (!isActive) {
          return;
        }

        applyAppState(dashboardJson, strategyJson);
      } catch (loadError) {
        if (String(loadError?.code ?? "") !== "AUTH_REQUIRED" && isActive) {
          setError(loadError.message);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      isActive = false;
    };
  }, [applyAppState, authUser, fetchAppState]);

  useEffect(() => {
    if (!authUser) {
      return undefined;
    }

    let isActive = true;

    async function loadStreamDiagnostics() {
      try {
        const response = await fetch("/api/stream-status");

        if (response.status === 401) {
          handleAuthRequired("Session expired");
          return;
        }

        if (!response.ok) {
          throw new Error(`Diagnostics request failed with ${response.status}`);
        }

        const payload = await response.json();
        if (isActive) {
          setStreamDiagnostics(payload);
        }
      } catch (_error) {
        // Keep the last known diagnostics visible if the lightweight status call fails.
      }
    }

    void loadStreamDiagnostics();
    const interval = window.setInterval(() => {
      void loadStreamDiagnostics();
    }, 15_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [authUser, handleAuthRequired]);

  useEffect(() => {
    if (!authUser) {
      return undefined;
    }

    let isActive = true;

    async function loadMarketStatus() {
      try {
        const response = await fetch("/api/market-status");

        if (response.status === 401) {
          handleAuthRequired("Session expired");
          return;
        }

        if (!response.ok) {
          throw new Error(`Market status request failed with ${response.status}`);
        }

        const payload = await response.json();
        if (isActive) {
          setMarketStatusPayload(payload);
        }
      } catch (_error) {
        // Keep the last known market schedule visible if the lightweight Polygon poll fails.
      }
    }

    void loadMarketStatus();
    const interval = window.setInterval(() => {
      void loadMarketStatus();
    }, 60_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [authUser, handleAuthRequired]);

  useEffect(() => {
    if (loading) {
      return;
    }

    if (
      !(activeView === "screening" || (activeView === "strategy" && selectedStrategyId === "strategy-1"))
    ) {
      strategyRefreshKeyRef.current = null;
      return;
    }

    const refreshKey = `${activeView}:${selectedStrategyId}`;
    if (strategyRefreshKeyRef.current === refreshKey) {
      return;
    }

    strategyRefreshKeyRef.current = refreshKey;
    if (!isTimestampStale(dashboard?.lastUpdated, ROUTE_REFRESH_STALE_MS)) {
      return;
    }

    void runStrategyRefresh({ announceStart: false });
  }, [activeView, dashboard?.lastUpdated, loading, runStrategyRefresh, selectedStrategyId]);

  useEffect(() => {
    if (!authUser) {
      return undefined;
    }

    if (loading || !(activeView === "paper" || activeView === "orders")) {
      return undefined;
    }

    if (!paperPortfolio) {
      void fetchPaperPortfolio().catch((paperLoadError) => {
        if (String(paperLoadError?.code ?? "") !== "AUTH_REQUIRED") {
          setRefreshNotice({
            tone: "error",
            message: paperLoadError.message
          });
        }
      });
    }

    const source = new EventSource("/api/paper-orders/stream");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload?.paperPortfolio) {
          applyPaperPortfolioUpdate(payload.paperPortfolio, payload.lastUpdated ?? new Date().toISOString());
        }
      } catch (streamError) {
        console.error("Unable to parse paper-trading stream payload:", streamError);
      }
    };

    return () => {
      source.close();
    };
  }, [activeView, applyPaperPortfolioUpdate, authUser, fetchPaperPortfolio, loading, paperPortfolio]);

  useEffect(() => {
    setMarketTimerContext(null);
  }, [activeView, selectedStrategyId]);

  useEffect(() => {
    function handlePopState() {
      const nextRoute = readRoute();
      setActiveView(nextRoute.activeView);
      setSelectedStrategyId(nextRoute.selectedStrategyId);

      if (matchesMobileSidebarViewport()) {
        setIsSidebarOpen(false);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const effectiveMarketTimerContext = useMemo(
    () => marketTimerContext ?? buildFallbackMarketTimerContext(strategyPayload),
    [marketTimerContext, strategyPayload]
  );

  if (!authReady) {
    return <div className="app-state">Loading HedgeHub…</div>;
  }

  if (!authUser) {
    return (
      <AuthScreen
        needsBootstrap={authNeedsBootstrap}
        busy={authBusy}
        error={authError}
        onLogin={handleLogin}
        onBootstrap={handleBootstrap}
      />
    );
  }

  if (loading) {
    return <div className="app-state">Loading HedgeHub…</div>;
  }

  if (error) {
    return <div className="app-state">{error}</div>;
  }

  const strategies = strategyPayload?.strategies ?? [];
  const primaryStrategy = strategyPayload?.primaryStrategy;
  const v2Screener = strategyPayload?.v2Screener;
  const strategyPaperContext = paperPortfolio ?? paperPortfolioPreview;
  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId) ?? null;
  const heroStats = dashboard?.heroStats ?? [];
  const showSettings = activeView === "settings";
  const showAdminUsers = activeView === "admin-users";
  const showScreening = activeView === "screening";
  const showWatchlist = activeView === "watchlist";
  const showStrategyFinder = activeView === "strategy" && selectedStrategyId === "strategy-1";
  const showVolCrushEarnings = activeView === "strategy" && selectedStrategyId === "strategy-2";
  const showDeltaHedgeScanner = activeView === "strategy" && selectedStrategyId === "strategy-4";
  const showCoveredIncomeScanner = activeView === "strategy" && selectedStrategyId === "strategy-5";
  const showTradingViewStrategyFinder =
    activeView === "strategy" && selectedStrategyId === "strategy-tv-finder";
  const showPlannedStrategy =
    activeView === "strategy" &&
    !showStrategyFinder &&
    !showVolCrushEarnings &&
    !showDeltaHedgeScanner &&
    !showCoveredIncomeScanner &&
    !showTradingViewStrategyFinder;
  const showPaperTrading = activeView === "paper";
  const showOrderManagement = activeView === "orders";
  const nextThemeLabel = theme === "dark" ? "Light mode" : "Dark mode";
  const isSidebarVisible = isMobileViewport ? isSidebarOpen : isDesktopSidebarVisible;

  return (
    <div className="app-root">
      {dashboard?.calendarWidgets?.tickerTape ? (
        <TradingViewWidget
          bare
          type={dashboard.calendarWidgets.tickerTape.type}
          config={dashboard.calendarWidgets.tickerTape.config}
          theme={theme}
          containerClassName="app-header-banner tradingview-widget-container--ticker"
        />
      ) : null}

      <div className="app-shell">
	        <div className="app-toolbar">
	          <button
	            type="button"
	            className={`sidebar-toggle ${isSidebarVisible ? "sidebar-toggle--active" : ""}`}
              aria-controls="app-sidebar"
              aria-expanded={isSidebarVisible}
              onClick={() => {
                if (isMobileViewport) {
                  setIsSidebarOpen((current) => !current);
                  return;
                }

                setIsDesktopSidebarVisible((current) => !current);
              }}
            >
              {isSidebarVisible ? "Hide sidebar" : "Show sidebar"}
            </button>
	          <button
	            type="button"
	            className="theme-toggle"
	            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
	            onClick={() => setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))}
	          >
	            {nextThemeLabel}
	          </button>
	          <div className="app-userbar">
	            <span className="app-userbar__label">
	              {authUser?.username}
	              {authUser?.role === "admin" ? " (admin)" : ""}
	            </span>
	            <button type="button" className="macro-layout-button" onClick={handleLogout} disabled={authBusy}>
	              Log out
	            </button>
	          </div>
	        </div>

        {isMobileViewport && isSidebarVisible ? (
          <button
            type="button"
            className="app-sidebar-backdrop"
            aria-label="Hide sidebar"
            onClick={() => setIsSidebarOpen(false)}
          />
        ) : null}

        <div className={`app-grid ${!isMobileViewport && !isSidebarVisible ? "app-grid--sidebar-hidden" : ""}`}>
	          <StrategyRail
	            sidebarId="app-sidebar"
	            activeView={activeView}
	            strategies={strategies}
	            selectedStrategyId={selectedStrategyId}
	            streamDiagnostics={streamDiagnostics}
	            marketStatusPayload={marketStatusPayload}
	            marketTimerContext={effectiveMarketTimerContext}
	            onOpenDashboard={() => navigateTo("dashboard")}
	            onOpenWatchlist={() => navigateTo("watchlist")}
	            onOpenSettings={() => navigateTo("settings")}
	            onOpenAdminUsers={() => navigateTo("admin-users")}
	            onOpenScreening={() => navigateTo("screening")}
	            onOpenPaperTrading={() => navigateTo("paper")}
	            onOpenOrderManagement={() => navigateTo("orders")}
	            onSelect={(strategyId) => navigateTo("strategy", strategyId)}
	            paperPortfolio={paperPortfolio ?? paperPortfolioPreview}
	            screeningSummary={v2Screener?.summary ?? null}
	            isAdmin={authUser?.role === "admin"}
	            isMobile={isMobileViewport}
	            isOpen={isSidebarVisible}
	            onCloseMobile={() => setIsSidebarOpen(false)}
	          />

	          <Suspense fallback={<WorkspaceLoadingFallback />}>
	          {showPaperTrading ? (
	            <PaperTradingWorkspace
	              paperPortfolio={paperPortfolio ?? paperPortfolioPreview}
	              lastUpdated={paperPortfolioLastUpdated ?? strategyPayload?.lastUpdated ?? null}
	              onUpdatePaperOrder={handleUpdatePaperOrder}
	              onClosePaperOrder={handleClosePaperOrder}
	              onClosePaperOrderLeg={handleClosePaperOrderLeg}
	              onRevivePaperOrderLeg={handleRevivePaperOrderLeg}
	              onAddPaperHedge={handleAddPaperHedge}
	              onDeletePaperOrder={handleDeletePaperOrder}
	              onSaveCalculatorSnapshot={handleSaveCalculatorSnapshot}
	              onExecutePaperOrder={handleExecutePaperOrder}
	              onConfirmPaperExecution={handleConfirmPaperExecution}
              onSyncPaperExecution={handleSyncPaperExecution}
              onCancelPaperExecution={handleCancelPaperExecution}
              theme={theme}
            />
          ) : showOrderManagement ? (
            <IbkrOrderManagementWorkspace
              paperPortfolio={paperPortfolio ?? paperPortfolioPreview}
              lastUpdated={paperPortfolioLastUpdated ?? strategyPayload?.lastUpdated ?? null}
              onUpdatePaperOrder={handleUpdatePaperOrder}
              onExecutePaperOrder={handleExecutePaperOrder}
              onConfirmPaperExecution={handleConfirmPaperExecution}
              onSyncPaperExecution={handleSyncPaperExecution}
              onCancelPaperExecution={handleCancelPaperExecution}
              onOpenStrategy={(strategyId) => navigateTo("strategy", strategyId)}
              onOpenPaperTrading={() => navigateTo("paper")}
            />
          ) : showWatchlist ? (
            <StrategyWatchlistWorkspace
              setupWatchlist={strategyPayload?.setupWatchlist ?? []}
              finderRows={strategyPayload?.primaryStrategy?.finder?.rows ?? []}
              onOpenFinderRow={handleOpenFinderRowFromWatchlist}
              onDeleteSetupWatchlistItem={handleDeleteSetupWatchlistItem}
              onCreatePaperOrder={handleCreatePaperOrder}
              onConfirmPaperExecution={handleConfirmPaperExecution}
              onOpenPaperTrading={() => navigateTo("paper")}
              paperPortfolio={strategyPaperContext}
              lastUpdated={strategyPayload?.lastUpdated ?? null}
              theme={theme}
            />
	          ) : showScreening ? (
	            <StrategyScreeningWorkspace
	              screenerPayload={v2Screener}
	              onManualRefresh={handleManualRefresh}
	              refreshing={refreshing}
	              refreshNotice={refreshNotice}
	              onMarketTimerContextChange={setMarketTimerContext}
	              theme={theme}
	            />
	          ) : showSettings ? (
	            <StrategySettingsWorkspace
	              strategyPayload={strategyPayload}
	              onSaveStrategyAssetMapping={handleSaveStrategyAssetMapping}
	              onDeleteStrategyAssetMapping={handleDeleteStrategyAssetMapping}
	            />
	          ) : showAdminUsers ? (
	            authUser?.role === "admin" ? (
	              <AdminUsersWorkspace onAuthRequired={handleAuthRequired} />
	            ) : (
	              <main className="workspace workspace--admin-users">
	                <header className="topbar">
	                  <div>
	                    <span className="brand__eyebrow">Admin</span>
	                    <h2>Access denied</h2>
	                  </div>
	                </header>
	                <div className="app-state app-state--inline">Admin access is required.</div>
	              </main>
	            )
	          ) : showStrategyFinder ? (
	            <StrategyFinderWorkspace
	              strategyPayload={strategyPayload}
	              strategyDefinition={selectedStrategy}
              setupWatchlist={strategyPayload?.setupWatchlist ?? []}
              onUpsertSetupWatchlistItem={handleUpsertSetupWatchlistItem}
              onDeleteSetupWatchlistItem={handleDeleteSetupWatchlistItem}
              autoOpenRowId={finderAutoOpenRowId}
              onAutoOpenRowHandled={() => setFinderAutoOpenRowId("")}
              onManualRefresh={handleManualRefresh}
              refreshing={refreshing}
              refreshNotice={refreshNotice}
              paperPortfolio={strategyPaperContext}
              onCreatePaperOrder={handleCreatePaperOrder}
              onConfirmPaperExecution={handleConfirmPaperExecution}
              onOpenPaperTrading={() => navigateTo("paper")}
              onMarketTimerContextChange={setMarketTimerContext}
              theme={theme}
            />
          ) : showVolCrushEarnings ? (
            <VolCrushEarningsWorkspace
              strategyDefinition={selectedStrategy}
              onCreatePaperOrder={handleCreatePaperOrder}
              onOpenPaperTrading={() => navigateTo("paper")}
              onMarketTimerContextChange={setMarketTimerContext}
              theme={theme}
            />
          ) : showDeltaHedgeScanner ? (
            <DeltaHedgeScannerWorkspace
              strategyDefinition={selectedStrategy}
              paperPortfolio={strategyPaperContext}
              onCreatePaperOrder={handleCreatePaperOrder}
              onConfirmPaperExecution={handleConfirmPaperExecution}
              onOpenPaperTrading={() => navigateTo("paper")}
              onMarketTimerContextChange={setMarketTimerContext}
              theme={theme}
            />
          ) : showCoveredIncomeScanner ? (
            <CoveredIncomeScannerWorkspace
              strategyDefinition={selectedStrategy}
              paperPortfolio={strategyPaperContext}
              onCreatePaperOrder={handleCreatePaperOrder}
              onConfirmPaperExecution={handleConfirmPaperExecution}
              onOpenPaperTrading={() => navigateTo("paper")}
              onMarketTimerContextChange={setMarketTimerContext}
              theme={theme}
            />
          ) : showTradingViewStrategyFinder ? (
            <TradingViewStrategyWorkspace
              strategyDefinition={selectedStrategy}
              paperPortfolio={strategyPaperContext}
              onCreatePaperOrder={handleCreatePaperOrder}
              onConfirmPaperExecution={handleConfirmPaperExecution}
              onOpenPaperTrading={() => navigateTo("paper")}
              onMarketTimerContextChange={setMarketTimerContext}
              theme={theme}
            />
          ) : showPlannedStrategy ? (
            <main className="workspace">
              <header className="topbar">
                <div>
                  <span className="brand__eyebrow">Planned strategy</span>
                  <h2>{selectedStrategy?.name ?? "Strategy"}</h2>
                </div>
              </header>
              <article className="insight-card">
                <p className="card-copy">
                  This strategy slot is reserved, but the finder and calculator flow is currently implemented for
                  Strategy 1 first.
                </p>
              </article>
            </main>
          ) : (
            <main className="workspace">
              {dashboard?.warnings?.length ? (
                <div className="warning-strip">
                  {dashboard.warnings.map((warning) => (
                    <span key={warning}>{warning}</span>
                  ))}
                </div>
              ) : null}

              <section className="hero-stats">
                {heroStats.map((stat) => (
                  <article key={stat.label} className={`metric-card metric-card--${stat.accent}`}>
                    <span>{stat.label}</span>
                    <strong>{stat.value}</strong>
                  </article>
                ))}
              </section>

              <MacroHeatmapDashboard
                macroDashboard={dashboard?.macroDashboard}
                theme={theme}
              />

              <section className="scan-section">
                <div className="section-heading">
                  <span>Cross-asset scan</span>
                  <span className="pill pill--live">Polymarket + options</span>
                </div>

                <div className="scan-grid">
                  {(primaryStrategy?.scanUniverse ?? []).map((asset) => (
                    <article key={asset.id} className="scan-card">
                      <div className="scan-card__header">
                        <div>
                          <h3>{asset.label}</h3>
                          <span>{asset.optionSymbol} proxy</span>
                        </div>
                        <span className="pill pill--ghost">{asset.opportunities.length} matches</span>
                      </div>

                      {asset.opportunities.map((opportunity) => (
                        <a
                          key={`${asset.id}-${opportunity.question}`}
                          href={opportunity.url}
                          target="_blank"
                          rel="noreferrer"
                          className="opportunity"
                        >
                          <strong>{opportunity.question}</strong>
                          <div className="opportunity__meta">
                            <span>YES {opportunity.yesPrice}</span>
                            <span>
                              {opportunity.optionSymbol} {opportunity.optionStrike}
                              {opportunity.optionType === "put" ? "P" : "C"} {opportunity.optionExpiry}
                            </span>
                          </div>
                          <div className="opportunity__meta">
                            <span>Live option {opportunity.liveOptionPrice}</span>
                            <span>Target model {opportunity.theoreticalOptionPriceAtTarget}</span>
                          </div>
                          <div className="opportunity__profit">
                            {opportunity.projectedProfit != null
                              ? `$${opportunity.projectedProfit.toLocaleString()}`
                              : "n/a"}
                          </div>
                        </a>
                      ))}
                    </article>
                  ))}
                </div>
              </section>

              <section className="calendar-grid">
                <div className="calendar-column">
                  <EconomicCalendarPanel data={dashboard?.economicCalendar} />
                </div>

                <div className="calendar-column">
                  <CompanyEventsPanel data={dashboard?.companyEvents} />
                </div>
              </section>

            </main>
          )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
