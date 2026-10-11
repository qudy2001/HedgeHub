# Postman assets

## Current read-only subscription checks

Use `Tiger-Subscription-Check.postman_collection.json` with `Tiger-Subscription-Check.local.postman_environment.json` to test the implemented bridge. Follow [中文测试说明](Tiger-Subscription-Check.zh-CN.md). It covers permissions, quotas, stock/option quotes, quote timestamps and research endpoints. No orders or subscription purchases. The older assets below contain prospective endpoints and are not the recommended subscription check.

## Files
- `HedgeHub-TigerTrade.postman_collection.json`
- `HedgeHub-TigerTrade.local.postman_environment.json`

## What this covers
- `Tiger Validation` assumes a local Tiger bridge HTTP surface in front of the Tiger Python SDK.
- `HedgeHub Integration` targets HedgeHub endpoints after TigerTrade is wired in as a selectable option market-data provider.

## Local variables
- `baseUrl`: HedgeHub base URL, defaults to `http://localhost:8787`
- `tigerBridgeUrl`: assumed Tiger bridge base URL, defaults to `http://localhost:8788`
- `sessionCookie`: HedgeHub `hedgehub_session` cookie value for protected `/api/*` requests
- `symbol`: defaults to `AAPL`
- `expiry`: initially blank, populated from the Tiger expirations request when available
- `optionType`: defaults to `call`
- `contractSymbol`: initially blank, populated from the Tiger or HedgeHub chain request
- `strikeHint`: defaults to `200`

## Notes
- HedgeHub authentication in this repo is cookie-based. Protected requests send `Cookie: hedgehub_session={{sessionCookie}}`.
- `/api/settings/market-data` and `/api/options/depth` are future-facing in the current app, so those requests are included for integration testing and may fail until the TigerTrade integration is implemented.
- The collection is committed with placeholders only and does not include Tiger credentials or account-specific values.

## Implemented research bridge

The research implementation is documented in `../docs/entry-research.md`. The older collection above remains a prospective streaming/provider-switching design. The implemented bridge is authenticated with `Authorization: Bearer <TIGER_BRIDGE_TOKEN>`, uses polling, and does not implement stream subscription or provider-setting PUT requests. Use the documented research API for current integration tests.
