export interface KnowledgeArchitecture {
  readonly facts: readonly { label: string; description: string }[];
  readonly dataFlow: readonly string[];
}
