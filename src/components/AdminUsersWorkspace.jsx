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

export default function AdminUsersWorkspace({ onAuthRequired = null } = {}) {
  const [users, setUsers] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
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
      const [usersResponse, keysResponse] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/api-keys")
      ]);
      handleAuthError(usersResponse);
      handleAuthError(keysResponse);

      const [usersPayload, keysPayload] = await Promise.all([
        usersResponse.json().catch(() => null),
        keysResponse.json().catch(() => null)
      ]);

      if (!usersResponse.ok) {
        throw new Error(usersPayload?.error || `Failed to load users (${usersResponse.status})`);
      }
      if (!keysResponse.ok) {
        throw new Error(keysPayload?.error || `Failed to load API keys (${keysResponse.status})`);
      }

      const nextUsers = Array.isArray(usersPayload?.users) ? usersPayload.users : [];
      const nextApiKeys = Array.isArray(keysPayload?.apiKeys) ? keysPayload.apiKeys : [];
      setUsers(nextUsers);
      setApiKeys(nextApiKeys);
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
          </div>
          <span className="timestamp">{loading ? "Loading…" : "Manage user access and GPT API keys."}</span>
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
    </main>
  );
}
