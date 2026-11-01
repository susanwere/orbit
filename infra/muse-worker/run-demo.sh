#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point. Preparation and checks are explicit; never auto-push.
: "${ORBIT_WORKER_JOB_ID:?Set the exact queued job ID; first run npm run muse:local -- prepare}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
exec npm run muse:local -- execute --job="$ORBIT_WORKER_JOB_ID"
