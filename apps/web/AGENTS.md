# Web Engineering Guidance

Applies within `apps/web/` in addition to the root `AGENTS.md`.

## React, TypeScript and UI
- Prefer small, cohesive functional components, explicit props, and domain-specific types.
- Keep presentation distinct from API access and complex state transitions. Use hooks only where they clarify shared or lifecycle behavior.
- Do not introduce derived state or effects when plain render calculations suffice.
- Follow the existing Vite/React architecture and Orbit design contracts; do not invent backend capabilities or optimistic success paths.
- Model loading, empty, error, unauthenticated, and forbidden states accurately, preserving form inputs on recoverable errors.

## Accessibility and performance
- Use semantic markup, labeled controls, keyboard access, visible focus, and accessible validation messages.
- Respect reduced-motion preferences, particularly in Three.js/Universe scenes; provide usable non-3D fallbacks as required.
- Avoid unnecessary re-renders and expensive scene work; profile before introducing memoization or complex caching.
- Keep responsive layouts and contrast appropriate for small screens and zoom.

## Data and tests
- Use typed API boundaries; never embed secrets or production bearer tokens in the frontend.
- Test meaningful interactions and accessible states as relevant; do not assert backend behavior not implemented.
- Run `npm run typecheck -w @orbit/web` and `npm run build -w @orbit/web`, plus repository checks.
