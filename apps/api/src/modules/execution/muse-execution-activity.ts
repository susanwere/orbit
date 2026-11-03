import type { ExecutionActivityEntry } from "@orbit/domain";
import type { SqlExecutor } from "@orbit/db";

/** Do not retain prompts, reasoning, commands, arguments, stdout or arbitrary provider messages. */
export function summarizeMuseEvent(event: unknown): ExecutionActivityEntry | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const envelope = event as Record<string, unknown>;
  if (
    envelope.schema_version !== 1 ||
    !envelope.payload ||
    typeof envelope.payload !== "object" ||
    Array.isArray(envelope.payload)
  )
    return null;
  const payload = envelope.payload as Record<string, unknown>;
  switch (envelope.payload_type) {
    case "runtime.command.accepted":
      return payload.command_kind === "turn.submit"
        ? { stage: "execution", status: "started", message: "Muse accepted the execution turn." }
        : null;
    case "run.lifecycle.started":
      return { stage: "execution", status: "info", message: "Muse execution turn started." };
    case "tool.execution.started": {
      const toolName = payload.tool_name ?? payload.name;
      const message =
        toolName === "read_file" || toolName === "file_read"
          ? "Muse is reading repository files."
          : toolName === "apply_patch" || toolName === "write_file" || toolName === "file_edit"
            ? "Muse is editing repository files."
            : toolName === "exec_command" || toolName === "shell"
              ? "Muse is running an authorized command."
              : "Muse is using an execution tool.";
      return { stage: "tools", status: "started", message };
    }
    case "tool_batch.effect.started":
      return { stage: "tools", status: "info", message: "Muse started a tool batch." };
    case "tool_batch.effect.completed":
      return { stage: "tools", status: "info", message: "Muse finished a tool batch." };
    case "run.output.delta":
      return {
        stage: "output",
        status: "info",
        message: "Muse is preparing its execution response.",
      };
    case "run.terminal.completed":
      return payload.terminal === "completed"
        ? {
            stage: "output",
            status: "info",
            message: "Muse reported a completed turn. Verification is still required.",
          }
        : null;
    case "run.terminal.failed":
      return { stage: "execution", status: "info", message: "Muse reported a failed turn." };
    default:
      return null;
  }
}

/** Writes only while this worker attempt still owns its live lease. */
export function createExecutionActivityRecorder(
  database: SqlExecutor,
  scope: {
    jobId: string;
    projectId: string;
    organizationId: string;
    attempt: number;
  },
) {
  let recordedCount = 0;
  let previousMessage = "";
  return async (entry: ExecutionActivityEntry): Promise<void> => {
    if (recordedCount >= 1000 || entry.message === previousMessage) return;
    await database.query(
      `INSERT INTO muse_execution_activity(job_id,organization_id,project_id,stage,status,message)
       SELECT id,organization_id,project_id,$4,$5,$6 FROM muse_execution_jobs
       WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND attempts=$7
         AND status='RUNNING' AND lease_expires_at > now()`,
      [
        scope.jobId,
        scope.projectId,
        scope.organizationId,
        entry.stage,
        entry.status,
        entry.message,
        scope.attempt,
      ],
    );
    recordedCount++;
    previousMessage = entry.message;
  };
}
