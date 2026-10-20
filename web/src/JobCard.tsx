import { motion } from "motion/react";

export type Job = {
  id: string;
  ticket_id: string;
  title: string;
  status: string;
  pr_url: string | null;
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

export function JobCard({ job, highlighted }: { job: Job; highlighted?: boolean }) {
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
        <span className="job-ticket">{job.ticket_id}</span>
        <span className="job-status">{STATUS_LABEL[job.status] ?? job.status}</span>
      </div>
      <div className="job-title">{job.title}</div>
      {job.question && <div className="job-question">Q: {job.question}</div>}
      {job.answer && <div className="job-answer">A: {job.answer}</div>}
      {job.pr_url && (
        <a className="job-pr" href={job.pr_url} target="_blank" rel="noreferrer">
          View PR →
        </a>
      )}
    </motion.li>
  );
}
