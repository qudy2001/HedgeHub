export const money = (v, d = 0) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: d,
      }).format(v);
export const num = (v, d = 1) =>
  v == null
    ? "—"
    : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
export const pct = (v) => (v == null ? "—" : `${num(v)}%`);
export const pillTone = (v, good, mid) => (v == null ? "mid" : v >= good ? "good" : v >= mid ? "mid" : "bad");
