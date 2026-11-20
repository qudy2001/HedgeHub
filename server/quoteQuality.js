export function finiteNumber(value, fallback = null) {
  if (value == null || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function timestampIso(value) {
  if (value == null || value === '') return null;
  let v = value;
  if (typeof v === 'string' && /^\d{10,19}$/.test(v)) v = Number(v);
  if (typeof v === 'number') v = v > 1e17 ? v / 1e6 : v > 1e14 ? v / 1e3 : v < 1e11 ? v * 1000 : v;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function assessQuote(contract, now = Date.now(), maxAgeMs = 90_000) {
  const bid = finiteNumber(contract?.bid), ask = finiteNumber(contract?.ask);
  const at = timestampIso(contract?.quoteTimestamp);
  const ageMs = at ? now - Date.parse(at) : null;
  const reasons = [];
  if (contract?.hasRealBidAsk !== true || contract?.isLive !== true) reasons.push('modeled-or-unverified');
  if (!(bid > 0) || !(ask >= bid)) reasons.push('invalid-bid-ask');
  if (ageMs == null) reasons.push('unknown-quote-time');
  else if (ageMs > maxAgeMs || ageMs < -5000) reasons.push('stale-or-future-quote');
  return { eligible: reasons.length === 0, reasons, ageMs, quoteTimestamp: at, source: contract?.source ?? 'unknown' };
}
