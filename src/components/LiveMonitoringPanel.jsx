import { isIbkrReady, isIbkrReloginNeeded } from "../ibkrStatus.js";

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

export default function LiveMonitoringPanel({ streamDiagnostics = null, brokerStatus = null, className = "" }) {
  const optionDiagnostics = streamDiagnostics?.options ?? null;
  const polymarketDiagnostics = streamDiagnostics?.polymarket ?? null;
  const ibkrSnapshot = getIbkrMonitorSnapshot(brokerStatus?.ibkr ?? null);
  const optionState = optionDiagnostics?.state ?? "idle";
  const trackedContracts = Number(optionDiagnostics?.trackedContracts ?? 0);
  const refreshEverySeconds = Number(polymarketDiagnostics?.refreshEverySeconds ?? 0);
  const classes = ["macro-layout-diagnostics", className].filter(Boolean).join(" ");

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
    </div>
  );
}
