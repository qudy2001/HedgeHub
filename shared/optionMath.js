// Shared European reference model. Prices/Greeks are estimates, never market quotes.
export function normalCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z));
  return 0.5 * (1 + Math.sign(x) * erf);
}

export function optionPrice({ type, spot, strike, timeYears, volatility, riskFreeRate = 0.0425, dividendYield = 0 }) {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (!(timeYears > 0)) return Math.max(type === 'put' ? strike - spot : spot - strike, 0);
  const s = spot * Math.exp(-dividendYield * timeYears);
  const k = strike * Math.exp(-riskFreeRate * timeYears);
  if (!(volatility > 0)) return Math.max(type === 'put' ? k - s : s - k, 0);
  const d1 = (Math.log(spot / strike) + (riskFreeRate - dividendYield + volatility ** 2 / 2) * timeYears) / (volatility * Math.sqrt(timeYears));
  const d2 = d1 - volatility * Math.sqrt(timeYears);
  return type === 'put' ? k * normalCdf(-d2) - s * normalCdf(-d1) : s * normalCdf(d1) - k * normalCdf(d2);
}

export function optionDelta({ type, spot, strike, timeYears, volatility, riskFreeRate = 0.0425, dividendYield = 0 }) {
  if (![spot, strike, timeYears, volatility].every(v => Number.isFinite(v) && v > 0)) return null;
  const d1 = (Math.log(spot / strike) + (riskFreeRate - dividendYield + volatility ** 2 / 2) * timeYears) / (volatility * Math.sqrt(timeYears));
  return Math.exp(-dividendYield * timeYears) * (normalCdf(d1) - (type === 'put' ? 1 : 0));
}

export function coveredCapital(type, spot, putStrike, contracts = 1, multiplier = 100) {
  return contracts * multiplier * ((type === 'cash_secured_put' ? 0 : spot) + (type === 'covered_call' ? 0 : putStrike));
}

export function coveredPayoff({ type, spot, terminal, putStrike, callStrike, putPremium = 0, callPremium = 0, multiplier = 100, contracts = 1 }) {
  return contracts * multiplier * ((type === 'cash_secured_put' ? 0 : terminal - spot + callPremium - Math.max(terminal - callStrike, 0)) +
    (type === 'covered_call' ? 0 : putPremium - Math.max(putStrike - terminal, 0)));
}

export function coveredBreakeven(type, spot, putStrike, putPremium, callPremium) {
  if (type === 'cash_secured_put') return putStrike - putPremium;
  if (type === 'covered_call') return spot - callPremium;
  const credit = putPremium + callPremium;
  return spot - credit >= putStrike ? spot - credit : (spot + putStrike - credit) / 2;
}
