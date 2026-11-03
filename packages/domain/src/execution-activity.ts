/** Bounded, sanitized worker observations; these never authorize step completion. */
export interface ExecutionActivity {
  readonly id: string;
  readonly stage: "preparing" | "execution" | "tools" | "output";
  readonly status: "started" | "info" | "completed" | "failed";
  readonly message: string;
  readonly occurredAt: string;
}
export type ExecutionActivityEntry = Omit<ExecutionActivity, "id" | "occurredAt">;
