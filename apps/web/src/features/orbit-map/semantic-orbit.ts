import type { OrbitNodeKind, OrbitNodeModel, OrbitNodeStatus } from "../contracts/orbit.js";

type Ring = 0 | 1 | 2;
export interface SemanticOrbitNode {
  readonly id: OrbitNodeKind;
  readonly label: string;
  readonly ring: Ring;
  readonly angle: number;
  readonly color: string;
  readonly description: string;
  readonly detail: string;
}

export const SEMANTIC_NODES: readonly SemanticOrbitNode[] = [
  { id:"decision", label:"Decision", ring:0, angle:-90, color:"#a997ff", description:"The choices that shape implementation.", detail:"Approved decisions become authoritative project context. Proposed decisions require human review." },
  { id:"guardrail", label:"Guardrail", ring:0, angle:0, color:"#f0c880", description:"Rules that protect the original intent.", detail:"Engineering and policy constraints limit what people and agents may change." },
  { id:"context", label:"Context", ring:0, angle:90, color:"#a997ff", description:"The project's versioned memory.", detail:"Immutable context versions preserve what was known and approved when work began." },
  { id:"evidence", label:"Evidence", ring:0, angle:180, color:"#70e5c2", description:"Source-backed reasons behind decisions.", detail:"Follow provenance from discussions to decisions and outcomes." },
  { id:"work_item", label:"Work Item", ring:1, angle:-65, color:"#65cfff", description:"Scoped engineering work.", detail:"Execution is mapped back to intent and project decisions." },
  { id:"agent", label:"Agent", ring:1, angle:25, color:"#65cfff", description:"AI execution with explicit boundaries.", detail:"An agent starts with an authorized Context Snapshot and Execution Contract." },
  { id:"human_gate", label:"Human Gate", ring:1, angle:115, color:"#f0c880", description:"Human judgment when it matters.", detail:"Affected agent sessions pause for review when material context changes." },
  { id:"human", label:"Human", ring:1, angle:205, color:"#70e5c2", description:"People own consequential decisions.", detail:"AI proposes, humans authorize, Orbit enforces." },
  { id:"ci", label:"CI", ring:2, angle:-76, color:"#65cfff", description:"Automated checks and confidence signals.", detail:"Builds, tests and validation provide evidence of execution." },
  { id:"release", label:"Release", ring:2, angle:14, color:"#70e5c2", description:"Approved changes delivered to users.", detail:"Releases connect completed work to measurable outcomes." },
  { id:"pull_request", label:"Pull Request", ring:2, angle:104, color:"#a997ff", description:"Implementation and review evidence.", detail:"GitHub reviews and comments may contain decisions that update project context." },
  { id:"outcome", label:"Outcome", ring:2, angle:194, color:"#f0c880", description:"What the team learned and delivered.", detail:"Outcomes close the loop between initial intent and observed results." },
] as const;

export const RING_LABELS = ["Governance & memory", "Execution & accountability", "Systems & outcomes"] as const;

/**
 * Project summary is the only input. Providers cannot mutate the semantic
 * taxonomy; the renderer never consumes raw GitHub/Linear/Figma payloads.
 */
export function projectOrbitNodes(
  summaries: Readonly<Partial<Record<OrbitNodeKind, Pick<OrbitNodeModel, "status" | "summary" | "attentionRequired" | "activityCount" | "updatedAt">>>> = {},
): readonly OrbitNodeModel[] {
  return SEMANTIC_NODES.map(node => {
    const summary = summaries[node.id];
    const status: OrbitNodeStatus = summary?.status ?? "empty";
    return {
      id: node.id,
      kind: node.id,
      label: node.label,
      summary: summary?.summary ?? node.description,
      status,
      attentionRequired: summary?.attentionRequired ?? false,
      activityCount: summary?.activityCount ?? 0,
      updatedAt: summary?.updatedAt,
    };
  });
}
