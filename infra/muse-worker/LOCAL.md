# Local Docker Muse worker (ORB-72)

Reuse the existing queue and Docker worker for the disposable private repository `susanwere/private-test`. Commands run from the ORBIT repository root and load ignored `.env.local` files privately. No command below pushes or creates a PR.

## Prepare an already queued job

The browser must first authorize the agent, bind/start a session, and dispatch the job. Copy its exact job ID. Preparation reads its persisted contract, verifies the project repository registration, clones `main` with the restricted GitHub credential, and pins the commit. It never creates a project, changes approvals, or claims a job.

```sh
npm run muse:local -- prepare --job=musejob_<actual-uuid>
```

Required private settings: `DATABASE_URL` and `ORBIT_WORKER_GITHUB_TOKEN`. The clone subprocess receives the GitHub token through an ephemeral Git authorization header, never a remote URL or saved Git config. Local artifacts live under ignored `.orbit-local/<job-id>/`. Preparation refuses to overwrite an existing job directory. It rejects symlinks, submodules, credential files, and repository-local agent configuration.

## Build the existing image

```sh
ORBIT_DISPOSABLE_CHECKOUT=/tmp docker compose \
  -f docker-compose.yml -f infra/muse-worker/compose.local.yml \
  --profile muse-smoke build muse-worker
```

The build does not mount `/tmp` or run a job. The image includes the current local source and checks the expected Muse version. Rebuild after changing worker code. Credentials and `.orbit-local/` are excluded from the build context. The installer is still fetched at build time; the version check is not checksum verification.

## Check the real Docker boundary

```sh
npm run muse:local -- check --job=musejob_<actual-uuid>
```

This launches a one-shot container with no Meta or GitHub key. It verifies the pinned checkout and origin, read-only workspace root, read-only Git metadata and application source, writable contract mounts, dropped Linux capabilities, and no-new-privileges. A non-Meta echo-provider startup probe checks the installed CLI flags. No model call, database claim, or workflow completion occurs.

The checkout is mounted read-only; generated Compose overrides expose only complete contract-granted directories and individual allowed files writable. Exact allowed files absent from the checkout are prepared as empty mount targets; unused empty targets are removed after execution. Basename globs such as `tsconfig*.json` expose matching **existing** files only. New files matching a glob need explicitly prepared targets; the launcher never makes the entire parent writable to accommodate a glob. Atomic replacement of an individually bind-mounted file can fail; edit that file in place rather than broadening its parent grant.

## Execute locally, without delivery

```sh
npm run muse:local -- execute --job=musejob_<actual-uuid>
```

Requires `META_API_KEY`. The launcher repeats preflight before claiming. The worker pins its claim to the exact job, project, repository and unchanged path contract, and rechecks plan revision, approvals, dependencies, open human gates and running session state. It never takes another project's queued job.

Muse runs in **file-edit-only mode**: shell and web tools disabled, personal context excluded, temporary home, no session log, restricted sandbox networking, sandbox retained. The provider runtime receives only PATH, HOME and the Meta key. It receives no GitHub token, database URL, SSH agent, Docker socket or host home mount. Repository-local configuration is rejected before preparation; the clean disposable workspace is explicitly trusted for headless startup.

This mode deliberately cannot run npm, Git, tests, arbitrary shell commands or package installation. `network_policy=none` applies to agent tools; the trusted Muse provider process still needs outbound access to Meta. This is **not** general network isolation of the whole container or a production multi-tenant sandbox. Do not re-enable shell/web tools without implementing and verifying their additional boundaries.

A `TURN_FINISHED` job is not verified success. Review the changed files and run builds/tests separately in a credential-free disposable environment. The session and step stay incomplete until independent evidence is verified. A failed execution requires the existing authenticated retry/review flow; do not manually requeue it.

## Delivery remains explicit and separate

After a code-producing turn, review the retained response and changed files. In Execution Steps, check the authorization box and click **Push generated changes and create PR**. This explicitly authorizes a remote write to `susanwere/private-test`; executing Muse alone never requests delivery.

The authenticated `POST /projects/:projectId/execution/steps/:stepId/request-delivery` endpoint records the exact job, retained output hash and human requester. It rechecks project authorization, session ownership, current approved plan, prerequisites, gates and repository registration. Proposal-only steps, empty changes, read-only regenerated proposals and stale output hashes cannot be delivered. Duplicate requests reuse the same pending delivery.

