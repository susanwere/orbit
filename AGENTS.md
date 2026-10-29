# Orbit Engineering Standards

Applies to the entire repository. More specific `AGENTS.md` files in `apps/api`, `apps/web`, and `packages` add scoped guidance. Follow the closest applicable guidance without contradicting this file.

## Working agreement
- Before editing, inspect existing implementation, contracts, tests, and relevant Linear issue. Match established naming and patterns.
- Scope changes to the requested task; avoid speculative abstractions, unrelated refactors, and unrequested dependencies.
- Never minify application source. Use descriptive names, readable functions, and the committed Prettier style.
- Name variables, parameters, functions, classes, and types for their purpose: prefer `projectRepository`, `authenticatedUser`, `repositoryUrl`, and `projectId` over `r`, `p`, `u`, or `x`. Avoid cryptic abbreviations and generic names such as `data`, `result`, or `value` when a more specific name improves understanding. Conventional short indices in tiny loops or well-known mathematical notation are fine.
- For every PR, review new and changed identifiers for clarity. Formatting tools do not guarantee descriptive naming; do not rename unrelated identifiers during a formatting-only change.
- Prefer clear modules and precise TypeScript types. Avoid `any`, unnecessary assertions, and swallowing errors.
- Preserve behavior on formatting-only changes. Do not mix formatting migrations with functional changes.
- Maintain secure defaults: validate external input, enforce authentication/authorization at boundaries, never commit credentials or log sensitive data.
- Treat AI-generated code as untrusted until reviewed and verified.

## Packages and boundaries
- `apps/api`: Fastify application and protected HTTP interfaces; see its `AGENTS.md`.
- `apps/web`: React/Vite frontend; see its `AGENTS.md`.
- `packages/domain`: shared domain concepts and contracts.
- `packages/db`: SQL database access and migrations; see `packages/AGENTS.md`.

## Required verification
- Format changed files before submitting. `npm run format` formats the repository; `npm run format:check` checks API, web, and shared-package source.
- Run `npm run typecheck`, `npm test`, and `npm run build` when relevant to your change. CI must pass before merge.
- Add or update tests for behavior changes, including errors and security boundaries.
- Never weaken CI, bypass required checks, or claim a test passed without observing its result.
- Keep pull requests reviewable; explain scope, risk, test evidence, and outstanding limitations.
- Formatting conventions are automatically checked. Architectural guidance requires review unless a specific automated rule enforces it.
