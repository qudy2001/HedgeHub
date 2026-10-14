# HedgeHub MCP server

Tools: `list_market_topics`, `upsert_market_topic`, `get_next_analysis_task`, `complete_analysis_task`.

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
