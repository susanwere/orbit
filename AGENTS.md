# Orbit Engineering Standards

These rules apply to all contributors and coding agents working on this repository.

## Readability and formatting
- Write clear, human-readable source. Never minify application code.
- Use descriptive names and meaningful whitespace. Avoid dense one-line functions and compressed conditionals.
- Run `npm run format:api` for backend files, `npm run format:web` for frontend files, or `npm run format` across both apps and shared packages before opening a pull request.
- CI checks changed TypeScript, JavaScript, JSON, and stylesheets in BOTH apps and shared packages. The repository-wide `npm run format:check` can be used once legacy files have been formatted.
- Follow the committed Prettier configuration. CI rejects unformatted changed source files.
- Do not bypass or disable formatting, typechecking, tests, or build checks to merge a change.

## Architecture
- Keep Fastify route handlers focused on request handling and response mapping.
- Put domain logic in services and database queries in repositories when complexity justifies separation.
- Apply authentication and resource authorization to every protected endpoint.
- Validate external inputs and use parameterized SQL.
- Prefer precise TypeScript types over `any` or loosely typed records when shapes are known.
- Keep changes scoped; a formatting-only change must not include behavioral refactors.

## Testing and delivery
- Cover success paths, invalid input, unauthenticated and unauthorized requests, and failure behavior with focused tests.
- Preserve and run existing typecheck, tests, and build checks.
- Avoid claiming CI is green or a branch is protected until verified.
- Use a separate, reviewable pull request to reformat existing legacy files.
