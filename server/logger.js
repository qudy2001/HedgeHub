import crypto from "node:crypto";

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
};

const configuredLevel = String(process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
const minimumLevel = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info;
const logAllRequests = String(process.env.HEDGEHUB_LOG_ALL_REQUESTS ?? "true").trim().toLowerCase() !== "false";
const slowRequestThresholdMs = Math.max(Number(process.env.HEDGEHUB_LOG_SLOW_REQUEST_MS ?? 1500) || 1500, 0);

function canLog(level) {
  return (LOG_LEVELS[level] ?? LOG_LEVELS.info) >= minimumLevel;
}

export function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    signal: error.signal,
    cause: error.cause ? serializeError(error.cause) : undefined
  };
}

function sanitizeMeta(value, depth = 0) {
  if (depth > 4) {
    return "[truncated]";
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMeta(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .map(([key, nestedValue]) => [key, sanitizeMeta(nestedValue, depth + 1)])
    );
  }

  return String(value);
}

function writeLog(level, message, meta = {}) {
  if (!canLog(level)) {
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...sanitizeMeta(meta)
  };

  const line = `${JSON.stringify(entry)}\n`;
  if (level === "error" || level === "fatal") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
}

export function logDebug(message, meta) {
  writeLog("debug", message, meta);
}

export function logInfo(message, meta) {
  writeLog("info", message, meta);
}

export function logWarn(message, meta) {
  writeLog("warn", message, meta);
}

export function logError(message, meta) {
  writeLog("error", message, meta);
}

export function logFatal(message, meta) {
  writeLog("fatal", message, meta);
}

export function buildRequestLogContext(request, extra = {}) {
  return {
    requestId: request.requestId,
    method: request.method,
    path: request.originalUrl || request.url,
    ip: request.ip,
    userId: request.user?.id ?? null,
    ...extra
  };
}

export function createRequestLoggingMiddleware() {
  return function requestLoggingMiddleware(request, response, next) {
    request.requestId =
      request.headers["x-request-id"] || request.headers["cf-ray"] || crypto.randomUUID();

    const startedAt = process.hrtime.bigint();
    request.requestStartedAtNs = startedAt;
    let finished = false;

    function emit(level, reason) {
      if (finished) {
        return;
      }
      finished = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const meta = buildRequestLogContext(request, {
        statusCode: response.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        reason
      });

      if (level === "error") {
        logError("HTTP request failed", meta);
      } else if (level === "warn") {
        logWarn("HTTP request completed with warning", meta);
      } else {
        logInfo("HTTP request completed", meta);
      }
    }

    response.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const isApiRequest = request.path.startsWith("/api/");
      const statusCode = response.statusCode;

      if (statusCode >= 500) {
        emit("error", "finish");
        return;
      }

      if (statusCode >= 400) {
        emit("warn", "finish");
        return;
      }

      if (isApiRequest && (logAllRequests || durationMs >= slowRequestThresholdMs)) {
        emit("info", "finish");
      }
    });

    response.on("close", () => {
      if (!response.writableEnded) {
        emit("warn", "aborted");
      }
    });

    next();
  };
}

function wrapExpressHandler(handler) {
  if (typeof handler !== "function" || handler.length === 4) {
    return handler;
  }

  return function wrappedExpressHandler(...args) {
    const next = args[2];
    try {
      const result = handler(...args);
      if (result && typeof result.then === "function") {
        result.catch(next);
      }
      return result;
    } catch (error) {
      return next(error);
    }
  };
}

function wrapExpressHandlers(handlers) {
  return handlers.map((handler) =>
    Array.isArray(handler) ? wrapExpressHandlers(handler) : wrapExpressHandler(handler)
  );
}

export function patchExpressAsync(app) {
  const methods = ["use", "all", "get", "post", "put", "patch", "delete"];
  for (const method of methods) {
    const original = app[method].bind(app);
    app[method] = (...args) => original(...wrapExpressHandlers(args));
  }
}

export function installProcessErrorHandlers() {
  process.on("unhandledRejection", (reason) => {
    logError("Unhandled promise rejection", {
      error: reason instanceof Error ? reason : new Error(String(reason))
    });
  });

  process.on("uncaughtException", (error) => {
    logFatal("Uncaught exception", { error });
  });

  process.on("warning", (warning) => {
    logWarn("Process warning", { error: warning });
  });

  process.on("SIGTERM", () => {
    logInfo("Received SIGTERM");
  });

  process.on("SIGINT", () => {
    logInfo("Received SIGINT");
  });
}