The same local consumer claims delivery separately and runs the existing `compose.delivery.yml` service with the job's pinned policy, disposable checkout and restricted GitHub credential. No Meta key reaches that process. It verifies actual Docker isolation, the base SHA, origin, contract paths and exact changed-file list, disables Git hooks/global Git configuration, commits, pushes a job-specific branch and opens a PR. It runs no repository scripts or model tools. Persisted delivery status, PR number, repository and commit SHA appear in the browser.

REQUESTED means the local consumer must be running. ERROR means inspect the checkout and existing GitHub branch/PR before operator recovery; automatic retries are deliberately disabled because a network interruption may follow a successful push. Restarting the consumer does not replay an interrupted delivery.

PR creation leaves the step running. Review the PR, wait for CI, and merge only after checks pass. Use the existing **Verify GitHub CI** action with the GitHub Actions CI run ID. The API needs the separate read-only `ORBIT_GITHUB_EVIDENCE_TOKEN`; it independently verifies GitHub's run/PR/head/merge evidence before completion. Do not use the delivery credential as a model credential. No live GitHub delivery is required for local-only regression tests.

The older `run-demo.sh` now delegates to local execution only; it does not automatically run delivery.

## Retained responses and proposal review

New turns retain only a bounded final assistant response from the installed Muse JSONL terminal envelope, a SHA-256 hash, and independently inspected changed paths. Tool output and reasoning transcripts are not stored as review content. Credential-like responses are refused. The authenticated job endpoint returns this response; Refresh execution status loads it in the browser.

For an older finished turn with no retained response, use:

```sh
npm run muse:local -- recover --job=musejob_<actual-uuid>
```

This is a **new read-only generation**, not reconstruction of the lost original. It uses read-only mounts, `--disable-write`, disabled shell/web tools, and the existing scoped repository/plan checks. It never requeues the original job, changes its attempt count, approves a step, pushes, or delivers. The browser labels its source explicitly. A second recovery is refused once an output exists.

An administrator can explicitly designate a proposal-only agent step for human review. Review requires the exact retained response hash, a bounded decision note, no code changes, an authorized session owner/admin, current plan approval, completed prerequisites and no open human gates. Approval records `human_review` evidence rather than CI evidence. Requesting revision preserves the response, marks the attempt rejected, and requires the existing explicit retry authorization for a new session; it never automatically reruns Muse.

The plan's declared human-only steps have a separate authenticated decision/completion action. Their decisions are recorded in evidence and propagated as execution instructions to later agent sessions that depend on them. Approval comments are optional: the complete accepted proposal is retained alongside any comments. Requesting revision still requires actionable feedback. Existing sessions retain their original immutable snapshots. Code-producing steps remain on the GitHub CI path.

## Replacing an unstarted session after revision feedback

New sessions include the latest rejected review comments for their work item and approved plan revision, explicitly labeled as requested revisions rather than approval. The immutable snapshot receives the same mission. A newer review supersedes older feedback for that step.

For a queued session created before this fix, refresh the browser and use **Retire queued session and authorize a fresh attempt**. The authenticated owner/admin action accepts only the exact queued job with zero attempts and no start timestamp, with the matching approved plan/session/step and no open gate. It locks the job against worker claims, records retirement, terminates the old session, and uses the existing explicit retry flow. Historical snapshots, contracts, jobs and reviews remain intact. Then use **Create & bind agent session** to create the new authorized session with feedback; starting and dispatching remain separate actions.

The worker refuses to claim a job if its session mission omits the latest rejected feedback for its step and plan revision. Retirement cannot stop or replace a job that has already started. A race with a worker claim fails closed; refresh and inspect its state rather than forcing a reset. No queued job is executed by replacement.

The retirement prompt is shown only when the authenticated job status reports missing revision feedback. A corrected replacement that is queued is ready for its worker, not another retirement. The retirement endpoint independently checks the same condition and refuses to retire an up-to-date session.

## Execute from the browser

Start the trusted local consumer once for the existing project:

```sh
npm run muse:local:serve -- --project=<existing-project-id>
```

Docker and the `orbit-muse-worker:local` image must be available. The consumer loads private local configuration, scopes itself to that one project and `susanwere/private-test`, and waits for explicit browser requests. It does not consume ordinary queued jobs. PR delivery requires its own explicit browser request.

