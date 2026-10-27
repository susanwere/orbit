import type { Store } from "./store.js";

export interface ProposedStep {
  title: string;
  kind: "ai" | "human" | "system" | "gate";
  requiredCapabilities: string[];
  suggestedAgentDefinitionId?: string;
  /** Titles of steps in the same work item that must complete first. */
  dependsOnStepTitles?: string[];
}

export interface ProposedWorkflow {
  type: string;
  title: string;
  lane: "PRODUCT" | "DESIGN" | "ENGINEERING" | "QA" | "RELEASE";
  dependsOnWorkflowIndexes: number[];
  steps: ProposedStep[];
}

export interface ProposedWorkItem {
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  decisionIds: string[];
  workflows: ProposedWorkflow[];
}

export interface ProposedPlan {
  initiativeId: string;
  planner: { provider: string; model: string; mode: "stub" | "live" };
  workItems: ProposedWorkItem[];
  detectedDecisionIds: string[];
  relevantPolicyCodes: string[];
  requiresHumanApprovalBeforeExternalWrites: true;
}

/**
 * Deterministic stub planner. Returns schema-identical output to the future
 * Muse Spark structured planner so the demo path never depends on live
 * model availability. Swap the implementation, not the contract.
 */
export function proposePlanStub(store: Store, initiativeId: string, intent: string): ProposedPlan {
  const lower = intent.toLowerCase();
  const mentionsInterview = lower.includes("interview") || lower.includes("recording") || lower.includes("consent");

  const detectedDecisionIds = store.decisions
    .filter((d) => d.status === "active")
    .filter((d) => {
      if (!mentionsInterview) return false;
      return d.scope.some((s) => ["recorder", "storage", "transcription", "frontend"].includes(s));
    })
    .map((d) => d.id);

  const workItems: ProposedWorkItem[] = mentionsInterview
    ? [
        {
          title: "Recorder Controls",
          description: "Consent-first recorder controls with visible status, stop-anytime, mic + system audio, and device-change recovery.",
          risk: "high",
          decisionIds: ["dec_consent", "dec_visible_status", "dec_no_bot"],
          workflows: [
            {
              type: "requirements", title: "Requirements", lane: "PRODUCT", dependsOnWorkflowIndexes: [],
              steps: [
                { title: "Draft recorder requirements from intent + decisions", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" },
  { title: "DRI approves requirements", kind: "human", requiredCapabilities: [], dependsOnStepTitles: ["Draft recorder requirements from intent + decisions"] },
              ],
            },
            {
              type: "design", title: "Design", lane: "DESIGN", dependsOnWorkflowIndexes: [0],
              steps: [
  { title: "Generate recorder / consent / recovery states", kind: "ai", requiredCapabilities: ["design.generate"], suggestedAgentDefinitionId: "agt_muse_image_design", dependsOnStepTitles: ["DRI approves requirements"] },
  { title: "Designer reviews states", kind: "human", requiredCapabilities: [], dependsOnStepTitles: ["Generate recorder / consent / recovery states"] },
              ],
            },
            {
              type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0],
              steps: [
  { title: "Implement recorder controls (src/recorder/**)", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["DRI approves requirements", "Designer reviews states"] },
  { title: "CI: typecheck + unit tests", kind: "system", requiredCapabilities: [], dependsOnStepTitles: ["Implement recorder controls (src/recorder/**)"] },
              ],
            },
            {
              type: "qa", title: "QA", lane: "QA", dependsOnWorkflowIndexes: [2],
              steps: [
  { title: "Device-change recovery test matrix", kind: "system", requiredCapabilities: [], dependsOnStepTitles: ["Implement recorder controls (src/recorder/**)"] },
  { title: "QA engineer verifies consent flow", kind: "human", requiredCapabilities: [], dependsOnStepTitles: ["Device-change recovery test matrix", "CI: typecheck + unit tests"] },
              ],
            },
          ],
        },
        {
          title: "Async Transcription Pipeline",
          description: "Asynchronous transcription of recorded audio with 7-day raw-audio retention and user-controlled deletion.",
          risk: "medium",
          decisionIds: ["dec_async_transcription", "dec_retention"],
          workflows: [
            {
              type: "architecture", title: "Architecture", lane: "ENGINEERING", dependsOnWorkflowIndexes: [],
              steps: [
                { title: "Propose async transcription architecture", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend" },
  { title: "Human approves architecture + API contract", kind: "gate", requiredCapabilities: [], dependsOnStepTitles: ["Propose async transcription architecture"] },
              ],
            },
            {
              type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0],
              steps: [
  { title: "Implement ingestion + processing pipeline", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Human approves architecture + API contract"] },
              ],
            },
          ],
        },
        {
          title: "Structured Interview Debrief",
          description: "Structured debrief generated from the transcript, linked back to the recording and decisions.",
          risk: "medium",
          decisionIds: ["dec_async_transcription"],
          workflows: [
            {
              type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [],
              steps: [
                { title: "Implement debrief view (src/debrief/**)", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend" },
  { title: "Human review", kind: "human", requiredCapabilities: [], dependsOnStepTitles: ["Implement debrief view (src/debrief/**)"] },
              ],
            },
            {
              type: "release", title: "Release", lane: "RELEASE", dependsOnWorkflowIndexes: [0],
              steps: [
  { title: "CI release checks", kind: "system", requiredCapabilities: [], dependsOnStepTitles: ["Implement debrief view (src/debrief/**)"] },
  { title: "Release approval", kind: "gate", requiredCapabilities: [], dependsOnStepTitles: ["CI release checks"] },
              ],
            },
          ],
        },
      ]
    : [
        {
          title: "Deliver intent as scoped work",
          description: intent,
          risk: "medium",
          decisionIds: detectedDecisionIds,
          workflows: [
            {
              type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [],
              steps: [
                { title: "Implement scoped change", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend" },
  { title: "Human review", kind: "human", requiredCapabilities: [], dependsOnStepTitles: ["Implement debrief view (src/debrief/**)"] },
              ],
            },
          ],
        },
      ];

  return {
    initiativeId,
    planner: { provider: "meta", model: "muse-spark", mode: "stub" },
    workItems,
    detectedDecisionIds,
    relevantPolicyCodes: ["REC-01", "API-04", "SEC-01", "SEC-02", "PRIV-01"],
    requiresHumanApprovalBeforeExternalWrites: true,
  };
}
