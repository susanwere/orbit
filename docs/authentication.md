# Orbit authentication setup

Orbit uses a Google OpenID Connect ID token as proof of identity and exchanges it with
the API for a short-lived Orbit access token. The client never signs JWTs.

## Configuration

1. In Google Cloud Console, create an OAuth 2.0 **Web application** client ID.
   Add the exact local and production frontend origins to the authorized JavaScript
   origins. Never put the Google client secret in the frontend.
2. Set `VITE_GOOGLE_CLIENT_ID` to that public client ID and `VITE_API_BASE_URL`
   to your Orbit API origin.
3. Configure the API's `ORBIT_OIDC_ISSUER=https://accounts.google.com`,
   `ORBIT_OIDC_AUDIENCE=<the same Google client ID>`,
   `ORBIT_OIDC_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs`.
4. Configure a randomly generated server-only `ORBIT_AUTH_SECRET` of at least
   32 characters and set `ORBIT_AUTH_ISSUER` to an issuer name under your control.
   Never reuse the Google client secret as the Orbit signing key.
5. Run `npm run db:migrate` before deploying the API (migration
   `022_refresh_sessions.sql` creates the server-managed sessions table). Set
   `ORBIT_WEB_ORIGINS` to a comma-separated list of exact permitted frontend
   origins, without trailing slashes. Local defaults are `http://localhost:5173`
   and `http://127.0.0.1:5173`; include other ports explicitly when needed.
   Set `NODE_ENV=production` behind HTTPS to enable Secure cookies.
6. Provision an Orbit organization and human principal. Link the *trusted Google
   subject* (not an unverified email address) to that principal in
   `principal_oidc_identities`:

   ```sql
   INSERT INTO principal_oidc_identities (issuer, subject, principal_id)
   VALUES ('https://accounts.google.com', '<verified-Google-sub>', '<existing-Orbit-principal-id>');
   ```

The API denies unlinked identities instead of auto-creating privileged accounts.
The app remains in public preview mode if `VITE_GOOGLE_CLIENT_ID` is unset;
project creation cannot be called without an authorized session.

## Local API startup and environment loading

From the repository root run `npm run dev:api`. The workspace script runs in
`apps/api` and automatically loads the optional repository-root `.env.local`,
followed by optional `apps/api/.env.local`. Values in the API-specific file
override values from the root file; values already exported in your shell take
precedence over both. The script uses Node.js 22.9+ built-in environment-file
support and needs no dotenv dependency.

Ensure the five `ORBIT_AUTH_*` and `ORBIT_OIDC_*` variables above are set.
Missing identity configuration prevents `POST /auth/exchange` from registering.
Keep local environment files untracked; never commit signing secrets or API keys.

## Security boundaries

- Only the backend verifies the Google token signature, issuer, audience, and expiry.
- Orbit API tokens are short lived (default 15 minutes), scoped to an existing
  human principal and organization, and stored in browser memory rather than
  localStorage.
- The browser restores sessions using an opaque HttpOnly, SameSite=Strict cookie
  scoped to `/auth`; production uses a Secure cookie with the `__Secure-` prefix.
  Frontend and API must share the same site and scheme (for example
  `app.example.com` and `api.example.com`). Locally, use `localhost` for both or
  `127.0.0.1` for both; mixing the two prevents cookie delivery. The client uses
  credentialed fetch; CORS allows only `ORBIT_WEB_ORIGINS`.
- Refresh credentials contain 256 random bits and only their SHA-256 hashes are
  persisted. Each refresh atomically consumes and replaces the credential without
  extending its seven-day absolute expiry. Reuse, expiry, deleted principals and
  removed identity links are rejected. Database-backed sessions survive API restarts.
- Renewal runs one minute before token expiry and when a background tab becomes
  visible. Requests within a tab share one refresh; Web Locks serialize cookie
  operations across tabs where supported. Transient renewal failures retry every
  ten seconds without granting access with expired tokens. Initial restoration
  failures show an explicit retry state instead of prompting Google repeatedly.
- Sign-out revokes the refresh credential before clearing local identity. A failed
  logout shows a retry error. Account exchange revokes the previous browser cookie.
  Already-issued stateless bearer tokens remain valid for at most their original
  15-minute lifetime; this change does not add an immediate access-token denylist.
- Refresh/logout require a custom request header and validate supplied Origin;
  authentication responses use `Cache-Control: no-store`. Refresh returns 401 for
  missing, expired or revoked sessions. Project 403 responses retain the session;
  project 401 responses retain the existing stale-account protection.
- To revoke a user's refresh sessions administratively, delete from
  `auth_refresh_sessions` using their `principal_id`. Periodically remove rows
  where `expires_at <= NOW()` as routine database maintenance. No scheduler or
  infrastructure is required for expiry enforcement.
- Use an approved OIDC application and configure accounts yourself. CI tests
  use simulated cryptographic keys and never provision a real Google account.

## Verification

Run the root format, typecheck, test and build commands. Set `TEST_DATABASE_URL`
to an isolated migrated PostgreSQL database to include refresh rotation/replay,
expiry, logout, application restart, concurrent refresh, identity removal, and
origin/CSRF integration tests alongside existing tenant-isolation tests.

For the focused mocked browser journey, install Playwright in your test environment
and its Chromium browser (`npx playwright install chromium`), start Vite on port
5174 with a public test `VITE_GOOGLE_CLIENT_ID` and
`VITE_API_BASE_URL=http://127.0.0.1:4000`, then run
`node scripts/auth-session-browser-smoke.mjs`. Screenshots are saved under
`/tmp/orbit-auth-smoke`. The test simulates Google and API responses; it does not
verify real Google credentials. Live approved-account verification is still required
for ORB-64 before declaring deployment verification complete.

This implementation follows ORB-68 and the session lifecycle follow-up to ORB-54,
with deployment verification tracked in ORB-64.
