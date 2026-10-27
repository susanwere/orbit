import { useEffect, useMemo, useState } from "react";
import { Landing } from "./Landing.js";
import { OrbitMap } from "./OrbitMap.js";
import {
  api,
  type AgentDefinition,
  type DemoContext,
  type ExecutionRecord,
  type HumanGate,
  type InitiativeDetail,
  type ProposedPlan,
  type WorkItem,
} from "./api.js";

const DEMO_INTENT =
  "Build interview capture with explicit consent, microphone and system audio, recovery when devices change, transcription, and a structured interview debrief.";
type View = "home" | "projects" | "intent" | "map" | "decisions" | "agents";

export function App() {
  const [view, setView] = useState<View>("home");
  const [context, setContext] = useState<DemoContext | null>(null);
  const [principalId, setPrincipalId] = useState("usr_susan");
  const [title, setTitle] = useState("Interview Capture & Debrief");
  const [intent, setIntent] = useState(DEMO_INTENT);
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
  }, []);

  const principal = context?.principals.find((p) => p.id === principalId);
  const decisionTitle = (id: string) => context?.decisions.find((d) => d.id === id)?.title ?? id;
  const agentName = (id?: string) => context?.agentDefinitions.find((a) => a.id === id)?.name ?? id ?? "";
  const policyCode = (id: string) => context?.policies.find((p) => p.id === id)?.code ?? id;

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
      setView("map");
      setNotice("Plan approved. Work graph created — nothing was written externally.");
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
      {error && <div className="notice error-box">{error}</div>}

      {view === "home" && (
        <Landing onEnter={() => setView("projects")} onDescribe={() => setView("intent")} />
      )}

      {view === "projects" && (
        <main className="page">
          <p className="eyebrow">Projects</p>
          <h1>Your projects</h1>
          <div className="project-list">
            <button className="project-row" onClick={() => setView(detail ? "map" : "intent")}>
              <span className="project-glyph live">◉</span>
              <span className="project-main">
                <b>CareerGlyph</b>
                <span>{detail ? `${detail.initiative.title} · ${detail.initiative.status}` : "Interview Capture & Debrief · not started"}</span>
              </span>
              <span className="project-signals">
                {openGates.length > 0 && <span className="signal amber">◆ {openGates.length} needs you</span>}
                {executions.some((e) => e.session.state === "running") && <span className="signal cyan">executing</span>}
                {detail && <span className="signal muted">{detail.workItems.length} work items</span>}
              </span>
              <span className="project-open">{detail ? "Open map →" : "Start →"}</span>
            </button>

            <div className="project-row quiet" aria-disabled="true">
              <span className="project-glyph">○</span>
              <span className="project-main"><b>Orbit Platform</b><span>Dogfooding Orbit itself — no initiative yet</span></span>
              <span className="signal muted">idle</span>
            </div>

            <div className="project-row quiet" aria-disabled="true">
              <span className="project-glyph">○</span>
              <span className="project-main"><b>Mobile Companion</b><span>Concept — awaiting intent</span></span>
              <span className="signal muted">concept</span>
            </div>
          </div>
          <button className="cta-quiet" onClick={() => setView("intent")}>+ New project from intent</button>
        </main>
      )}

      {view === "intent" && (
        <main className="page">
          <p className="eyebrow">Describe Intent</p>
          <h1>What do you want to build?</h1>
          <p className="lede">Muse Voice → Muse Spark turns intent into a proposed Orbit Map. Nothing is created externally before human review.</p>
          <section className="panel">
            <label htmlFor="title">Initiative</label>
            <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <label htmlFor="intent">Product intent</label>
            <textarea id="intent" value={intent} onChange={(e) => setIntent(e.target.value)} />
            <div className="row">
              <button onClick={propose} disabled={busy || !intent.trim()}>{busy ? "Planning…" : "Review proposed Orbit Map"}</button>
              <span className="meta">Recorder chip (demo): “Build interview capture with explicit consent…” is the seeded CareerGlyph scenario.</span>
            </div>
          </section>

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
