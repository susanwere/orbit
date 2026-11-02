import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";

const scrypt = promisify(scryptCallback);
export const hashEmailToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newEmailToken = () => randomBytes(32).toString("base64url");
export const validEmailToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export async function hashNewPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024)
    throw new DomainError("validation", "Password must be at least 12 characters.");
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}

export interface VerificationEmailService {
  send(email: string, kind: "verify" | "reset", token: string): Promise<void>;
}

/** Resend is optional locally, but required for public email signup. No tokens in logs. */
export class ResendVerificationEmailService implements VerificationEmailService {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly appUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!this.apiKey || !this.from || !/^https:\/\//.test(this.appUrl))
      throw new Error("Configure verified email delivery and an HTTPS application URL.");
  }
  async send(email: string, kind: "verify" | "reset", token: string): Promise<void> {
    const route = kind === "verify" ? "verify-email" : "reset-password";
    const link = new URL(this.appUrl);
    link.searchParams.set("auth_action", route);
    link.searchParams.set("token", token);
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from, to: [email],
        subject: kind === "verify" ? "Verify your Orbit email" : "Reset your Orbit password",
        text: `Open this link to ${kind === "verify" ? "verify your email" : "reset your password"}:\n${link.toString()}\n\nIf you did not request this, ignore this email.`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new DomainError("email_delivery_failed", "Could not send the email. Try again later.");
  }
}

export async function createEmailToken(
  db: SqlDatabase,
  principalId: string,
  purpose: "verify" | "reset",
): Promise<string> {
  const token = newEmailToken();
  await db.query(
    `WITH cleared AS (
      DELETE FROM auth_email_tokens WHERE principal_id=$1 AND purpose=$2
    ) INSERT INTO auth_email_tokens(token_hash,principal_id,purpose,expires_at)
      VALUES($3,$1,$2,NOW() + ($4 * INTERVAL '1 minute'))`,
    [principalId, purpose, hashEmailToken(token), purpose === "verify" ? 60 * 24 : 30],
  );
  return token;
}
