import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

type AuthState = { checked: boolean; username: string | null; token: string | null };

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api(path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `request failed (${res.status})`, res.status);
  return json;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ checked: false, username: null, token: null });

  useEffect(() => {
    api("/auth/me")
      .then((d) => setState({ checked: true, username: d.username, token: d.token }))
      .catch(() => setState({ checked: true, username: null, token: null }));
  }, []);

  // reproduced live: no body meant api()'s method:body?"POST":"GET" picked GET, but the server
  // only registers POST /auth/logout — 404'd silently (no .catch), button looked dead.
  const logout = () =>
    api("/auth/logout", {})
      .catch(() => {})
      .then(() => setState({ checked: true, username: null, token: null }));

  return { ...state, setState, logout };
}

export function LoginForm({ onAuthed }: { onAuthed: (username: string, token: string) => void }) {
  const [signupAvailable, setSignupAvailable] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/auth/signup-available")
      .then((d) => {
        setSignupAvailable(d.available);
        if (d.available) setMode("signup");
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const d = await api(mode === "signup" ? "/auth/signup" : "/auth/login", { username, password });
      onAuthed(d.username, d.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page auth-page">
      <h1>VALET</h1>
      <form className="auth-form" onSubmit={submit}>
        <h2>{mode === "signup" ? "Set up your account" : "Sign in"}</h2>
        <input autoFocus placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" disabled={busy}>
          {mode === "signup" ? "Create account" : "Sign in"}
        </button>
        {signupAvailable === false && mode === "login" && <p className="muted">Single-account tool — this is the only sign-in.</p>}
      </form>
    </main>
  );
}
