import { useState } from "react";

// The runner lives on your own Mac and is controlled by a launchd daemon (runner/scripts/*.sh) —
// a web page can't reach into your terminal to start it, and if it's stopped there's nothing on
// your Mac left listening to receive a "start" command anyway. So this is the honest version:
// live status (from the same websocket that already tracks it) plus the exact command to copy.
export function RunnerPanel({ online }: { online: boolean | undefined }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (cmd: string) => {
    navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(cmd);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div className="runner-panel">
      <button
        type="button"
        className={`runner-dot ${online ? "runner-online" : "runner-offline"}`}
        onClick={() => setOpen((v) => !v)}
        title="Runner controls"
      >
        ● {online === undefined ? "checking…" : online ? "Mac connected" : "Mac disconnected"}
      </button>
      {open && (
        <div className="runner-popover">
          <p className="runner-popover-status">
            {online ? "Your Mac is online and taking jobs." : "Your Mac isn't connected — nothing will run until it is."}
          </p>
          <div className="runner-cmd-row">
            <code>cd runner && npm run daemon:start</code>
            <button type="button" onClick={() => copy("cd runner && npm run daemon:start")}>
              {copied === "cd runner && npm run daemon:start" ? "copied" : "copy"}
            </button>
          </div>
          <div className="runner-cmd-row">
            <code>npm run daemon:stop</code>
            <button type="button" onClick={() => copy("npm run daemon:stop")}>
              {copied === "npm run daemon:stop" ? "copied" : "copy"}
            </button>
          </div>
          <div className="runner-cmd-row">
            <code>npm run daemon:status</code>
            <button type="button" onClick={() => copy("npm run daemon:status")}>
              {copied === "npm run daemon:status" ? "copied" : "copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
