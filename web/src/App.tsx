import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { AnimatePresence } from "motion/react";
import DeskMode from "./DeskMode.tsx";
import { useAuth, LoginForm } from "./Auth.tsx";
import { JobCard, type Job } from "./JobCard.tsx";
import { History } from "./History.tsx";
import { Stats } from "./Stats.tsx";
import { useLenis } from "./useLenis.ts";
import { PushToggle } from "./PushToggle.tsx";
import { Landing } from "./Landing.tsx";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";

type Status = { order: { id: string; createdAt: string; jobs: Job[] } | null; runnerOnline?: boolean };
type Tab = "today" | "history" | "stats";

function useDashboardSocket(onStatus: (s: Status) => void) {
  useEffect(() => {
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      // cookie rides along automatically on same-site requests, including WS upgrades
      ws = new WebSocket(`${WS_URL}/ws/dashboard`);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "status") onStatus({ order: msg.order, runnerOnline: msg.runnerOnline });
      };
      ws.onclose = () => {
        retryTimer = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      clearTimeout(retryTimer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function Dashboard({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [priorities, setPriorities] = useState("");
  const [status, setStatus] = useState<Status>({ order: null });
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as Tab) ?? "today";
  const highlightJob = searchParams.get("job");

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(searchParams);
    if (t === "today") next.delete("tab");
    else next.set("tab", t);
    setSearchParams(next, { replace: true });
  };

  useDashboardSocket(setStatus);
  useLenis();

  useEffect(() => {
    const fetchPriorities = () =>
      fetch(`${API_URL}/api/priorities`, { credentials: "include" })
        .then((r) => r.json())
        .then((d) => setPriorities(d.summary))
        .catch(() => {});
    fetchPriorities();
    const id = setInterval(fetchPriorities, 60_000); // matches the server's cache TTL
    return () => clearInterval(id);
  }, []);

  // a push notification's "job" deep link: jump straight to the ticket it's about.
  useEffect(() => {
    if (!highlightJob) return;
    document.getElementById(`job-${highlightJob}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightJob, status]);

  return (
    <main className="page">
      <div className="page-head">
        <h1>VALET</h1>
        <div className="who">
          {status.runnerOnline !== undefined && (
            <span
              className={`runner-dot ${status.runnerOnline ? "runner-online" : "runner-offline"}`}
              title={status.runnerOnline ? "Runner on your Mac is connected" : "Runner on your Mac is not connected"}
            >
              ● {status.runnerOnline ? "Mac connected" : "Mac disconnected"}
            </span>
          )}
          {" · "}
          {username} · <PushToggle /> · <button className="link-button" onClick={onLogout}>sign out</button>
        </div>
      </div>

      <nav className="tabs">
        {(["today", "history", "stats"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "tab-active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      {tab === "today" && (
        <>
          <section>
            <h2>Today</h2>
            <p className="priorities">{priorities || "Loading…"}</p>
          </section>

          <DeskMode />

          <section>
            <h2>Latest order</h2>
            {!status.order && <p className="muted">Nothing running yet.</p>}
            {status.order && (
              <ul className="jobs">
                <AnimatePresence initial={false}>
                  {status.order.jobs.map((job) => (
                    <JobCard key={job.id} job={job} highlighted={job.ticket_id === highlightJob} />
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </section>
        </>
      )}

      {tab === "history" && (
        <section>
          <h2>History</h2>
          <History />
        </section>
      )}

      {tab === "stats" && (
        <section>
          <h2>Tool latency</h2>
          <Stats />
        </section>
      )}
    </main>
  );
}

export default function App() {
  const { checked, username, setState, logout } = useAuth();

  if (!checked) return null;

  return (
    <Routes>
      <Route path="/" element={<Landing authed={!!username} />} />
      <Route
        path="/login"
        element={username ? <Navigate to="/app" replace /> : <LoginForm onAuthed={(u) => setState({ checked: true, username: u })} />}
      />
      <Route path="/app" element={username ? <Dashboard username={username} onLogout={logout} /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
