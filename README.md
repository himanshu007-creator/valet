# valet

A phone number that runs your coding agents. Bolna Symphony Buildathon entry (submit by 31 Oct 2026).
Read `VOICE_AI_HACKATHON_PLAN.md`: PRD first, then HLD, LLD and ITD. Layout: `server/` (Render), `web/` (Vercel), `runner/` (your Mac).

## Running the Mac-side runner

VALET's tasks execute on your own Mac, not on Render — the `runner/` process is what connects your
machine to the deployed server and actually runs opencode. It runs as a real launchd daemon (not tied
to any terminal session), so it survives reboots and restarts itself if it crashes. Control it with:

```bash
# from the valet/ repo root
npm run daemon:start --workspace=runner    # start (or restart) it — connects to the server
npm run daemon:stop --workspace=runner     # stop it — nothing runs until you start it again
npm run daemon:status --workspace=runner   # check: is it running, and genuinely connected?

# equivalently, from valet/runner:
npm run daemon:start
npm run daemon:stop
npm run daemon:status
```

First-time setup (only needed once, or after moving the repo): `bash runner/scripts/install-daemon.sh`
registers the launchd service — `runner/.env` must exist and be filled in first (copy
`runner/.env.example`). After that, `daemon:start`/`daemon:stop`/`daemon:status` are all you need.

`daemon:stop` doesn't kill any opencode process already running — it just stops being tracked/reported
until you `daemon:start` again. `daemon:status` checks the real launchd state (not just whether a pid
file exists) and tells you honestly if it's running but not yet connected.

## Desk mode runs on [Auricle](https://github.com/himanshu007-creator/auricle)

Desk mode's browser tab listens hands-free using [`auricle`](https://www.npmjs.com/package/auricle) +
[`auricle-react`](https://www.npmjs.com/package/auricle-react) (`^0.1.1`), a 334 KB in-browser
voice-activity-detection and turn-taking engine (Rust/WASM core + React hooks), built and maintained
by the same author as this project. Honest shoutout, not a courtesy mention: this is Auricle's first
real multi-tool production integration, and it earned the spot on its own merits, not because it was
convenient to reach for.

- **Saves STT cost and tokens.** VAD runs entirely client-side; only confirmed speech segments go to
  the transcription API, not a continuous audio stream. No speech, no tokens spent.
- **Saves TTS cost on interruption.** Barge-in is detected locally and stops playback immediately —
  the session stats track "TTS characters avoided by interruption" as a first-class metric.
- **Saves round-trip latency.** No server hop needed to decide "is this speech," so VALET reacts to a
  barge-in in milliseconds, not after a network round trip.
- **Held up under real use, not just a demo.** `web/src/voice/useDesk.ts` wires it straight into
  VALET's actual tool-calling loop (`handle_task`, `answer_question`, `implement` — the same router
  the phone line uses), not a toy transcript box. It didn't need special-casing to carry that.

VALET's desk mode is one more reason this thing exists: a real multi-tool voice agent pushing on
Auricle's own numbers, built in the same stretch of work as Auricle itself.
