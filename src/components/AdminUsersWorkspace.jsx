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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");

  const userCountLabel = useMemo(() => {
    const count = users.length;
    return `${count} ${count === 1 ? "user" : "users"}`;
  }, [users.length]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/admin/users");
      const payload = await response.json().catch(() => null);

      if (response.status === 401) {
        onAuthRequired?.("Session expired");
        const authError = new Error("Authentication required");
        authError.code = "AUTH_REQUIRED";
        throw authError;
      }

      if (!response.ok) {
        throw new Error(payload?.error || `Failed to load users (${response.status})`);
      }

      setUsers(Array.isArray(payload?.users) ? payload.users : []);
      setNotice(null);
    } catch (loadError) {
      if (String(loadError?.code ?? "") !== "AUTH_REQUIRED") {
        setError(loadError.message);
      }
    } finally {
      setLoading(false);
    }
  }, [onAuthRequired]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

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
        const payload = await response.json().catch(() => null);

        if (response.status === 401) {
          onAuthRequired?.("Session expired");
          const authError = new Error("Authentication required");
          authError.code = "AUTH_REQUIRED";
          throw authError;
        }

        if (!response.ok) {
          throw new Error(payload?.error || `Failed to create user (${response.status})`);
        }

        setUsername("");
        setPassword("");
        setRole("user");
        setNotice({
          tone: "success",
          message: `Created ${payload?.user?.username ?? trimmedUsername} (${payload?.user?.role ?? normalizedRole}).`
        });

        if (payload?.user) {
          setUsers((current) => [payload.user, ...(current ?? [])]);
        } else {
          await loadUsers();
        }
      } catch (createError) {
        if (String(createError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(createError.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [loadUsers, onAuthRequired, password, role, username]
  );

  return (
    <main className="workspace workspace--admin-users">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Admin</span>
          <h2>User accounts</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--ghost">{userCountLabel}</span>
          </div>
          <span className="timestamp">{loading ? "Loading…" : "Manage access to this instance."}</span>
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
                  {busy ? "Creating…" : "Create"}
                </button>
                <button type="button" className="macro-layout-button" onClick={loadUsers} disabled={busy || loading}>
                  Refresh
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
          </section>
        </div>
      </article>
    </main>
  );
}

