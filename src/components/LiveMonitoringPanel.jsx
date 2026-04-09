import { useEffect, useState } from "react";
import { isIbkrReady, isIbkrReloginNeeded } from "../ibkrStatus.js";

const DEFAULT_TWS_HOST = "127.0.0.1";
const DEFAULT_TWS_PORT = 7497;

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp);
}

function formatRelativeTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return "n/a";
  }

  const diffSeconds = Math.max(Math.round((Date.now() - timestamp.getTime()) / 1000), 0);

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  if (diffSeconds < 3600) {
    return `${Math.round(diffSeconds / 60)}m ago`;
  }

  if (diffSeconds < 86400) {
    return `${Math.round(diffSeconds / 3600)}h ago`;
  }

  return formatTimestamp(value);
}

function getStreamStateLabel(state) {
  switch (state) {
    case "live":
      return "Live";
    case "connecting":
      return "Connecting";
    case "retrying":
      return "Retrying";
    case "disconnected":
      return "Disconnected";
    default:
      return "Idle";
  }
}

function getIbkrMonitorSnapshot(ibkrStatus) {
  if (!ibkrStatus) {
    return {
      stateClass: "idle",
      label: "Idle",
      detail: "Waiting for broker status"
    };
  }

  if (isIbkrReady(ibkrStatus)) {
    return {
      stateClass: "live",
      label: "Paper",
      detail: ibkrStatus.selectedAccount ? `Acct ${ibkrStatus.selectedAccount}` : "Gateway ready"
    };
  }

  if (isIbkrReloginNeeded(ibkrStatus)) {
    return {
      stateClass: "retrying",
      label: "Relogin",
      detail: "Session expired"
    };
  }

  if (ibkrStatus.configured === false) {
    return {
      stateClass: "idle",
      label: "Offline",
      detail: "Gateway not configured"
    };
  }

  if (ibkrStatus.connected !== true) {
    return {
      stateClass: "disconnected",
      label: "Offline",
      detail: "Gateway unreachable"
    };
  }

  if (ibkrStatus.authenticated !== true) {
    return {
      stateClass: "disconnected",
      label: "Offline",
      detail: "Authentication required"
    };
  }

  if (ibkrStatus.isPaper !== true) {
    return {
      stateClass: "disconnected",
      label: "Offline",
      detail: "Paper mode required"
    };
  }

  return {
    stateClass: "disconnected",
    label: "Offline",
    detail: "Gateway unavailable"
  };
}

function getTwsMonitorSnapshot(twsStatus) {
  if (!twsStatus) {
    return {
      stateClass: "idle",
      label: "Idle",
      detail: "Waiting for broker status"
    };
  }

  const connected = twsStatus.connected === true && twsStatus.authenticated === true;
  const ready = twsStatus.ready === true;
  const isPaper = twsStatus.isPaper === true;

  if (connected && ready && isPaper) {
    return {
      stateClass: "live",
      label: "Paper",
      detail: twsStatus.selectedAccount ? `Acct ${twsStatus.selectedAccount}` : "Connected"
    };
  }

  if (twsStatus.configured === false) {
    return {
      stateClass: "idle",
      label: "Offline",
      detail: "TWS not configured"
    };
  }

  if (!connected) {
    return {
      stateClass: "disconnected",
      label: "Offline",
      detail: "TWS unreachable"
    };
  }

  if (!ready) {
    return {
      stateClass: "connecting",
      label: "Connecting",
      detail: "Waiting for handshake"
    };
  }

  if (!isPaper) {
    return {
      stateClass: "disconnected",
      label: "Offline",
      detail: "Paper account required"
    };
  }

  return {
    stateClass: "disconnected",
    label: "Offline",
    detail: "TWS unavailable"
  };
}

