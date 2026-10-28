import { useState } from "react";
import { motion } from "motion/react";
import { api } from "./Auth.tsx";
import { parseOptions } from "./parseOptions.ts";

export type Job = {
  id: string;
  ticket_id: string;
  title: string;
  description?: string | null;
  status: string;
  pr_url: string | null;
  doc_url?: string | null;
  ticket_url?: string | null;
  question: string | null;
  answer: string | null;
  started_at?: string | null;
  finished_at?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  blocked: "Needs a decision",
  failed: "Failed",
  timeout: "Timed out",
};

const SPRING = { type: "spring" as const, stiffness: 260, damping: 28 };

function BlockedAnswerForm({ jobId, options }: { jobId: string; options: string[] }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/jobs/${jobId}/answer`, { answer });
      // no local state flip needed — the live dashboard websocket updates this card once the
      // runner actually processes the answer, same as answering by voice would.
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't send that");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="job-answer-form">
      {options.length > 0 && (
        <div className="job-answer-options">
          {options.map((opt, i) => (
            <button key={i} type="button" onClick={() => submit(opt)} disabled={busy}>
              {opt}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); submit(text); }}>
        <input placeholder="Your own answer…" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
        <button type="submit" disabled={busy || !text.trim()}>Send</button>
      </form>
      {error && <div className="job-answer-error">{error}</div>}
    </div>
  );
}

function RetryDismissButtons({ jobId }: { jobId: string }) {
  const [busy, setBusy] = useState<"retry" | "dismiss" | null>(null);
  const [error, setError] = useState("");

  const act = async (action: "retry" | "dismiss") => {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      await api(`/api/jobs/${jobId}/${action}`, {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't work");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="job-error-actions">
      <button type="button" onClick={() => act("retry")} disabled={busy !== null}>
        {busy === "retry" ? "Retrying…" : "Retry"}
      </button>
      <button type="button" className="job-dismiss" onClick={() => act("dismiss")} disabled={busy !== null}>
        {busy === "dismiss" ? "…" : "Dismiss"}
      </button>
      {error && <div className="job-answer-error">{error}</div>}
    </div>
  );
}

export function JobCard({ job, highlighted }: { job: Job; highlighted?: boolean }) {
  const options = job.status === "blocked" && job.question ? parseOptions(job.question) : [];
  return (
    <motion.li
      id={`job-${job.ticket_id}`}
      layout
      layoutId={job.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={SPRING}
      whileHover={{ y: -2 }}
      className={`job job-${job.status}${highlighted ? " job-highlighted" : ""}`}
    >
      <div className="job-head">
        {job.ticket_url ? (
          <a className="job-ticket" href={job.ticket_url} target="_blank" rel="noreferrer">
            {job.ticket_id}
          </a>
        ) : (
          <span className="job-ticket">{job.ticket_id}</span>
        )}
        <span className="job-status">{STATUS_LABEL[job.status] ?? job.status}</span>
      </div>
      <div className="job-title">{job.title}</div>
      {job.description && <div className="job-description">{job.description}</div>}
      {job.question && <div className="job-question">Q: {job.question}</div>}
      {job.answer && <div className="job-answer">A: {job.answer}</div>}
      {job.status === "blocked" && !job.answer && <BlockedAnswerForm jobId={job.id} options={options} />}
      {(job.status === "failed" || job.status === "timeout") && <RetryDismissButtons jobId={job.id} />}
      <div className="job-links">
        {job.pr_url && (
          <a className="job-pr" href={job.pr_url} target="_blank" rel="noreferrer">
            View PR →
          </a>
        )}
        {job.doc_url && (
          <a className="job-pr" href={job.doc_url} target="_blank" rel="noreferrer">
            View notes →
          </a>
        )}
      </div>
    </motion.li>
  );
}
