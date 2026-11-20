import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { logError, logInfo, logWarn } from "./logger.js";

const ROOT_DIR = process.cwd();
const COMPOSE_FILE = path.join(ROOT_DIR, "docker-compose.yml");
const BRIDGE_HOST = "0.0.0.0";
const BRIDGE_PORT = 8799;
const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const ALLOWED_SERVICES = new Set(["postgres", "web", "scanner"]);
const REDACTED_VALUE = "[redacted]";
const SECRET_KEY_PATTERN = /(pass(word)?|token|secret|api[_-]?key|database[_-]?url|cookie|auth|credential)/i;

const bridgeState = {
  enabled: false,
  running: false,
  server: null,
  lastError: null,
  lastHealthCheckAt: null,
  startedAt: null
};

function normalizeServiceName(value) {
  const normalized = String(value ?? "").trim();
  if (!ALLOWED_SERVICES.has(normalized)) {
    throw new Error(`Unsupported service: ${normalized || "unknown"}`);
  }
  return normalized;
}

function normalizeTail(value) {
  const numeric = Number.parseInt(String(value ?? "200"), 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 200;
  }
  return Math.min(numeric, 2000);
}

function normalizeSince(value) {
  const normalized = String(value ?? "10m").trim();
  return /^[0-9]+[smhd]$/i.test(normalized) ? normalized.toLowerCase() : "10m";
}

function buildComposeArgs(...args) {
  return ["compose", "--file", COMPOSE_FILE, ...args];
}

function shouldRedactKey(key) {
  return SECRET_KEY_PATTERN.test(String(key ?? ""));
}

function redactSensitiveText(raw) {
  return String(raw ?? "").replace(/^([A-Z0-9_]+)(:\s*|=).*$/gim, (line, key, separator) => {
    return shouldRedactKey(key) ? `${key}${separator}${REDACTED_VALUE}` : line;
  });
}

function redactValue(value, key = "") {
  if (shouldRedactKey(key)) {
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    if (key.toLowerCase() === "env") {
      return value.map((entry) => {
        const raw = String(entry ?? "");
        const separatorIndex = raw.indexOf("=");
        if (separatorIndex <= 0) {
          return raw;
        }
        const envKey = raw.slice(0, separatorIndex);
        return shouldRedactKey(envKey) ? `${envKey}=${REDACTED_VALUE}` : raw;
      });
    }

    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactValue(nestedValue, nestedKey)])
    );
  }

  if (typeof value === "string" && shouldRedactKey(key)) {
    return REDACTED_VALUE;
  }

  return value;
}

function parseComposePsOutput(raw) {
  const normalized = String(raw ?? "").trim();
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_error) {
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.map((line) => JSON.parse(line));
  }
}

function runCommand(command, args, { stream = false, onStdout = null, onStderr = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: stream ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
    };

    if (signal) {
      spawnOptions.signal = signal;
    }

    const child = spawn(command, args, {
      ...spawnOptions
    });

    if (stream) {
      if (typeof onStdout === "function") {
        child.stdout.on("data", onStdout);
      }
      if (typeof onStderr === "function") {
        child.stderr.on("data", onStderr);
      }
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      if (!stream) {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr.on("data", (chunk) => {
      if (!stream) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", reject);
    child.on("close", (code, closeSignal) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
          signal: closeSignal
        });
        return;
      }

      reject(
        new Error(
          (stderr || stdout || `${command} ${args.join(" ")} failed with code ${code ?? "unknown"}`).trim()
        )
      );
    });
  });
}

async function getComposePs() {
  const result = await runCommand("docker", buildComposeArgs("ps", "--all", "--format", "json"));
  return parseComposePsOutput(result.stdout);
}

async function getContainerInfoByService(service) {
  const normalizedService = normalizeServiceName(service);
  const entries = await getComposePs();
  const matched =
    entries.find((entry) => String(entry?.Service ?? entry?.service ?? "").trim() === normalizedService) ?? null;

  if (!matched) {
    return null;
  }

  return {
    service: normalizedService,
    containerId: String(matched.ID ?? matched.Id ?? "").trim(),
    containerName: String(matched.Name ?? matched.name ?? "").trim(),
    composeEntry: matched
  };
}

