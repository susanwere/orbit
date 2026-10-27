import { useEffect, useState } from "react";

interface Orbiter {
  label: string;
  glyph: string;
  ring: 0 | 1 | 2;
  angle: number;
  tone: "indigo" | "cyan" | "green" | "amber" | "muted";
  note: string;
}

// Orbit's own vocabulary, placed in space. Inner ring = why/decided/allowed,
// middle = work/execution, outer = proof/outcome. Nothing spins fast:
// this should feel like a system at rest, not a loading spinner.
// Angles are spread so no two chips on a ring start within ~55 degrees of
// each other — since a whole ring rotates together, they can never collide.
const ORBITERS: Orbiter[] = [
  // Orbit 1 — why: what governs the work
  { label: "Decision", glyph: "◐", ring: 0, angle: 0, tone: "indigo", note: "What we decided — and why" },
  { label: "Guardrail", glyph: "⬡", ring: 0, angle: 0, tone: "amber", note: "What is allowed" },
  { label: "Context", glyph: "☰", ring: 0, angle: 0, tone: "indigo", note: "Authorized product memory" },
  { label: "Evidence", glyph: "✓", ring: 0, angle: 0, tone: "green", note: "Proof the work honors the intent" },
  // Orbit 2 — execution: who/what does the work
  { label: "Work Item", glyph: "▦", ring: 1, angle: 0, tone: "cyan", note: "Accountable work" },
  { label: "Agent", glyph: "⚙", ring: 1, angle: 0, tone: "cyan", note: "Scoped execution" },
  { label: "Human Gate", glyph: "◆", ring: 1, angle: 0, tone: "amber", note: "Judgment, when it matters" },
  { label: "Human", glyph: "●", ring: 1, angle: 0, tone: "green", note: "Owns the outcome" },
  // Orbit 3 — proof & systems: what the work touches and produces
  { label: "CI", glyph: "▣", ring: 2, angle: 0, tone: "muted", note: "Deterministic checks" },
  { label: "Release", glyph: "➤", ring: 2, angle: 0, tone: "green", note: "Shipped outcome" },
  { label: "Pull Request", glyph: "⑂", ring: 2, angle: 0, tone: "muted", note: "External artifact" },
  { label: "Outcome", glyph: "◎", ring: 2, angle: 0, tone: "indigo", note: "What we learned" },
];

function evenAngles(count: number, phase: number): number[] {
  return Array.from({ length: count }, (_, i) => phase + (360 / count) * i);
}

const RING_R = [102, 164, 226];
// Adjacent orbits counter-rotate: WHY drifts clockwise, EXECUTION
// counter-clockwise, PROOF clockwise again — like geared rings.
const RING_SPEED = [70, 110, 160]; // seconds per revolution — slow drift
const RING_DIR: Array<1 | -1> = [1, -1, 1];

