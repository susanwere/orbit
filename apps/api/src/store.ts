import type {
  AgentDefinition,
  Decision,
  Initiative,
  Policy,
  Principal,
  WorkItem,
  Workflow,
  WorkflowStep,
} from "@orbit/domain";

export interface Store {
  organizationId: string;
  principals: Map<string, Principal>;
  decisions: Decision[];
  policies: Policy[];
  agentDefinitions: AgentDefinition[];
  initiatives: Map<string, Initiative>;
  workItems: Map<string, WorkItem>;
  workflows: Map<string, Workflow>;
  steps: Map<string, WorkflowStep>;
  counters: { workItem: number };
}

const now = () => new Date().toISOString();

export function createDemoStore(): Store {
  const organizationId = "org_orbit_demo";
  const principals = new Map<string, Principal>([
    ["usr_susan", { id: "usr_susan", organizationId, type: "human", displayName: "Susan — Product / Initiative DRI", role: "admin" }],
    ["usr_alex", { id: "usr_alex", organizationId, type: "human", displayName: "Alex — Frontend Engineer", role: "member" }],
    ["usr_priya", { id: "usr_priya", organizationId, type: "human", displayName: "Priya — Product Designer", role: "member" }],
  ]);

  const decisions: Decision[] = [
    { id: "dec_consent", organizationId, title: "Explicit recording consent required", rationale: "Interview recordings contain sensitive personal information; recording must never start silently.", alternatives: ["Implied consent via joining a call"], scope: ["recorder", "storage", "transcription"], status: "active", decidedByPrincipalId: "usr_susan", affectedEntityRefs: [], createdAt: now() },
    { id: "dec_no_bot", organizationId, title: "No meeting bot joins the interview", rationale: "A bot changes interview dynamics and creates a second, uncontrolled recording path.", alternatives: ["Meeting bot with visible badge"], scope: ["recorder", "integrations"], status: "active", decidedByPrincipalId: "usr_susan", affectedEntityRefs: [], createdAt: now() },
    { id: "dec_visible_status", organizationId, title: "Recording status is always visible; user can stop at any time", rationale: "User control must be continuous, not only at start.", alternatives: ["Status only in settings"], scope: ["recorder", "frontend"], status: "active", decidedByPrincipalId: "usr_susan", affectedEntityRefs: [], createdAt: now() },
    { id: "dec_retention", organizationId, title: "Raw interview audio retention is 7 days", rationale: "Minimize sensitive-data exposure while allowing transcription recovery.", alternatives: ["30-day retention"], scope: ["storage", "transcription"], status: "active", decidedByPrincipalId: "usr_susan", affectedEntityRefs: [], createdAt: now() },
    { id: "dec_async_transcription", organizationId, title: "Transcription happens asynchronously", rationale: "Recording must stay responsive and recoverable when devices change mid-interview.", alternatives: ["Synchronous transcription blocking the recorder"], scope: ["transcription", "backend"], status: "active", decidedByPrincipalId: "usr_susan", affectedEntityRefs: [], createdAt: now() },
  ];

  const policies: Policy[] = [
    { id: "pol_rec_01", organizationId, code: "REC-01", name: "Recording cannot begin before an explicit consent event", category: "product", description: "Recording cannot begin before an explicit consent event.", sourceDecisionId: "dec_consent", scopeType: "organization", triggerAction: "recording.start", result: "DENY", mandatory: true, version: 1, active: true },
    { id: "pol_api_04", organizationId, code: "API-04", name: "API contract changes require human approval", category: "architecture", description: "API contract changes require human approval.", scopeType: "organization", triggerAction: "api_contract.change", result: "APPROVAL_REQUIRED", mandatory: true, version: 1, active: true },
    { id: "pol_sec_01", organizationId, code: "SEC-01", name: "Agents cannot access production secrets", category: "security", description: "Agents cannot access production secrets.", scopeType: "organization", triggerAction: "secret.production.read", result: "DENY", mandatory: true, version: 1, active: true },
    { id: "pol_sec_02", organizationId, code: "SEC-02", name: "Authentication and security changes require approval", category: "security", description: "Authentication and security changes require approval.", scopeType: "organization", triggerAction: "auth.change", result: "APPROVAL_REQUIRED", mandatory: true, version: 1, active: true },
    { id: "pol_gov_01", organizationId, code: "GOV-01", name: "AI agents cannot approve their own work or exceptions", category: "security", description: "AI agents cannot approve their own work or exceptions.", scopeType: "organization", triggerAction: "gate.resolve.self", result: "DENY", mandatory: true, version: 1, active: true },
    { id: "pol_priv_01", organizationId, code: "PRIV-01", name: "Retention beyond 7 days for raw interview audio is forbidden", category: "privacy", description: "Retention beyond 7 days for raw interview audio is forbidden.", sourceDecisionId: "dec_retention", scopeType: "organization", triggerAction: "storage.retention.extend", result: "DENY", mandatory: true, version: 1, active: true },
  ];

  const agentDefinitions: AgentDefinition[] = [
    {
      id: "agt_muse_code_frontend", organizationId, name: "Frontend Engineer — Muse Code",
      purpose: "Implements scoped frontend work items under an execution contract.",
      provider: "meta", model: "muse-code",
      capabilities: ["frontend.implementation", "tests.write", "code.edit"],
      approvedTools: ["repo.read", "repo.write_scoped", "tests.run"],
      maxContextClassification: "CONFIDENTIAL", allowedContextScopes: ["recorder", "debrief", "product"],
      allowedRepositories: ["careerglyph/frontend"], allowedPaths: ["src/recorder/**", "src/debrief/**", "tests/**"],
      approvalRequiredActions: ["api_contract.change", "auth.change", "dependency.add"],
      forbiddenActions: ["secret.production.read", "gate.resolve.self", "agent.create"],
      networkPolicy: "none", networkAllowlist: [], status: "approved", version: 1,
      createdByPrincipalId: "usr_susan", createdAt: now(),
    },
    {
      id: "agt_muse_spark_planner", organizationId, name: "Planner — Muse Spark",
      purpose: "Converts product intent into a structured proposed work graph.",
      provider: "meta", model: "muse-spark",
      capabilities: ["planning", "work_graph.propose", "risk.identify"],
      approvedTools: ["context.read_authorized"], maxContextClassification: "CONFIDENTIAL",
      allowedContextScopes: ["product"], allowedRepositories: [], allowedPaths: [],
      approvalRequiredActions: [], forbiddenActions: ["repo.write", "secret.production.read", "gate.resolve.self", "agent.create"],
      networkPolicy: "none", networkAllowlist: [], status: "approved", version: 1,
      createdByPrincipalId: "usr_susan", createdAt: now(),
    },
    {
      id: "agt_muse_image_design", organizationId, name: "Design — Muse Image",
      purpose: "Produces design artifacts for recorder and debrief states.",
      provider: "meta", model: "muse-image",
      capabilities: ["design.generate", "design.variant"],
      approvedTools: ["design.create_artifact"], maxContextClassification: "INTERNAL",
      allowedContextScopes: ["design"], allowedRepositories: [], allowedPaths: [],
      approvalRequiredActions: [], forbiddenActions: ["repo.write", "secret.production.read", "agent.create"],
      networkPolicy: "none", networkAllowlist: [], status: "approved", version: 1,
      createdByPrincipalId: "usr_susan", createdAt: now(),
    },
  ];

  return {
    organizationId,
    principals,
    decisions,
    policies,
    agentDefinitions,
    initiatives: new Map(),
    workItems: new Map(),
    workflows: new Map(),
    steps: new Map(),
    counters: { workItem: 141 },
  };
}