async function inspectService(service) {
  const containerInfo = await getContainerInfoByService(service);
  if (!containerInfo?.containerId) {
    return {
      service,
      found: false
    };
  }

  const result = await runCommand("docker", ["inspect", containerInfo.containerId]);
  const parsed = JSON.parse(result.stdout || "[]");
  return {
    service,
    found: true,
    containerId: containerInfo.containerId,
    containerName: containerInfo.containerName,
    inspect: redactValue(parsed[0] ?? null)
  };
}

async function buildHealthSummary() {
  const services = [];
  const entries = await getComposePs();

  for (const service of ALLOWED_SERVICES) {
    const composeEntry =
      entries.find((entry) => String(entry?.Service ?? entry?.service ?? "").trim() === service) ?? null;

    if (!composeEntry) {
      services.push({
        service,
        present: false,
        state: "missing",
        health: null
      });
      continue;
    }

    const containerId = String(composeEntry.ID ?? composeEntry.Id ?? "").trim();
    let inspectPayload = null;

    if (containerId) {
      const inspectResult = await runCommand("docker", ["inspect", containerId]);
      const parsed = JSON.parse(inspectResult.stdout || "[]");
      inspectPayload = parsed[0] ?? null;
    }

    services.push({
      service,
      present: true,
      state: String(composeEntry.State ?? composeEntry.state ?? "unknown"),
      health: inspectPayload?.State?.Health?.Status ?? null,
      status: inspectPayload?.State?.Status ?? null,
      startedAt: inspectPayload?.State?.StartedAt ?? null,
      ports: composeEntry.Publishers ?? composeEntry.Ports ?? []
    });
  }

  bridgeState.lastHealthCheckAt = new Date().toISOString();
  return {
    ok: true,
    checkedAt: bridgeState.lastHealthCheckAt,
    services
  };
}

async function getDockerEvents(since = "10m") {
  const containerIds = (await getComposePs())
    .map((entry) => String(entry?.ID ?? entry?.Id ?? "").trim())
    .filter(Boolean);

  if (!containerIds.length) {
    return [];
  }

  const until = new Date().toISOString();
  const args = ["events", "--since", since, "--until", until, "--format", "{{json .}}"];
  for (const containerId of containerIds) {
    args.push("--filter", `container=${containerId}`);
  }

  const result = await runCommand("docker", args);
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => JSON.parse(line));
}