export function Landing({ onEnter }: { onEnter: () => void }) {
  const [active, setActive] = useState(0);

  // A pulse travels Orbit 1 (intent, decisions, guardrails, evidence), then 2, then 3: each makes exactly one lap
  // while its pills are revealed in turn, then attention moves inward
  // again. STEP matches the CSS lap windows in the shared tour cycle.
  useEffect(() => {
    const tour = [
      ...ORBITERS.filter((o) => o.ring === 0),
      ...ORBITERS.filter((o) => o.ring === 1),
      ...ORBITERS.filter((o) => o.ring === 2),
    ];
    const t = setInterval(() => {
      setActive((a) => {
        const idx = tour.findIndex((o) => o.label === ORBITERS[a]?.label);
        const next = tour[(idx + 1) % tour.length]!;
        return ORBITERS.findIndex((o) => o.label === next.label);
      });
    }, 3400);
    return () => clearInterval(t);
  }, []);

  const current = ORBITERS[active]!;

  // Evenly spaced by construction: chips are distributed at exactly
  // 360/n per orbit, phase-shifted so orbits don't radially align.
  const ringPhases = [-90, -67.5, -54];
  const angleByLabel = new Map<string, number>();
  ([0, 1, 2] as const).forEach((ring) => {
    const inRing = ORBITERS.filter((o) => o.ring === ring);
    evenAngles(inRing.length, ringPhases[ring]!).forEach((angle, i) => {
      angleByLabel.set(inRing[i]!.label, angle);
    });
  });

  return (
    <main className="landing">
      <section className="landing-hero">
        <div className="orbit-stage" aria-hidden="true">
          <svg className="orbit-svg" viewBox="0 0 560 560">
            <defs>
              <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#7c6cff" stopOpacity="0.5" />
                <stop offset="55%" stopColor="#7c6cff" stopOpacity="0.12" />
                <stop offset="100%" stopColor="#7c6cff" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="280" cy="280" r="150" fill="url(#coreGlow)" className="core-halo" />
            {RING_R.map((r, i) => (
              <circle key={r} cx="280" cy="280" r={r} className={`orbit-ring ring-${i}`} />
            ))}
            {/* A pulse travels each orbit in turn; on arrival a pill
                lights up and reveals its label. */}
            <circle cx="280" cy="280" r={RING_R[0]} className="orbit-pulse-track" fill="none" />
            <circle cx="280" cy="280" r={RING_R[0]} className="orbit-pulse pulse-1" fill="none" />
            <circle cx="280" cy="280" r={RING_R[1]} className="orbit-pulse-track" fill="none" />
            <circle cx="280" cy="280" r={RING_R[1]} className="orbit-pulse pulse-2" fill="none" />
            <circle cx="280" cy="280" r={RING_R[2]} className="orbit-pulse-track" fill="none" />
            <circle cx="280" cy="280" r={RING_R[2]} className="orbit-pulse pulse-3" fill="none" />
          </svg>

          <div className="orbit-core">
            <span className="core-label">INTENT</span>
          </div>

          {ORBITERS.map((o, i) => (
            <OrbiterNode key={o.label} orbiter={o} angle={angleByLabel.get(o.label) ?? 0} isActive={i === active} onHover={() => setActive(i)} />
          ))}
        </div>

        <div className="landing-copy">
          <p className="eyebrow">Orbit</p>
          <h1>Intent, in orbit.</h1>
          <p className="orbit-caption" aria-live="polite">
            <span className={`caption-glyph tone-${current.tone}`}>{current.glyph}</span>
            <b>{current.label}</b>
            <span>— {current.note}</span>
          </p>
          <div className="landing-ctas">
            <button className="cta-primary" onClick={onEnter}>View projects</button>
          </div>
          <p className="landing-foot">Work, agents, decisions and evidence — moving around one outcome.</p>
        </div>
      </section>
    </main>
  );
}

function OrbiterNode({ orbiter, angle, isActive, onHover }: { orbiter: Orbiter; angle: number; isActive: boolean; onHover: () => void }) {
  const r = RING_R[orbiter.ring]!;
  const speed = RING_SPEED[orbiter.ring]!;
  const spinClass = RING_DIR[orbiter.ring] === 1 ? "spin-cw" : "spin-ccw";
  return (
    <div
      className={`orbiter-wrap ${spinClass}`}
      style={{ animationDuration: `${speed}s`, transform: `rotate(${angle}deg)` }}
    >
      <button
        className={`orbiter tone-${orbiter.tone} ${isActive ? "active" : ""}`}
        style={{ ["--orbit-r" as string]: `${r}px` }}
        onMouseEnter={onHover}
        onFocus={onHover}
        aria-label={orbiter.label}
      >
        <span
          className={`orbiter-upright ${spinClass === "spin-cw" ? "spin-ccw" : "spin-cw"}`}
          style={{ animationDuration: `${speed}s` }}
        >
          <span className="orbiter-glyph">{orbiter.glyph}</span>
        </span>
        <span className="orbiter-label">{orbiter.label}</span>
      </button>
    </div>
  );
}
