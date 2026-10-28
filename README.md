# Orbit

Orbit is the context, governance, and execution layer for AI-native engineering organizations.

> Intent moves outward into execution. Accepted decisions and evidence flow inward into organizational understanding.

## Product model

Orbit preserves the relationship between:

```text
Intent
↓
Current Context
↓
Decisions + Guardrails
↓
Work
↓
Humans + Approved Agents
↓
Evidence
↓
Outcome
↓
Learning
```

The UI uses three semantic orbits around Intent:

1. **Governance & memory** — Decision, Guardrail, Context, Evidence
2. **Execution & accountability** — Work Item, Agent, Human Gate, Human
3. **Systems & consequences** — CI, Release, Pull Request, Outcome

External tools such as Linear, Figma, GitHub, and Meta Muse are providers behind these concepts. They are not Orbit's domain model.

## Core rules

- AI interprets. Humans authorize. Orbit enforces.
- Agents have capabilities, not authority.
- No meaningful agent execution without an authorized Context Snapshot and Execution Contract.
- Provider credentials are brokered and never handed directly to agents.
- Proposed decisions do not mutate authoritative project context.
- Original Intent is immutable historical input.
- Context versions are immutable and versioned.
- Existing agent sessions keep the Context Snapshot they started with.

## Repository

This repository is intentionally at a clean implementation baseline.

```text
apps/
  api/       Fastify + TypeScript API
  web/       Vite + React + TypeScript
packages/
  domain/    Reusable governance and policy primitives
  db/        PostgreSQL migration runner
```

Legacy CareerGlyph, HN Jobs demo state, simulated agent execution, hard-coded planner output, and prototype persistence have been removed. New backend behavior is implemented from the approved backend design and Linear backlog.

## Local development

```bash
npm install
cp .env.example .env

npm run db:up
npm run dev:api
npm run dev:web
```

Validate:

```bash
npm run typecheck
npm test
npm run build
```

The API currently exposes only a health endpoint. Database migrations will be introduced with the backend persistence work.
