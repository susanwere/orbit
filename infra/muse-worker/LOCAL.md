# Orbit Muse local queue smoke test (ORB-72)

**Developer-only disposable repository test. Not a production sandbox.**

The execution and GitHub delivery phases run as **separate processes and separate containers**. Muse execution gets META_API_KEY but no GitHub token. Delivery gets a repository-scoped GitHub token but no Muse key. Orbit's database holds only approved jobs and verified state. Neither Compose profile provisions a checkout or dispatches jobs.

## Build without running

From Orbit's root:
```sh
export ORBIT_DISPOSABLE_CHECKOUT="$HOME/Desktop/private-test" # adjust to real absolute path
docker compose -f docker-compose.yml -f infra/muse-worker/compose.local.yml \
  --profile muse-smoke build muse-worker
```

## Execution, AFTER an approved job is queued

The following runs actual Muse Code. Only use an initialized **disposable** test checkout containing no secrets. The working tree must match the approved Execution Contract. Load the Meta key into your shell privately (do not paste it into chat). Do **not** export the GitHub token in this terminal.

```sh
docker compose -f docker-compose.yml -f infra/muse-worker/compose.local.yml \
  --profile muse-smoke run --rm muse-worker
```

The CLI result `TURN_FINISHED` is NOT verified success. Find the job ID in the authorized Orbit job records. Run the delivery container **only after confirming the job ID, workspace, and allowed paths**.

## Delivery, only after a real Muse turn finished

Use a separate shell with the restricted GitHub token, and `unset META_API_KEY`. Set the exact job ID:

```sh
export ORBIT_WORKER_JOB_ID=musejob_<actual-uuid>
docker compose -f docker-compose.yml -f infra/muse-worker/compose.delivery.yml \
  --profile muse-delivery run --rm muse-delivery
```

The delivery process checks the persisted job, execution contract and modified files before creating a PR. Verify its actual GitHub Actions run via Orbit's authenticated `verify-github-ci` endpoint. Never label a CLI exit, unverified PR, or local build as completed CI.

## Remaining security limitations

- Credentials are separated **between** two processes, but the Muse CLI still receives its Meta API key, and Docker Compose alone does not prevent reading files in its writable checkout.
- Docker default egress remains unrestricted, despite contract `network_policy=none`. This scaffold is not suitable for untrusted code. A properly network-restricted brokered execution architecture is still required.
- Delivery inherits only the supplied checkout. The current architecture has no robust separate file-policy mount provisioner, even though GitHub delivery checks changed paths before committing.
- The GitHub token is exposed to its delivery process, not to the Muse execution container. Do not mount secrets, SSH agents or Docker socket. The delivery container may still execute Git hooks; run against a trusted clean checkout.
- The Muse installer is fetched during image build and is not pinned or checksum-verified.
- No automatic checkout, queued-job submission, or complete PostgreSQL→PR→CI E2E test has been performed with this scaffold.

**Do not use for arbitrary third-party repositories, sensitive source, production jobs, or public multi-tenant workloads.**
