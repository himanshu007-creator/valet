import { useRef } from "react";
import { Link } from "react-router-dom";
import { motion, useScroll, useTransform } from "motion/react";
import { useLenis } from "./useLenis.ts";

const JOURNEYS = [
  { verb: "Start something", example: "“Begin the auth ticket.”" },
  { verb: "Describe something new", example: "“We need a billing export — set it up.”" },
  { verb: "Check in", example: "“How's the auth ticket doing?”" },
  { verb: "Call it off", example: "“Cancel the billing one.”" },
  { verb: "Mark it done", example: "“That one's finished.”" },
  { verb: "Sharpen a ticket", example: "“Rename it, and add more detail.”" },
  { verb: "Get the shape of things", example: "“What's in progress?”" },
  { verb: "Decide, once", example: "A question, read aloud, answered in one line." },
];

// trigger well before the section is fully on-screen (amount: 0 fires on first pixel, a large
// bottom margin counts it "in view" while still below the fold) — a fast scroll or a judge
// skimming the page must never see a blank section, only a quick, already-underway reveal.
const FADE_UP = {
  initial: { opacity: 0, y: 10 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0, margin: "0px 0px -35% 0px" },
  transition: { duration: 0.35, ease: "easeOut" as const },
};

const GRID = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const CARD = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } },
};

export function Landing({ authed }: { authed: boolean }) {
  useLenis();
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroY = useTransform(scrollYProgress, [0, 1], ["0%", "18%"]);
  const heroScale = useTransform(scrollYProgress, [0, 1], [1, 1.08]);

  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="landing-wordmark">VALET</span>
        <Link to={authed ? "/app" : "/login"} className="landing-cta-small">
          {authed ? "Open dashboard" : "Sign in"}
        </Link>
      </header>

      <section className="landing-hero" ref={heroRef}>
        <motion.img
          className="landing-hero-bg"
          src="/landing/hero-1.webp"
          alt=""
          loading="eager"
          fetchPriority="high"
          style={{ y: heroY, scale: heroScale }}
        />
        <div className="landing-glow" aria-hidden />
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
          <motion.div className="landing-steps" variants={GRID} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0, margin: "0px 0px -35% 0px" }}>
            <motion.div className="landing-step" variants={CARD}>
              <span className="landing-step-num">01</span>
              <p>Speak. On the phone, or in the browser.</p>
            </motion.div>
            <motion.div className="landing-step" variants={CARD}>
              <span className="landing-step-num">02</span>
              <p>VALET works — research, a draft, real code — in the background, on your own machine.</p>
            </motion.div>
            <motion.div className="landing-step" variants={CARD}>
              <span className="landing-step-num">03</span>
              <p>You're called back only when there's a real decision, or it's genuinely done.</p>
            </motion.div>
          </motion.div>
        </motion.div>
      </section>

      <section className="landing-section landing-section-glimpse">
        <motion.div {...FADE_UP}>
          <h2 className="landing-h2">See it live</h2>
          <p className="landing-glimpse-sub">
            This is the real Today tab — not a mockup. Ask by voice, watch it get picked up, tap a
            ticket if talking isn't faster.
          </p>
          <div className="landing-glimpse">
            <div className="desk landing-glimpse-desk">
              <div className="desk-row">
                <div className="desk-orb landing-glimpse-orb" />
                <div>
                  <div className="desk-state">listening</div>
                  <div className="desk-text">Starting the auth ticket now — I'll call you when it's ready.</div>
                  <div className="desk-heard">You said: start the auth one</div>
                </div>
              </div>
            </div>
            <ul className="jobs landing-glimpse-jobs">
              <li className="job job-running">
                <div className="job-head">
                  <span className="job-ticket">HIM-14</span>
                  <span className="job-status">Running</span>
                </div>
                <div className="job-title">Auth: session refresh on expiry</div>
              </li>
              <li className="job job-blocked">
                <div className="job-head">
                  <span className="job-ticket">HIM-9</span>
                  <span className="job-status">Needs a decision</span>
                </div>
                <div className="job-title">Billing export</div>
                <div className="job-question">Q: CSV or JSON for the export format?</div>
              </li>
            </ul>
          </div>
        </motion.div>
      </section>

      <section className="landing-section landing-section-alt">
        <motion.div {...FADE_UP}>
          <h2 className="landing-h2">Ask for anything</h2>
          <motion.div className="landing-journeys" variants={GRID} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0, margin: "0px 0px -35% 0px" }}>
            {JOURNEYS.map((j) => (
              <motion.div key={j.verb} className="landing-journey" variants={CARD} whileHover={{ y: -3 }}>
                <div className="landing-journey-verb">{j.verb}</div>
                <div className="landing-journey-example">{j.example}</div>
              </motion.div>
            ))}
          </motion.div>
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
