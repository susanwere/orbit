# ORBIT setup guide

This guide describes the current repository. Start with the local app, then enable
Meta planning, coding execution, and merge-driven context versioning as needed.
For subsequent starts and stops, see [Running ORBIT](RUNNING.md).

## 1. Prerequisites

- Git and access to this repository.
- Node.js 22 and npm. Use a recent Node 22 release.
- Docker Desktop or Docker Engine with Docker Compose, running before database or
  coding-worker commands.
- Meta Model API access for live planning/context generation.
- A disposable GitHub repository and scoped credentials for live coding/PR demos.

Commands below assume a macOS/Linux shell and run from the repository root unless
another directory is explicitly named. Ports 4000, 5173 and 5433 must be available.

```bash
git clone https://github.com/susanwere/orbit.git
cd orbit
npm ci
npm run build -w @orbit/domain
npm run build -w @orbit/db
```

The repository may require GitHub authentication while private. The coding worker
installs Muse Code inside its Docker image; the normal app does not require a host
Muse CLI installation.

## 2. Configure private environment files

If these files already exist, edit them rather than overwriting working secrets.
Never copy another person's credentials or commit environment files.

Create `.env.local` in the repository root:

```dotenv
HOST=127.0.0.1
PORT=4000
DATABASE_URL=postgres://orbit:orbit@localhost:5433/orbit
ORBIT_AUTH_ISSUER=orbit-local
ORBIT_AUTH_SECRET=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS_LONG
ORBIT_WEB_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Generate your own signing secret, then paste its output into `ORBIT_AUTH_SECRET`:

```bash
openssl rand -hex 32
```

Create `apps/web/.env.local` separately:

```dotenv
VITE_API_BASE_URL=http://localhost:4000
```

The separate frontend value is important: without it, the browser currently uses
its own origin for API requests. The development frontend on port 5173 does not
proxy API requests to port 4000.

```bash
chmod 600 .env.local apps/web/.env.local
```

Environment-loading rules:

| Process                                     | Configuration                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev:api`                           | Root `.env.local`, then `apps/api/.env.local` overrides                 |
| `npm run muse:local:serve` / `muse:local`   | Root `.env.local`, then API-local overrides                             |
| Vite frontend                               | `apps/web/.env.local`; `VITE_*` values are public browser configuration |
| `npm run db:migrate`                        | Exported `DATABASE_URL`, otherwise the local default above              |
| Built API via `npm run start -w @orbit/api` | Exported environment; does not automatically load local env files       |

Keep optional backend credentials in `apps/api/.env.local` and set file permissions
to 600. Do not put API keys, GitHub tokens or the signing secret into `VITE_*`.
The application reads `MODEL_API_BASE_URL`; the similarly named
`META_MODEL_API_BASE_URL` in the old example file is not read by the server.

## 3. Start PostgreSQL and migrate

```bash
npm run db:up
docker compose exec postgres pg_isready -U orbit -d orbit
npm run db:migrate
```

Wait until PostgreSQL reports that it is accepting connections before migrating.
The development Compose database uses user/password/database `orbit` and host port 5433. Those are local sample credentials, not suitable for a public database.
Data persists in the `orbit-pgdata` Docker volume.

For a custom `DATABASE_URL` stored in root `.env.local`, load it explicitly:

```bash
node --env-file=.env.local --import tsx packages/db/src/migrate.ts
```

## 4. Run the app

Terminal 1:

```bash
npm run dev:api
```

Terminal 2:

```bash
npm run dev -w @orbit/web -- --host 127.0.0.1
```

Open **http://localhost:5173**. API health is **http://localhost:4000/health**.
Use the same hostname consistently; avoid switching between localhost and
127.0.0.1 during a session.

Create an email/password account using the UI. Passwords must contain at least
12 characters. Signup creates a personal organization and an administrator account.
Google login and outbound email delivery are not required for local email signup.
The normal authenticated UI requires `ORBIT_AUTH_SECRET` and `ORBIT_AUTH_ISSUER`;
starting a health endpoint alone does not prove authentication is configured.

## 5. Enable Muse Spark planning and Project Context

Add to `apps/api/.env.local`:

```dotenv
MODEL_API_KEY=YOUR_META_MODEL_API_KEY
# Optional; omit to use the application's default endpoint.
MODEL_API_BASE_URL=https://api.meta.ai/v1
```

Restart the API. Create a project, optionally connect a repository, save an intent
and generate a plan. The current planner/context generator uses Muse Spark. Review
and approve proposed output in the UI; generation does not grant execution access.

For private repository evidence, also configure:

```dotenv
ORBIT_GITHUB_EVIDENCE_TOKEN=YOUR_REPOSITORY_READ_TOKEN
```

Use a fine-grained GitHub token limited to the disposable repository, with Contents,
Pull requests and Actions read access for the evidence/CI flow. Ensure its owner
can access the repository. Meta service access and billing are independent of
hosting and GitHub access.

