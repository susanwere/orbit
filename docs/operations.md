# Orbit backend operations and safe recovery

## Admin endpoints
- `GET /projects/:projectId/operations` reports PostgreSQL readiness and queue backlog by status without serializing webhook bodies, model prompts, user data, or credentials.
- `POST /projects/:projectId/operations/retry` accepts `{ "queue": "webhook" | "analysis" | "effects", "jobId": "..." }`. Only a verified project admin may requeue a failed job. Retry is idempotent at the event/decision layer and creates an auditable `operations.job_retried` event.

## Runbook
1. Confirm health and which queue is failing through the protected operations endpoint.
2. Investigate configuration and logs. Never paste provider tokens, model responses, or webhook bodies into issue trackers.
3. After correcting the root cause, retry a specific failed job by its ID.
4. Verify processing changes from failed to processed/completed, and review the emitted audit events. Keep authorization and context promotion invariant checks intact.
5. Repeated failures should be escalated to a human operator. Do not blindly replay arbitrary webhooks.

Worker polling uses durable PostgreSQL records; notification/SSE readers use committed events. A webhook or inference failure cannot silently advance authoritative context.

## Deployment secrets
Use a deployment secret store for `DATABASE_URL`, `MODEL_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `ORBIT_AUTH_SECRET`. Never commit them, expose them to a browser, or send them to an agent runtime.

## Outstanding integrations
Dashboards and alerting (e.g. Prometheus/OpenTelemetry), distributed tracing, and enterprise audit retention need production planning. This MVP surface provides actionable queue visibility and audited manual recovery.
