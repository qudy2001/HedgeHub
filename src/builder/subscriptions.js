// Tiger market-data subscriptions, as returned by the bridge's /permissions endpoint.
const LABELS = {
  usQuoteBasic: "US stocks",
  usOptionQuote: "US options",
  aStockQuoteLv1: "China A-shares",
  hkStockQuoteLv2: "HK stocks L2",
  usStockQuoteLv2Totalview: "US stocks L2",
};
const EXPIRING_SOON_MS = 7 * 86400_000;

const dateTime = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// status: "active" | "soon" (under 7 days left) | "expired"
export function describeSubscriptions(permissions, now = Date.now()) {
  return (Array.isArray(permissions) ? permissions : [])
    .filter((p) => p && p.name)
    .map((p) => {
      const expireAt = Number(p.expire_at);
      const label = LABELS[p.name] ?? p.name;
      if (!(expireAt > 0))
        return { name: p.name, label, status: "active", expireAt: null, text: "No expiry" };
      const status =
        expireAt <= now ? "expired" : expireAt - now < EXPIRING_SOON_MS ? "soon" : "active";
      return {
        name: p.name,
        label,
        status,
        expireAt,
        text: `${status === "expired" ? "Expired" : "Expires"} ${dateTime(expireAt)}`,
      };
    })
    .sort((a, b) => (a.expireAt ?? Infinity) - (b.expireAt ?? Infinity));
}
