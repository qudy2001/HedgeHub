export function isIbkrReady(status) {
  return (
    status?.configured === true &&
    status?.connected === true &&
    status?.authenticated === true &&
    status?.isPaper === true
  );
}

export function isIbkrReloginNeeded(status) {
  const error = String(status?.error ?? "")
    .trim()
    .toLowerCase();

  return error.includes("access denied") || error.includes("not authenticated") || error.includes("session expired");
}

export function getIbkrGatewayLoginUrl(hostname = "") {
  const fallbackHostname =
    hostname ||
    (typeof window !== "undefined" ? String(window.location?.hostname ?? "").trim() : "") ||
    "localhost";

  return `https://${fallbackHostname}:5001`;
}