Supporting-document uploads currently accept TXT, MD, PDF and DOCX up to 5 MiB per
file. Local uploads use a private `.orbit-documents` directory relative to the API
process working directory unless `ORBIT_DOCUMENT_STORAGE_DIR` is set to an absolute
private location. Preserve that directory alongside the database if retaining a
demo. Do not include uploads in Git or a shared source archive.

## 6. Enable local Muse Code execution and PR delivery

**Current repository restriction:** the local preparation, policy and delivery
pipeline is restricted to `susanwere/private-test`. Setting an environment variable
will not change that restriction. Other developers can use the app and planning,
but portable execution against their own fork requires a code change preserving
exact repository/path authorization. Do not grant someone access to your personal
repository or share credentials merely to work around this.

For the supported disposable repository, add to `apps/api/.env.local`:

```dotenv
META_API_KEY=YOUR_MUSE_CODE_KEY
ORBIT_WORKER_GITHUB_TOKEN=YOUR_REPOSITORY_DELIVERY_TOKEN
ORBIT_GITHUB_EVIDENCE_TOKEN=YOUR_REPOSITORY_READ_TOKEN
```

- `MODEL_API_KEY` is used by the API for planning/context/voice features.
- `META_API_KEY` is passed to the Muse Code execution process.
- The delivery token needs Contents and Pull requests write access on the exact
  disposable repository. Keep the evidence token read-only.
- The trusted launcher separates execution credentials from GitHub delivery
  credentials. Do not manually pass every host variable into the agent process.

Build the worker image from the root:

```bash
docker build -f infra/muse-worker/Dockerfile.local -t orbit-muse-worker:local .
```

The Dockerfile installs Muse Code and checks version 1.4.14. Rebuild when worker
code changes. The installer is fetched at build time, so a new upstream CLI version
may fail the pinned check; do not bypass it without reviewing compatibility.

Terminal 3:

```bash
npm run muse:local:serve -- --project=YOUR_PROJECT_ID
```

Replace the project ID with the real database ID. Omitting `--project` lets the
consumer consider eligible local projects; restricting it is preferable for a
controlled recording. Keep the terminal running while demonstrating execution.

In the UI:

1. Connect the supported repository to the project.
2. Generate, review and approve the plan.
3. Authorize the coding agent for the displayed repository/path scope.
4. Execute an eligible work item. Dependencies must finish before successors run.
5. Review execution output, the delivered PR and independent CI status.
6. Merge the PR yourself when ready; the agent does not merge it automatically.

The current authorized consumer can deliver PRs and perform CI repair. Read the
actual authorization modal before starting; do not assume an execution is limited
to local edits. CI repair should update the original PR branch.

Shell execution is disabled by default. Although the worker supports
`ORBIT_MUSE_ALLOW_SHELL`, the normal consumer currently does not forward that
variable to its execution child. Setting it in the consumer env file alone is not
an effective way to enable shell-based builds/tests. Report this limitation
accurately; independent GitHub CI is separate evidence.

API and local consumer must refer to the same database for this local setup. The
current execution container Compose files use the local Compose PostgreSQL service;
pointing only the host's `DATABASE_URL` at a hosted database does not connect the
entire execution pipeline to that database.

## 7. Enable merge-driven context versioning

The webhook is handled by the API and does not require the coding consumer to run.
Configure these API variables:

```dotenv
GITHUB_WEBHOOK_SECRET=YOUR_RANDOM_WEBHOOK_SECRET
ORBIT_ORGANIZATION_ID=YOUR_PROJECT_ORGANIZATION_ID
ORBIT_PROJECT_ID=YOUR_PROJECT_ID
ORBIT_SYSTEM_PRINCIPAL_ID=AN_EXISTING_PRINCIPAL_IN_THAT_ORGANIZATION
MODEL_API_KEY=YOUR_META_MODEL_API_KEY
ORBIT_GITHUB_EVIDENCE_TOKEN=YOUR_REPOSITORY_READ_TOKEN
```

Generate a webhook secret with `openssl rand -hex 32`. The organization/project
values must refer to the actual saved project, not the old demo placeholders.
The system principal must already exist in that organization; an arbitrary string
will fail the snapshot's database foreign key.

To find project IDs locally:

```bash
docker compose exec postgres psql -U orbit -d orbit -c \
  'SELECT id, name, organization_id FROM projects ORDER BY created_at DESC;'
```

An administrator can create a dedicated context-refresh principal in psql after
replacing `YOUR_PROJECT_ID` below:

```sql
INSERT INTO principals (id, organization_id, type, display_name)
SELECT 'context_refresh_' || id, organization_id, 'system', 'Context refresh worker'
FROM projects WHERE id = 'YOUR_PROJECT_ID'
ON CONFLICT (id) DO NOTHING
RETURNING id, organization_id;
```

Use the returned ID for `ORBIT_SYSTEM_PRINCIPAL_ID`. This SQL creates a narrowly
identified background actor; it does not grant agent execution or bypass review.
If the principal already exists, the command returns no new row; look it up rather
than creating a duplicate. On hosted environments, use the hosting provider's
secure database console instead of exposing PostgreSQL publicly.

