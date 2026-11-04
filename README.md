# ORBIT

ORBIT is a workspace for planning and executing software changes with AI agents.
Describe what you want to build, review the proposed plan, authorize execution,
and follow the resulting pull requests and CI evidence in one project canvas.

**Muse Spark** generates plans and evidence-based project understanding.
**Muse Code** implements approved work through the separately operated coding
worker. Humans review proposals, authorize execution and merge pull requests.

## Built during the hackathon

ORBIT was started from scratch after the hackathon began. Its application UI,
planning/context flows, execution orchestration and GitHub/CI integration were
built during the event. It uses third-party libraries and Meta's Muse Spark and
Muse Code; those tools and models are not original ORBIT implementations.

The table below links one representative merged PR per feature. These are entry
points for reviewing the work, not an exhaustive list of subsequent improvements.

## What you can do in the UI

| Screen                       | What it provides                                                                                                                                                                                                                                                                                                                                                 | Main PR                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Sign in / Create account** | Email/password signup and sign-in, session restoration, and account sign-out. Google sign-in, verification emails and password reset depend on their configured providers.                                                                                                                                                                                       | [#126](https://github.com/susanwere/orbit/pull/126) |
| **Projects**                 | Searchable project cards, pagination with the active page indicated, and a New project action.                                                                                                                                                                                                                                                                   | [#104](https://github.com/susanwere/orbit/pull/104) |
| **New project**              | Name a project and optionally connect a GitHub repository. An empty project is valid; repository connection can happen later.                                                                                                                                                                                                                                    | [#105](https://github.com/susanwere/orbit/pull/105) |
| **Composer**                 | Describe the initial intent, attach supporting documents, or record voice input and edit its transcription before generating a plan. Recording/transcription states disable conflicting actions. The composer is available for a project that has no saved intent or generated plan.                                                                             | [#129](https://github.com/susanwere/orbit/pull/129) |
| **Project Context**          | Generate an understanding from original intent, connected repository evidence and documents. Follow generation activity, browse saved versions, request changes or approve a proposal. Tabs show Overview, Architecture, Technologies, Features, Constraints and Version History. A dot indicates a version not yet viewed during the current workspace session. | [#134](https://github.com/susanwere/orbit/pull/134) |
| **Plan details**             | Horizontal tabs for Original Intent, Proposed Outcome, Guardrails, Decisions to Review and Assumptions. Original Intent is immutable; editable proposal details become read-only after plan approval.                                                                                                                                                            | [#134](https://github.com/susanwere/orbit/pull/134) |
| **Workflow**                 | A canvas showing the original intent and main work items, their dependencies and execution states. Open a work item for its details or execute it when ready. Pan, zoom, fit controls and an accessible node list support navigation.                                                                                                                            | [#124](https://github.com/susanwere/orbit/pull/124) |
| **Work item details**        | View the task description, execution progress, activity, formatted execution summary, prompt/context, and available PR/CI evidence. Execution is offered only when the work item is eligible.                                                                                                                                                                    | [#135](https://github.com/susanwere/orbit/pull/135) |

The project sidebar provides **Project Context**, **Plan details**, **Workflow**,
and **Composer** when eligible, with Account at the bottom. The main canvas shows
work items; it does not require users to navigate through separate workflow and
step screens to reach execution details.

## A typical project flow

1. Create a project and optionally connect its repository.
2. Describe the desired outcome in the composer, with supporting documents or
   voice input if useful.
3. Generate a plan with Muse Spark, inspect its details and approve it.
4. Authorize the coding agent's displayed scope and execute a ready work item.
   Dependent work waits until its prerequisites are satisfied.
5. Follow activity and execution output. When delivery succeeds and independent
   CI passes, ORBIT indicates that the PR is ready for human review.
6. Merge the PR in GitHub. Verified merge/CI evidence completes the work item.

Project Context is a related, separately reviewed flow: generate a summary, inspect
its sources and sections, and approve it when accurate. With the signed GitHub
webhook and background processor configured, merging a PR queues a new **proposed**
context version. Generating a version does not automatically approve it or replan
existing work.

## Execution and evidence

- Coding execution requires the configured local worker, a registered repository,
  an approved plan and explicit agent authorization.
- A finished agent turn is not the same as a passing build or a completed work
  item. The UI distinguishes execution output from independent GitHub evidence.
- CI repairs target the existing PR rather than creating a separate repair-only PR.
  New execution PR descriptions identify the approved task and ORBIT worker origin.
- The canvas distinguishes ready, waiting, running, failed and completed work.
  Completion and PR-review notifications can be dismissed from the canvas header.
- Generated summaries render readable paragraphs, lists, headings and code blocks.
- Existing agent context snapshots remain immutable. New approved context is
  supplied only within the agent's authorized scope and classification clearance.

Full semantic reconciliation of planned/running/waiting work after every context
change is a future milestone, not an existing automatic UI capability. See
[bounded context-change review](docs/context-change-review.md).

## Current demo boundaries

The local execution pipeline is currently restricted to the disposable repository
`susanwere/private-test`; another developer cannot switch it to their own fork
using environment variables alone. The API's planning/context features and the
coding worker have separate credentials and runtime requirements.

Background processing requires a running API process. Google login requires a
pre-linked identity; email/password signup is the simplest local entry point.

## Repository

```text
apps/
  api/       Fastify + TypeScript API and worker entrypoints
  web/       Vite + React + TypeScript UI
packages/
  domain/    Shared domain contracts and policy primitives
  db/        PostgreSQL access and migrations
setup/
  README.md  Installation, configuration and integration setup
  RUNNING.md Startup, shutdown and verification commands
```

## Setup and running

Start with the [installation and configuration guide](setup/README.md). It covers
Node/Docker prerequisites, private environment files, PostgreSQL migrations,
Meta/GitHub credentials and the merge-driven context-versioning webhook.

Once configured, run these from the repository root:

```bash
npm run db:up
npm run db:migrate
```

Start the API and frontend in separate terminals:

```bash
# Terminal 1: API
npm run dev:api
```

```bash
# Terminal 2: frontend
npm run dev -w @orbit/web -- --host 127.0.0.1
```

Open **http://localhost:5173**. The API health endpoint is
**http://localhost:4000/health**. The frontend requires its own
`apps/web/.env.local` with `VITE_API_BASE_URL=http://localhost:4000`.

See [running and stopping ORBIT](setup/RUNNING.md) for daily commands, the optional
coding worker and verification. Live execution currently targets the configured
local demo repository; read the setup guide's repository restriction before
attempting execution against a different repository.
