import { useDesk } from "./voice/useDesk.ts";

const TOOL_LABEL: Record<string, string> = {
  get_priorities: "checking your tickets",
  handle_task: "working on that",
  answer_question: "passing that along",
  implement: "starting implementation",
};

export type DeskActivity = { name: string; phase: "calling" | "done" } | null;

export default function DeskMode({ token, activity }: { token: string | null; activity: DeskActivity }) {
  const { state, probability, agentText, heardText, error, start, stop } = useDesk(token);

  const running = state !== "idle";
  const orbScale = 1 + Math.min(probability, 1) * 0.5;

  return (
    <section className="desk">
      <h2>Desk mode</h2>
      <div className="desk-row">
        <button className="desk-orb" style={{ transform: `scale(${orbScale})` }} onClick={() => (running ? stop() : start())} aria-label={running ? "Stop listening" : "Start listening"} />
        <div>
          <div className="desk-state">{running ? state.replace("_", " ") : "tap to start"}</div>
          {activity && (
            <div className="desk-activity">
              {activity.phase === "calling" ? "→ " : "✓ "}
              {TOOL_LABEL[activity.name] ?? activity.name}
            </div>
          )}
          {agentText && <div className="desk-text">{agentText}</div>}
          {heardText && <div className="desk-heard">You said: {heardText}</div>}
          {error && <div className="desk-error">{error.message}</div>}
        </div>
      </div>
    </section>
  );
}
