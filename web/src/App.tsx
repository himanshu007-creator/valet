import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useSearchParams, useNavigate } from "react-router-dom";
import { AnimatePresence } from "motion/react";
import DeskMode, { type DeskActivity } from "./DeskMode.tsx";
import { useAuth, LoginForm, api, ApiError } from "./Auth.tsx";
import { JobCard, type Job } from "./JobCard.tsx";
import { TaskList, type Task } from "./TaskList.tsx";
import { History } from "./History.tsx";
import { Stats } from "./Stats.tsx";
import { useLenis } from "./useLenis.ts";
import { PushToggle } from "./PushToggle.tsx";
import { Landing } from "./Landing.tsx";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";

type Status = { order: { id: string; createdAt: string; jobs: Job[] } | null; runnerOnline?: boolean };
// "today" isn't a real tab value anymore — it's the absence of one (no ?tab= in the URL). History
// and Stats live one tap away in a menu overlay instead of sitting in the main nav, since only
// Today gets opened daily.
type MenuTab = "history" | "stats";

function useDashboardSocket(onMessage: (msg: any) => void) {
  useEffect(() => {
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      // cookie rides along automatically on same-site requests, including WS upgrades
      ws = new WebSocket(`${WS_URL}/ws/dashboard`);
      ws.onmessage = (e) => onMessage(JSON.parse(e.data));
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

function Dashboard({ username, token, onLogout }: { username: string; token: string | null; onLogout: () => void }) {
  const [priorities, setPriorities] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<Status>({ order: null });
  const [deskActivity, setDeskActivity] = useState<DeskActivity>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const menuTab = searchParams.get("tab") as MenuTab | null;
  const highlightJob = searchParams.get("job");
  const navigate = useNavigate();

  const openMenu = (t: MenuTab) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", t);
    setSearchParams(next, { replace: true });
  };
  const closeMenu = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    setSearchParams(next, { replace: true });
  };

  const fetchTasks = () => api("/api/tasks").then((d) => setTasks(d.tasks)).catch(() => {});

  useDashboardSocket((msg) => {
    if (msg.type === "status") setStatus({ order: msg.order, runnerOnline: msg.runnerOnline });
    else if (msg.type === "desk_event") {
      setDeskActivity({ name: msg.name, phase: msg.kind === "tool_call" ? "calling" : "done" });
      // the voice agent just asked for or acted on the ticket list — refresh the tap-to-act list
      // from the same cache it reads, so "I asked, I see the tasks fetched" is actually true.
      if (msg.kind === "tool_result" && (msg.name === "get_priorities" || msg.name === "handle_task")) fetchTasks();
    }
  });
  useLenis();

  useEffect(() => {
    // reproduced live: a 401 here (e.g. a server redeploy wiping the in-memory session) was
    // silently swallowed — "Today" just went stale/blank forever instead of bouncing to login
    // the way History/Stats already do.
    const fetchPriorities = () =>
      api("/api/priorities")
        .then((d) => setPriorities(d.summary))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) navigate("/login");
        });
    fetchPriorities();
    fetchTasks();
    const id = setInterval(fetchPriorities, 60_000); // matches the server's cache TTL
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

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
          {username} · <PushToggle /> ·{" "}
          <button className="link-button" onClick={() => openMenu("history")}>history</button> ·{" "}
          <button className="link-button" onClick={() => openMenu("stats")}>stats</button> ·{" "}
          <button className="link-button" onClick={onLogout}>sign out</button>
        </div>
      </div>

      <section>
        <h2>Today</h2>
        <p className="priorities">{priorities || "Loading…"}</p>
      </section>

      <DeskMode token={token} activity={deskActivity} />

      <section>
        <h2>Pick something</h2>
        <TaskList tasks={tasks} />
      </section>

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

      {menuTab && (
        <div className="overlay" onClick={closeMenu}>
          <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-nav">
              <button className={`tab ${menuTab === "history" ? "tab-active" : ""}`} onClick={() => openMenu("history")}>
                history
              </button>
              <button className={`tab ${menuTab === "stats" ? "tab-active" : ""}`} onClick={() => openMenu("stats")}>
                stats
              </button>
              <button className="link-button overlay-close" onClick={closeMenu}>close</button>
            </div>
            {menuTab === "history" && <History />}
            {menuTab === "stats" && <Stats />}
          </div>
        </div>
      )}
    </main>
  );
}

export default function App() {
  const { checked, username, token, setState, logout } = useAuth();

  if (!checked) return null;

  return (
    <Routes>
      <Route path="/" element={<Landing authed={!!username} />} />
      <Route
        path="/login"
        element={username ? <Navigate to="/app" replace /> : <LoginForm onAuthed={(u, t) => setState({ checked: true, username: u, token: t })} />}
      />
      <Route path="/app" element={username ? <Dashboard username={username} token={token} onLogout={logout} /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
