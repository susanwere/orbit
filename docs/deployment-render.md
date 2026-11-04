# Render hackathon starter

This deployment deliberately hosts **the UI, Fastify API, PostgreSQL, and API's built-in event/context processors**. It **does not** deploy the Muse Code sandbox, disposable Git checkouts, delivery runner, or persistent uploaded documents. Do not represent those capabilities as hosted until separately verified. The blueprint is infrastructure configuration, not a tested live deployment.

## Deploy

1. Push/merge `render.yaml`; connect GitHub in [Render](https://dashboard.render.com/) and create **New → Blueprint** for this repository.
2. Render will create `orbit-demo-web`, `orbit-demo-api`, and `orbit-demo-db`. Check the resource plans before confirming. The free API sleeps after idle time; free PostgreSQL expires after 30 days. Free instances are for testing only.
3. Before the first static-site build, set:
   - `VITE_API_BASE_URL`: the full HTTPS origin shown by Render for `orbit-demo-api`, **without** trailing slash.
   - `VITE_GOOGLE_CLIENT_ID`: Google OAuth *web* client ID, if using Google.
4. Set API variables:
   - `ORBIT_WEB_ORIGINS`: exact frontend HTTPS origin (no trailing slash).
   - `MODEL_API_KEY`: Meta model API key (keep server-side).
   - `ORBIT_OIDC_AUDIENCE`: same Google web client ID as the frontend, if using Google.
   - Optionally `MODEL_API_BASE_URL` if the configured Meta endpoint requires it. Note that the application reads `MODEL_API_BASE_URL`, not `META_MODEL_API_BASE_URL`.
   - For GitHub events: `GITHUB_WEBHOOK_SECRET`, `ORBIT_ORGANIZATION_ID`, `ORBIT_PROJECT_ID`, `ORBIT_SYSTEM_PRINCIPAL_ID`; `ORBIT_GITHUB_EVIDENCE_TOKEN` for the read-only evidence flow. Configure these only with an intentionally authorized disposable demo project. The webhook receiver requires a matching signed GitHub webhook configuration.
   - `ORBIT_APP_URL` for email links, and the Resend settings only if you use that feature.
5. Deploy/redeploy the static site **after** setting its build-time Vite variables. Verify the API's `/health` endpoint and database migrations. Never paste keys into `render.yaml` or GitHub.
6. Google Console: authorize the frontend HTTPS origin for the correct OAuth web client. The current Google exchange route allows only **pre-linked** OIDC identities; it does not auto-register judges. Use the existing email/password signup for judge access or implement controlled Google registration separately.

## Important authentication caveat

ORBIT currently sets refresh cookies with `SameSite=Strict`. When the frontend and API are on separate `*.onrender.com` hostnames, the browser may treat the API as a different *site* and refuse to send the refresh cookie. For reliable production Google sign-in / session refresh, deploy under a common site you control (e.g., `orbit.example.com` and `api.orbit.example.com`) and verify sign-in/refresh in a clean browser. Merely changing Google OAuth credentials will **not** resolve cookie/site mismatches. Do not weaken refresh-cookie security as a deployment shortcut.

## Deliberate limitations

- API's own `server.ts` interval processes webhook, context refresh, decision analysis, and execution impact while the instance is awake. A free web service spins down on idle, so automatic webhook processing and retries are **not reliable** on Free. A paid always-on web service is recommended for live judging.
- Uploaded document storage is intentionally **not enabled**: `LocalDocumentStorage` has no persistent disk on Render Free, and the API disables uploads in production unless `ORBIT_DOCUMENT_STORAGE_DIR` is set. Use a separate durable object-storage integration before enabling public uploads.
- Muse Code execution and GitHub delivery are **not** hosted by this Blueprint. They require a trusted dispatcher, isolated worker, restricted checkout, isolated credentials, and explicit human approval. Do **not** run the local demo worker as an unrestricted public background service.
- Migrations run at service startup, so keep API instance count at one until migration deployment is separated.
- The published environment is not a full multi-user production environment. Restrict demo repository access and do not share personal Meta/GitHub credentials with judges.

## Verify before publishing the demo URL

- [ ] `/health` works over HTTPS
- [ ] Landing page loads after a hard refresh at a nested route
- [ ] Email signup/login, refresh, logout work in a clean private window
- [ ] Google login works only for explicitly linked account(s)
- [ ] Project reads/writes are tenant-isolated
- [ ] Real Muse Spark planning succeeds with a controlled demo project
- [ ] Webhook signature verification rejects invalid requests
- [ ] Logs show successful context refresh / impact events while API stays awake
- [ ] Muse Code/PR/CI only claimed as hosted if the separate sandboxed pipeline was deployed and tested
