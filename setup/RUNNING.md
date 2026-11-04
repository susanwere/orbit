# Running ORBIT

Complete the [setup guide](README.md) first. Commands below run from the repository
root, not from this `setup/` directory.

## Start the local application

Docker must be running. Start PostgreSQL, wait for readiness, then apply any new
migrations:

```bash
npm run db:up
docker compose exec postgres pg_isready -U orbit -d orbit
npm run db:migrate
```

If using a custom database URL, follow the setup guide's explicit environment
loading instructions for migrations.

Keep these two terminals running:

```bash
# Terminal 1
npm run dev:api
```

```bash
# Terminal 2
npm run dev -w @orbit/web -- --host 127.0.0.1
```

- Application: http://localhost:5173
- API health: http://localhost:4000/health
- Local PostgreSQL: localhost:5433

Use the same hostname throughout a browser session. Sign up or sign in through the
UI. Muse Spark planning/context features additionally require the API model key.

## Start coding execution, when configured

The coding worker is optional for browsing projects and generating plans/context.
It requires separate credentials, a registered supported repository, approved
execution scope and Docker. See the setup guide before enabling it.

Build the image before the first execution and after worker code changes:

```bash
docker build -f infra/muse-worker/Dockerfile.local -t orbit-muse-worker:local .
```

Then keep a third terminal running, replacing the placeholder with your real
project database ID:

```bash
npm run muse:local:serve -- --project=YOUR_PROJECT_ID
```

Use the UI to approve the plan, authorize the agent and execute a ready work item.
Review the PR and independent CI evidence before merging. The current worker's
repository and shell-execution limitations are documented in the setup guide;
these commands do not remove those restrictions.

Do not use the local consumer against a hosted database and assume the execution
container follows it: its Compose configuration still uses local PostgreSQL.

## Versioning webhook

No extra versioning terminal is needed. The API polls its durable webhook/context
queues while running. Configure the signed GitHub webhook and the project/system
principal environment values in the [setup guide](README.md#7-enable-merge-driven-context-versioning).
A merged PR triggers a proposed version; human approval remains separate.

## Verify code changes

```bash
npm run typecheck
npm test
npm run build
npm run format:check
```

Database integration tests require a separate migrated test database and
`TEST_DATABASE_URL`; see the setup guide. Tests without that variable skip those
integration suites. Do not run them against your recording or production database.

## Stop and restart

When no execution is active, stop API/frontend/consumer terminals with Ctrl+C.
Stop the development database with:

```bash
npm run db:down
```

The database volume remains intact. Do not remove Docker volumes unless you intend
to erase the database. Retain the private document-storage directory as well.

After changing API/consumer env files, restart those processes. After changing
frontend env values, restart Vite.
Rebuild the worker image for changes packaged into it. Avoid interrupting an active
job to refresh its image.
