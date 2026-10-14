import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callHedgeHub } from "./hedgehubClient.js";

export function createServer() {
const server = new McpServer({
  name: "hedgehub-mcp-server",
  version: "0.1.0"
});

server.registerTool(
  "list_market_topics",
  {
    title: "List market hot topics",
    description: "List the market hot topics HedgeHub currently tracks, with weight, bullish/bearish rating, and summary.",
    inputSchema: {}
  },
  async () => {
    const payload = await callHedgeHub("GET", "/api/gpt/market-topics");
    return { content: [{ type: "text", text: JSON.stringify(payload.results.topics, null, 2) }] };
  }
);

server.registerTool(
  "upsert_market_topic",
  {
    title: "Add or update a market hot topic",
    description:
      "Create a new market hot topic, or update an existing one if the title already matches (case-insensitive).",
    inputSchema: {
      title: z.string().min(1).describe("Short topic title, used to match an existing topic"),
      weight: z.number().int().min(1).max(100).describe("How much this topic currently matters, 1-100"),
      bullishScore: z.number().int().min(0).max(100).describe("Bullish rating, 0-100"),
      bearishScore: z.number().int().min(0).max(100).describe("Bearish rating, 0-100"),
      summary: z.string().min(1).describe("Short analysis summary of why this topic matters")
    }
  },
  async ({ title, weight, bullishScore, bearishScore, summary }) => {
    const payload = await callHedgeHub("POST", "/api/gpt/market-topics", {
      title,
      weight,
      bullishScore,
      bearishScore,
      summary
    });
    return { content: [{ type: "text", text: JSON.stringify(payload.results.topic, null, 2) }] };
  }
);

server.registerTool(
  "get_next_analysis_task",
  {
    title: "Get next pending analysis task",
    description:
      "Claim the oldest-due pending analysis task from HedgeHub's queue, or null if nothing is pending. " +
      "A claimed task is not handed out again; call complete_analysis_task when done, otherwise it is released after 30 minutes.",
    inputSchema: {}
  },
  async () => {
    const payload = await callHedgeHub("GET", "/api/gpt/analysis-tasks/next");
    return { content: [{ type: "text", text: JSON.stringify(payload.results.task, null, 2) }] };
  }
);

server.registerTool(
  "complete_analysis_task",
  {
    title: "Complete an analysis task",
    description: "Submit the finished analysis for a task and mark it done on HedgeHub.",
    inputSchema: {
      taskId: z.number().int().describe("The id of the task returned by get_next_analysis_task"),
      result: z.string().min(1).describe("The finished analysis write-up for this task")
    }
  },
  async ({ taskId, result }) => {
    const payload = await callHedgeHub("POST", `/api/gpt/analysis-tasks/${taskId}/complete`, { result });
    return { content: [{ type: "text", text: JSON.stringify(payload.results.task, null, 2) }] };
  }
);

return server;
}
