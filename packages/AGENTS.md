# Shared Packages Engineering Guidance

Applies within `packages/` in addition to the root `AGENTS.md`.

## Domain contracts
- Keep `packages/domain` framework-agnostic; avoid importing Fastify, React, or browser runtime APIs.
- Use explicit types and stable contracts for cross-package boundaries. Avoid circular dependencies and feature-specific UI behavior.
- When changing exported contracts, inspect all consumers and update relevant tests.

## Database package
- Keep schema changes in ordered migrations; never silently mutate existing applied migrations.
- Write reversible or safely forward-only changes with a documented rollout, taking existing data into account.
- Use parameterized queries, clear transaction boundaries and explicit tenant/project scoping.
- Never expose database secrets in source, tests, logs, or error responses.

## Verification
- Build and typecheck dependent packages; run available domain tests and database-backed integration tests as appropriate.
- Separate pure formatting changes from migrations and behavior changes.
