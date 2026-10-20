import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { useLenis } from "./useLenis.ts";

const JOURNEYS = [
  { verb: "Start something", example: "“Begin the auth ticket.”" },
  { verb: "Describe something new", example: "“We need a billing export — set it up.”" },
  { verb: "Check in", example: "“How's the auth ticket doing?”" },
  { verb: "Call it off", example: "“Cancel the billing one.”" },
  { verb: "Get the shape of things", example: "“What's in progress?”" },
  { verb: "Decide, once", example: "A question, read aloud, answered in one line." },
];

const FADE_UP = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.5, ease: "easeOut" as const },
};

export function Landing({ authed }: { authed: boolean }) {
  useLenis();

  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="landing-wordmark">VALET</span>
        <Link to={authed ? "/app" : "/login"} className="landing-cta-small">
          {authed ? "Open dashboard" : "Sign in"}
        </Link>
      </header>

      <section className="landing-hero">
        <img className="landing-hero-bg" src="/landing/hero-1.webp" alt="" loading="eager" fetchPriority="high" />
        <motion.div className="landing-hero-content" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
          <h1 className="landing-title">VALET</h1>
          <p className="landing-tagline">Say it. It's handled.</p>
          <p className="landing-sub">
            The checkpoint between you and your coding agents — not another one. Hand off work by voice,
            and you're pulled back in only for the one decision that actually needs you.
          </p>
          <Link to={authed ? "/app" : "/login"} className="landing-cta">
            {authed ? "Open dashboard" : "Request access"}
          </Link>
        </motion.div>
      </section>

      <section className="landing-section">
        <motion.div {...FADE_UP}>
          <h2 className="landing-h2">How it works</h2>
          <div className="landing-steps">
            <div className="landing-step">
              <span className="landing-step-num">01</span>
              <p>Speak. On the phone, or in the browser.</p>
            </div>
            <div className="landing-step">
              <span className="landing-step-num">02</span>
              <p>VALET works — research, a draft, real code — in the background, on your own machine.</p>
            </div>
            <div className="landing-step">
              <span className="landing-step-num">03</span>
              <p>You're called back only when there's a real decision, or it's genuinely done.</p>
            </div>
          </div>
        </motion.div>
      </section>

      <section className="landing-section landing-section-alt">
        <motion.div {...FADE_UP}>
          <h2 className="landing-h2">Ask for anything</h2>
          <div className="landing-journeys">
            {JOURNEYS.map((j) => (
              <div key={j.verb} className="landing-journey">
                <div className="landing-journey-verb">{j.verb}</div>
                <div className="landing-journey-example">{j.example}</div>
              </div>
            ))}
          </div>
        </motion.div>
      </section>

      <section className="landing-section landing-closing-section">
        <motion.div {...FADE_UP} className="landing-closing">
          <p className="landing-quote">
            Autonomous agents fail quietly — errors compound without a human checkpoint. VALET's
            resumable, blocked-question loop is that checkpoint, built in, not bolted on.
          </p>
          <Link to={authed ? "/app" : "/login"} className="landing-cta">
            {authed ? "Open dashboard" : "Request access"}
          </Link>
        </motion.div>
      </section>

      <footer className="landing-footer">Your engineering, attended to.</footer>
    </div>
  );
}
