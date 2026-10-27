import { useEffect, useMemo, useRef, useState } from "react";
import { Landing } from "./Landing.js";
import { OrbitMap } from "./OrbitMap.js";
import {
  api,
  type AgentDefinition,
  type DemoContext,
  type ExecutionRecord,
  type HumanGate,
  type InitiativeDetail,
  type ProposedDecision,
  type ContextState,
  type ProposedPlan,
  type WorkItem,
} from "./api.js";

const DEMO_INTENT =
  "Build interview capture with explicit consent, microphone and system audio, recovery when devices change, transcription, and a structured interview debrief.";
type View = "home" | "projects" | "intent" | "map" | "decisions" | "agents";

interface Project {
  id: string;
  name: string;
  note: string;
  live?: boolean;
}

export function App() {
  const [view, setView] = useState<View>("home");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureStep, setCaptureStep] = useState(0);
  const [projects, setProjects] = useState<Project[]>([
    { id: "hn-jobs", name: "HN Jobs Viewer", note: "A React app for browsing Hacker News job postings", live: true },
    { id: "careerglyph", name: "CareerGlyph", note: "Interview Capture & Debrief", live: true },
    { id: "orbit-platform", name: "Orbit Platform", note: "Dogfooding Orbit itself — no initiative yet" },
    { id: "mobile-companion", name: "Mobile Companion", note: "Concept — awaiting intent" },
  ]);
  const [activeProjectId, setActiveProjectId] = useState("hn-jobs");
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [context, setContext] = useState<DemoContext | null>(null);
  const [principalId, setPrincipalId] = useState("usr_susan");
  const [title, setTitle] = useState("Build HN Jobs Viewer");
  const [hnStage, setHnStage] = useState(0);
  const [contextState, setContextState] = useState<ContextState | null>(null);
  const [proposedDecisions, setProposedDecisions] = useState<ProposedDecision[]>([]);
  const [contextToast, setContextToast] = useState("");
  const [decisionPulse, setDecisionPulse] = useState(false);
  const [intent, setIntent] = useState("Build a React application that fetches Hacker News job postings and displays them in a responsive list.");
  const [plan, setPlan] = useState<ProposedPlan | null>(null);
  const [detail, setDetail] = useState<InitiativeDetail | null>(null);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string>("");
  const [selectedStepId, setSelectedStepId] = useState<string>("");
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [gates, setGates] = useState<HumanGate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const openGates = gates.filter((g) => g.state === "open");
  const executionByStep = useMemo(
    () => new Map(executions.map((e) => [e.session.workflowStepId, e])),
    [executions],
  );

  async function refreshGatesAndExecutions() {
    const [g, e] = await Promise.all([api.gates(), api.executions()]);
    setGates(g.gates);
    setExecutions(e.executions);
  }

  useEffect(() => {
    api.demoContext().then(setContext).catch((e) => setError(String(e)));
    refreshGatesAndExecutions().catch(() => undefined);
    api.context().then((c) => { setContextState(c.context); setProposedDecisions(c.proposedDecisions); }).catch(() => undefined);

    // Live: proposed decisions and context updates land the moment they happen.
    const stream = new EventSource("http://localhost:4000/events/stream");
    stream.addEventListener("orbit", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent).data) as { type: string; payload?: Record<string, unknown> };
        if (event.type.startsWith("decision.") || event.type === "context.updated") {
          api.context().then((c) => { setContextState(c.context); setProposedDecisions(c.proposedDecisions); }).catch(() => undefined);
        }
        if (event.type === "context.updated") {
          setDecisionPulse(true);
          window.setTimeout(() => setDecisionPulse(false), 2600);
        }
      } catch { /* keep stream open */ }
    });
    return () => stream.close();
  }, []);

  const principal = context?.principals.find((p) => p.id === principalId);
  const decisionTitle = (id: string) => context?.decisions.find((d) => d.id === id)?.title ?? id;
  const agentName = (id?: string) => context?.agentDefinitions.find((a) => a.id === id)?.name ?? id ?? "";
  const policyCode = (id: string) => context?.policies.find((p) => p.id === id)?.code ?? id;

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]!;

  function openProject(project: Project) {
    setActiveProjectId(project.id);
    if (project.id === "hn-jobs") {
      setView("intent");
    } else if (project.live) {
      setView(detail ? "map" : "intent");
    } else {
      setTitle("");
      setIntent("");
      setPlan(null);
      setCreatingProject(false);
      setView("intent");
    }
  }

  function createProject() {
    const name = newProjectName.trim();
    if (!name) return;
    const project: Project = { id: `proj_${Math.random().toString(36).slice(2, 9)}`, name, note: "New project — describe its intent", live: true };
    setProjects((prev) => [...prev, project]);
    setActiveProjectId(project.id);
    setNewProjectName("");
    setCreatingProject(false);
    setTitle("");
    setIntent("");
    setPlan(null);
    setView("intent");
  }

  async function propose() {
    setBusy(true); setError(""); setNotice("");
    try {
      const initiative = await api.createInitiative(title, intent);
      setPlan(await api.plan(initiative.id));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function approvePlan() {
    if (!plan) return;
    setBusy(true); setError("");
    try {
      await api.approvePlan(plan.initiativeId);
      const d = await api.getInitiative(plan.initiativeId);
      setDetail(d);
      setSelectedWorkItemId(d.workItems[0]?.id ?? "");
      if (activeProjectId !== "hn-jobs") setView("map");
      setNotice(activeProjectId === "hn-jobs"
        ? "Plan approved. Follow the journey below — Linear, design, implementation, PR, decisions, CI, release."
        : "Plan approved. Work graph created — nothing was written externally.");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function executeStep(stepId: string) {
    setBusy(true); setError("");
    try {
      await api.executeStep(stepId);
      await refreshAll();
      setNotice("Agent Session started under a scoped Execution Contract. Policy API-04 opened a Human Gate.");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function refreshAll() {
    if (detail) setDetail(await api.getInitiative(detail.initiative.id));
    await refreshGatesAndExecutions();
    setContext(await api.demoContext());
  }

  async function resolveGate(gateId: string, decision: "approved" | "rejected") {
    setBusy(true); setError("");
    try {
      await api.resolveGate(gateId, decision);
      await refreshAll();
      setNotice(decision === "approved" ? "Gate approved — execution resumed; evidence collected." : "Gate rejected — workflow blocked; API change not applied.");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  const selectedWorkItem: WorkItem | undefined = detail?.workItems.find((w) => w.id === selectedWorkItemId) ?? detail?.workItems[0];
  const selectedExecution = selectedStepId ? executionByStep.get(selectedStepId) : undefined;
  const selectedGate = selectedExecution?.gate;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="orbit-dot" /> ORBIT</div>
        <nav>
          <button className={view === "home" ? "nav active" : "nav"} onClick={() => setView("home")}>Home</button>
          <button className={view === "projects" ? "nav active" : "nav"} onClick={() => setView("projects")}>Projects</button>
          <button className={view === "intent" ? "nav active" : "nav"} onClick={() => setView("intent")}>Describe Intent</button>
          <button className={view === "map" ? "nav active" : "nav"} onClick={() => setView("map")}>Orbit Map</button>
          <button className={view === "decisions" ? "nav active" : "nav"} onClick={() => setView("decisions")}>Context & Decisions</button>
          <button className={view === "agents" ? "nav active" : "nav"} onClick={() => setView("agents")}>Agents{principal?.role === "admin" ? " · Admin" : ""}</button>
        </nav>
        <div className="top-right">
          {openGates.length > 0 && <button className="needs-you" onClick={() => setView("map")}>● Needs You ({openGates.length})</button>}
          <select value={principalId} onChange={(e) => setPrincipalId(e.target.value)} aria-label="Acting principal">
            {context?.principals.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.role})</option>)}
          </select>
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}
      {contextToast && <div className="notice context-toast">{contextToast}</div>}
      {error && <div className="notice error-box">{error}</div>}

      {view === "home" && (
        <Landing onEnter={() => setView("projects")} />
      )}

      {view === "projects" && (
        <main className="page">
          <p className="eyebrow">Projects</p>
          <h1>Your projects</h1>
          <div className="project-list">
            {projects.map((project) => {
              const isLive = Boolean(project.live && detail);
              return (
                <button className="project-row" key={project.id} onClick={() => openProject(project)}>
                  <span className={project.live ? "project-glyph live" : "project-glyph"}>{project.live ? "◉" : "○"}</span>
                  <span className="project-main">
                    <b>{project.name}</b>
                    <span>{project.id === "careerglyph" && detail ? `${detail.initiative.title} · ${detail.initiative.status}` : project.note}</span>
                  </span>
                  <span className="project-signals">
                    {project.id === activeProjectId && openGates.length > 0 && <span className="signal amber">◆ {openGates.length} needs you</span>}
                    {project.id === activeProjectId && executions.some((e) => e.session.state === "running") && <span className="signal cyan">executing</span>}
                    {project.id === "careerglyph" && detail && <span className="signal muted">{detail.workItems.length} work items</span>}
                  </span>
                  <span className="project-open">{project.live ? (isLive ? "Open map →" : "Describe intent →") : "Describe intent →"}</span>
                </button>
              );
            })}
          </div>
          {creatingProject ? (
            <section className="panel new-project">
              <h2>New project</h2>
              <label htmlFor="project-name">Project name</label>
              <input id="project-name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="e.g. Atlas" autoFocus />
              <div className="row">
                <button onClick={createProject} disabled={!newProjectName.trim()}>Create project</button>
                <button className="secondary" onClick={() => setCreatingProject(false)}>Cancel</button>
              </div>
              <p className="meta">Next, you will describe this project's intent.</p>
            </section>
          ) : (
            <button className="cta-quiet" onClick={() => setCreatingProject(true)}>+ New project</button>
          )}
        </main>
      )}

      {view === "intent" && (
        <main className="page intent-page">
          <p className="eyebrow">{activeProject.name} · New initiative</p>
          <h1>What do you want to build?</h1>
          <p className="lede">One line, from voice to approved plan.</p>

          <section className="pulse-line" aria-label="Intent steps">
            <div className="pulse-track" />
            <div className="pulse-runner" />

            <button className="pulse-pill current" onClick={() => { setCaptureStep(0); setCaptureOpen(true); }}>
              <span className="pulse-disc voice">🎙</span>
              <span className="pulse-text"><b>Describe intent</b><small>{intent ? truncateIntent(intent) : "Speak or type what this project should become"}</small></span>
              <span className="pulse-state">{intent.trim() ? "ready" : "start here"}</span>
            </button>

            <button className="pulse-pill" onClick={() => { setCaptureStep(1); setCaptureOpen(true); }}>
              <span className="pulse-disc goal">◎</span>
              <span className="pulse-text"><b>Set the goal</b><small>{title || "Name the initiative"}</small></span>
              <span className="pulse-state">{title.trim() ? "set" : "optional"}</span>
            </button>

            <div className="pulse-pill static">
              <span className="pulse-disc decision">◐</span>
              <span className="pulse-text"><b>Review decisions</b><small>{plan ? `${plan.detectedDecisionIds.length} detected for this intent` : "Orbit checks product decisions first"}</small></span>
              <span className="pulse-state">{plan ? "done" : "auto"}</span>
            </div>

            <div className="pulse-pill static">
              <span className="pulse-disc guardrail">⬡</span>
              <span className="pulse-text"><b>Apply guardrails</b><small>{plan ? plan.relevantPolicyCodes.join(" · ") : "Allowed · approval-gated · forbidden"}</small></span>
              <span className="pulse-state">{plan ? "attached" : "auto"}</span>
            </div>

            <button className="pulse-pill review" disabled={!intent.trim() || busy} onClick={propose}>
              <span className="pulse-disc plan">➤</span>
              <span className="pulse-text"><b>Review proposed plan</b><small>{plan ? "Plan ready below" : "Generate the Orbit Map for approval"}</small></span>
              <span className="pulse-state">{busy ? "planning…" : plan ? "ready" : "next"}</span>
            </button>
          </section>

          {activeProject.id === "hn-jobs" && !plan && (
            <section className="panel hn-seed">
              <h2>Starting from zero</h2>
              <p className="meta">Repository: blank React + TypeScript app · No work items, decisions, designs, PRs, CI evidence, or releases yet. That emptiness is the point — Orbit builds the context from your intent.</p>
              <div className="hn-apis">
                <code>GET https://hacker-news.firebaseio.com/v0/jobstories.json</code>
                <code>GET https://hacker-news.firebaseio.com/v0/item/{"{id}"}.json</code>
              </div>
            </section>
          )}

          {activeProject.id === "hn-jobs" && plan && detail && (
            <HnJourney
              stage={hnStage}
              setStage={setHnStage}
              onOpenMap={() => setView("map")}
              contextState={contextState}
              proposedDecisions={proposedDecisions}
              decisionPulse={decisionPulse}
              onSimulatePr={async () => { await api.postPrComment(); }}
              onApproveDecision={async (id) => {
                const res = await api.approveDecision(id);
                setContextState(res.context);
                setProposedDecisions((prev) => prev.map((d) => (d.id === id ? res.decision : d)));
                setContextToast(`Context updated — ${res.decision.id} from ${res.decision.sourceRef} is now active (Context v${res.context.version}).`);
                setHnStage((n) => Math.max(n, 7));
              }}
              onRejectDecision={async (id) => {
                const res = await api.rejectDecision(id);
                setProposedDecisions((prev) => prev.map((d) => (d.id === id ? res.decision : d)));
                setContextToast(`${res.decision.id} rejected — Current Context unchanged (v${contextState?.version ?? 1}).`);
              }}
            />
          )}

          {captureOpen && (
            <CaptureWindow
              step={captureStep}
              intent={intent}
              title={title}
              onClose={() => setCaptureOpen(false)}
              onIntent={(value) => { setIntent(value); setCaptureOpen(false); setNotice("Intent captured. Review decisions and guardrails, then review the proposed plan."); }}
              onTitle={(value) => { setTitle(value); setCaptureOpen(false); }}
            />
          )}

          {plan && (
            <section className="panel">
              <h2>Proposed Plan</h2>
              <p className="meta">Planner: {plan.planner.provider} · {plan.planner.model} · mode: {plan.planner.mode} — deterministic stub with the same schema as Muse Spark structured output.</p>
              <p>
                <span className="chip green">{plan.detectedDecisionIds.length} decisions detected</span>
                {plan.relevantPolicyCodes.map((code) => <span className="chip amber" key={code}>{code}</span>)}
              </p>
              <div className="grid">
                {plan.workItems.map((item) => (
                  <article className="card" key={item.title}>
                    <h3>{item.title} <span className="chip amber">risk: {item.risk}</span></h3>
                    <p className="meta">{item.description}</p>
                    {item.decisionIds.map((id) => <span className="chip" key={id}>{decisionTitle(id)}</span>)}
                    <ul className="steps">
                      {item.workflows.map((wf) => (
                        <li key={wf.title}><span className="lane">{wf.lane}</span> {wf.title}
                          <ul>{wf.steps.map((s) => <li key={s.title}>{s.title}{s.suggestedAgentDefinitionId ? <span className="meta"> — {agentName(s.suggestedAgentDefinitionId)}</span> : null}</li>)}</ul>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
              <button onClick={approvePlan} disabled={busy}>Approve & Start</button>
            </section>
          )}
        </main>
      )}

      {view === "map" && (
        <main className="page wide">
          <p className="eyebrow">Orbit Map</p>
          <h1>{detail?.initiative.title ?? "Interview Capture & Debrief"}</h1>
          {!detail ? (
            <section className="panel"><p className="meta">No approved plan yet.</p><button onClick={() => setView("intent")}>Describe Intent</button></section>
          ) : (
            <>
              <div className="row wrap">
                {detail.workItems.map((w) => (
                  <button key={w.id} className={w.id === selectedWorkItem?.id ? "tab active" : "tab"} onClick={() => { setSelectedWorkItemId(w.id); setSelectedStepId(""); }}>
                    {w.key} · {w.title} <span className="meta">({w.state})</span>
                  </button>
                ))}
              </div>

              <GatePanel gates={openGates} policyCode={policyCode} busy={busy} onResolve={resolveGate} />

              {selectedWorkItem && (
                <OrbitMap
                  workItem={selectedWorkItem}
                  executions={executionByStep}
                  agentName={agentName}
                  openGatePolicyCode={selectedGate ? policyCode(selectedGate.policyId) : "API-04"}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                />
              )}

              <section className="panel inspector">
                <h2>Execution Inspector</h2>
                {!selectedStepId && <p className="meta">Select any node. Agent nodes show Context Snapshot, Execution Contract, permissions, activity, evidence, and audit.</p>}
                {selectedStepId && !selectedExecution && (() => {
                  const step = selectedWorkItem?.workflows.flatMap((w) => w.steps).find((s) => s.id === selectedStepId);
                  return step ? (
                    <div>
                      <h3>{step.title}</h3>
                      <p className="meta">Kind: {step.kind} · State: {step.state}{step.assignedAgentDefinitionId ? ` · Suggested: ${agentName(step.assignedAgentDefinitionId)}` : ""}</p>
                      {step.kind === "ai" ? <button onClick={() => executeStep(step.id)} disabled={busy}>Start scoped Agent Session</button> : <p className="meta">Human/system steps are tracked on the map; agent execution starts from AI nodes.</p>}
                    </div>
                  ) : null;
                })()}
                {selectedExecution && (
                  <ExecutionInspector exec={selectedExecution} context={context} busy={busy} onResolve={resolveGate} policyCode={policyCode} />
                )}
                {selectedWorkItem && (
                  <div className="why">
                    <h3>Why does this work exist?</h3>
                    <p className="trace">Product problem → <b>{detail.initiative.title}</b> → {selectedWorkItem.decisionIds.map(decisionTitle).join(" · ") || "intent"} → {selectedWorkItem.key} {selectedWorkItem.title} → workflows above → agent session → evidence.</p>
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      )}

      {view === "decisions" && (
        <main className="page">
          <p className="eyebrow">Context & Decisions · Guardrails</p>
          <h1>What we decided. What is allowed.</h1>
          <div className="grid">
            {context?.decisions.map((d) => (
              <article className="card" key={d.id}>
                <h3>{d.title} <span className="chip green">{d.status}</span></h3>
                <p className="meta">{d.rationale}</p>
                <p className="meta">Scope: {d.scope.join(", ")}</p>
                {context.policies.filter((p) => p.sourceDecisionId === d.id).map((p) => <span className="chip amber" key={p.id}>{p.code} derived guardrail</span>)}
              </article>
            ))}
          </div>
          <section className="panel">
            <h2>Guardrails</h2>
            <table className="table"><thead><tr><th>Code</th><th>Policy</th><th>Category</th><th>Result</th><th>Source</th></tr></thead>
              <tbody>{context?.policies.map((p) => <tr key={p.id}><td>{p.code}</td><td>{p.name}</td><td>{p.category}</td><td><span className={p.result === "DENY" ? "chip red" : "chip amber"}>{p.result}</span></td><td className="meta">{p.sourceDecisionId ? decisionTitle(p.sourceDecisionId) : "Organization policy"}</td></tr>)}</tbody>
            </table>
            <p className="meta">AI can recommend or explain policies. Deterministic software enforces them. Policy results: ALLOW · DENY · APPROVAL_REQUIRED.</p>
          </section>
        </main>
      )}

      {view === "agents" && context && (
        <AgentCatalog context={context} principalId={principalId} onChanged={refreshAll} setError={setError} setNotice={setNotice} />
      )}
    </div>
  );
}

function GatePanel({ gates, policyCode, busy, onResolve }: { gates: HumanGate[]; policyCode: (id: string) => string; busy: boolean; onResolve: (id: string, d: "approved" | "rejected") => void }) {
  if (!gates.length) return null;
  return (
    <section className="gate-panel">
      <h2>◆ Susan needed — Human Gate</h2>
      {gates.map((g) => (
        <article key={g.id}>
          <p><b>{g.title}</b> <span className="chip amber">{policyCode(g.policyId)}</span></p>
          <p className="meta">{g.reason}</p>
          <p className="meta">Blocking {g.blockedWorkflowIds.length} workflow(s). Agents cannot approve their own work (GOV-01).</p>
          <div className="row">
            <button onClick={() => onResolve(g.id, "approved")} disabled={busy}>Approve</button>
            <button className="secondary" onClick={() => onResolve(g.id, "rejected")} disabled={busy}>Reject</button>
            <span className="meta">Request alternative: reject and ask the agent for a different approach.</span>
          </div>
        </article>
      ))}
    </section>
  );
}

function ExecutionInspector({ exec, context, busy, onResolve, policyCode }: { exec: ExecutionRecord; context: DemoContext | null; busy: boolean; onResolve: (id: string, d: "approved" | "rejected") => void; policyCode: (id: string) => string }) {
  const definition: AgentDefinition | undefined = context?.agentDefinitions.find((a) => a.id === exec.session.agentDefinitionId);
  return (
    <div>
      <h3>{exec.session.mission}</h3>
      <p className="meta">Executor: {definition?.name} v{exec.session.agentDefinitionVersion} · Session {exec.session.id} · State: <b>{exec.session.state}</b></p>
      <div className="grid">
        <article className="card"><h4>Context Snapshot</h4><p className="meta">{exec.snapshot.id} · max {exec.snapshot.maxClassification} · {exec.snapshot.items.length} authorized decisions</p><ul>{exec.snapshot.items.map((i) => <li className="meta" key={i.contextItemId}><b>{i.title}</b> — {i.excerpt}</li>)}</ul><p className="meta">Forbidden: {exec.snapshot.forbiddenData.join(", ")}</p></article>
        <article className="card"><h4>Execution Contract</h4><p className="meta">{exec.contract.id}</p><p className="meta">Allowed: {exec.contract.allowedActions.join(", ")}</p><p className="meta">Approval required: {exec.contract.approvalRequiredActions.join(", ")}</p><p className="meta">Forbidden: {exec.contract.forbiddenActions.join(", ")}</p><p className="meta">Paths: {exec.contract.allowedPaths.join(", ")}</p></article>
        <article className="card"><h4>Evidence & Provenance</h4>{exec.evidence.map((e) => <p className="meta" key={e.id}><span className={e.result === "passed" ? "chip green" : e.result === "failed" ? "chip red" : "chip amber"}>{e.result}</span> <b>{e.title}</b> — {e.summary}</p>)}</article>
      </div>
      <h4>Live Activity</h4>
      <ul className="activity">{exec.activity.map((a, i) => <li key={i}><span className={`act act-${a.kind}`}>{a.kind}</span>{a.text}</li>)}</ul>
      {exec.gate?.state === "open" && (
        <div className="gate-inline">
          <b>◆ {policyCode(exec.gate.policyId)} Human Gate open</b><span className="meta"> {exec.gate.reason}</span>
          <div className="row"><button onClick={() => onResolve(exec.gate!.id, "approved")} disabled={busy}>Approve & Resume</button><button className="secondary" onClick={() => onResolve(exec.gate!.id, "rejected")} disabled={busy}>Reject</button></div>
        </div>
      )}
    </div>
  );
}

function AgentCatalog({ context, principalId, onChanged, setError, setNotice }: { context: DemoContext; principalId: string; onChanged: () => Promise<void>; setError: (s: string) => void; setNotice: (s: string) => void }) {
  const [name, setName] = useState("");
  const isAdmin = context.principals.find((p) => p.id === principalId)?.role === "admin";
  async function createAgent() {
    try {
      await api.createAgentDefinition({ name, purpose: "Created from Admin Agent Catalog", model: "muse-spark", capabilities: ["review"], approvedTools: ["context.read_authorized"] }, principalId);
      setName("");
      await onChanged();
      setNotice("Agent definition created and approved (v1). Every change is versioned and auditable.");
    } catch (e) { setError(String(e)); }
  }
  return (
    <main className="page">
      <p className="eyebrow">Admin · Agent Catalog</p>
      <h1>Approved reusable agents.</h1>
      <p className="lede">Only organization administrators can create, edit, approve, suspend, or retire Agent Definitions. Regular members assign approved agents — they cannot create them. Try it: switch the principal to Alex in the top bar, then create an agent.</p>
      <div className="grid">
        {context.agentDefinitions.map((a) => (
          <article className="card" key={a.id}>
            <h3>{a.name} <span className="chip green">{a.status}</span></h3>
            <p className="meta">{a.purpose}</p>
            <p className="meta">Provider: {a.provider} · Model: {a.model} · v{a.version} · Clearance: {a.maxContextClassification}</p>
            <p className="meta">Capabilities: {a.capabilities.join(", ")}</p>
            <p className="meta">Tools: {a.approvedTools.join(", ")}</p>
            <p className="meta">Repos: {a.allowedRepositories.join(", ") || "none"} · Paths: {a.allowedPaths.join(", ") || "none"}</p>
            <p>{a.approvalRequiredActions.map((x) => <span className="chip amber" key={x}>approval: {x}</span>)}{a.forbiddenActions.map((x) => <span className="chip red" key={x}>forbidden: {x}</span>)}</p>
          </article>
        ))}
      </div>
      <section className="panel">
        <h2>Create Agent {isAdmin ? "" : "(admin only)"}</h2>
        <label htmlFor="agent-name">Agent name</label>
        <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. QA Reviewer — Muse Spark" />
        <button onClick={createAgent} disabled={!name.trim()}>Validate Agent → Approve Agent</button>
        {!isAdmin && <p className="meta">You are acting as a member: the API will deny this (403) — governance is enforced server-side, not by hiding the button.</p>}
      </section>
    </main>
  );
}

function truncateIntent(s: string) {
  return s.length > 72 ? `${s.slice(0, 71)}…` : s;
}

function CaptureWindow({
  step,
  intent,
  title,
  onClose,
  onIntent,
  onTitle,
}: {
  step: number;
  intent: string;
  title: string;
  onClose: () => void;
  onIntent: (value: string) => void;
  onTitle: (value: string) => void;
}) {
  const [mode, setMode] = useState<"voice" | "type">(step === 0 ? "voice" : "type");
  const [draft, setDraft] = useState(step === 0 ? intent : title);
  const [status, setStatus] = useState("");
  const [usedPreview, setUsedPreview] = useState(false);
  const [supported] = useState(() => typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window));

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [recordError, setRecordError] = useState("");
  const mediaRef = useRef<MediaRecorder | null>(null);
  const dictationRef = useRef<SpeechRecognitionLike | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function startRecording() {
    setRecordError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", ""];
      const mimeType = types.find((t) => t && MediaRecorder.isTypeSupported(t)) ?? "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size > 0) {
          setAudioUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return URL.createObjectURL(blob);
          });
          setStatus("Recording saved below — play it back, then use the transcript.");
        } else {
          setStatus("Recording stopped, but no audio was captured. Try again, or use Type.");
        }
        // Real transcription path: if the browser has SpeechRecognition,
        // the user can dictate/type at any time. MediaRecorder audio itself
        // cannot be transcribed client-side, so the preview transcript is
        // labeled honestly; the recording remains playable as evidence.
        setUsedPreview(true);
        setDraft((previous) =>
          previous.trim()
            ? previous
            : "Build interview capture with explicit consent, microphone and system audio, recovery when devices change, transcription, and a structured interview debrief.",
        );
      };
      recorder.onerror = () => setRecordError("The recorder stopped unexpectedly. Try again or type the intent instead.");
      mediaRef.current = recorder;
      recorder.start(250);
      setElapsed(0);
      setRecording(true);
      setStatus("Recording… tap again to stop.");
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setRecording(false);
      setRecordError(
        name === "NotAllowedError"
          ? "Recording is not available: microphone permission was denied. Allow microphone access for localhost in the browser address bar, then try again — or use Type."
          : name === "NotFoundError"
            ? "Recording is not available: no microphone was found. Connect a microphone or use Type."
            : "Recording is not available in this browser window. Open Orbit in a browser tab with microphone access, or use Type.",
      );
    }
  }

  // Live dictation: real client-side speech-to-text where the browser
  // provides it (Chrome/Edge desktop). This is the transcription engine
  // for the demo; Muse Voice Transcribe replaces it server-side later.
  function startDictation() {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!Ctor) {
      setRecordError("Live dictation is not available in this browser. Use Record to capture audio, or open Orbit in Chrome and allow microphone access.");
      return;
    }
    setRecordError("");
    let finalText = "";
    const rec = new Ctor();
    rec.lang = "en-GB";
    rec.interimResults = true;
    rec.continuous = true;
    // event.results is cumulative for the whole session: indexing from
    // resultIndex and replacing (not appending) the draft each time is
    // what keeps phrases from duplicating.
    rec.onresult = (event: SpeechRecognitionEventLike) => {
      let nextFinal = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i]!;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) nextFinal += text;
        else interim += text;
      }
      finalText = nextFinal;
      const text = `${finalText} ${interim}`.replace(/\s+/g, " ").trim();
      setDraft(text);
      setUsedPreview(false);
      setStatus("Transcribing your voice…");
    };
    rec.onend = () => {
      setRecording(false);
      setStatus(finalText.trim() ? "Transcript ready — review and edit before using it." : "Dictation stopped. No speech was captured — try again, or use Type.");
    };
    rec.onerror = (event: { error?: string }) => {
      setRecording(false);
      setRecordError(
        event?.error === "not-allowed"
          ? "Microphone permission was denied. Allow microphone access for localhost in the browser address bar, then try Dictate again."
          : "Dictation stopped before capturing speech. Try again in a quiet moment, or use Type.",
      );
    };
    mediaRef.current = null;
    dictationRef.current = rec;
    try {
      rec.start();
      setRecording(true);
      setAudioUrl("");
      setStatus("Dictating… speak now — your words become the transcript.");
    } catch {
      setRecordError("Dictation could not start. Try again, or use Type.");
    }
  }

  function stopDictation() {
    dictationRef.current?.stop();
    setRecording(false);
  }

  function stopRecording() {
    const recorder = mediaRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.requestData?.();
      recorder.stop();
    }
    // Some embedded browsers do not deliver onstop; never strand the UI in
    // a recording state. The audio element appears when onstop arrives.
    window.setTimeout(() => setRecording(false), 150);
  }

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const isIntent = step === 0;
  return (
    <div className="capture-backdrop" role="dialog" aria-modal="true" aria-label={isIntent ? "Describe intent" : "Set the goal"}>
      <section className="capture-window">
        <button className="capture-close" onClick={onClose} aria-label="Close">×</button>
        <p className="eyebrow">{isIntent ? "Describe intent" : "Set the goal"}</p>
        {isIntent && (
          <div className="capture-tabs">
            <button className={mode === "voice" ? "tab active" : "tab"} onClick={() => setMode("voice")}>🎙 Voice</button>
            <button className={mode === "type" ? "tab active" : "tab"} onClick={() => setMode("type")}>Type</button>
          </div>
        )}

        {isIntent && mode === "voice" ? (
          <div className="voice-stage">
            {!recording && (
              <div className="capture-tabs">
                <button className="tab active" onClick={startDictation}>🎙 Dictate — transcribe my voice</button>
                <button className="tab" onClick={() => void startRecording()}>● Record audio only</button>
              </div>
            )}
            <button className={recording ? "mic listening" : "mic"} onClick={() => (recording ? (dictationRef.current ? stopDictation() : stopRecording()) : startDictation())} aria-label={recording ? "Stop" : "Dictate — transcribe my voice"}>
              <span className="mic-ring" /><span className="mic-ring delay" /><span className="mic-icon">{recording ? "■" : "🎙"}</span>
            </button>
            <p className="meta">{recordError || (recording ? `${dictationRef.current ? "Dictating" : "Recording"}… ${elapsed}s — tap the mic to stop.` : status || "Dictate transcribes your voice live. Record only captures audio with a preview transcript.")}</p>
            {audioUrl && <audio className="recording-playback" controls src={audioUrl} />}
            {usedPreview && <p className="chip amber preview-chip">Muse Voice Transcribe · preview transcript</p>}
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Transcript appears here — review and edit before using it." />
          </div>
        ) : (
          <div className="voice-stage">
            <label htmlFor="capture-draft">{isIntent ? "Product intent" : "Initiative name"}</label>
            <textarea id="capture-draft" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={isIntent ? "Describe what this project should become…" : "e.g. Interview Capture & Debrief"} />
          </div>
        )}

        <div className="row">
          <button onClick={() => (isIntent ? onIntent(draft.trim()) : onTitle(draft.trim()))} disabled={!draft.trim()}>
            {isIntent ? "Use this intent" : "Save goal"}
          </button>
          <button className="secondary" onClick={onClose}>Cancel</button>
        </div>
        <p className="meta">Nothing is planned or created from this text until you review the proposed plan.</p>
      </section>
    </div>
  );
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

const HN_STAGES = [
  { node: "Work Item", actor: "Linear Agent", model: "Muse Spark", action: "Creating the approved work plan in Linear", lines: ["HN-1 … HN-9 queued from the approved plan", "✓ 9 work items created in Linear"], cta: "Open in Linear ↗", done: "9 work items created in Linear" },
  { node: "Agent", actor: "Design Agent", model: "Muse Spark + Figma", action: "Preparing the initial Jobs Viewer design", lines: ["Designing: Job card · Jobs list · Loading state · Error state · Mobile layout", "✓ Design ready in Figma — HN Jobs Viewer v1"], cta: "Open design ↗", done: "Design ready in Figma" },
  { node: "Human Gate", actor: "Susan", model: "Human approval", action: "Design ready for review", lines: ["Figma: HN Jobs Viewer — v1", "Decision D-101 will be recorded on approval"], cta: "Approve design", done: "Design approved — Decision D-101 recorded (Orbit 1)" },
  { node: "Agent", actor: "Engineering Agent", model: "Muse Code / Muse Spark", action: "Implementing HN-1 → HN-9", lines: ["Context Snapshot + Execution Contract resolved (src/**, tests/**; no .env, secrets)", "API client · job IDs · job details · job cards · tests"], cta: "Implementation in progress", done: "Implementation complete" },
  { node: "Pull Request", actor: "Engineering Agent", model: "GitHub PR #1", action: "Build initial HN Jobs Viewer", lines: ["Contains: API client, fetching, UI, states, tests"], cta: "Open PR #1 ↗", done: "PR #1 opened" },
  { node: "Decision", actor: "Decision Agent", model: "Muse Spark (detects) · Orbit (governs)", action: "Potential decision detected in PR #1", lines: ["“Let’s only fetch 20 jobs initially — users can load more manually.”", "Save as product decision D-102?"], cta: "Accept Decision D-102", done: "D-102 accepted — fetch 20 jobs initially, explicit incremental loading" },
  { node: "Context", actor: "Orbit", model: "Deterministic context refresh", action: "Decision flows inward", lines: ["Pull Request → Decision → Context → INTENT", "Context v1 → v2 · Current Intent updated (Original Intent preserved)"], cta: "Context updated", done: "Context v2 — future sessions inherit: batch = 20, incremental loading" },
  { node: "New Work", actor: "Product Planner", model: "Muse Wonder", action: "Plan updated from Context v2", lines: ["HN-10 added: Add Load More Jobs (20 jobs per batch)", "Next Copilot session receives Context v2 automatically"], cta: "HN-10 created", done: "HN-10 “Load More Jobs” added to the plan" },
  { node: "CI", actor: "CI", model: "GitHub Actions", action: "Verifying PR #1", lines: ["✓ TypeScript · ✓ Unit tests · ✓ Build", "Evidence: 3 verification checks passed"], cta: "Evidence recorded", done: "CI passed — Evidence updated in Orbit 1" },
  { node: "Release", actor: "Release", model: "Deployment", action: "Release ready — v0.1 HN Jobs Viewer", lines: ["10 work items · 2 decisions recorded · 3 CI checks · 1 release"], cta: "Release v0.1", done: "✓ Released — Initial HN Jobs Viewer shipped" },
];

function HnJourney({
  stage,
  setStage,
  onOpenMap,
  contextState,
  proposedDecisions,
  decisionPulse,
  onSimulatePr,
  onApproveDecision,
  onRejectDecision,
}: {
  stage: number;
  setStage: (n: number | ((n: number) => number)) => void;
  onOpenMap: () => void;
  contextState: ContextState | null;
  proposedDecisions: ProposedDecision[];
  decisionPulse: boolean;
  onSimulatePr: () => Promise<void>;
  onApproveDecision: (id: string) => Promise<void>;
  onRejectDecision: (id: string) => Promise<void>;
}) {
  const current = HN_STAGES[stage];
  const finished = stage >= HN_STAGES.length;
  const pending = proposedDecisions.filter((d) => d.status === "proposed");
  const showDecisionCard = stage >= 5 && pending.length > 0;
  return (
    <section className="panel hn-journey">
      <div className="row between">
        <h2>From idea to release</h2>
        <span className={decisionPulse ? "chip green context-chip pulse" : "chip green context-chip"}>
          Current Context v{contextState?.version ?? 1}
        </span>
        <button className="secondary" onClick={onOpenMap}>Open Orbit Map</button>
      </div>

      {showDecisionCard && pending.map((d) => (
        <article className="decision-proposal" key={d.id}>
          <p className="proposal-kicker">◐ New decision detected · {d.sourceRef} · Awaiting approval</p>
          <h3>{d.title}</h3>
          <p className="meta">Detected from: “{d.sourceQuote}”</p>
          <div className="context-diff">
            <p><span className="diff-from">Current Context v{d.proposedChange.fromVersion}</span> → <span className="diff-to">Proposed Context v{d.proposedChange.toVersion}</span> <span className="meta">(not active yet)</span></p>
            {d.proposedChange.additions.map((line) => <p className="diff-add" key={line}>+ {line}</p>)}
            {d.proposedChange.exclusions.map((line) => <p className="diff-del" key={line}>− {line} prohibited</p>)}
            <p className="meta">Affected future work: {d.proposedChange.affectedWork.join(" · ")}</p>
          </div>
          <div className="row">
            <button onClick={() => void onApproveDecision(d.id)}>Approve context update</button>
            <button className="secondary" onClick={() => void onRejectDecision(d.id)}>Reject</button>
            <span className="meta">◆ Susan needed — a PR decision may change project context.</span>
          </div>
        </article>
      ))}

      <ol className="hn-steps">
        {HN_STAGES.map((s2, i) => (
          <li key={s2.node + i} className={i < stage ? "done" : i === stage ? "active" : "todo"}>
            <span className="hn-dot">{i < stage ? "✓" : i + 1}</span>
            <span className="hn-step-main">
              <b>{s2.actor}</b> <span className="chip">{s2.node}</span> <span className="meta">{s2.model}</span>
              <small>{i < stage ? s2.done : s2.action}</small>
              {(i === stage || i < stage) && s2.lines.map((line) => <small className="meta" key={line}>{line}</small>)}
            </span>
            {i === stage && i === 5 ? (
              <button onClick={() => void onSimulatePr()}>Simulate PR #14 comment</button>
            ) : i === stage && i === 6 ? (
              <span className="meta">{pending.length ? "Review the proposed decision above" : "Decision approved — context is current"}</span>
            ) : i === stage ? (
              <button onClick={() => setStage(stage + 1)}>{s2.cta}</button>
            ) : null}
          </li>
        ))}
      </ol>
      {finished ? (
        <p className="meta">Outcome: <b>Initial HN Jobs Viewer shipped</b> · 10 work items · 2 decisions (D-101 design, D-102 batch size) · Context v{contextState?.version ?? 2} · CI evidence · v0.1 released. Why? — “Why does HN Jobs Viewer load 20 jobs at a time?” → Intent → HN-10 → PR #14 → D-102 → Context v{contextState?.version ?? 2} → Implementation → CI → Release.</p>
      ) : (
        <p className="meta">Now: <b>{current?.actor}</b> — {current?.action}. Internal Snapshot / Contract / Policy detail lives in the Orbit Map inspector, not here.</p>
      )}
      {stage > 0 && <button className="secondary" onClick={() => setStage(0)}>Reset demo</button>}
    </section>
  );
}
