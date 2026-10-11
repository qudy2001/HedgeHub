import { useCallback, useEffect, useMemo, useState } from "react";

function normalizeRole(value) {
  return String(value ?? "").trim().toLowerCase() === "admin" ? "admin" : "user";
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString("en-GB");
}

function formatNumber(value, options = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", options).format(numeric);
}

function formatResponseTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  return `${formatNumber(numeric, {
    minimumFractionDigits: numeric % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 1
  })} ms`;
}

function formatPriceRange(low, high) {
  const lowValue = Number(low);
  const highValue = Number(high);
  if (!Number.isFinite(lowValue) && !Number.isFinite(highValue)) {
    return "n/a";
  }

  if (Number.isFinite(lowValue) && Number.isFinite(highValue)) {
    return `${formatNumber(lowValue, { maximumFractionDigits: 2 })} - ${formatNumber(highValue, {
      maximumFractionDigits: 2
    })}`;
  }

  return Number.isFinite(lowValue)
    ? `From ${formatNumber(lowValue, { maximumFractionDigits: 2 })}`
    : `Up to ${formatNumber(highValue, { maximumFractionDigits: 2 })}`;
}

function formatApiKeyLabel(apiKey) {
  const label = String(apiKey?.apiKeyLabel ?? "").trim();
  const prefix = String(apiKey?.apiKeyPrefix ?? "").trim();
  if (label && prefix) {
    return `${label} (${prefix}…)`;
  }
  if (label) {
    return label;
  }
  if (prefix) {
    return `${prefix}…`;
  }
  return "n/a";
}

function formatRequestBody(value) {
  if (!value || typeof value !== "object") {
    return "n/a";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return "n/a";
  }
}

function getStatusTone(code) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) {
    return "ghost";
  }

  if (numeric >= 200 && numeric < 300) {
    return "live";
  }
  if (numeric >= 400) {
    return "warning";
  }
  return "ghost";
}

