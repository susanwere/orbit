import { OrbitScene } from "./OrbitScene.js";
import { useMemo, useState } from "react";

import {
  SEMANTIC_NODES,
  RING_LABELS,
  projectOrbitNodes,
} from "./features/orbit-map/semantic-orbit.js";
import type { OrbitNodeKind } from "./contracts/orbit.js";

type Ring = 0 | 1 | 2;
const nodes = SEMANTIC_NODES;
const rings = RING_LABELS;
const toneColors = Object.fromEntries(nodes.map((node) => [node.id, node.color])) as Record<
  OrbitNodeKind,
  string
>;

export function Universe({ onExit }: { onExit: () => void }) {
  const [selected, setSelected] = useState<OrbitNodeKind>("decision");
  const [filter, setFilter] = useState<"all" | Ring>("all");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const active = useMemo(() => nodes.find((node) => node.id === selected) ?? nodes[0]!, [selected]);
  const visible = nodes.filter((node) => filter === "all" || node.ring === filter);
  const semanticState = useMemo(() => projectOrbitNodes(), []);
  function choose(id: OrbitNodeKind) {
    setSelected(id);
    setInspectorOpen(true);
  }
  return (
    <main className="workspace">
      <header className="workspace-header">
        <button
          className="brand-mark"
          type="button"
          onClick={onExit}
          aria-label="Back to Orbit landing page"
        >
          <span className="brand-symbol">◎</span> orbit
        </button>
        <span className="header-divider" aria-hidden="true" />
        <div className="workspace-project">
          <span className="project-dot" /> HN Jobs <span className="chevron">⌄</span>
        </div>
        <div className="header-right">
          <span className="live-dot" /> Prototype preview{" "}
          <button
            type="button"
            className="header-icon"
            onClick={() => setInspectorOpen((v) => !v)}
            aria-label="Toggle inspector"
          >
            ☷
          </button>
        </div>
      </header>
      <section className="workspace-body">
        <aside className="workspace-nav" aria-label="Workspace navigation">
          <div className="nav-section-label">WORKSPACE</div>
          <div className="nav-entry current">
            <span>◎</span> Universe
          </div>
          <div className="nav-entry muted">
            <span>✧</span> Intent Studio <small>Soon</small>
          </div>
          <div className="nav-entry muted">
            <span>◇</span> Reviews <small>Soon</small>
          </div>
          <div className="nav-entry muted">
            <span>≋</span> Activity <small>Soon</small>
          </div>
          <div className="nav-entry muted">
            <span>▤</span> Context <small>Soon</small>
          </div>
          <div className="nav-entry muted">
            <span>⌘</span> Agents <small>Soon</small>
          </div>
          <div className="nav-bottom">
            <span className="avatar">O</span>
            <div>
              <strong>Orbit workspace</strong>
              <span>Prototype environment</span>
            </div>
          </div>
        </aside>
        <section className="universe-main" aria-labelledby="universe-title">
          <div className="universe-top">
            <div>
              <p className="eyebrow">PROJECT INTELLIGENCE / UNIVERSE</p>
              <h1 id="universe-title">Everything revolves around intent.</h1>
              <p className="universe-subtitle">
                Explore how decisions, people and systems connect to what we're building.
              </p>
            </div>
            <span className="preview-chip">Interactive preview</span>
          </div>
          <div className="universe-filters" aria-label="Filter orbital layers">
            {(
              [
                { id: "all", label: "All orbits" },
                { id: 0, label: "01 · Governance" },
                { id: 1, label: "02 · Execution" },
                { id: 2, label: "03 · Outcomes" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                className={filter === item.id ? "filter-pill selected" : "filter-pill"}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="universe-canvas">
            <div className="canvas-aura" />
            <OrbitScene
              nodes={visible.map(({ id, label, ring, angle, color }) => ({
                id,
                label,
                ring,
                angle,
                color,
              }))}
              selected={selected}
              onSelect={choose}
            />
            <div className="scene-accessible-list" aria-label="Select an engineering concept">
              {visible.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => choose(node.id)}
                  aria-pressed={selected === node.id}
                >
                  {node.label}
                </button>
              ))}
            </div>
            <div className="canvas-legend">
              <span>
                <i className="legend-dot violet" /> Governance
              </span>
              <span>
                <i className="legend-dot cyan" /> Execution
              </span>
              <span>
                <i className="legend-dot mint" /> Outcomes
              </span>
            </div>
          </div>
          <div className="universe-footer">
            <span>12 connected concepts · 3 semantic orbits</span>
            <span>
              Select a node to inspect its role <span aria-hidden="true">↗</span>
            </span>
          </div>
        </section>
        {inspectorOpen && (
          <aside className="node-inspector" aria-label="Selected node details">
            <div className="inspector-heading">
              <span>NODE INSPECTOR</span>
              <button
                type="button"
                aria-label="Close inspector"
                onClick={() => setInspectorOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="inspector-body">
              <div className="inspector-icon" style={{ color: toneColors[active.id] }}>
                ◎
              </div>
              <p className="eyebrow">
                ORBIT {active.ring + 1} · {rings[active.ring]}
              </p>
              <h2>{active.label}</h2>
              <p className="inspector-lede">
                {semanticState.find((node) => node.id === active.id)?.summary}
              </p>
              <div className="inspector-rule" />
              <h3>Why it matters</h3>
              <p className="inspector-detail">{active.detail}</p>
              <div className="inspector-note">
                <span className="live-dot" /> Semantic node · prototype data
              </div>
            </div>
            <div className="inspector-bottom">
              Select any node in the Universe to explore its meaning.
            </div>
          </aside>
        )}
      </section>
    </main>
  );
}
