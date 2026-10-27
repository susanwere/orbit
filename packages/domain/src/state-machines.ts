import { DomainError } from "./errors.js";
import type {
  AgentDefinitionStatus,
  AgentSessionState,
  DecisionStatus,
  HumanGateState,
  InitiativeStatus,
  WorkflowState,
  WorkflowStepState,
  WorkItemState,
} from "./types.js";

function transition<T extends string>(
  entity: string,
  allowed: Record<T, readonly T[]>,
  from: T,
  to: T,
): T {
  const next = allowed[from];
  if (!next?.includes(to)) {
    throw new DomainError(
      "invalid_transition",
      `${entity} cannot transition from ${from} to ${to}`,
    );
  }
  return to;
}

export const INITIATIVE_TRANSITIONS: Record<InitiativeStatus, readonly InitiativeStatus[]> = {
  draft: ["planning", "archived"],
  planning: ["proposed", "draft", "archived"],
  proposed: ["active", "planning", "archived"],
  active: ["completed", "archived"],
  completed: ["archived"],
  archived: [],
};

export const WORK_ITEM_TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  draft: ["ready", "cancelled"],
  ready: ["in_progress", "cancelled"],
  in_progress: ["blocked", "in_review", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  in_review: ["done", "in_progress"],
  done: [],
  cancelled: [],
};

export const WORKFLOW_TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  proposed: ["approved", "cancelled"],
  approved: ["running", "cancelled"],
  running: ["paused", "failed", "completed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  failed: ["running", "cancelled"],
  completed: [],
  cancelled: [],
};

export const STEP_TRANSITIONS: Record<WorkflowStepState, readonly WorkflowStepState[]> = {
  pending: ["ready", "skipped"],
  ready: ["running", "blocked", "skipped"],
  running: ["waiting", "blocked", "failed", "completed"],
  waiting: ["running", "blocked", "failed"],
  blocked: ["ready", "failed"],
  failed: ["ready"],
  completed: [],
  skipped: [],
};

export const AGENT_SESSION_TRANSITIONS: Record<AgentSessionState, readonly AgentSessionState[]> = {
  created: ["authorized", "terminated"],
  authorized: ["running", "terminated"],
  running: ["waiting", "completed", "failed", "terminated"],
  waiting: ["running", "failed", "terminated"],
  completed: [],
  failed: [],
  terminated: [],
};

export const HUMAN_GATE_TRANSITIONS: Record<HumanGateState, readonly HumanGateState[]> = {
  open: ["approved", "rejected", "expired"],
  approved: [],
  rejected: [],
  expired: [],
};

export const DECISION_TRANSITIONS: Record<DecisionStatus, readonly DecisionStatus[]> = {
  proposed: ["active", "rejected"],
  active: ["superseded", "expired"],
  superseded: [],
  rejected: [],
  expired: ["superseded"],
};

export const AGENT_DEFINITION_TRANSITIONS: Record<AgentDefinitionStatus, readonly AgentDefinitionStatus[]> = {
  draft: ["approved", "retired"],
  approved: ["suspended", "retired"],
  suspended: ["approved", "retired"],
  retired: [],
};

export const transitionInitiative = (from: InitiativeStatus, to: InitiativeStatus) =>
  transition("Initiative", INITIATIVE_TRANSITIONS, from, to);
export const transitionWorkItem = (from: WorkItemState, to: WorkItemState) =>
  transition("WorkItem", WORK_ITEM_TRANSITIONS, from, to);
export const transitionWorkflow = (from: WorkflowState, to: WorkflowState) =>
  transition("Workflow", WORKFLOW_TRANSITIONS, from, to);
export const transitionStep = (from: WorkflowStepState, to: WorkflowStepState) =>
  transition("WorkflowStep", STEP_TRANSITIONS, from, to);
export const transitionAgentSession = (from: AgentSessionState, to: AgentSessionState) =>
  transition("AgentSession", AGENT_SESSION_TRANSITIONS, from, to);
export const transitionHumanGate = (from: HumanGateState, to: HumanGateState) =>
  transition("HumanGate", HUMAN_GATE_TRANSITIONS, from, to);
export const transitionDecision = (from: DecisionStatus, to: DecisionStatus) =>
  transition("Decision", DECISION_TRANSITIONS, from, to);
export const transitionAgentDefinition = (from: AgentDefinitionStatus, to: AgentDefinitionStatus) =>
  transition("AgentDefinition", AGENT_DEFINITION_TRANSITIONS, from, to);