export default function LiveMonitoringPanel({ streamDiagnostics = null, brokerStatus = null, className = "" }) {
  const optionDiagnostics = streamDiagnostics?.options ?? null;
  const polymarketDiagnostics = streamDiagnostics?.polymarket ?? null;
  const ibkrSnapshot = getIbkrMonitorSnapshot(brokerStatus?.ibkr ?? null);
  const [twsStatus, setTwsStatus] = useState(() => brokerStatus?.tws ?? null);
  const [twsHost, setTwsHost] = useState(() => String(brokerStatus?.tws?.host ?? "").trim() || DEFAULT_TWS_HOST);
  const [twsPort, setTwsPort] = useState(() => String(brokerStatus?.tws?.port ?? DEFAULT_TWS_PORT));
  const [twsBusy, setTwsBusy] = useState(false);
  const effectiveTwsStatus = twsStatus ?? brokerStatus?.tws ?? null;
  const twsSnapshot = getTwsMonitorSnapshot(effectiveTwsStatus);
  const optionState = optionDiagnostics?.state ?? "idle";
  const trackedContracts = Number(optionDiagnostics?.trackedContracts ?? 0);
  const refreshEverySeconds = Number(polymarketDiagnostics?.refreshEverySeconds ?? 0);
  const classes = ["macro-layout-diagnostics", className].filter(Boolean).join(" ");

  useEffect(() => {
    if (brokerStatus?.tws) {
      setTwsStatus(brokerStatus.tws);
      const nextHost = String(brokerStatus.tws.host ?? "").trim();
      if (nextHost) {
        setTwsHost((current) => (current === DEFAULT_TWS_HOST || !current ? nextHost : current));
      }
      const nextPort = String(brokerStatus.tws.port ?? "").trim();
      if (nextPort) {
        setTwsPort((current) => (current === String(DEFAULT_TWS_PORT) || !current ? nextPort : current));
      }
    }
  }, [brokerStatus?.tws]);

  useEffect(() => {
    let cancelled = false;

    async function loadTwsStatus() {
      try {
        const response = await fetch("/api/brokers/tws/status");
        const payload = await response.json().catch(() => null);
        if (!cancelled && response.ok) {
          setTwsStatus(payload?.tws ?? null);
          const nextHost = String(payload?.tws?.host ?? "").trim();
          setTwsHost((current) =>
            nextHost && (current === DEFAULT_TWS_HOST || !current) ? nextHost : current || DEFAULT_TWS_HOST
          );
          const nextPort = String(payload?.tws?.port ?? "").trim();
          setTwsPort((current) =>
            nextPort && (current === String(DEFAULT_TWS_PORT) || !current)
              ? nextPort
              : current || String(DEFAULT_TWS_PORT)
          );
        }
      } catch (_error) {
        // ignore
      }
    }

    void loadTwsStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConnectTws() {
    const host = String(twsHost ?? "").trim();
    const port = Number(twsPort);

    if (!host || !Number.isFinite(port)) {
      setTwsStatus((current) => ({
        ...(current ?? {}),
        configured: true,
        host,
        port,
        connected: false,
        authenticated: false,
        ready: false,
        error: "Enter a valid TWS host and port."
      }));
      return;
    }

    setTwsBusy(true);
    try {
      const response = await fetch("/api/brokers/tws/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          host,
          port
        })
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.error || "Failed to connect to TWS");
      }

      setTwsStatus(payload?.tws ?? null);
    } catch (error) {
      setTwsStatus((current) => ({
        ...(current ?? {}),
        configured: true,
        host,
        port,
        connected: false,
        authenticated: false,
        ready: false,
        error: error.message
      }));
    } finally {
      setTwsBusy(false);
    }
  }

  const twsConnected =
    effectiveTwsStatus?.connected === true &&
    effectiveTwsStatus?.authenticated === true &&
    effectiveTwsStatus?.ready === true;
  const twsHasError = String(effectiveTwsStatus?.error ?? "").trim();
  const showTwsConnectForm = !twsConnected || Boolean(twsHasError);

  return (
    <div className={classes} aria-label="Live data diagnostics">
      <div className="macro-layout-diagnostics__row">
        <span className="macro-layout-diagnostics__label">Options</span>
        <span className={`macro-layout-diagnostics__state macro-layout-diagnostics__state--${optionState}`}>
          {getStreamStateLabel(optionState)}
        </span>
        <span>{`${trackedContracts} contract${trackedContracts === 1 ? "" : "s"} watching`}</span>
      </div>

      <div className="macro-layout-diagnostics__row">
        <span className="macro-layout-diagnostics__label">Polymarket</span>
        <span className="macro-layout-diagnostics__state macro-layout-diagnostics__state--polling">
          {refreshEverySeconds > 0 ? `${Math.round(refreshEverySeconds / 60)}m poll` : "Polling"}
        </span>
        <span>
          {polymarketDiagnostics?.lastRefreshAt
            ? `Last refresh ${formatRelativeTimestamp(polymarketDiagnostics.lastRefreshAt)}`
            : "Waiting for refresh"}
        </span>
      </div>

      <div className="macro-layout-diagnostics__row">
        <span className="macro-layout-diagnostics__label">IBKR</span>
        <span className={`macro-layout-diagnostics__state macro-layout-diagnostics__state--${ibkrSnapshot.stateClass}`}>
          {ibkrSnapshot.label}
        </span>
        <span>{ibkrSnapshot.detail}</span>
      </div>

      <div className="macro-layout-diagnostics__row">
        <span className="macro-layout-diagnostics__label">TWS</span>
        <span className={`macro-layout-diagnostics__state macro-layout-diagnostics__state--${twsSnapshot.stateClass}`}>
          {twsSnapshot.label}
        </span>
        <span>{twsSnapshot.detail}</span>
      </div>

      {showTwsConnectForm ? (
        <form
          className="sidebar-broker-connect"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConnectTws();
          }}
        >
          <label>
            <span>IP</span>
            <input
              type="text"
              value={twsHost}
              onChange={(event) => {
                setTwsHost(event.target.value);
                setTwsStatus((current) => (current?.error ? { ...current, error: "" } : current));
              }}
              placeholder={DEFAULT_TWS_HOST}
            />
          </label>
          <label className="sidebar-broker-connect__port">
            <span>Port</span>
            <input
              type="number"
              value={twsPort}
              onChange={(event) => {
                setTwsPort(event.target.value);
                setTwsStatus((current) => (current?.error ? { ...current, error: "" } : current));
              }}
              placeholder={String(DEFAULT_TWS_PORT)}
            />
          </label>
          <button
            type="submit"
            className="chart-toggle sidebar-broker-connect__button"
            disabled={twsBusy}
          >
            {twsBusy ? "Connecting..." : effectiveTwsStatus?.connected === true ? "Reconnect" : "Connect"}
          </button>
          {twsHasError ? <small className="negative sidebar-broker-connect__error">{twsHasError}</small> : null}
        </form>
      ) : null}
    </div>
  );
}
