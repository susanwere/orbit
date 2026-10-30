# Local Muse Code queue worker (ORB-72)

This is a **developer-only smoke-test scaffold**, not a safe multi-tenant executor or a complete automatic integration.

## Prerequisites

- Docker Desktop and the already-running `postgres` service.
- A disposable, initialized clone of `susanwere/private-test`, with no secrets or unrelated files.
- An **approved and dispatched** Orbit Muse execution job with an execution contract allowing precisely that repository and its intended changed paths. The worker does **not** create or approve jobs.
- Private `apps/api/.env.local` with `META_API_KEY` and `ORBIT_WORKER_GITHUB_TOKEN`; never commit them. The GitHub credential must be limited to the disposable repository.
- Local Compose builds download Muse Code from Meta's official installer. `muse --version` must succeed; there is no pinned installer artifact yet.

## Build and launch ONE eligible job

Run from the repository root:

```sh
export ORBIT_DISPOSABLE_CHECKOUT=/absolute/path/to/private-test
docker compose -f docker-compose.yml -f infra/muse-worker/compose.local.yml \
  --profile muse-smoke build muse-worker
docker compose -f docker-compose.yml -f infra/muse-worker/compose.local.yml \
  --profile muse-smoke run --rm muse-worker
```

The image receives the **entire** API environment file and the checkout is writable. This is acceptable only for a deliberately disposable, non-sensitive local test. Avoid mounting personal folders, Orbit itself, Docker socket, SSH agent, or cloud credentials. No host ports are published by the worker.

The CLI exit is not proof of build success. Inspect the GitHub PR and its actual CI run, then verify with Orbit's authenticated `verify-github-ci` endpoint. Do not mark the job completed on a successful CLI exit alone.

## Important limitations before calling this safe or production-ready

1. Current CLI process may access all environment variables, including credentials. An untrusted agent must not be given secrets. Separate code-execution and credentialed delivery processes, with a narrowly scoped authenticated broker.
2. The checkout is writable as a whole. Application-level allowed path checks are NOT the same as a read-only filesystem with allowed-path mounts.
3. Network egress is not allowlisted. Docker Compose default networking is not a network sandbox.
4. Installer is downloaded during Docker build and must be pinned and supply-chain verified for production.
5. Only an already queued approved job can run. This does not automatically create the checkout, dispatch the job or perform authenticated CI verification.
6. The image is experimental. Validate behavior and OS architecture with a real smoke test before treating it as working.

A production-style isolated runner requires separated credentials and policy enforcement, immutable image, per-job workspace provisioning, and complete database-backed end-to-end tests.
