# Orbit API authentication (ORB-42)

All project review, event stream and Why? routes require `Authorization: Bearer <JWT>`.
The public `/health` and signed GitHub webhook remain separate.

## Configuration
Set `ORBIT_AUTH_SECRET` (random high-entropy secret, at least 32 characters), `ORBIT_AUTH_ISSUER` (trusted token issuer), and `DATABASE_URL`. Protected routes are **disabled** if authentication is unconfigured. Never expose or commit the secret.

An explicitly trusted authentication backend must issue standard `HS256` JWTs with a `typ: JWT` header and claims `iss`, `aud: orbit-api`, `sub` (the Orbit principal ID), `organizationId`, `iat`, and `exp` (max one-hour lifetime). Rotate secrets operationally. The browser must never know the signing secret. Use short-lived tokens and HTTPS.

For the frontend, authenticate the user with the issuer, receive its short-lived Orbit API access token, then attach it as the bearer credential to REST, SSE (with a fetch-based EventSource client because native EventSource cannot set arbitrary Authorization headers) and provenance requests. Untrusted identity headers are ignored. Each backend service verifies project membership/role against PostgreSQL.

## Remaining production integration
This PR provides verification, not an identity provider, login UI, refresh-token rotation or token issuance. Wire a trusted provider into the token issuance flow and perform security review before any public deployment. Do not hand-issue tokens from browsers.
