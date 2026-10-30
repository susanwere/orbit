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
5. Provision an Orbit organization and human principal. Link the *trusted Google
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
- Sign-out clears the current browser token, and session expiration denies API
  calls. Browser sign-out does **not** revoke previously issued stateless tokens;
  server-side token revocation and renewal are follow-up production requirements.
- Configure HTTPS and restrict trusted frontend origins for production. The
  current API CORS configuration is permissive and must be hardened before
  exposure on a public origin.
- Use an approved OIDC application and configure accounts yourself. CI tests
  use simulated cryptographic keys and never provision a real Google account.
