export interface CommittedDomainEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly type: "decision.accepted" | "context.version_created" | "context.updated";
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly actorType: "human" | "agent" | "system" | "integration";
  readonly actorId: string;
  readonly entityType: "Decision" | "ContextVersion" | "ProjectContext";
  readonly entityId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DomainEventPublisher {
  publish(events: readonly CommittedDomainEvent[]): Promise<void>;
}

export class NoopDomainEventPublisher implements DomainEventPublisher {
  async publish(_events: readonly CommittedDomainEvent[]): Promise<void> {}
}
