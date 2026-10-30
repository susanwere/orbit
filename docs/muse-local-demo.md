# Orbit hackathon: run Muse demo locally

No AWS, IAM, Fargate, or advanced account features are required.

## 1. Install and prepare
```sh
npm ci
docker compose up -d postgres
npm run build
mkdir -p /tmp/orbit-muse-demo
```

## 2. Guaranteed deterministic simulation
```sh
npm run muse:demo -w @orbit/api -- --workspace=/tmp/orbit-muse-demo
```

Alternatively, run directly from the API workspace:
```sh
npm run muse:demo -w @orbit/api -- --workspace=/tmp/orbit-muse-demo
```

The output is **SIMULATED** and does not create files, GitHub PRs, test artifacts, or verified execution evidence. This is an adapter demo, not yet an end-to-end DB job test.

## 3. Optional real Muse CLI check
Create a **disposable, non-sensitive local checkout** and install/authenticate the official Muse Code CLI following Meta documentation. Do not point the CLI at personal files or production repositories. Then:
```sh
export ORBIT_DEMO_MODE=real
export ORBIT_DEMO_REAL_CONFIRMED=yes
# Configure META_API_KEY in local environment, never in source or GitHub.
npm run muse:demo -w @orbit/api -- --workspace=/absolute/path/to/disposable/checkout
```

The output is marked **REAL_CLI_TURN_UNVERIFIED**. A process exit 0 is **not** proof of successful tests/PR or an Orbit execution completion. The script deliberately redacts raw real-provider events to avoid leaking secrets in logs.

This real mode is only suitable for your personally controlled local demo environment. It is **not** production isolation and does not enforce allowed paths, GitHub access controls or network egress. Run against throwaway content only.

## Remaining ORB-72 work
Connect a job-scoped worker entrypoint to the durable queue and real evidence collector with DB integration tests. Only then can the UI show authoritative status and GitHub/CI provenance. No mock result should ever be stored as PASSED evidence or promoted to a real completed workflow step.

## 4. Real Open Jobs site on your Mac (hackathon walkthrough)

This creates a React/Vite **Open Jobs** website in a disposable EMPTY folder using real Muse Code, builds it, and starts Vite bound to loopback at **http://127.0.0.1:4173**.

```sh
mkdir -p /tmp/orbit-open-jobs-demo
export ORBIT_DEMO_REAL_CONFIRMED=yes
# META_API_KEY must be configured privately on your machine.
npm run muse:open-jobs -w @orbit/api -- --workspace=/tmp/orbit-open-jobs-demo
```

The generated site uses sample jobs and requires no production credentials. Keep the terminal open while presenting, then Ctrl+C to stop. Use the Orbit frontend's inspector to open the local URL once preview URL support is added; that wiring is **not yet implemented** in this PR.

**Demo labels:** LOCAL PREVIEW (not cloud deployment), Muse CLI turn (not verified GitHub CI), sample data (not live job feed). The runner rejects nonempty workspaces and validates React, Vite, build and dev scripts. It runs generated npm scripts: only do this in a disposable trusted dev environment with no private keys, user data, sensitive git credentials, or production access. This is not a security sandbox or a proof of agent scopes.
