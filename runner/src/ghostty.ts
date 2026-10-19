import { spawn } from "node:child_process";

// Ghostty ships a real AppleScript dictionary (command/cwd/wait-after-exit as structured
// fields, not "do script" text-typing like Terminal.app/iTerm2), so we drive it directly.
export function openGhosttyTab(scriptPath: string, cwd: string): Promise<void> {
  const osa = `
tell application "Ghostty"
  activate
  set cfg to new surface configuration
  set command of cfg to "/bin/bash ${scriptPath}"
  set initial working directory of cfg to "${cwd}"
  set wait after command of cfg to true
  set w to new window with configuration cfg
  activate window w
end tell
`;
  return new Promise((resolve, reject) => {
    const p = spawn("osascript", ["-e", osa]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`osascript exit ${code}: ${err}`))));
  });
}
