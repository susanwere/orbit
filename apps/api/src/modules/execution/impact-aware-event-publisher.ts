import type {
  CommittedDomainEvent,
  DomainEventPublisher,
} from "../events/domain-event-publisher.js";
import type { PostgresExecutionImpactService } from "./postgres-execution-impact.js";

/** Delivers context-change impacts only after the promotion transaction commits. */
export class ImpactAwareEventPublisher implements DomainEventPublisher {
  constructor(
    private readonly impact: PostgresExecutionImpactService,
    private readonly downstream: DomainEventPublisher,
  ) {}

  async publish(events: readonly CommittedDomainEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type !== "context.updated") continue;
      const { previousContextVersionId, currentContextVersionId } = event.payload;
      if (
        typeof previousContextVersionId !== "string" ||
        typeof currentContextVersionId !== "string"
      ) {
        throw new Error("context.updated lacks required version provenance.");
      }
      await this.impact.evaluate({
        organizationId: event.organizationId,
        projectId: event.projectId,
        previousContextVersionId,
        currentContextVersionId,
      });
    }
    await this.downstream.publish(events);
  }
}
