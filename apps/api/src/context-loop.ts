import { DomainError, type Decision, type OrbitEvent } from "@orbit/domain";

const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

export interface ProposedContextChange {
  additions: string[];
  exclusions: string[];
  affectedWork: string[];
  fromVersion: number;
  toVersion: number;
}

export interface ProposedDecision extends Decision {
  sourceType: "pull_request";
  sourceRef: string;
  sourceQuote: string;
  proposedChange: ProposedContextChange;
}

export interface ContextState {
  projectId: string;
  version: number;
  /** Active, human-approved constraint lines that make up Current Context. */
  constraints: string[];
  originalIntent: string;
}

type Listener = (event: OrbitEvent) => void;

/**
 * Real-time detection, human-controlled mutation.
 * Detected decisions may update *proposed* context immediately, but they
 * cannot mutate authoritative project context until a human approves them.
 *
 * AI interprets. Humans authorize. Orbit enforces.
 */
export class ContextLoop {
  readonly proposedDecisions: ProposedDecision[] = [];
  readonly events: OrbitEvent[] = [];
  readonly #listeners = new Set<Listener>();
  #context: ContextState = {
    projectId: "hn-jobs",
    version: 1,
    constraints: ["Display Hacker News job postings", "Client-side React application", "Hacker News Firebase API (public)"],
    originalIntent: "Build a React application that fetches Hacker News job postings and displays them in a responsive list.",
  };
  #decisionSeq = 106;

  get context(): ContextState {
    return { ...this.#context, constraints: [...this.#context.constraints] };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(type: string, actorId: string, entityType: string, entityId: string, payload: Record<string, unknown> = {}): OrbitEvent {
    const event: OrbitEvent = {
      id: id("evt"),
      organizationId: "org_orbit_demo",
      type,
      actorType: "system",
      actorId,
      entityType,
      entityId,
      payload,
      occurredAt: now(),
    };
    this.events.push(event);
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  /**
   * Simulated GitHub webhook entry point (POST /demo/pr-comment).
   * The transport is stubbed; everything downstream of it is real.
   */
  ingestPrComment(input: { prNumber: number; author: string; body: string }): ProposedDecision {
    this.#decisionSeq += 1;
    const decision: ProposedDecision = {
      id: `D-${this.#decisionSeq}`,
      organizationId: "org_orbit_demo",
      title: "Use explicit Load More with batches of 20 jobs (no infinite scroll)",
      rationale: "Fetching every job detail up front is slow and wasteful; explicit incremental loading keeps the initial view fast and user-controlled.",
      alternatives: ["Infinite scroll", "Fetch all jobs on initial load"],
      scope: ["HN-5 jobs list", "HN-6 loading states", "future implementation sessions"],
      status: "proposed",
      decidedByPrincipalId: input.author,
      affectedEntityRefs: [`PR #${input.prNumber}`, "HN-5", "HN-6"],
      createdAt: now(),
      sourceType: "pull_request",
      sourceRef: `PR #${input.prNumber}`,
      sourceQuote: input.body,
      proposedChange: {
        additions: ["Initial batch size: 20 jobs", "Pagination: explicit Load More"],
        exclusions: ["Infinite scroll"],
        affectedWork: ["HN-5 Build jobs list interface", "HN-6 Add loading, empty and error states", "Future implementation sessions"],
        fromVersion: this.#context.version,
        toVersion: this.#context.version + 1,
      },
    };
    this.proposedDecisions.push(decision);
    this.#emit("decision.detected", "decision-agent", "Decision", decision.id, {
      sourceRef: decision.sourceRef,
      title: decision.title,
      proposedVersion: decision.proposedChange.toVersion,
    });
    return decision;
  }

  approveDecision(actorId: string, decisionId: string): { decision: ProposedDecision; context: ContextState } {
    const decision = this.proposedDecisions.find((d) => d.id === decisionId);
    if (!decision) throw new DomainError("not_found", "Proposed decision not found");
    if (decision.status !== "proposed") {
      throw new DomainError("invalid_state", `Decision is ${decision.status}; only proposed decisions can be approved`);
    }
    // One transaction: decision active + context version++ + recompute.
    decision.status = "active";
    const previousVersion = this.#context.version;
    this.#context = {
      ...this.#context,
      version: decision.proposedChange.toVersion,
      constraints: [
        ...this.#context.constraints,
        ...decision.proposedChange.additions,
        ...decision.proposedChange.exclusions.map((x) => `Excluded: ${x}`),
      ],
    };
    this.#emit("decision.accepted", actorId, "Decision", decision.id, { sourceRef: decision.sourceRef });
    this.#emit("context.updated", actorId, "Context", this.#context.projectId, {
      previousVersion,
      currentVersion: this.#context.version,
      decisionId: decision.id,
      source: { type: "pull_request", ref: decision.sourceRef },
    });
    return { decision, context: this.context };
  }

  rejectDecision(actorId: string, decisionId: string): ProposedDecision {
    const decision = this.proposedDecisions.find((d) => d.id === decisionId);
    if (!decision) throw new DomainError("not_found", "Proposed decision not found");
    if (decision.status !== "proposed") {
      throw new DomainError("invalid_state", `Decision is ${decision.status}; only proposed decisions can be rejected`);
    }
    decision.status = "rejected";
    this.#emit("decision.rejected", actorId, "Decision", decision.id, { sourceRef: decision.sourceRef });
    return decision;
  }

  editDecision(decisionId: string, title: string): ProposedDecision {
    const decision = this.proposedDecisions.find((d) => d.id === decisionId);
    if (!decision) throw new DomainError("not_found", "Proposed decision not found");
    if (decision.status !== "proposed") {
      throw new DomainError("invalid_state", "Only proposed decisions can be edited");
    }
    decision.title = title;
    this.#emit("decision.edited", "usr_susan", "Decision", decision.id, { title });
    return decision;
  }
}
