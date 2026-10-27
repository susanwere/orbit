# Orbit

Orbit is an AI-native product engineering context and execution control plane. It helps software teams move from product intent → decisions → guardrails → work → AI/human execution → evidence → outcome, while preserving product context, enforcing security boundaries, and surfacing the moments where human judgment is required.

Orbit is not a Jira/Linear clone, a coding-agent IDE, or a replacement for GitHub, Figma, CI/CD, or AI coding tools. It sits above those systems and coordinates how they contribute to a product outcome.

**Working rule:** no meaningful agent execution without an authorized, minimal context snapshot and an execution contract. Agents have capabilities, not authority.

## Hackathon demo

Demo scenario: **CareerGlyph — Interview Capture & Debrief** (a seeded example initiative inside Orbit; Orbit itself is the product being built).

Three-minute story: a human describes the feature → Orbit (Muse Spark planner) proposes a governed work graph on the Orbit Map → an approved agent executes one step inside a scoped Agent Session → policy API-04 triggers a Human Gate → the human approves → execution resumes → Orbit shows evidence and provenance.

See `docs/` for the hackathon execution brief (PDF) and the full architecture v4 (DOCX).

## Monorepo

```text
apps/
  api/   Fastify + TypeScript API (modular monolith), stub planner -> Muse Spark later
  web/   Vite + React + TypeScript frontend
packages/
  domain/  Pure domain model: state machines, policy evaluation, agent governance invariants
  db/      PostgreSQL migrations + CareerGlyph seed
```

## Quick start

```bash
npm install
cp .env.example .env

# optional in Day 1: Postgres (API currently runs on an in-memory demo store)
npm run db:up
npm run db:migrate
npm run db:seed

# terminals
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:5173
```

Validate:

```bash
npm run typecheck
npm test
```

## Demo script (3 minutes)

1. **Home / Attention** — "You don't need to watch everything. Orbit surfaces decisions where human judgment changes the outcome."
2. **Describe Intent** — Use the seeded CareerGlyph intent → **Review proposed Orbit Map**. Point out 5 detected decisions and the REC-01 / API-04 / SEC-01 / PRIV-01 guardrails. Planner runs in deterministic `stub` mode with the exact schema of the future Muse Spark structured output.
3. **Approve & Start** — The work graph appears on the Orbit Map (CG-142 Recorder Controls, CG-143 Async Transcription, CG-144 Structured Debrief). Nothing was created externally.
4. **Orbit Map** — The signature constellation: lanes + flowing connections. **Lines carry meaning** — thin muted = dependency, glowing cyan (animated dashes) = executing, green settled = completed, amber pulsing = waiting for human, red dashed = blocked/failed, faint dotted = proposed. Nodes are restrained (▭ agent, ● human, ▣ system, ◆ gate). Select *Frontend Engineer — Muse Code · Implement recorder controls* → **Start scoped Agent Session**. Show the Context Snapshot (3 authorized CONFIDENTIAL decisions), Execution Contract (allowed paths, forbidden `secret.production.read`), and live activity.
5. **Human Gate** — Policy API-04 fires: the Muse Code node becomes an amber ◆ with a **SUSAN NEEDED · API-04** callout, its outgoing lines pulse amber, **Needs You (1)** lights up, and unaffected lanes keep their own state. Approve. The line settles green, execution resumes, tests pass (14/14), and Evidence & Provenance shows policy evaluation, test, requirement-coverage, and human-review records. Use **Why does this work exist?** to trace intent → decisions → work item → session → evidence.
6. **Governance beats** — Agents (Admin): switch the principal to Alex (member) and try creating an agent → API denies with 403. Context & Decisions: REC-01 and PRIV-01 trace back to the decisions that generated them.

Fallback: the entire flow is deterministic (in-memory store, stub planner, simulated agent activity), so it replays identically after a server restart.

## Priorities

- **P0:** intent input, Spark planning (stub-compatible schema), Orbit Map, approved agent assignment, scoped Agent Session, Context Snapshot, one policy, one Human Gate, one execution, evidence.
- **P1:** voice, Decisions UI, Agent Catalog, Why? trace, live events.
- **P2 (do not let delay P0):** complete RBAC, full policy DSL, provider marketplace, production credential broker, SSO/SCIM, full sync.
