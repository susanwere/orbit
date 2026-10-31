#!/usr/bin/env bash
set -euo pipefail

# Developer-only orchestration for an explicitly disposable checkout.
# Execution and delivery remain separate containers with separate credentials.
: "${ORBIT_DISPOSABLE_CHECKOUT:?Set the absolute path of your disposable checkout}"
: "${ORBIT_DEMO_REPOSITORY:?Set the approved owner/repository}"
: "${META_API_KEY:?META_API_KEY required for Muse execution}"
: "${ORBIT_WORKER_GITHUB_TOKEN:?Restricted GitHub token required for PR delivery}"

if [[ "$ORBIT_DISPOSABLE_CHECKOUT" != /* || ! "$ORBIT_DEMO_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Use an absolute checkout path and an owner/repository name." >&2
  exit 1
fi
if [[ ! -d "$ORBIT_DISPOSABLE_CHECKOUT/.git" ]]; then
  echo "Workspace must be a disposable Git checkout." >&2
  exit 1
fi
origin="$(git -C "$ORBIT_DISPOSABLE_CHECKOUT" remote get-url origin)"
case "$origin" in
  "https://github.com/$ORBIT_DEMO_REPOSITORY"|"https://github.com/$ORBIT_DEMO_REPOSITORY.git"|"git@github.com:$ORBIT_DEMO_REPOSITORY.git") ;;
  *) echo "Checkout origin does not match the expected demo repository." >&2; exit 1 ;;
esac
if [[ -n "$(git -C "$ORBIT_DISPOSABLE_CHECKOUT" status --porcelain)" ]]; then
  echo "The disposable checkout must start clean." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
execution_log="$(mktemp)"
trap 'rm -f "$execution_log"' EXIT

echo "Running queued Muse job in a separate execution container..."
if ! docker compose -f docker-compose.yml -f infra/muse-worker/compose.local.yml --profile muse-smoke run --rm muse-worker | tee "$execution_log"; then
  echo "Muse execution failed. GitHub delivery was NOT started." >&2
  exit 1
fi
job_id="$(sed -n 's/^Muse job \(musejob_[A-Za-z0-9-]*\) outcome: TURN_FINISHED$/\1/p' "$execution_log" | tail -1)"
if [[ -z "$job_id" ]]; then
  echo "No verified TURN_FINISHED job ID in execution output; refusing delivery." >&2
  exit 1
fi
echo "Delivering only job $job_id in the independent GitHub container..."
ORBIT_WORKER_JOB_ID="$job_id" docker compose -f docker-compose.yml -f infra/muse-worker/compose.delivery.yml --profile muse-delivery run --rm muse-delivery
echo "PR delivery returned. Check the PR and verify actual GitHub Actions evidence in ORBIT."
