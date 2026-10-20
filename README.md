# valet

A phone number that runs your coding agents. Bolna Symphony Buildathon entry (submit by 31 Oct 2026).
Read `VOICE_AI_HACKATHON_PLAN.md`: PRD first, then HLD, LLD and ITD. Layout: `server/` (Render), `web/` (Vercel), `runner/` (your Mac).

## Desk mode runs on [Auricle](https://github.com/himanshu007-creator/auricle)

Desk mode's browser tab listens hands-free using Auricle, a 334 KB in-browser voice-activity-detection
and turn-taking engine (Rust/WASM core + React hooks), built and maintained by the same author as this
project. It's what makes always-on listening actually cheap and fast instead of a liability:

- **Saves STT cost and tokens.** VAD runs entirely client-side; only confirmed speech segments go to
  the transcription API, not a continuous audio stream. No speech, no tokens spent.
- **Saves TTS cost on interruption.** Barge-in is detected locally and stops playback immediately —
  the session stats track "TTS characters avoided by interruption" as a first-class metric.
- **Saves round-trip latency.** No server hop needed to decide "is this speech," so VALET reacts to a
  barge-in in milliseconds, not after a network round trip.

VALET's desk mode is one more reason this thing exists: a real multi-tool voice agent pushing on
Auricle's own numbers.