async function getComposeConfigSummary() {
  try {
    const result = await runCommand("docker", buildComposeArgs("config", "--format", "json"));
    return {
      format: "json",
      payload: redactValue(JSON.parse(result.stdout || "{}"))
    };
  } catch (error) {
    const fallback = await runCommand("docker", buildComposeArgs("config"));
    return {
      format: "text",
      payload: {
        raw: redactSensitiveText(fallback.stdout)
      },
      warning: error.message
    };
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function buildBridgeStatusPayload() {
  return {
    enabled: bridgeState.enabled,
    running: bridgeState.running,
    host: BRIDGE_HOST,
    port: BRIDGE_PORT,
    bridgeUrl: BRIDGE_URL,
    composeFile: COMPOSE_FILE,
    projectRoot: ROOT_DIR,
    lastHealthCheckAt: bridgeState.lastHealthCheckAt,
    lastError: bridgeState.lastError,
    startedAt: bridgeState.startedAt
  };
}

async function handleLogsRequest(request, response, service, searchParams) {
  const normalizedService = normalizeServiceName(service);
  const tail = normalizeTail(searchParams.get("tail"));
  const follow = String(searchParams.get("follow") ?? "false").trim().toLowerCase() === "true";

  if (!follow) {
    const result = await runCommand("docker", buildComposeArgs("logs", "--no-color", "--tail", String(tail), normalizedService));
    sendJson(response, 200, {
      service: normalizedService,
      tail,
      logs: result.stdout
    });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });

  const child = spawn("docker", buildComposeArgs("logs", "--no-color", "--follow", "--tail", String(tail), normalizedService), {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    response.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    response.write(chunk);
  });
  child.on("close", () => {
    response.end();
  });
  child.on("error", (error) => {
    response.write(`Bridge log stream failed: ${error.message}\n`);
    response.end();
  });

  request.on("close", () => {
    child.kill("SIGTERM");
  });
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  try {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (requestUrl.pathname === "/status") {
      sendJson(response, 200, buildBridgeStatusPayload());
      return;
    }

    if (requestUrl.pathname === "/ps") {
      sendJson(response, 200, {
        services: await getComposePs()
      });
      return;
    }

    if (requestUrl.pathname === "/health") {
      sendJson(response, 200, await buildHealthSummary());
      return;
    }

    if (requestUrl.pathname === "/config-summary") {
      sendJson(response, 200, await getComposeConfigSummary());
      return;
    }

    if (requestUrl.pathname === "/events") {
      sendJson(response, 200, {
        since: normalizeSince(requestUrl.searchParams.get("since")),
        events: await getDockerEvents(normalizeSince(requestUrl.searchParams.get("since")))
      });
      return;
    }

    if (requestUrl.pathname.startsWith("/inspect/")) {
      const service = decodeURIComponent(requestUrl.pathname.slice("/inspect/".length));
      sendJson(response, 200, await inspectService(service));
      return;
    }

    if (requestUrl.pathname.startsWith("/logs/")) {
      const service = decodeURIComponent(requestUrl.pathname.slice("/logs/".length));
      await handleLogsRequest(request, response, service, requestUrl.searchParams);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    bridgeState.lastError = error.message;
    logError("Docker diagnostics bridge request failed", {
      subsystem: "docker-diagnostics-bridge",
      error,
      path: requestUrl.pathname
    });
    sendJson(response, 500, {
      error: error.message
    });
  }
}

export function getDockerDiagnosticsBridgeStatus() {
  return buildBridgeStatusPayload();
}

export async function setDockerDiagnosticsBridgeEnabled(enabled) {
  bridgeState.enabled = Boolean(enabled);

  if (!bridgeState.enabled) {
    await stopDockerDiagnosticsBridge();
    return getDockerDiagnosticsBridgeStatus();
  }

  if (bridgeState.running) {
    return getDockerDiagnosticsBridgeStatus();
  }

  await startDockerDiagnosticsBridge();
  return getDockerDiagnosticsBridgeStatus();
}

export async function startDockerDiagnosticsBridge() {
  if (bridgeState.running) {
    return getDockerDiagnosticsBridgeStatus();
  }

  bridgeState.lastError = null;

  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
      resolve();
    });
  });

  bridgeState.server = server;
  bridgeState.running = true;
  bridgeState.startedAt = new Date().toISOString();

  server.on("close", () => {
    bridgeState.running = false;
    bridgeState.server = null;
  });

  server.on("error", (error) => {
    bridgeState.lastError = error.message;
    logError("Docker diagnostics bridge runtime error", {
      subsystem: "docker-diagnostics-bridge",
      error
    });
  });

  try {
    await buildHealthSummary();
  } catch (error) {
    bridgeState.lastError = error.message;
    logWarn("Docker diagnostics bridge initial health check failed", {
      subsystem: "docker-diagnostics-bridge",
      error
    });
  }

  logInfo("Docker diagnostics bridge started", {
    subsystem: "docker-diagnostics-bridge",
    host: BRIDGE_HOST,
    port: BRIDGE_PORT
  });

  return getDockerDiagnosticsBridgeStatus();
}

export async function stopDockerDiagnosticsBridge() {
  const wasRunning = bridgeState.running || Boolean(bridgeState.server);

  if (bridgeState.server) {
    await new Promise((resolve) => {
      bridgeState.server.close(() => {
        resolve();
      });
    });
  }

  bridgeState.server = null;
  bridgeState.running = false;
  bridgeState.startedAt = null;

  if (wasRunning) {
    logInfo("Docker diagnostics bridge stopped", {
      subsystem: "docker-diagnostics-bridge",
      host: BRIDGE_HOST,
      port: BRIDGE_PORT
    });
  }

  return getDockerDiagnosticsBridgeStatus();
}
