import crypto from "node:crypto";
import {
  claimLegacyUserData,
  countUsers,
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  getSessionWithUser,
  getUserByUsername,
  touchSession
} from "./db.js";

const COOKIE_NAME = "hedgehub_session";
const DEFAULT_SESSION_DAYS = Math.max(Number(process.env.HEDGEHUB_SESSION_DAYS ?? 30) || 30, 1);
const PASSWORD_MIN_LENGTH = Math.max(Number(process.env.HEDGEHUB_PASSWORD_MIN_LENGTH ?? 10) || 10, 8);

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function readRequestCookie(request, name) {
  const cookieHeader = String(request.headers?.cookie ?? "").trim();
  if (!cookieHeader) {
    return "";
  }

  const entries = cookieHeader.split(";").map((chunk) => chunk.trim());
  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    if (key !== name) {
      continue;
    }

    return entry.slice(separatorIndex + 1).trim();
  }

  return "";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function addDays(date, days) {
  const ms = Math.max(Math.round(Number(days) || 0), 0) * 24 * 60 * 60 * 1000;
  return new Date(date.getTime() + ms);
}

function shouldUseSecureCookie(request) {
  const override = String(process.env.HEDGEHUB_COOKIE_SECURE ?? "").trim().toLowerCase();
  if (override === "true") {
    return true;
  }
  if (override === "false") {
    return false;
  }

  return Boolean(request.secure);
}

function buildSafeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}

function createPasswordHash(password) {
  const secret = String(password ?? "");
  if (secret.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024
  });

  return `scrypt$16384$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  const secret = String(password ?? "");
  const raw = String(storedHash ?? "");
  if (!secret || !raw.startsWith("scrypt$")) {
    return false;
  }

  const parts = raw.split("$");
  if (parts.length !== 6) {
    return false;
  }

  const [, nRaw, rRaw, pRaw, saltHex, keyHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt;
  let expected;

  try {
    salt = Buffer.from(String(saltHex ?? ""), "hex");
    expected = Buffer.from(String(keyHex ?? ""), "hex");
  } catch (_error) {
    return false;
  }

  if (!salt.length || !expected.length) {
    return false;
  }

  const actual = crypto.scryptSync(secret, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 32 * 1024 * 1024
  });

  try {
    return crypto.timingSafeEqual(actual, expected);
  } catch (_error) {
    return false;
  }
}

function setSessionCookie(request, response, token) {
  const secure = shouldUseSecureCookie(request);
  const maxAgeSeconds = DEFAULT_SESSION_DAYS * 24 * 60 * 60;

  response.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: maxAgeSeconds * 1000,
    path: "/"
  });
}

function clearSessionCookie(request, response) {
  const secure = shouldUseSecureCookie(request);

  response.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/"
  });
}

export function requireAuth(request, response, next) {
  try {
    deleteExpiredSessions(nowIso());
    const token = readRequestCookie(request, COOKIE_NAME);
    if (!token) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    const tokenHash = hashToken(token);
    const session = getSessionWithUser(tokenHash);
    if (!session) {
      clearSessionCookie(request, response);
      response.status(401).json({ error: "Session expired" });
      return;
    }

    if (String(session.expiresAt ?? "") <= nowIso()) {
      deleteSession(tokenHash);
      clearSessionCookie(request, response);
      response.status(401).json({ error: "Session expired" });
      return;
    }

    if (Number(session.disabled ?? 0) === 1) {
      response.status(403).json({ error: "Account disabled" });
      return;
    }

    request.user = {
      id: session.userId,
      username: session.username,
      role: session.role
    };
    request.sessionTokenHash = tokenHash;
    touchSession(tokenHash);
    next();
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
}

export function requireAdmin(request, response, next) {
  if (request.user?.role !== "admin") {
    response.status(403).json({ error: "Admin access required" });
    return;
  }

  next();
}

export function registerAuthRoutes(app) {
  app.get("/api/auth/config", (_request, response) => {
    response.json({
      needsBootstrap: countUsers() === 0
    });
  });

  app.post("/api/auth/bootstrap", (request, response) => {
    if (countUsers() > 0) {
      response.status(400).json({ error: "Bootstrap has already been completed" });
      return;
    }

    const username = normalizeUsername(request.body?.username);
    const password = String(request.body?.password ?? "");

    if (!username) {
      response.status(400).json({ error: "username is required" });
      return;
    }

    try {
      const user = createUser({
        id: crypto.randomUUID(),
        username,
        passwordHash: createPasswordHash(password),
        role: "admin",
        disabled: false
      });

      claimLegacyUserData(user.id);

      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = addDays(new Date(), DEFAULT_SESSION_DAYS).toISOString();
      createSession({
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt
      });

      setSessionCookie(request, response, token);
      response.status(201).json({ ok: true, user: buildSafeUser(user) });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/login", (request, response) => {
    const username = normalizeUsername(request.body?.username);
    const password = String(request.body?.password ?? "");

    if (!username || !password) {
      response.status(400).json({ error: "username and password are required" });
      return;
    }

    const user = getUserByUsername(username);
    if (!user || Number(user.disabled ?? 0) === 1) {
      response.status(401).json({ error: "Invalid credentials" });
      return;
    }

    if (!verifyPassword(password, user.passwordHash)) {
      response.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = addDays(new Date(), DEFAULT_SESSION_DAYS).toISOString();
    createSession({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt
    });

    setSessionCookie(request, response, token);
    response.json({ ok: true, user: buildSafeUser(user) });
  });

  app.post("/api/auth/logout", (request, response) => {
    const token = readRequestCookie(request, COOKIE_NAME);
    if (token) {
      deleteSession(hashToken(token));
    }

    clearSessionCookie(request, response);
    response.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, (request, response) => {
    response.json({ user: buildSafeUser(request.user) });
  });
}

export function createAdminUser({ username, password, role = "admin" } = {}) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("username is required");
  }

  const user = createUser({
    id: crypto.randomUUID(),
    username: normalizedUsername,
    passwordHash: createPasswordHash(password),
    role,
    disabled: false
  });

  return buildSafeUser(user);
}

export function hashPlaintextPassword(password) {
  return createPasswordHash(password);
}
