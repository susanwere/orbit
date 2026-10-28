import { OrbitScene } from "./OrbitScene.js";
import { useMemo, useState } from "react";

type Ring = 0 | 1 | 2;
type Tone = "violet" | "cyan" | "mint" | "gold";
type Node = { label: string; ring: Ring; angle: number; tone: Tone; description: string; detail: string };
const nodes: Node[] = [
  { label: "Decision", ring: 0, angle: -90, tone: "violet", description: "The choices that shape implementation.", detail: "Approved decisions become authoritative project context. Proposed decisions require explicit human review." },
  { label: "Guardrail", ring: 0, angle: 0, tone: "gold", description: "Rules that protect the original intent.", detail: "Engineering and policy constraints limit what people and agents may change." },
  { label: "Context", ring: 0, angle: 90, tone: "violet", description: "The project's living, versioned memory.", detail: "Immutable context versions preserve what was known and approved when work began." },
  { label: "Evidence", ring: 0, angle: 180, tone: "mint", description: "Source-backed reasons behind decisions.", detail: "Follow provenance from intent and discussions to approved decisions and outcomes." },
  { label: "Work Item", ring: 1, angle: -65, tone: "cyan", description: "Scoped, accountable engineering work.", detail: "Execution is mapped back to intent and approved project decisions." },
  { label: "Agent", ring: 1, angle: 25, tone: "cyan", description: "AI execution with explicit boundaries.", detail: "An agent starts with an authorized Context Snapshot and Execution Contract." },
  { label: "Human Gate", ring: 1, angle: 115, tone: "gold", description: "Human judgment when it matters.", detail: "Affected agent sessions pause for approval when material context changes." },
  { label: "Human", ring: 1, angle: 205, tone: "mint", description: "People own consequential decisions.", detail: "AI interprets; humans authorize; Orbit enforces." },
  { label: "CI", ring: 2, angle: -76, tone: "cyan", description: "Automated checks and confidence signals.", detail: "Builds, tests and validation provide evidence of execution." },
  { label: "Release", ring: 2, angle: 14, tone: "mint", description: "Approved changes delivered to users.", detail: "Releases connect completed work to measurable outcomes." },
  { label: "Pull Request", ring: 2, angle: 104, tone: "violet", description: "Implementation and review evidence.", detail: "GitHub reviews and comments may contain decisions that update project context." },
  { label: "Outcome", ring: 2, angle: 194, tone: "gold", description: "What the team learned and delivered.", detail: "Outcomes close the loop between initial intent and observed results." },
];
const rings = [{ r: 115, name: "Governance & memory" }, { r: 205, name: "Execution & accountability" }, { r: 288, name: "Systems & outcomes" }];
const toneColors: Record<Tone, string> = { violet: "#a997ff", cyan: "#65cfff", mint: "#70e5c2", gold: "#f0c880" };

export function Universe({ onExit }: { onExit: () => void }) {
  const [selected, setSelected] = useState("Decision");
  const [filter, setFilter] = useState<"all" | Ring>("all");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const active = useMemo(() => nodes.find((node) => node.label === selected) ?? nodes[0]!, [selected]);
  const visible = nodes.filter((node) => filter === "all" || node.ring === filter);
  function choose(label: string) { setSelected(label); setInspectorOpen(true); }
  return (
    <main className="workspace">
      <header className="workspace-header">
        <button className="brand-mark" type="button" onClick={onExit} aria-label="Back to Orbit landing page"><span className="brand-symbol">◎</span> orbit</button>
        <span className="header-divider" aria-hidden="true" />
        <div className="workspace-project"><span className="project-dot" /> HN Jobs <span className="chevron">⌄</span></div>
        <div className="header-right"><span className="live-dot" /> Prototype preview <button type="button" className="header-icon" onClick={() => setInspectorOpen((v) => !v)} aria-label="Toggle inspector">☷</button></div>
      </header>
      <section className="workspace-body">
        <aside className="workspace-nav" aria-label="Workspace navigation">
          <div className="nav-section-label">WORKSPACE</div>
          <div className="nav-entry current"><span>◎</span> Universe</div>
          <div className="nav-entry muted"><span>✧</span> Intent Studio <small>Soon</small></div>
          <div className="nav-entry muted"><span>◇</span> Reviews <small>Soon</small></div>
          <div className="nav-entry muted"><span>≋</span> Activity <small>Soon</small></div>
          <div className="nav-entry muted"><span>▤</span> Context <small>Soon</small></div>
          <div className="nav-entry muted"><span>⌘</span> Agents <small>Soon</small></div>
          <div className="nav-bottom"><span className="avatar">O</span><div><strong>Orbit workspace</strong><span>Prototype environment</span></div></div>
        </aside>
        <section className="universe-main" aria-labelledby="universe-title">
          <div className="universe-top"><div><p className="eyebrow">PROJECT INTELLIGENCE / UNIVERSE</p><h1 id="universe-title">Everything revolves around intent.</h1><p className="universe-subtitle">Explore how decisions, people and systems connect to what we're building.</p></div><span className="preview-chip">Interactive preview</span></div>
          <div className="universe-filters" aria-label="Filter orbital layers">
            {([{ id: "all", label: "All orbits" }, { id: 0, label: "01 · Governance" }, { id: 1, label: "02 · Execution" }, { id: 2, label: "03 · Outcomes" }] as const).map((item) => <button key={item.id} type="button" className={filter === item.id ? "filter-pill selected" : "filter-pill"} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
          </div>
          <div className="universe-canvas">
            <div className="canvas-aura" />
            <OrbitScene nodes={visible.map(({label,ring,angle,tone}) => ({label,ring,angle,color:toneColors[tone]}))} selected={selected} onSelect={choose} />
            <div className="scene-accessible-list" aria-label="Select an engineering concept">
              {visible.map((node) => <button key={node.label} type="button" onClick={() => choose(node.label)} aria-pressed={selected === node.label}>{node.label}</button>)}
            </div>
            <div className="canvas-legend"><span><i className="legend-dot violet" /> Governance</span><span><i className="legend-dot cyan" /> Execution</span><span><i className="legend-dot mint" /> Outcomes</span></div>
          </div>
          <div className="universe-footer"><span>12 connected concepts · 3 semantic orbits</span><span>Select a node to inspect its role <span aria-hidden="true">↗</span></span></div>
        </section>
        {inspectorOpen && <aside className="node-inspector" aria-label="Selected node details"><div className="inspector-heading"><span>NODE INSPECTOR</span><button type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>×</button></div><div className="inspector-body"><div className="inspector-icon" style={{ color: toneColors[active.tone] }}>◎</div><p className="eyebrow">ORBIT {active.ring + 1} · {rings[active.ring]!.name}</p><h2>{active.label}</h2><p className="inspector-lede">{active.description}</p><div className="inspector-rule"/><h3>Why it matters</h3><p className="inspector-detail">{active.detail}</p><div className="inspector-note"><span className="live-dot" /> Semantic node · prototype data</div></div><div className="inspector-bottom">Select any node in the Universe to explore its meaning.</div></aside>}
      </section>
    </main>
  );
}
