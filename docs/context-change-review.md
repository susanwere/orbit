# Bounded Project Context change review

Human approval publishes Project Knowledge into the runtime context's
`/attributes/approvedProjectKnowledge` namespace. Proposed summaries do not change
execution context. Publication atomically records `context.updated` and a durable
`domain_effect_jobs` entry with previous/current runtime version IDs and knowledge
snapshot/revision provenance. Failed transactions publish neither. Repeating the
same publication while it is current does not create another version or event.
The existing domain effects worker retries committed events after request failure
or process restart.

## Execution propagation and access

New immutable execution snapshots can include the structured approved knowledge
as a JSON excerpt with snapshot/revision provenance. An approved agent definition
must explicitly grant `/attributes/approvedProjectKnowledge` and at least INTERNAL
clearance. The broad `project` scope does not grant access. Existing PUBLIC agents
with empty scopes remain unchanged; an administrator must approve a suitably
scoped agent definition before this feature supplies knowledge to that agent.

The Muse worker reads only its session-bound snapshot, scoped by organization and
project, and passes those items to the CLI as untrusted evidence alongside the
bounded mission. Evidence cannot grant tools, repository access or execution
permissions. Existing snapshots and active missions are never rewritten. Knowledge
is limited to 48,000 UTF-8 bytes per snapshot excerpt; total serialized prompt
context is limited to 64,000 bytes. Over-budget context fails explicitly, without
silent truncation. No database migration is needed.

## What the review currently means

The existing deterministic impact evaluator checks RUNNING sessions against a
committed change. A changed knowledge attribute requires review only when the
session's snapshot included that exact attribute. It conservatively treats any
change to consumed knowledge as review-worthy, including metadata-only changes;
it does not claim semantic understanding of the difference. Sessions which did not
consume knowledge do not gain access retroactively.

Affected sessions become WAITING with a durable human gate and review notification.
Event replay does not duplicate gates. This is an authorization/review boundary,
not a guarantee that an already-running external Muse process is interrupted.
Do not present it as automatic cancellation or safe live replanning.

## Next milestone: full workflow reconciliation

Before claiming end-to-end reconciliation, implement and verify:

- Version provenance for planned and waiting work, not only running sessions.
- Structured, evidence-backed semantic impact proposals with human review.
- Invalidation of stale queued execution before dispatch, including approval races.
- Cooperative cancellation/acknowledgement of active workers before delivery.
- Explicit retain/replan/supersede decisions and snapshot replacement through new
  authorized sessions, with no automatic resumption.
- UI status and recovery for every affected workflow, plus concurrency/replay tests.

This milestone is deliberately separate from the bounded propagation and durable
event plumbing so the submission can describe precisely what is verified today.
