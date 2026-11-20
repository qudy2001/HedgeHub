import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { MARKET_TOPIC_CATEGORIES, MARKET_TOPIC_STATUS_FILTERS } from "../shared/marketTopics.js";

// The MCP server is its own package, so its dependencies (SDK, zod) live in mcp-server/node_modules.
const sdkDir = new URL("../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url);
const skip = existsSync(sdkDir) ? false : "run npm install in mcp-server/ first";

test("list_market_topics offers optional status, category and symbol filters and passes on only the ones given", { skip }, async () => {
  const requests = [];
  const hedgehub = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, apiKey: request.headers["x-api-key"] });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ results: { topics: [{ id: 1, title: "Fed policy" }] } }));
  });
  await new Promise((resolve) => hedgehub.listen(0, "127.0.0.1", resolve));
  // hedgehubClient.js reads these when it is first imported.
  process.env.HEDGEHUB_API_URL = `http://127.0.0.1:${hedgehub.address().port}`;
  process.env.HEDGEHUB_API_KEY = "test-key";

  const { createServer } = await import("../mcp-server/src/server.js");
  const { Client } = await import(new URL("client/index.js", sdkDir).href);
  const { InMemoryTransport } = await import(new URL("inMemory.js", sdkDir).href);
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const list = async (args) => {
    requests.length = 0;
    const result = await client.callTool({ name: "list_market_topics", arguments: args }).catch((error) => ({
      isError: true,
      content: [{ type: "text", text: String(error.message) }]
    }));
    const url = requests[0] ? new URL(requests[0].url, "http://hedgehub.test") : null;
    return { result, count: requests.length, path: url?.pathname, params: Object.fromEntries(url?.searchParams ?? []), request: requests[0] };
  };

  try {
    // The tool declares the three filters, all optional, with the values HedgeHub accepts.
    const { tools } = await client.listTools();
    const { inputSchema } = tools.find((tool) => tool.name === "list_market_topics");
    assert.deepEqual(Object.keys(inputSchema.properties).sort(), ["category", "status", "symbol"]);
    assert.deepEqual(inputSchema.required ?? [], []);
    assert.deepEqual([...inputSchema.properties.status.enum].sort(), [...MARKET_TOPIC_STATUS_FILTERS].sort());
    assert.deepEqual([...inputSchema.properties.category.enum].sort(), [...MARKET_TOPIC_CATEGORIES].sort());

    // No filters: the same bare request existing clients and prompts have always made.
    const bare = await list({});
    assert.equal(bare.result.isError, undefined);
    assert.equal(bare.request.method, "GET");
    assert.equal(bare.request.url, "/api/gpt/market-topics");
    assert.equal(bare.request.apiKey, "test-key");
    assert.deepEqual(JSON.parse(bare.result.content[0].text), [{ id: 1, title: "Fed policy" }]);

    // Each filter is sent when given, and only then.
    assert.deepEqual((await list({ status: "active" })).params, { status: "active" });
    assert.deepEqual((await list({ category: "social" })).params, { category: "social" });
    assert.deepEqual((await list({ symbol: "TSLA" })).params, { symbol: "TSLA" });
    const all = await list({ status: "archived", category: "ticker", symbol: "tsla" });
    assert.equal(all.path, "/api/gpt/market-topics");
    assert.deepEqual(all.params, { status: "archived", category: "ticker", symbol: "tsla" });

    // A value HedgeHub would not accept is turned away before any request is made.
    for (const args of [{ status: "deleted" }, { category: "crypto" }, { symbol: "" }]) {
      const rejected = await list(args);
      assert.equal(rejected.result.isError, true, JSON.stringify(args));
      assert.equal(rejected.count, 0, `${JSON.stringify(args)} must not reach HedgeHub`);
    }
  } finally {
    await client.close();
    await server.close();
    hedgehub.closeAllConnections();
    await new Promise((resolve) => hedgehub.close(resolve));
  }
});
