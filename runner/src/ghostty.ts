import { spawn } from "node:child_process";

// Ghostty ships a real AppleScript dictionary (command/cwd/wait-after-exit as structured
// fields, not "do script" text-typing like Terminal.app/iTerm2), so we drive it directly.
// All jobs share one window, one tab each, so N tickets means N tabs, not N windows.
function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("osascript", ["-e", script]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`osascript exit ${code}: ${err}`))));
  });
}

// serialize: two jobs dispatched in the same tick could both see "0 windows" and each create one
let chain: Promise<unknown> = Promise.resolve();

// returns the new tab's stable id, so the caller can close exactly that tab later
export function openGhosttyTab(scriptPath: string, cwd: string): Promise<string> {
  const run = chain.then(() => {
    const osa = `
tell application "Ghostty"
  set cfg to new surface configuration
  set command of cfg to "/bin/bash ${scriptPath}"
  set initial working directory of cfg to "${cwd}"
  set wait after command of cfg to true
  set isNewWindow to (count of windows) is 0
  if isNewWindow then
    set w to new window with configuration cfg
  else
    set w to front window
    new tab in w with configuration cfg
  end if
  activate
  activate window w
  if isNewWindow then
    -- best-effort: needs Accessibility permission for Ghostty/osascript, granted once in
    -- System Settings → Privacy & Security → Accessibility. Never block the job on this.
    try
      tell application "System Events" to tell process "Ghostty" to keystroke "f" using {control down, command down}
    end try
  end if
  return id of (selected tab of w)
end tell
`;
    return runOsascript(osa);
  });
  chain = run.catch(() => {});
  return run;
}

export async function closeGhosttyTab(tabId: string): Promise<void> {
  const osa = `
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      if id of t is "${tabId}" then
        close tab t
        return
      end if
    end repeat
  end repeat
end tell
`;
  await runOsascript(osa).catch(() => {});
}
