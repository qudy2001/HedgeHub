import crypto from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.MCP_HTTP_PORT ?? 8790);
const HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const TOKEN = String(process.env.MCP_ACCESS_TOKEN ?? "").trim();

if (TOKEN.length < 24) {
  throw new Error("MCP_ACCESS_TOKEN is required and must be at least 24 characters (try: openssl rand -hex 24)");
}

const tokenBuf = Buffer.from(TOKEN);
function tokenMatches(candidate) {
  const buf = Buffer.from(String(candidate ?? ""));
  return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf);
}

// Connector UIs differ: some only take a URL, some take a bearer token.
// Accept either /mcp/<token> or "Authorization: Bearer <token>" on /mcp.
function isAuthorized(url, headers) {
  const match = url.pathname.match(/^\/mcp\/([^/]+)$/);
  if (match) return tokenMatches(decodeURIComponent(match[1]));
  if (url.pathname === "/mcp") {
    const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    return tokenMatches(bearer);
  }
  return false;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (!url.pathname.startsWith("/mcp")) return send(res, 404, { error: "Not found" });
  if (!isAuthorized(url, req.headers)) return send(res, 401, { error: "Unauthorized" });

  // Stateless mode: a fresh server + transport per request, no session to lose on restart.
  if (req.method !== "POST") {
    return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }

  try {
    const body = await readJson(req);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`HedgeHub MCP (streamable HTTP) listening on http://${HOST}:${PORT}/mcp`);
});
