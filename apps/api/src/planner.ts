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

const HN_JOB_INTENT = "hacker news";

/**
 * Planner for the HN Jobs Viewer demo (brief v3, step 2).
 * Deterministic stub today; Muse Spark (live) returns this same schema later.
 */
export function proposeHnPlan(initiativeId: string): ProposedPlan {
  const linear = (id: string, title: string, desc: string, lane: ProposedWorkflow["lane"] = "PRODUCT"): ProposedWorkItem => ({
    title,
    description: desc,
    risk: "low",
    decisionIds: [],
    workflows: [
      {
        type: "requirements",
        title: "Linear",
        lane,
        dependsOnWorkflowIndexes: [],
        steps: [
          { title: `Create ${id} in Linear`, kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" },
        ],
      },
    ],
  });

  return {
    initiativeId,
    planner: { provider: "meta", model: "muse-wonder", mode: "stub" },
    workItems: [
      linear("HN-1", "Understand Hacker News Jobs API", "Read the Firebase API contract: jobstories.json returns IDs; item/{id}.json returns each posting. Confirm field shape (title, url, by, time, type)."),
      {
        title: "Create Hacker News API client",
        description: "Typed fetchers for job IDs and job details with error handling, abort support, and response validation.",
        risk: "low",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-2 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Implement typed HN API client (src/api/**)", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Create HN-2 in Linear"] },
          ]},
        ],
      },
      {
        title: "Fetch job story IDs",
        description: "Load jobstories.json, hold the ID list in state, and expose count/loading for the UI.",
        risk: "low",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-3 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Fetch + store job story IDs", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Create HN-3 in Linear"] },
          ]},
        ],
      },
      {
        title: "Fetch individual job details",
        description: "Fetch item details for visible jobs, combine with IDs, and cache results to avoid refetching.",
        risk: "low",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-4 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Fetch + combine job details", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Create HN-4 in Linear"] },
          ]},
        ],
      },
      {
        title: "Build jobs list interface",
        description: "Job cards + list layout for title, company (by), time, and link. Figma design first, then implementation.",
        risk: "medium",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-5 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "design", title: "Design", lane: "DESIGN", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Design job card, list, loading + error states (Figma)", kind: "ai", requiredCapabilities: ["design.generate"], suggestedAgentDefinitionId: "agt_muse_image_design", dependsOnStepTitles: ["Create HN-5 in Linear"] },
            { title: "Human approves design", kind: "gate", requiredCapabilities: [], dependsOnStepTitles: ["Design job card, list, loading + error states (Figma)"] },
          ]},
          { type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [1], steps: [
            { title: "Implement jobs list UI (src/jobs/**)", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Human approves design"] },
          ]},
        ],
      },
      {
        title: "Add loading, empty and error states",
        description: "Skeletons while loading, a clear empty state, and a recoverable error state with retry.",
        risk: "low",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-6 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Implement loading/empty/error states", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Create HN-6 in Linear"] },
          ]},
        ],
      },
      {
        title: "Add responsive/mobile behavior",
        description: "Single-column mobile layout, touch-friendly targets, no horizontal scroll at 360px.",
        risk: "low",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-7 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Implement responsive layout", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Create HN-7 in Linear"] },
          ]},
        ],
      },
      {
        title: "Add tests and CI",
        description: "Unit tests for the API client and list rendering; CI runs typecheck, tests, and build on every PR.",
        risk: "low",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-8 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "implementation", title: "Implementation", lane: "ENGINEERING", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Add tests + CI pipeline", kind: "ai", requiredCapabilities: ["frontend.implementation"], suggestedAgentDefinitionId: "agt_muse_code_frontend", dependsOnStepTitles: ["Create HN-8 in Linear"] },
            { title: "CI: typecheck + tests + build", kind: "system", requiredCapabilities: [], dependsOnStepTitles: ["Add tests + CI pipeline"] },
          ]},
        ],
      },
      {
        title: "Release application",
        description: "Ship v0.1 of HN Jobs Viewer once CI is green and evidence is recorded.",
        risk: "low",
        decisionIds: [],
        workflows: [
          { type: "requirements", title: "Linear", lane: "PRODUCT", dependsOnWorkflowIndexes: [], steps: [{ title: "Create HN-9 in Linear", kind: "ai", requiredCapabilities: ["planning"], suggestedAgentDefinitionId: "agt_muse_spark_planner" }] },
          { type: "release", title: "Release", lane: "RELEASE", dependsOnWorkflowIndexes: [0], steps: [
            { title: "Release approval", kind: "gate", requiredCapabilities: [], dependsOnStepTitles: ["Create HN-9 in Linear"] },
            { title: "Deploy v0.1", kind: "system", requiredCapabilities: [], dependsOnStepTitles: ["Release approval"] },
          ]},
        ],
      },
    ],
    detectedDecisionIds: [],
    relevantPolicyCodes: [],
    requiresHumanApprovalBeforeExternalWrites: true,
  };
}

/**
 * Deterministic stub planner. Returns schema-identical output to the future
 * Muse planner so the demo path never depends on live model availability.
 * Swap the implementation, not the contract.
 */
export function proposePlanStub(store: Store, initiativeId: string, intent: string): ProposedPlan {
  const lower = intent.toLowerCase();
  if (lower.includes(HN_JOB_INTENT) || lower.includes("jobstories") || lower.includes("jobs viewer")) {
    return proposeHnPlan(initiativeId);
  }
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
                { title: "Human review", kind: "human", requiredCapabilities: [], dependsOnStepTitles: ["Implement scoped change"] },
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
