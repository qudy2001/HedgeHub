CREATE OR REPLACE VIEW latest_market_snapshots AS
SELECT DISTINCT ON (symbol)
    id,
    captured_at,
    symbol,
    label,
    group_name,
    provider,
    price,
    change_percent,
    currency
FROM market_snapshots
ORDER BY symbol, captured_at DESC, id DESC;

CREATE OR REPLACE VIEW latest_iv30_by_symbol AS
SELECT DISTINCT ON (symbol)
    date,
    symbol,
    underlying_price,
    iv30,
    atm_call_iv,
    atm_put_iv,
    near_expiry,
    far_expiry,
    near_dte,
    far_dte,
    option_volume,
    open_interest,
    created_at
FROM iv30_history
ORDER BY symbol, date DESC;

