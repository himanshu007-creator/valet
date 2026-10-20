import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import DeskMode from "./DeskMode.tsx";
import { useAuth, LoginForm } from "./Auth.tsx";
import { JobCard, type Job } from "./JobCard.tsx";
import { History } from "./History.tsx";
import { Stats } from "./Stats.tsx";
import { useLenis } from "./useLenis.ts";
import { PushToggle } from "./PushToggle.tsx";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";

type Status = { order: { id: string; createdAt: string; jobs: Job[] } | null };
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
        if (msg.type === "status") onStatus({ order: msg.order });
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
  const [tab, setTab] = useState<Tab>("today");

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

  return (
    <main className="page">
      <div className="page-head">
        <h1>VALET</h1>
        <div className="who">
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
                    <JobCard key={job.id} job={job} />
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
  if (!username) return <LoginForm onAuthed={(u) => setState({ checked: true, username: u })} />;
  return <Dashboard username={username} onLogout={logout} />;
}
