#!/usr/bin/env node

import http from "node:http";
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 8799;

function usage() {
  process.stderr.write(`Usage:
  node scripts/codex-docker-bridge.js status
  node scripts/codex-docker-bridge.js ps
  node scripts/codex-docker-bridge.js health
  node scripts/codex-docker-bridge.js logs <service> [--tail N] [--follow]
  node scripts/codex-docker-bridge.js inspect <service>
  node scripts/codex-docker-bridge.js events [--since 10m]
  node scripts/codex-docker-bridge.js config-summary
`);
}

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const args = [];
  const flags = new Map();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, "true");
    }
  }

  return {
    command,
    args,
    flags
  };
}

function buildRequestPath(parsed) {
  switch (parsed.command) {
    case "status":
      return "/status";
    case "ps":
      return "/ps";
    case "health":
      return "/health";
    case "config-summary":
      return "/config-summary";
    case "inspect": {
      const service = parsed.args[0];
      if (!service) {
        throw new Error("inspect requires a service name");
      }
      return `/inspect/${encodeURIComponent(service)}`;
    }
    case "logs": {
      const service = parsed.args[0];
      if (!service) {
        throw new Error("logs requires a service name");
      }
      const searchParams = new URLSearchParams();
      if (parsed.flags.has("tail")) {
        searchParams.set("tail", parsed.flags.get("tail"));
      }
      if (parsed.flags.has("follow")) {
        searchParams.set("follow", "true");
      }
      const query = searchParams.toString();
      return `/logs/${encodeURIComponent(service)}${query ? `?${query}` : ""}`;
    }
    case "events": {
      const searchParams = new URLSearchParams();
      if (parsed.flags.has("since")) {
        searchParams.set("since", parsed.flags.get("since"));
      }
      const query = searchParams.toString();
      return `/events${query ? `?${query}` : ""}`;
    }
    default:
      throw new Error(`Unknown command: ${parsed.command || "unknown"}`);
  }
}

function requestBridge(pathname, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        path: pathname,
        method: "GET"
      },
      (response) => {
        if (stream) {
          if ((response.statusCode ?? 500) >= 400) {
            let errorBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              errorBody += chunk;
            });
            response.on("end", () => {
              reject(new Error(errorBody.trim() || `Bridge request failed (${response.statusCode})`));
            });
            return;
          }

          response.pipe(process.stdout);
          response.on("end", resolve);
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(body.trim() || `Bridge request failed (${response.statusCode})`));
            return;
          }
          resolve(body);
        });
      }
    );

    request.on("error", (error) => {
      reject(
        new Error(
          `Could not reach Docker diagnostics bridge at http://${BRIDGE_HOST}:${BRIDGE_PORT}. ${error.message}`
        )
      );
    });

    request.end();
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.flags.has("help")) {
    usage();
    process.exit(parsed.command ? 0 : 1);
  }

  const pathname = buildRequestPath(parsed);
  const isLogFollow = parsed.command === "logs" && parsed.flags.has("follow");

  if (isLogFollow) {
    await requestBridge(pathname, { stream: true });
    return;
  }

  const body = await requestBridge(pathname);
  try {
    const parsedBody = JSON.parse(body);
    process.stdout.write(`${JSON.stringify(parsedBody, null, 2)}\n`);
  } catch (_error) {
    process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
