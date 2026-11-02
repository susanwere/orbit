import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { SqlDatabase } from "@orbit/db";
import { DomainError } from "@orbit/domain";
import { RefreshSessionService, refreshLifetimeSeconds } from "./refresh-session-service.js";
import { OrbitAccessTokenIssuer } from "./orbit-access-token.js";
import {
  createEmailToken,
  hashEmailToken,
  validEmailToken,
  hashNewPassword,
  type VerificationEmailService,
} from "./email-token-service.js";

const scrypt = promisify(scryptCallback);
const loginError = () => new DomainError("unauthenticated", "Invalid email or password.");
const normalizeEmail = (value: unknown): string => {
  if (typeof value !== "string")
    throw new DomainError("validation", "Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new DomainError("validation", "Enter a valid email address.");
  return email;
};
function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || Buffer.byteLength(value) > 1024)
    throw new DomainError("validation", "Password must have at least 12 characters.");
}
async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const fields = stored.split(":");
  if (
    fields.length !== 3 ||
    fields[0] !== "scrypt" ||
    !/^[0-9a-f]{32}$/.test(fields[1] ?? "") ||
    !/^[0-9a-f]{128}$/.test(fields[2] ?? "")
  )
    return false;
  const expected = Buffer.from(fields[2]!, "hex");
  const actual = (await scrypt(password, fields[1]!, 64)) as Buffer;
  return timingSafeEqual(actual, expected);
}
interface Account extends Record<string, unknown> {
  principal_id: string;
  organization_id: string;
  password_hash: string;
  email_verified_at: string | null;
}
export interface EmailPasswordOptions {
  database: SqlDatabase;
  tokenIssuer: OrbitAccessTokenIssuer;
  allowedOrigins: readonly string[];
  secureCookies: boolean;
  emailService?: VerificationEmailService;
}
export async function registerEmailPasswordRoutes(
  app: FastifyInstance,
  options: EmailPasswordOptions,
) {
  const sessions = new RefreshSessionService(options.database);
  const cookieName = options.secureCookies ? "__Secure-orbit_refresh" : "orbit_refresh";
  const sessionCookie = (token: string) =>
    `${cookieName}=${token}; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=${refreshLifetimeSeconds}${options.secureCookies ? "; Secure" : ""}`;
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (origin && !options.allowedOrigins.includes(origin))
      throw new DomainError("forbidden", "Untrusted authentication origin.");
    if (request.headers["x-orbit-session"] !== "1")
      throw new DomainError("forbidden", "Session request header required.");
  });
  const issueSession = async (
    principalId: string,
    organizationId: string,
    reply: { header: (key: string, value: string) => unknown },
  ) => {
    const token = await sessions.create(principalId);
    reply.header("Set-Cookie", sessionCookie(token));
    return {
      ...options.tokenIssuer.issue({ id: principalId, organizationId }),
      principalId,
      organizationId,
    };
  };
  app.post<{ Body: { email?: unknown; password?: unknown } }>(
    "/auth/email/signup",
    async (request, reply) => {
      if (!options.emailService)
        throw new DomainError(
          "promotion_unavailable",
          "Email verification delivery is not configured.",
        );
      const email = normalizeEmail(request.body?.email);
      validatePassword(request.body?.password);
      const password = request.body.password;
      const hashed = await hashPassword(password);
      const organizationId = `org_${randomUUID()}`;
      const principalId = `principal_${randomUUID()}`;
      try {
        await options.database.transaction(async (tx) => {
          await tx.query("INSERT INTO organizations(id,name) VALUES ($1,$2)", [
            organizationId,
            "Personal workspace",
          ]);
          await tx.query(
            "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES ($1,$2,'human',$3,'admin')",
            [principalId, organizationId, email],
          );
          await tx.query(
            "INSERT INTO auth_password_accounts(principal_id,email,password_hash) VALUES($1,$2,$3)",
            [principalId, email, hashed],
          );
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        )
          throw new DomainError("validation", "An account with this email already exists.");
        throw error;
      }
      const token = await createEmailToken(options.database, principalId, "verify");
      await options.emailService!.send(email, "verify", token);
      return reply.code(201).send({ message: "Check your email for a verification link." });
    },
  );
  app.post<{ Body: { email?: unknown; password?: unknown } }>(
    "/auth/email/login",
    async (request, reply) => {
      const email = normalizeEmail(request.body?.email);
      if (
        typeof request.body?.password !== "string" ||
        Buffer.byteLength(request.body.password) > 1024
      )
        throw loginError();
      const attempts = await options.database.query<{ blocked: boolean } & Record<string, unknown>>(
        "SELECT (blocked_until > NOW()) AS blocked FROM auth_login_attempts WHERE email=$1",
        [email],
      );
      if (attempts.rows[0]?.blocked) throw loginError();
      const result = await options.database.query<Account>(
        `SELECT a.principal_id,p.organization_id,a.password_hash,a.email_verified_at FROM auth_password_accounts a
       JOIN principals p ON p.id=a.principal_id
       WHERE a.email=$1 AND p.type='human' AND p.role IN ('admin','member','viewer')`,
        [email],
      );
      const account = result.rows[0];
      const valid = await verifyPassword(
        request.body.password,
        account?.password_hash ?? (await hashPassword("dummy-password-not-valid")),
      );
      if (!account || !valid) {
        await options.database.query(
          `INSERT INTO auth_login_attempts(email,attempts,blocked_until) VALUES($1,1,NULL)
         ON CONFLICT(email) DO UPDATE SET
           attempts=CASE WHEN auth_login_attempts.last_attempt_at < NOW()-INTERVAL '15 minutes' THEN 1 ELSE auth_login_attempts.attempts+1 END,
           last_attempt_at=NOW(),
           blocked_until=CASE WHEN auth_login_attempts.attempts >= 4 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END`,
          [email],
        );
        throw loginError();
      }
      if (!account.email_verified_at)
        throw new DomainError("forbidden", "Verify your email before signing in.");
      await options.database.query("DELETE FROM auth_login_attempts WHERE email=$1", [email]);
      return issueSession(account.principal_id, account.organization_id, reply);
    },
  );
  app.post<{ Body: { token?: unknown } }>("/auth/email/verify", async (request) => {
    const token = request.body?.token;
    if (!validEmailToken(token)) throw new DomainError("validation", "Invalid verification link.");
    const result = await options.database.transaction(async (tx) => {
      const used = await tx.query<{ principal_id: string } & Record<string, unknown>>(
        `DELETE FROM auth_email_tokens
         WHERE token_hash=$1 AND purpose='verify' AND expires_at>NOW()
         RETURNING principal_id`,
        [hashEmailToken(token)],
      );
      if (!used.rows[0])
        throw new DomainError("validation", "Verification link expired or already used.");
      await tx.query(
        "UPDATE auth_password_accounts SET email_verified_at=NOW() WHERE principal_id=$1",
        [used.rows[0].principal_id],
      );
      return true;
    });
    return { verified: result };
  });
  app.post<{ Body: { email?: unknown } }>("/auth/email/resend-verification", async (request) => {
    const email = normalizeEmail(request.body?.email);
    const account = await options.database.query<
      { principal_id: string } & Record<string, unknown>
    >(
      "SELECT principal_id FROM auth_password_accounts WHERE email=$1 AND email_verified_at IS NULL",
      [email],
    );
    if (account.rows[0] && options.emailService) {
      const recent = await options.database.query<Record<string, unknown>>(
        "SELECT 1 FROM auth_email_tokens WHERE principal_id=$1 AND purpose='verify' AND created_at > NOW() - INTERVAL '60 seconds'",
        [account.rows[0].principal_id],
      );
      if (!recent.rows[0]) {
        const token = await createEmailToken(
          options.database,
          account.rows[0].principal_id,
          "verify",
        );
        await options.emailService.send(email, "verify", token);
      }
    }
    return { message: "If the address is awaiting verification, we have sent a new link." };
  });
  app.post<{ Body: { email?: unknown } }>("/auth/email/forgot-password", async (request) => {
    const email = normalizeEmail(request.body?.email);
    const account = await options.database.query<
      { principal_id: string } & Record<string, unknown>
    >("SELECT principal_id FROM auth_password_accounts WHERE email=$1", [email]);
    if (account.rows[0] && options.emailService) {
      const recent = await options.database.query<Record<string, unknown>>(
        "SELECT 1 FROM auth_email_tokens WHERE principal_id=$1 AND purpose='reset' AND created_at > NOW() - INTERVAL '60 seconds'",
        [account.rows[0].principal_id],
      );
      if (!recent.rows[0]) {
        const token = await createEmailToken(
          options.database,
          account.rows[0].principal_id,
          "reset",
        );
        await options.emailService.send(email, "reset", token);
      }
    }
    return { message: "If the account exists, a password reset link has been sent." };
  });
  app.post<{ Body: { token?: unknown; password?: unknown } }>(
    "/auth/email/reset-password",
    async (request) => {
      const token = request.body?.token;
      if (!validEmailToken(token)) throw new DomainError("validation", "Invalid reset link.");
      validatePassword(request.body?.password);
      const hashed = await hashNewPassword(request.body.password);
      await options.database.transaction(async (tx) => {
        const used = await tx.query<{ principal_id: string } & Record<string, unknown>>(
          `DELETE FROM auth_email_tokens WHERE token_hash=$1 AND purpose='reset' AND expires_at>NOW()
         RETURNING principal_id`,
          [hashEmailToken(token)],
        );
        if (!used.rows[0])
          throw new DomainError("validation", "Reset link expired or already used.");
        await tx.query(
          "UPDATE auth_password_accounts SET password_hash=$2,updated_at=NOW() WHERE principal_id=$1",
          [used.rows[0].principal_id, hashed],
        );
        await tx.query("DELETE FROM auth_email_tokens WHERE principal_id=$1", [
          used.rows[0].principal_id,
        ]);
        await tx.query("DELETE FROM auth_refresh_sessions WHERE principal_id=$1", [
          used.rows[0].principal_id,
        ]);
      });
      return { reset: true };
    },
  );
}
