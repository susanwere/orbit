export type KnowledgeGenerationStage =
  | "sources"
  | "documents"
  | "repositories"
  | "summary"
  | "saving";
export interface KnowledgeGenerationActivity {
  readonly stage: KnowledgeGenerationStage;
  readonly status: "started" | "completed" | "info";
  readonly message: string;
  readonly occurredAt: string;
}
