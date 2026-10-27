import {
  DomainError,
  assertCanManageAgents,
  assertCanStartSession,
  assertGateResolverIsHuman,
  assertSnapshotWithinEnvelope,
  evaluatePolicies,
  transitionAgentSession,
  transitionHumanGate,
  transitionStep,
  transitionWorkflow,
  type AgentDefinition,
  type AgentSession,
  type ContextSnapshot,
  type Evidence,
  type ExecutionContract,
  type HumanGate,
  type OrbitEvent,
  type PolicyEvaluation,
  type Principal,
} from "@orbit/domain";
import type { Store } from "./store.js";

const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

/**
 * Simulated Muse Code activity. The session/event contract is real;
 * swapping this timeline for a live runner keeps every upstream behaviour
 * (snapshots, contracts, policy gates, evidence) unchanged.
 */
export interface ActivityLine {
  at: string;
  text: string;
  kind: "info" | "file" | "test" | "policy";
}

export interface ExecutionRecord {
  session: AgentSession;
  snapshot: ContextSnapshot;
  contract: ExecutionContract;
  activity: ActivityLine[];
  gate?: HumanGate;
  evidence: Evidence[];
  policyEvaluations: PolicyEvaluation[];
}

export class ExecutionService {
  readonly executions = new Map<string, ExecutionRecord>();
  readonly gates = new Map<string, HumanGate>();
  readonly events: OrbitEvent[] = [];
  readonly snapshots = new Map<string, ContextSnapshot>();
  readonly contracts = new Map<string, ExecutionContract>();
  readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly store: Store) {}

  #emit(type: string, actor: Principal, entityType: string, entityId: string, payload: Record<string, unknown> = {}) {
    this.events.push({
      id: id("evt"),
      organizationId: this.store.organizationId,
      type,
      actorType: actor.type,
      actorId: actor.id,
      entityType,
      entityId,
      payload,
      occurredAt: now(),
    });
  }

  createAgentDefinition(actor: Principal, input: Partial<AgentDefinition>): AgentDefinition {
    assertCanManageAgents(actor);
    const definition: AgentDefinition = {
      id: id("agt"),
      organizationId: this.store.organizationId,
      name: input.name ?? "Untitled agent",
      purpose: input.purpose ?? "",
      provider: input.provider ?? "meta",
      model: input.model ?? "muse-code",
      capabilities: input.capabilities ?? [],
      approvedTools: input.approvedTools ?? [],
      maxContextClassification: input.maxContextClassification ?? "INTERNAL",
      allowedContextScopes: input.allowedContextScopes ?? [],
      allowedRepositories: input.allowedRepositories ?? [],
      allowedPaths: input.allowedPaths ?? [],
      approvalRequiredActions: input.approvalRequiredActions ?? [],
      forbiddenActions: input.forbiddenActions ?? ["secret.production.read", "gate.resolve.self", "agent.create"],
      networkPolicy: input.networkPolicy ?? "none",
      networkAllowlist: input.networkAllowlist ?? [],
      status: "approved",
      version: 1,
      createdByPrincipalId: actor.id,
      createdAt: now(),
    };
    this.store.agentDefinitions.push(definition);
    this.#emit("agent_definition.created", actor, "AgentDefinition", definition.id, { name: definition.name });
    return definition;
  }

  startExecution(actor: Principal, stepId: string): ExecutionRecord {
    const step = this.store.steps.get(stepId);
    if (!step) throw new DomainError("not_found", "Workflow step not found");
    const workflow = this.store.workflows.get(step.workflowId);
    if (!workflow) throw new DomainError("not_found", "Workflow not found");
    const workItem = this.store.workItems.get(workflow.workItemId);
    if (!workItem) throw new DomainError("not_found", "Work item not found");
    if (!step.assignedAgentDefinitionId) {
      throw new DomainError("validation", "Step has no approved agent assigned. Human/system steps are not agent executions.");
    }
    if (this.executions.has(stepId)) {
      throw new DomainError("invalid_state", "An execution already exists for this step. Restart is a new session (out of demo scope).");
    }

    const definition = this.store.agentDefinitions.find((a) => a.id === step.assignedAgentDefinitionId);
    if (!definition) throw new DomainError("not_found", "Agent definition not found");
    assertCanStartSession(definition, this.store.organizationId);

    const initiative = this.store.initiatives.get(workItem.initiativeId);
    // Context Resolver (authorized subset): decisions linked to the work item,
    // filtered to the definition's clearance.
    const decisionObjs = this.store.decisions.filter((d) => workItem.decisionIds.includes(d.id) && d.status === "active");
    const snapshot: ContextSnapshot = {
      id: id("ctx"),
      organizationId: this.store.organizationId,
      workflowStepId: step.id,
      mission: step.title,
      intentExcerpt: initiative?.intent ?? "",
      items: decisionObjs.map((d) => ({
        contextItemId: d.id,
        title: d.title,
        classification: "CONFIDENTIAL" as const,
        excerpt: d.rationale,
      })),
      decisionIds: decisionObjs.map((d) => d.id),
      maxClassification: definition.maxContextClassification,
      allowedRepositories: definition.allowedRepositories,
      allowedPaths: definition.allowedPaths,
      forbiddenData: ["customer information", "production secrets", "finance data"],
      approvalRequiredActions: definition.approvalRequiredActions,
      createdAt: now(),
    };
    assertSnapshotWithinEnvelope(definition, snapshot);
    this.snapshots.set(snapshot.id, snapshot);

    const contract: ExecutionContract = {
      id: id("contract"),
      organizationId: this.store.organizationId,
      workflowStepId: step.id,
      agentDefinitionId: definition.id,
      agentDefinitionVersion: definition.version,
      contextSnapshotId: snapshot.id,
      allowedActions: ["file.read", "file.write_scoped", "tests.run"],
      approvalRequiredActions: definition.approvalRequiredActions,
      forbiddenActions: definition.forbiddenActions,
      allowedRepositories: definition.allowedRepositories,
      allowedPaths: definition.allowedPaths,
      networkPolicy: definition.networkPolicy,
      completionCriteria: ["Scoped files changed within allowed paths", "Unit tests pass", "No forbidden action attempted"],
      createdAt: now(),
    };
    this.contracts.set(contract.id, contract);

    const session: AgentSession = {
      id: id("sess"),
      organizationId: this.store.organizationId,
      agentDefinitionId: definition.id,
      agentDefinitionVersion: definition.version,
      workflowStepId: step.id,
      requestedByPrincipalId: actor.id,
      humanOwnerPrincipalId: workItem.ownerPrincipalId,
      mission: step.title,
      contextSnapshotId: snapshot.id,
      executionContractId: contract.id,
      state: "created",
      createdAt: now(),
    };
    session.state = transitionAgentSession(session.state, "authorized");
    session.state = transitionAgentSession(session.state, "running");
    session.startedAt = now();
    this.sessions.set(session.id, session);

    step.state = transitionStep(step.state === "pending" ? "ready" : step.state, "running");
    workflow.state = workflow.state === "proposed" || workflow.state === "approved" ? "running" : workflow.state;
    if (workItem.state === "draft" || workItem.state === "ready") workItem.state = "in_progress";
    this.#emit("agent_session.started", actor, "AgentSession", session.id, { stepId, agentDefinitionId: definition.id });

    const activity: ActivityLine[] = [
      { at: now(), kind: "info", text: `Session authorized — Context Snapshot ${snapshot.id} (${snapshot.items.length} decisions, max ${snapshot.maxClassification})` },
      { at: now(), kind: "info", text: `Execution Contract ${contract.id} — repos: ${contract.allowedRepositories.join(", ") || "none"}; paths: ${contract.allowedPaths.join(", ") || "none"}` },
      { at: now(), kind: "file", text: "Read src/recorder/RecorderControls.tsx and tests/recorder/consent.test.ts within scoped checkout" },
      { at: now(), kind: "file", text: "Edited src/recorder/RecorderControls.tsx — consent gate, visible status, stop control" },
    ];

    // Policy API-04: the simulated agent proposes an API contract change.
    const evaluation = evaluatePolicies({
      action: "api_contract.change",
      resourceRef: step.id,
      policies: this.store.policies,
    });
    const policyEvaluations: PolicyEvaluation[] = evaluation.evaluations.map((e) => ({
      ...e,
      id: id("poleval"),
      organizationId: this.store.organizationId,
      evaluatedAt: now(),
    }));

    let gate: HumanGate | undefined;
    if (evaluation.result === "APPROVAL_REQUIRED" && evaluation.policy) {
      gate = {
        id: id("gate"),
        organizationId: this.store.organizationId,
        policyId: evaluation.policy.id,
        workflowId: workflow.id,
        workflowStepId: step.id,
        agentSessionId: session.id,
        title: "Approve API contract change",
        reason: "Muse Code proposes changing the recorder API contract (startRecording signature + consent event payload). Policy API-04 requires human approval before this proceeds.",
        requestedByPrincipalId: definition.id,
        state: "open",
        blockedWorkflowIds: [workflow.id],
        createdAt: now(),
      };
      this.gates.set(gate.id, gate);
      workflow.state = transitionWorkflow(workflow.state, "paused");
      step.state = transitionStep(step.state, "waiting");
      session.state = transitionAgentSession(session.state, "waiting");
      activity.push({ at: now(), kind: "policy", text: `Policy API-04 evaluated: APPROVAL_REQUIRED — workflow paused, Human Gate ${gate.id} opened` });
      this.#emit("gate.requested", actor, "HumanGate", gate.id, { policyCode: "API-04", workflowId: workflow.id });
    }

    const evidence: Evidence[] = [
      {
        id: id("ev"), organizationId: this.store.organizationId, scopeRef: step.id,
        category: "policy_evaluation", title: "Policy API-04 evaluation", result: "pending",
        summary: evaluation.reason, agentSessionId: session.id, producedByPrincipalId: definition.id, createdAt: now(),
      },
    ];

    const record: ExecutionRecord = { session, snapshot, contract, activity, gate, evidence, policyEvaluations };
    this.executions.set(stepId, record);
    return record;
  }

  resolveGate(actor: Principal, gateId: string, decision: "approved" | "rejected"): ExecutionRecord {
    assertGateResolverIsHuman(actor);
    const gate = this.gates.get(gateId);
    if (!gate) throw new DomainError("not_found", "Human gate not found");
    gate.state = transitionHumanGate(gate.state, decision);
    gate.approverPrincipalId = actor.id;
    gate.resolvedAt = now();

    const workflow = this.store.workflows.get(gate.workflowId);
    if (!workflow) throw new DomainError("not_found", "Workflow not found");
    const record = gate.workflowStepId ? this.executions.get(gate.workflowStepId) : undefined;
    if (!record) throw new DomainError("not_found", "Execution record not found");
    const step = gate.workflowStepId ? this.store.steps.get(gate.workflowStepId) : undefined;
    const policyEvalEvidence = record.evidence.find((e) => e.category === "policy_evaluation");

    if (decision === "approved") {
      workflow.state = transitionWorkflow(workflow.state, "running");
      if (step) step.state = transitionStep(step.state, "running");
      record.session.state = transitionAgentSession(record.session.state, "running");
      record.activity.push(
        { at: now(), kind: "policy", text: `Human Gate approved by ${actor.displayName} — execution resumed` },
        { at: now(), kind: "file", text: "Applied approved recorder API change within allowed paths" },
        { at: now(), kind: "test", text: "Tests: consent-gate, visible-status, device-recovery — 14 passed, 0 failed" },
      );
      if (step) step.state = transitionStep(step.state, "completed");
      record.session.state = transitionAgentSession(record.session.state, "completed");
      record.session.endedAt = now();
      workflow.state = transitionWorkflow(workflow.state, "completed");
      record.evidence.push(
        { id: id("ev"), organizationId: this.store.organizationId, scopeRef: record.session.workflowStepId, category: "test", title: "Recorder unit tests", result: "passed", summary: "14 passed, 0 failed (consent, visible status, device recovery).", agentSessionId: record.session.id, createdAt: now() },
        { id: id("ev"), organizationId: this.store.organizationId, scopeRef: record.session.workflowStepId, category: "requirement_coverage", title: "Consent requirement coverage", result: "passed", summary: "Explicit consent, visible status, and stop-anytime requirements traced to decisions dec_consent + dec_visible_status.", agentSessionId: record.session.id, createdAt: now() },
        { id: id("ev"), organizationId: this.store.organizationId, scopeRef: record.session.workflowStepId, category: "human_review", title: "Human Gate approval", result: "passed", summary: `Approved by ${actor.displayName}.`, producedByPrincipalId: actor.id, agentSessionId: record.session.id, createdAt: now() },
      );
      if (policyEvalEvidence) {
        policyEvalEvidence.result = "passed";
        policyEvalEvidence.summary += " Human approved at the gate; execution resumed.";
      }
      this.#emit("gate.approved", actor, "HumanGate", gate.id, {});
      this.#emit("agent_session.completed", actor, "AgentSession", record.session.id, {});
    } else {
      workflow.state = transitionWorkflow(workflow.state, "failed");
      if (step) {
        step.state = transitionStep(step.state, "blocked");
      }
      record.session.state = transitionAgentSession(record.session.state, "failed");
      record.session.endedAt = now();
      record.activity.push({ at: now(), kind: "policy", text: `Human Gate rejected by ${actor.displayName} — workflow blocked, agent session ended` });
      if (policyEvalEvidence) {
        policyEvalEvidence.result = "failed";
        policyEvalEvidence.summary += " Human rejected at the gate.";
      }
      record.evidence.push({
        id: id("ev"), organizationId: this.store.organizationId, scopeRef: record.session.workflowStepId,
        category: "human_review", title: "Human Gate rejection", result: "failed",
        summary: `Rejected by ${actor.displayName}; API change was not applied.`, producedByPrincipalId: actor.id,
        agentSessionId: record.session.id, createdAt: now(),
      });
      this.#emit("gate.rejected", actor, "HumanGate", gate.id, {});
    }
    return record;
  }
}