In Execution Steps, choose **Execute Muse Code locally** for a session with no job, or **Execute queued job locally** for an already queued current session. The existing authenticated dispatch endpoint accepts `{ "executeLocally": true }`; it records the request, rather than calling Docker. Repeat clicks reuse the same unstarted job and do not duplicate sessions or execution. The browser polls actual job status while local execution is pending or running, then displays retained output.

The consumer serializes each request with a PostgreSQL advisory lock, runs the existing preparation/check/execution commands, and leaves the Docker worker to independently claim the exact job with all approval/contract/dependency checks. Preparation receives the restricted GitHub clone credential but not the Meta key. Execution receives the Meta key but not the GitHub credential. The API and browser never receive Docker access or worker credentials.

Local setup failures are persisted as sanitized errors. **Retry local setup** requests another setup attempt only while the job remains queued with zero execution attempts. A failed real execution uses the existing human-authorized retry path instead. Interrupted setup without a live consumer lock becomes an actionable error, rather than being automatically replayed. Restarting the consumer never reruns a finished or failed job.

If a request stays at REQUESTED, check that the local consumer and Docker are running. Stop the consumer with Ctrl+C when local execution is no longer wanted; an already started execution is allowed to finish and is not silently replayed. This local consumer is not an unattended production service.

## Project context across workflows

Authenticated successful reviews publish the exact approved proposal, optional comment, reviewer, step/plan identity and source hash into a new immutable project ContextVersion. All approved shared workflow decisions are carried into future session missions across the project, including parallel workflows; there is no “latest three comments” cutoff. A bare approval preserves the accepted proposal rather than replacing it with an empty comment or “LGTM.” Rejected drafts remain revision feedback and are not promoted as approved project decisions.

The session snapshot records its context version and the review evidence IDs used to construct its mission. General protected attributes still pass through the existing agent clearance/scope filter; this publication channel includes only authenticated reviews explicitly shared as execution instructions. Existing snapshots, sessions and running jobs are never rewritten. The context synchronizer also materializes prior approved review history when a new snapshot is created, with no new human approval invented. Oversized context fails with an explicit budget error rather than silently dropping decisions. Original Intent is unchanged.

## CI failure feedback and draft readiness

New deliveries create draft PRs. Configure `ORBIT_GITHUB_EVIDENCE_TOKEN` privately in `apps/api/.env.local` and restart both API and local consumer. Create a fine-grained GitHub PAT for only `susanwere/private-test` with Actions read, Pull requests read and Contents read. The delivery token retains its separate Contents/Pull requests write permissions. Neither token goes to Muse. GitHub setup: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens.

The local consumer runs a separate trusted CI/delivery subprocess without the Meta key. It periodically reads the latest PR workflow runs associated with the exact delivered head, including the canonical `CI` workflow. Pending/missing/unrelated CI never grants readiness. All observed workflows must pass. Oversized run history fails closed rather than silently excluding checks. External check providers are not treated as verified by this Actions observer. A green draft is marked ready through GitHub's `markPullRequestReadyForReview` mutation. An observed failure converts an open ready PR back to draft. This never merges or completes the ORBIT step. Independent merged-PR completion evidence remains mandatory.

The browser's **Check CI and failures** action retains head-bound run links and bounded/redacted failed-job/step labels. It does not ingest raw logs, invoke a model or supply GitHub credentials to Muse. Full logs remain on GitHub. **Authorize CI repair with Muse** records the human's repair authorization and archives the failed attempt; the existing retry/session/start/execute actions still control a fresh model run. The repair mission explicitly authorizes a bounded CI fix, rather than treating it as a design proposal awaiting another “go.” Diagnostic labels are untrusted data, never authority to change workflow checks or path grants.

The new session carries the original failed PR/job identity, approved project decisions and CI summary in a fresh immutable snapshot. Preparation clones the existing PR branch into a new disposable checkout and requires its HEAD to match the failed commit exactly. It never overwrites the old checkout. Delivery validates that pinned base and current PR identity, pushes without force to the same PR branch, and records the new commit on the new job. It does not create a second PR. A moved/merged/closed source PR requires reconciliation instead of an automatic overwrite. Repair lineage is bounded to 20 attempts.

A repair turn with no changed files has no fix to deliver. The browser displays **Authorize a fresh CI repair**; that action retires only the finished unproductive attempt and uses the same original failed PR lineage for another explicit session. The old response and snapshot remain unchanged. A repair cannot be designated a proposal to bypass the original code's CI requirement.
