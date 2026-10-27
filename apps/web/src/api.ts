const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export interface ProposedPlanStep {
  title: string;
  kind: string;
  requiredCapabilities: string[];
  suggestedAgentDefinitionId?: string;
}
export interface ProposedPlanWorkflow { type: string; title: string; lane: string; steps: ProposedPlanStep[] }
export interface ProposedPlanWorkItem { title: string; description: string; risk: string; decisionIds: string[]; workflows: ProposedPlanWorkflow[] }
export interface ProposedPlan {
  initiativeId: string;
  planner: { provider: string; model: string; mode: string };
  workItems: ProposedPlanWorkItem[];
  detectedDecisionIds: string[];
  relevantPolicyCodes: string[];
}

export interface Decision { id: string; title: string; rationale: string; scope: string[]; status: string }
export interface Policy { id: string; code: string; name: string; category: string; result: string; sourceDecisionId?: string }
export interface AgentDefinition {
  id: string; name: string; purpose: string; model: string; provider: string; status: string; version: number;
  capabilities: string[]; approvedTools: string[]; maxContextClassification: string;
  allowedRepositories: string[]; allowedPaths: string[]; approvalRequiredActions: string[]; forbiddenActions: string[];
}
export interface DemoContext {
  organizationId: string;
  principals: Array<{ id: string; displayName: string; role?: string }>;
  decisions: Decision[];
  policies: Policy[];
  agentDefinitions: AgentDefinition[];
}

export interface Step { id: string; title: string; kind: string; state: string; assignedAgentDefinitionId?: string; workflowId: string; dependsOnStepIds: string[] }
export interface Workflow { id: string; title: string; type: string; lane: string; state: string; dependsOnWorkflowIds: string[]; steps: Step[] }
export interface WorkItem { id: string; key: string; title: string; description: string; state: string; risk: string; decisionIds: string[]; workflows: Workflow[] }
export interface InitiativeDetail {
  initiative: { id: string; title: string; intent: string; status: string };
  plan: ProposedPlan | null;
  workItems: WorkItem[];
}

export interface HumanGate {
  id: string; title: string; reason: string; state: string; policyId: string; workflowId: string;
  workflowStepId?: string; agentSessionId?: string; blockedWorkflowIds: string[]; createdAt: string;
}
export interface ExecutionRecord {
  session: { id: string; state: string; agentDefinitionId: string; agentDefinitionVersion: number; mission: string; humanOwnerPrincipalId: string; contextSnapshotId: string; executionContractId: string; workflowStepId: string };
  snapshot: { id: string; items: Array<{ contextItemId: string; title: string; classification: string; excerpt: string }>; decisionIds: string[]; maxClassification: string; allowedRepositories: string[]; allowedPaths: string[]; forbiddenData: string[]; approvalRequiredActions: string[] };
  contract: { id: string; allowedActions: string[]; approvalRequiredActions: string[]; forbiddenActions: string[]; allowedRepositories: string[]; allowedPaths: string[]; completionCriteria: string[] };
  activity: Array<{ at: string; text: string; kind: string }>;
  gate?: HumanGate;
  evidence: Array<{ id: string; category: string; title: string; result: string; summary: string }>;
  policyEvaluations: Array<{ policyId: string; result: string; reason: string }>;
}

async function request<T>(path: string, init?: RequestInit, principalId = "usr_susan"): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "content-type": "application/json", "x-principal-id": principalId },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  demoContext: () => request<DemoContext>("/demo/context"),
  createInitiative: (title: string, intent: string) =>
    request<{ id: string }>("/initiatives", { method: "POST", body: JSON.stringify({ title, intent }) }),
  plan: (id: string) => request<ProposedPlan>(`/initiatives/${id}/plan`, { method: "POST" }),
  approvePlan: (id: string) => request<{ workItemIds: string[] }>(`/initiatives/${id}/approve-plan`, { method: "POST" }),
  getInitiative: (id: string) => request<InitiativeDetail>(`/initiatives/${id}`),
  executeStep: (stepId: string) => request<ExecutionRecord>(`/workflow-steps/${stepId}/execute`, { method: "POST" }),
  gates: () => request<{ gates: HumanGate[] }>("/gates"),
  executions: () => request<{ executions: ExecutionRecord[]; events: Array<{ id: string; type: string; occurredAt: string }> }>("/executions"),
  resolveGate: (gateId: string, decision: "approved" | "rejected") =>
    request<ExecutionRecord>(`/gates/${gateId}/resolve`, { method: "POST", body: JSON.stringify({ decision }) }),
  context: () => request<{ context: ContextState; proposedDecisions: ProposedDecision[] }>("/context"),
  postPrComment: () => request<ProposedDecision>("/demo/pr-comment", { method: "POST", body: JSON.stringify({ prNumber: 14, author: "usr_susan", body: "Let's fetch 20 jobs at a time and keep explicit Load More instead of infinite scroll." }) }),
  approveDecision: (id: string) => request<{ decision: ProposedDecision; context: ContextState }>(`/decisions/${id}/approve`, { method: "POST" }),
  rejectDecision: (id: string) => request<{ decision: ProposedDecision }>(`/decisions/${id}/reject`, { method: "POST" }),
  createAgentDefinition: (body: Record<string, unknown>, principalId = "usr_susan") =>
    request<AgentDefinition>("/agent-definitions", { method: "POST", body: JSON.stringify(body) }, principalId),
};

export interface ProposedDecision {
  id: string;
  title: string;
  rationale: string;
  status: string;
  sourceRef: string;
  sourceQuote: string;
  proposedChange: { additions: string[]; exclusions: string[]; affectedWork: string[]; fromVersion: number; toVersion: number };
}
export interface ContextState {
  version: number;
  constraints: string[];
  originalIntent: string;
}
