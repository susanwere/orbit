# API Engineering Guidance

Applies within `apps/api/` in addition to the root `AGENTS.md`.

## Fastify and application architecture
- Use typed request parameters, query and body shapes; validate untrusted values at the HTTP boundary.
- Keep route handlers thin: authenticate, validate, authorize, delegate, and map response/error codes.
- Extract substantial business rules into services, and SQL/data access into repositories when needed. Avoid gratuitous layers for trivial behavior.
- Keep domain errors explicit; do not leak stack traces or internal implementation details to clients.
- Reuse existing module conventions and dependency injection patterns.

## Security and persistence
- Authenticate protected endpoints and authorize access to the exact project or organization resource, not merely a logged-in user.
- Enforce tenant isolation in database predicates and operations, including list/detail endpoints.
- Use parameterized SQL, intentional transaction boundaries, safe pagination, and stable ordering.
- Never hardcode credentials, leak access tokens, or log private payloads.

## Tests
- Use the existing Vitest setup and PostgreSQL integration patterns.
- Verify success, validation, not-found, unauthenticated, forbidden and cross-tenant scenarios when applicable.
- For changes to queries or pagination, test filtering, ordering, boundaries, and cursor behavior.
- Run `npm run typecheck -w @orbit/api`, `npm run test -w @orbit/api`, and the root CI checks.
