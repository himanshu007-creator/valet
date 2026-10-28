import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { api } from "./Auth.tsx";
import { parseOptions, needsReply } from "./parseOptions.ts";

export type Task = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  dueDate: string | null;
  state: { id: string; name: string; type: string } | null;
  url: string;
};

const ACTIONS = [
  { label: "Start", request: (t: Task) => `start ${t.identifier}` },
  { label: "Status", request: (t: Task) => `how's ${t.identifier} doing` },
  { label: "Mark done", request: (t: Task) => `mark ${t.identifier} as done` },
  { label: "Cancel", request: (t: Task) => `cancel ${t.identifier}` },
];

// renders whatever toolHandleTask said back — a plain result, or (if it ends in a question) a
// reply prompt with real buttons when numbered options parse, free text always as a fallback.
// Same reply shapes JobCard's BlockedAnswerForm already handles, since both go through the same
// handle_task confirmation flow (pendingDelete/pendingCreate/pendingExecute).
function ReplyPrompt({ message, onReply }: { message: string; onReply: (text: string) => void }) {
  const [text, setText] = useState("");
  const options = needsReply(message) ? parseOptions(message) : [];

  return (
    <div className="task-reply">
      <div className="task-reply-message">{message}</div>
      {needsReply(message) && (
        <div className="job-answer-form">
          <div className="job-answer-options">
            {(options.length > 0 ? options : ["Yes", "No"]).map((opt) => (
              <button key={opt} type="button" onClick={() => onReply(opt)}>
                {opt}
              </button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) onReply(text); }}>
            <input placeholder="Your own answer…" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" disabled={!text.trim()}>Send</button>
          </form>
        </div>
      )}
    </div>
  );
}

function TaskCard({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [extra, setExtra] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [error, setError] = useState("");

  const send = async (request: string) => {
    if (!request.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { message } = await api("/api/handle_task", { request });
      setReply(message || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't work");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.li layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="task">
      <div className="job-head">
        <a className="job-ticket" href={task.url} target="_blank" rel="noreferrer">{task.identifier}</a>
        <span className="job-status">{task.state?.name ?? ""}</span>
      </div>
      <div className="job-title">{task.title}</div>

      {reply ? (
        <ReplyPrompt message={reply} onReply={(text) => send(text)} />
      ) : (
        <div className="task-actions">
          {ACTIONS.map((a) => (
            <button key={a.label} type="button" disabled={busy} onClick={() => send(a.request(task))}>
              {a.label}
            </button>
          ))}
          <button type="button" disabled={busy} onClick={() => setShowMore((v) => !v)}>
            More
          </button>
        </div>
      )}

      {showMore && !reply && (
        <form
          className="task-more"
          onSubmit={(e) => {
            e.preventDefault();
            if (extra.trim()) send(extra);
          }}
        >
          <input
            placeholder={`e.g. "rename this to…" or "add more detail about…"`}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
          />
          <button type="submit" disabled={busy || !extra.trim()}>Send</button>
        </form>
      )}

      {error && <div className="job-answer-error">{error}</div>}
    </motion.li>
  );
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <p className="muted">Nothing open right now.</p>;
  return (
    <ul className="jobs tasks">
      <AnimatePresence initial={false}>
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </AnimatePresence>
    </ul>
  );
}
