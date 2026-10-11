import { fetchQuotes as legacyQuotes, fetchOptionChain as legacyChain } from './yahooFinance.js';
import { tigerEnabled, tigerQuotes, tigerOptionChain } from './tiger.js';

export const fetchOptionChain = args => tigerEnabled() ? tigerOptionChain(args) : legacyChain(args);
export async function fetchQuotes(requests) {
  if (!tigerEnabled()) return legacyQuotes(requests);
  // Retain crypto/FX/index proxies where Tiger US equity coverage does not apply.
  const us = requests.filter(r => r.provider === 'stooq' && String(r.sourceSymbol).endsWith('.us'));
  const others = requests.filter(r => !us.includes(r));
  const [equities, remaining] = await Promise.all([tigerQuotes(us), others.length ? legacyQuotes(others) : []]);
  return [...equities, ...remaining];
}
