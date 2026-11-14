# HedgeHub MCP server

Tools: `list_market_topics`, `upsert_market_topic`, `get_next_analysis_task`, `complete_analysis_task`.

`upsert_market_topic` takes an optional `category` (`general`, `commodity`, `forex`, `ticker`, `social`) and `symbols` (tickers, required for `ticker`). They decide where the topic appears in the Builder's AI suggestions: **General** (general, commodity, forex), **Ticker** (topics mentioning the selected stock), **Social**, or **Other tickers**. Omitted fields keep an existing topic's values; new topics default to `general`. After upgrading, refresh the connector's tools in ChatGPT (or reconnect in Claude) so the client sees the new parameters.

`list_market_topics` takes optional filters: `status` (`active`, `archived` or `all`; default `all`, so existing prompts keep working), `category` and `symbol` (one ticker). A topic that goes 30 days without an update is archived and drops out of the suggestions, so the scheduled-task templates below ask for `status: "active"`. A client that has not refreshed the connector's tools still gets every topic.

`complete_analysis_task` saves the write-up on the task. Admin -> Analysis tasks -> "Recent runs" lists the latest 50 tasks (pending, claimed and done) with their prompt, topic and an expandable result; admins can also read them from `GET /api/admin/analysis-tasks` (optional `limit`, up to 200). The list needs `DB_TYPE=postgres`; on SQLite it is empty.

## Scheduled-task templates

Admin -> Analysis tasks -> "AI schedule templates" holds ready-made prompts for Claude, ChatGPT, Grok and Gemini scheduled tasks (task queue runner, weekly sweep, daily market pulse, per-stock tracking, earnings, position risk and more). Fill in the fields, copy, and paste into the platform's scheduler, or use "Queue in HedgeHub" so HedgeHub keeps the schedule and one runner task works through the queue.

The "Daily desk" group is for running several platforms side by side: one daily prompt each for ChatGPT (overall view), Grok (social sentiment on X), Claude (deep research) and Gemini (news and calendar through Google Search). Each platform writes only its own lane of topics; the lane is decided by the title prefix (`Social:`, `News:`, `Event:`, `Thesis:`, `Research:`) and then by the category, and `deskLane()` is the code version of that rule. Every summary starts `As of <time> by <platform>. Stage: <stage>. Next check: <date>.`, so the topic list shows who wrote what and when it is due again, and each lane rewrites one anchor topic per run, which doubles as a sign that its scheduled task is still alive. The same page has a "Daily desk status" panel (`shared/deskStatus.js`) that reads those headers back: which lane last wrote and when, each topic's stage and next check, open flags, and topics close to being archived. Desk runs do not appear under "Recent runs", which only lists queue tasks.

The templates live in `shared/aiScheduleTemplates.js`. `tests/aiScheduleTemplates.test.js` checks that every tool they mention is still registered in `src/server.js`, so renaming a tool tells you which prompts to update.

## Local (stdio)
`npm start` with `HEDGEHUB_API_URL` and `HEDGEHUB_API_KEY` set.

## Remote via Docker + Cloudflare tunnel (ChatGPT / Claude / Grok connectors)

The compose `mcp` profile runs two containers on the same network as `web`:

- `mcp` — this server in streamable-HTTP mode. It publishes no host port and calls HedgeHub at `http://web:8787`.
- `cloudflared` — outbound-only tunnel to Cloudflare, forwarding to `http://mcp:8790`.

### 1. Create the tunnel (Cloudflare dashboard)
1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it `hedgehub-mcp`.
2. Copy the tunnel **token** (the long string after `--token`).
3. Add a public hostname, e.g. `mcp.yourdomain.com`, service type **HTTP**, URL `mcp:8790`.

### 2. Configure `.env`
```
HEDGEHUB_API_KEY=hhk_...            # admin UI → API keys
MCP_ACCESS_TOKEN=<openssl rand -hex 24>
CLOUDFLARE_TUNNEL_TOKEN=<token from step 1>
```

### 3. Start
```
docker compose --profile mcp up -d --build mcp cloudflared
docker compose logs -f cloudflared   # look for "Registered tunnel connection"
```

### 4. Add the connector
URL: `https://mcp.yourdomain.com/mcp/<MCP_ACCESS_TOKEN>`

- ChatGPT: Settings → Connectors → Advanced → Developer mode → Create.
- Claude: Settings → Connectors → Add custom connector.
- Grok: add as a remote MCP server.

Choose "No authentication" where asked; the token in the URL is the secret. Clients that can send headers may use `https://mcp.yourdomain.com/mcp` with `Authorization: Bearer <MCP_ACCESS_TOKEN>` instead.

Notes:
- The write tools (`upsert_market_topic`, `complete_analysis_task`) are reachable through this URL. Treat it like a password and rotate `MCP_ACCESS_TOKEN` if it leaks (`docker compose up -d mcp` picks up the new value).
- If the tunnel can't connect (UDP 7844 blocked), set `CLOUDFLARED_PROTOCOL=http2`.
- Running the HTTP server outside Docker: `npm run start:http` (127.0.0.1:8790).
