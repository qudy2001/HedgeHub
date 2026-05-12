import { useMemo, useState } from "react";

export default function AuthScreen({
  needsBootstrap = false,
  busy = false,
  error = "",
  onLogin,
  onBootstrap
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const mode = needsBootstrap ? "bootstrap" : "login";
  const title = needsBootstrap ? "Create admin account" : "Sign in";
  const subtitle = needsBootstrap
    ? "Set up the first admin account for this HedgeHub instance."
    : "Sign in to access your IBKR settings and trading records.";
  const submitLabel = needsBootstrap ? "Create admin" : "Sign in";

  const validationError = useMemo(() => {
    if (!username.trim()) {
      return "";
    }

    if (!password) {
      return "";
    }

    if (needsBootstrap && password !== confirmPassword) {
      return "Passwords do not match.";
    }

    return "";
  }, [confirmPassword, needsBootstrap, password, username]);

  const canSubmit = Boolean(
    username.trim() &&
      password &&
      (!needsBootstrap || password === confirmPassword) &&
      typeof (needsBootstrap ? onBootstrap : onLogin) === "function" &&
      busy !== true
  );

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    const normalizedUsername = username.trim();
    if (needsBootstrap) {
      await onBootstrap(normalizedUsername, password);
      return;
    }

    await onLogin(normalizedUsername, password);
  }

  return (
    <div className="auth-screen" data-mode={mode}>
      <div className="auth-card">
        <header className="auth-card__header">
          <div className="auth-card__brand">HedgeHub</div>
          <h1 className="auth-card__title">{title}</h1>
          <p className="auth-card__subtitle">{subtitle}</p>
        </header>

        {error ? <div className="auth-feedback auth-feedback--error">{error}</div> : null}
        {validationError ? (
          <div className="auth-feedback auth-feedback--warning">{validationError}</div>
        ) : null}

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete={needsBootstrap ? "username" : "username"}
              spellCheck={false}
              placeholder="admin"
              disabled={busy}
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={needsBootstrap ? "new-password" : "current-password"}
              disabled={busy}
              placeholder={needsBootstrap ? "Create a strong password" : "Your password"}
            />
          </label>

          {needsBootstrap ? (
            <label className="auth-field">
              <span>Confirm password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                disabled={busy}
                placeholder="Repeat password"
              />
            </label>
          ) : null}

          <button
            type="submit"
            className="macro-layout-button macro-layout-button--primary auth-submit"
            disabled={!canSubmit}
          >
            {busy ? "Working…" : submitLabel}
          </button>
        </form>
      </div>
    </div>
  );
}