export default function AdminUsersWorkspace({ onAuthRequired = null } = {}) {
  const [users, setUsers] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [apiUsageSummary, setApiUsageSummary] = useState(null);
  const [apiUsageRequests, setApiUsageRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");

  const [selectedUserId, setSelectedUserId] = useState("");
  const [apiKeyLabel, setApiKeyLabel] = useState("GPT access");

  const userCountLabel = useMemo(() => {
    const count = users.length;
    return `${count} ${count === 1 ? "user" : "users"}`;
  }, [users.length]);

  const apiKeyCountLabel = useMemo(() => {
    const count = apiKeys.length;
    return `${count} ${count === 1 ? "API key" : "API keys"}`;
  }, [apiKeys.length]);

  const apiRequestCountLabel = useMemo(() => {
    const count = apiUsageSummary?.totalRequests ?? apiUsageRequests.length;
    return `${count} ${count === 1 ? "request" : "requests"}`;
  }, [apiUsageRequests.length, apiUsageSummary?.totalRequests]);

  const handleAuthError = useCallback(
    (response) => {
      if (response.status !== 401) {
        return;
      }

      onAuthRequired?.("Session expired");
      const authError = new Error("Authentication required");
      authError.code = "AUTH_REQUIRED";
      throw authError;
    },
    [onAuthRequired]
  );

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [usersResponse, keysResponse, usageResponse] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/api-keys"),
        fetch("/api/admin/api-usage")
      ]);
      handleAuthError(usersResponse);
      handleAuthError(keysResponse);
      handleAuthError(usageResponse);

      const [usersPayload, keysPayload, usagePayload] = await Promise.all([
        usersResponse.json().catch(() => null),
        keysResponse.json().catch(() => null),
        usageResponse.json().catch(() => null)
      ]);

      if (!usersResponse.ok) {
        throw new Error(usersPayload?.error || `Failed to load users (${usersResponse.status})`);
      }
      if (!keysResponse.ok) {
        throw new Error(keysPayload?.error || `Failed to load API keys (${keysResponse.status})`);
      }
      if (!usageResponse.ok) {
        throw new Error(usagePayload?.error || `Failed to load API usage (${usageResponse.status})`);
      }

      const nextUsers = Array.isArray(usersPayload?.users) ? usersPayload.users : [];
      const nextApiKeys = Array.isArray(keysPayload?.apiKeys) ? keysPayload.apiKeys : [];
      const nextUsageRequests = Array.isArray(usagePayload?.requests) ? usagePayload.requests : [];
      setUsers(nextUsers);
      setApiKeys(nextApiKeys);
      setApiUsageSummary(usagePayload?.summary ?? null);
      setApiUsageRequests(nextUsageRequests);
      setSelectedUserId((current) => current || nextUsers[0]?.id || "");
      setNotice(null);
    } catch (loadError) {
      if (String(loadError?.code ?? "") !== "AUTH_REQUIRED") {
        setError(loadError.message);
      }
    } finally {
      setLoading(false);
    }
  }, [handleAuthError]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const handleCreateUser = useCallback(
    async (event) => {
      event.preventDefault();
      const trimmedUsername = username.trim();
      const normalizedRole = normalizeRole(role);

      if (!trimmedUsername) {
        setError("username is required");
        return;
      }

      if (!password) {
        setError("password is required");
        return;
      }

      setBusy(true);
      setError("");
      setNotice(null);

      try {
        const response = await fetch("/api/admin/users", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            username: trimmedUsername,
            password,
            role: normalizedRole
          })
        });
        handleAuthError(response);
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Failed to create user (${response.status})`);
        }

        setUsername("");
        setPassword("");
        setRole("user");
        if (!selectedUserId && payload?.user?.id) {
          setSelectedUserId(payload.user.id);
        }
        setUsers((current) => (payload?.user ? [payload.user, ...(current ?? [])] : current));
        setNotice({
          tone: "success",
          message: `Created ${payload?.user?.username ?? trimmedUsername} (${payload?.user?.role ?? normalizedRole}).`
        });
      } catch (createError) {
        if (String(createError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(createError.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [handleAuthError, password, role, selectedUserId, username]
  );

  const handleCreateApiKey = useCallback(
    async (event) => {
      event.preventDefault();
      const label = apiKeyLabel.trim() || "GPT access";

      if (!selectedUserId) {
        setError("Select a user for the API key");
        return;
      }

      setBusy(true);
      setError("");
      setNotice(null);

      try {
        const response = await fetch("/api/admin/api-keys", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            userId: selectedUserId,
            label
          })
        });
        handleAuthError(response);
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Failed to create API key (${response.status})`);
        }

        const createdKey = payload?.apiKey ?? null;
        if (createdKey) {
          setApiKeys((current) => [
            {
              ...createdKey,
              plainTextKey: undefined
            },
            ...(current ?? [])
          ]);
        }
        setApiKeyLabel("GPT access");
        setNotice({
          tone: "success",
          message: createdKey?.plainTextKey
            ? `New API key for ${createdKey.username} (${createdKey.label}): ${createdKey.plainTextKey}`
            : "API key created."
        });
      } catch (createError) {
        if (String(createError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(createError.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [apiKeyLabel, handleAuthError, selectedUserId]
  );

  const handleRevokeApiKey = useCallback(
    async (id) => {
      setBusy(true);
      setError("");
      setNotice(null);

      try {
        const response = await fetch(`/api/admin/api-keys/${encodeURIComponent(id)}`, {
          method: "DELETE"
        });
        handleAuthError(response);
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Failed to revoke API key (${response.status})`);
        }

        setApiKeys((current) =>
          (current ?? []).map((item) =>
            item.id === id
              ? {
                  ...item,
                  revokedAt: new Date().toISOString()
                }
              : item
          )
        );
        setNotice({
          tone: "success",
          message: "API key revoked."
        });
      } catch (revokeError) {
        if (String(revokeError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(revokeError.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [handleAuthError]
  );

  return (
    <main className="workspace workspace--admin-users">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Admin</span>
          <h2>User accounts and API keys</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--ghost">{userCountLabel}</span>
            <span className="pill pill--live">{apiKeyCountLabel}</span>
            <span className="pill pill--ghost">{apiRequestCountLabel}</span>
          </div>
          <span className="timestamp">
            {loading ? "Loading…" : "Manage user access, GPT API keys, and API usage visibility."}
          </span>
        </div>
      </header>

      <article className="insight-card admin-users__panel">
        <div className="admin-users__layout">
          <section className="admin-users__section">
            <h3>Create user</h3>
            <form className="admin-users__form" onSubmit={handleCreateUser}>
              <label>
                <span>Username</span>
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="trader1"
                  disabled={busy}
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Minimum length enforced"
                  disabled={busy}
                />
              </label>
              <label>
                <span>Role</span>
                <select value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </label>

              <div className="admin-users__actions">
                <button
                  type="submit"
                  className="macro-layout-button macro-layout-button--primary"
                  disabled={busy || !username.trim() || !password}
                >
                  {busy ? "Working…" : "Create"}
                </button>
                <button type="button" className="macro-layout-button" onClick={loadWorkspace} disabled={busy || loading}>
                  Refresh
                </button>
              </div>
            </form>

            <h3>Issue API key</h3>
            <form className="admin-users__form" onSubmit={handleCreateApiKey}>
              <label>
                <span>User</span>
                <select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} disabled={busy}>
                  <option value="">Select user</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.username} ({normalizeRole(user.role)})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Key label</span>
                <input
                  value={apiKeyLabel}
                  onChange={(event) => setApiKeyLabel(event.target.value)}
                  placeholder="GPT access"
                  disabled={busy}
                />
              </label>
              <div className="admin-users__actions">
                <button
                  type="submit"
                  className="macro-layout-button macro-layout-button--primary"
                  disabled={busy || !selectedUserId}
                >
                  {busy ? "Working…" : "Create API key"}
                </button>
              </div>
            </form>

            {notice ? (
              <div className={`refresh-feedback refresh-feedback--${notice.tone || "info"}`}>{notice.message}</div>
            ) : null}
            {error ? <div className="refresh-feedback refresh-feedback--error">{error}</div> : null}
          </section>

          <section className="admin-users__section">
            <h3>Existing users</h3>
            {loading ? (
              <div className="app-state app-state--inline">Loading users…</div>
            ) : users.length ? (
              <div className="admin-users__list">
                {users.map((user) => (
                  <div key={user.id} className="admin-users__row">
                    <div className="admin-users__identity">
                      <strong>{user.username}</strong>
                      <span className="timestamp">Created {formatTimestamp(user.createdAt)}</span>
                    </div>
                    <div className="admin-users__badges">
                      <span className={`pill ${user.role === "admin" ? "pill--warning" : "pill--ghost"}`}>
                        {normalizeRole(user.role)}
                      </span>
                      <span className={`pill ${user.disabled ? "pill--short" : "pill--live"}`}>
                        {user.disabled ? "disabled" : "active"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="app-state app-state--inline">No users found.</div>
            )}

            <h3>Issued API keys</h3>
            {loading ? (
              <div className="app-state app-state--inline">Loading API keys…</div>
            ) : apiKeys.length ? (
              <div className="admin-users__list">
                {apiKeys.map((apiKey) => (
                  <div key={apiKey.id} className="admin-users__row">
                    <div className="admin-users__identity">
                      <strong>{apiKey.label}</strong>
                      <span className="timestamp">
                        {apiKey.username} · {apiKey.tokenPrefix}… · Created {formatTimestamp(apiKey.createdAt)}
                      </span>
                      <span className="timestamp">Last used {formatTimestamp(apiKey.lastUsedAt)}</span>
                    </div>
                    <div className="admin-users__badges">
                      <span className={`pill ${apiKey.revokedAt ? "pill--short" : "pill--live"}`}>
                        {apiKey.revokedAt ? "revoked" : "active"}
                      </span>
                      {!apiKey.revokedAt ? (
                        <button
                          type="button"
                          className="macro-layout-button"
                          onClick={() => void handleRevokeApiKey(apiKey.id)}
                          disabled={busy}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="app-state app-state--inline">No API keys issued yet.</div>
            )}
          </section>
        </div>
      </article>

      <article className="insight-card admin-usage">
        <div className="admin-usage__header">
          <div>
            <h3>GPT API usage summary</h3>
            <p className="timestamp">
              Latest activity {formatTimestamp(apiUsageSummary?.latestRequestAt)}. Unknown requests keep the source IP and
              submitted body for investigation.
            </p>
          </div>
          <button type="button" className="macro-layout-button" onClick={loadWorkspace} disabled={busy || loading}>
            Refresh usage
          </button>
        </div>

        <div className="admin-usage__summary-grid">
          <div className="admin-usage__summary-card">
            <span className="timestamp">Total requests</span>
            <strong>{formatNumber(apiUsageSummary?.totalRequests ?? 0)}</strong>
          </div>
          <div className="admin-usage__summary-card">
            <span className="timestamp">Successful</span>
            <strong>{formatNumber(apiUsageSummary?.successCount ?? 0)}</strong>
          </div>
          <div className="admin-usage__summary-card">
            <span className="timestamp">Authorized</span>
            <strong>{formatNumber(apiUsageSummary?.authorizedCount ?? 0)}</strong>
          </div>
          <div className="admin-usage__summary-card">
            <span className="timestamp">Unknown / rejected</span>
            <strong>{formatNumber(apiUsageSummary?.unknownCount ?? 0)}</strong>
          </div>
          <div className="admin-usage__summary-card">
            <span className="timestamp">Unique IPs</span>
            <strong>{formatNumber(apiUsageSummary?.uniqueIpCount ?? 0)}</strong>
          </div>
          <div className="admin-usage__summary-card">
            <span className="timestamp">Users seen</span>
            <strong>{formatNumber(apiUsageSummary?.uniqueUserCount ?? 0)}</strong>
          </div>
          <div className="admin-usage__summary-card">
            <span className="timestamp">Average response</span>
            <strong>{formatResponseTime(apiUsageSummary?.averageResponseTimeMs)}</strong>
          </div>
        </div>

        <div className="admin-usage__list">
          <div className="admin-usage__list-header">
            <h3>Recent GPT API requests</h3>
            <span className="pill pill--ghost">{apiRequestCountLabel}</span>
          </div>

          {loading ? (
            <div className="app-state app-state--inline">Loading API usage…</div>
          ) : apiUsageRequests.length ? (
            <div className="admin-usage__rows">
              {apiUsageRequests.map((requestLog) => {
                const statusTone = getStatusTone(requestLog.statusCode);
                const isUnknown = requestLog.authStatus !== "authorized";
                return (
                  <div key={requestLog.id} className="admin-usage__row">
                    <div className="admin-usage__row-top">
                      <div className="admin-users__identity">
                        <strong>
                          {requestLog.requestTicker || "Unknown ticker"} · {requestLog.systemName || "gpt-strategy-query"}
                        </strong>
                        <span className="timestamp">
                          {requestLog.method} {requestLog.path} · {formatTimestamp(requestLog.createdAt)}
                        </span>
                      </div>
                      <div className="admin-users__badges">
                        <span className={`pill pill--${statusTone}`}>{requestLog.statusCode || "n/a"}</span>
                        <span className={`pill ${isUnknown ? "pill--warning" : "pill--ghost"}`}>
                          {requestLog.authStatus || "unknown"}
                        </span>
                      </div>
                    </div>

                    <div className="admin-usage__meta-grid">
                      <div>
                        <span className="timestamp">User</span>
                        <strong>{requestLog.username || "Unknown user"}</strong>
                      </div>
                      <div>
                        <span className="timestamp">API key</span>
                        <strong>{formatApiKeyLabel(requestLog)}</strong>
                      </div>
                      <div>
                        <span className="timestamp">IP address</span>
                        <strong>{requestLog.ipAddress || "n/a"}</strong>
                      </div>
                      <div>
                        <span className="timestamp">Response time</span>
                        <strong>{formatResponseTime(requestLog.responseTimeMs)}</strong>
                      </div>
                      <div>
                        <span className="timestamp">Price range</span>
                        <strong>
                          {formatPriceRange(requestLog.expectedPriceRangeLow, requestLog.expectedPriceRangeHigh)}
                        </strong>
                      </div>
                      <div>
                        <span className="timestamp">Expiration window</span>
                        <strong>
                          {requestLog.optionExpirationStartDate || "n/a"} to {requestLog.optionExpirationEndDate || "n/a"}
                        </strong>
                      </div>
                    </div>

                    {requestLog.errorMessage ? (
                      <div className="refresh-feedback refresh-feedback--warning admin-usage__feedback">
                        {requestLog.errorMessage}
                      </div>
                    ) : null}

                    {isUnknown ? (
                      <div className="admin-usage__body">
                        <span className="timestamp">Captured request body</span>
                        <pre>{formatRequestBody(requestLog.requestBody)}</pre>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="app-state app-state--inline">No GPT API requests logged yet.</div>
          )}
        </div>
      </article>
    </main>
  );
}
