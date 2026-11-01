import { createHash, randomBytes } from "node:crypto";
import type { SqlDatabase } from "@orbit/db";
import { DomainError } from "@orbit/domain";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const createToken = () => randomBytes(32).toString("base64url");
export const refreshLifetimeSeconds = 7 * 24 * 60 * 60;

/** Atomic consume-and-replace prevents concurrent reuse of a refresh credential. */
export class RefreshSessionService {
  constructor(private readonly database: SqlDatabase) {}

  async create(principalId: string): Promise<string> {
    const token = createToken();
    await this.database.query(
      `INSERT INTO auth_refresh_sessions (token_hash, principal_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [hashToken(token), principalId],
    );
    return token;
  }

  async rotate(token: string) {
    const replacementToken = createToken();
    const refreshedPrincipal = await this.database.query<{
      id: string;
      organization_id: string;
    }>(
      `WITH consumed AS (
         DELETE FROM auth_refresh_sessions WHERE token_hash = $1 AND expires_at > NOW()
         RETURNING principal_id, expires_at
       ), replacement AS (
         INSERT INTO auth_refresh_sessions (token_hash, principal_id, expires_at)
         SELECT $2, principal.id, consumed.expires_at FROM consumed
         JOIN principals principal ON principal.id = consumed.principal_id
         WHERE principal.type = 'human' AND principal.role IN ('admin', 'member', 'viewer')
           AND EXISTS (SELECT 1 FROM principal_oidc_identities WHERE principal_id = principal.id)
         RETURNING principal_id
       ) SELECT principal.id, principal.organization_id FROM replacement
         JOIN principals principal ON principal.id = replacement.principal_id`,
      [hashToken(token), hashToken(replacementToken)],
    );
    const principal = refreshedPrincipal.rows[0];
    if (!principal)
      throw new DomainError("unauthenticated", "Session expired. Please sign in again.");
    return { principal, token: replacementToken };
  }

  async revoke(token: string): Promise<void> {
    await this.database.query("DELETE FROM auth_refresh_sessions WHERE token_hash = $1", [
      hashToken(token),
    ]);
  }
}