Expose local API port 4000 through an HTTPS tunnel, or use the deployed API URL.
In the connected GitHub repository's webhook settings, configure:

| Setting      | Value                                   |
| ------------ | --------------------------------------- |
| Payload URL  | `https://YOUR_API_HOST/webhooks/github` |
| Content type | `application/json`                      |
| Secret       | The same `GITHUB_WEBHOOK_SECRET`        |
| Events       | Pull requests                           |
| Active       | Enabled                                 |

Restart the API. The repository must also be registered to that ORBIT project.
The current API environment maps webhook ingress to one organization/project.

On a merged PR, the API saves the signed delivery, enqueues a durable context
refresh, calls Muse Spark and saves the next **proposed** context version. Closing
without merging does not trigger a version. Duplicate deliveries of the same merge
are deduplicated. `202 Accepted` only acknowledges receipt; inspect Project Context
or the refresh job to confirm generation completed. The API processes background
jobs while it is running; a sleeping hosted instance cannot process them on time.
Human approval is still required before the new knowledge becomes authoritative.

New execution snapshots receive approved knowledge only if the approved agent
explicitly has `/attributes/approvedProjectKnowledge` scope and INTERNAL clearance.
Default PUBLIC agents are not silently upgraded. Existing snapshots remain frozen.
See [context change review](../docs/context-change-review.md) for the exact impact
review behavior and the remaining workflow-reconciliation milestone.

## 8. Optional authentication and email services

For Google login, set `VITE_GOOGLE_CLIENT_ID` in the frontend env file and configure
`ORBIT_OIDC_ISSUER`, `ORBIT_OIDC_AUDIENCE` and `ORBIT_OIDC_JWKS_URL` on the API for
the trusted OAuth application. Authorize the frontend origin in Google. Google
exchange currently requires a pre-linked identity; email signup is the simplest
entry point for a new local user.

For verification/reset emails, configure `ORBIT_RESEND_API_KEY`,
`ORBIT_EMAIL_FROM` and `ORBIT_APP_URL`. The sender must be verified, and the current
email adapter requires an HTTPS application URL. Do not assume it accepts a plain
HTTP localhost callback. Without email delivery, local signup/login work, but
verification and password-reset emails cannot be delivered.

## 9. Verify the installation

```bash
npm run typecheck
npm test
npm run build
npm run format:check
```

`npm test` skips PostgreSQL integration suites unless `TEST_DATABASE_URL` is set.
Use a separate integration-test database; do not run tests against valuable demo
or production data. For example, create `orbit_test` once:

```bash
docker compose exec postgres createdb -U orbit orbit_test
DATABASE_URL=postgres://orbit:orbit@localhost:5433/orbit_test npm run db:migrate
TEST_DATABASE_URL=postgres://orbit:orbit@localhost:5433/orbit_test npm test
```

If `orbit_test` already exists, skip `createdb`. The tests create synthetic fixtures;
using an isolated test database keeps them away from recording data.

Manual smoke check: health endpoint, signup/login, refresh/logout, create project,
save intent, generate/review plan, generate/review context, then optionally execute
one bounded task and confirm its PR/CI evidence. A successful build is not evidence
that a real Meta call or GitHub delivery was exercised.

## 10. Restart behavior

After backend environment changes, restart the API and local consumer. After
frontend environment changes, restart Vite. After worker source changes, rebuild
the worker image before starting the next execution. Avoid stopping an active
execution merely to refresh its image.

## 11. Troubleshooting

| Symptom                                           | Check                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Browser calls port 5173 for `/auth`               | Set `apps/web/.env.local` `VITE_API_BASE_URL`; restart Vite.                                                                        |
| API health works but signup/project routes do not | API signing secret/issuer are configured and migrations ran.                                                                        |
| Database connection fails                         | Docker is running; port 5433 is reachable; explicitly set DATABASE_URL. The server's current fallback is invalid.                   |
| Workspace package import fails                    | Build `@orbit/domain` and `@orbit/db` after `npm ci`.                                                                               |
| Login works but refresh fails when hosted         | Use same-origin hosting or verify the exact frontend/API site and cookie configuration.                                             |
| Planning reports 503                              | Check Meta credentials/model access and safe API diagnostics; not every failure is a timeout.                                       |
| Execute waits indefinitely                        | Confirm Docker image, running consumer, exact project/database, approved plan/agent, dependency readiness and supported repository. |
| No context version after webhook 202              | Check repository mapping, merged PR, model key, existing same-organization system principal, awake API and refresh-job status.      |
| Version exists but is not authoritative           | Review and approve it; generation alone never approves context.                                                                     |
| Worker cannot run npm/build/tests                 | Default file-only execution and the consumer's shell-flag forwarding limitation apply.                                              |
| Changes are missing in a new recording            | A new ORBIT project does not reset GitHub. Use an intentionally clean disposable repository baseline.                               |

Stop API/frontend/consumer terminals with Ctrl+C when idle. `npm run db:down` stops
the development database while preserving its volume. Do not add `--volumes` or run
volume-removal commands unless you intend to erase the database. Never package
your whole working directory for submission; use reviewed tracked source only.
