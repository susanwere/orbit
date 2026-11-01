import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { buildApp } from "../src/app.js";
import type { AuthExchangeOptions } from "../src/modules/auth/auth-exchange-routes.js";
import { OrbitAccessTokenIssuer } from "../src/modules/auth/orbit-access-token.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("persistent browser sessions (PostgreSQL)", () => {
  let database: PgDatabase;
  let authExchangeOptions: AuthExchangeOptions;
  let application: Awaited<ReturnType<typeof buildApp>>;
  const organizationId = randomUUID();
  const principalId = randomUUID();
  const headers = { origin: "http://localhost:5173", "x-orbit-session": "1" };
  const cookieHeader = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0] ?? "";
  const login = () =>
    application.inject({
      method: "POST",
      url: "/auth/exchange",
      headers,
      payload: { idToken: "verified-by-test-adapter" },
    });
  const refresh = (cookie: string) =>
    application.inject({ method: "POST", url: "/auth/refresh", headers: { ...headers, cookie } });
  beforeAll(async () => {
    database = new PgDatabase(databaseUrl!);
    await database.query("INSERT INTO organizations (id,name) VALUES ($1,'Session tests')", [
      organizationId,
    ]);
    await database.query(
      "INSERT INTO principals (id,organization_id,type,display_name,role) VALUES ($1,$2,'human','Session user','member')",
      [principalId, organizationId],
    );
    await database.query(
      "INSERT INTO principal_oidc_identities (issuer,subject,principal_id) VALUES ('test-issuer',$1,$1)",
      [principalId],
    );
    authExchangeOptions = {
      database,
      allowedOrigins: [headers.origin],
      identityVerifier: { verify: async () => ({ issuer: "test-issuer", subject: principalId }) },
      tokenIssuer: new OrbitAccessTokenIssuer({
        secret: "test-session-signing-secret-at-least-32-characters",
        issuer: "orbit",
        audience: "orbit-api",
      }),
    };
    application = await buildApp({ authExchange: authExchangeOptions });
  });
  afterAll(async () => {
    await application?.close();
    if (database) {
      await database.query("DELETE FROM principals WHERE id = $1", [principalId]);
      await database.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await database.close();
    }
  });
  it("issues secure cookies and renews through a new application instance; old credentials cannot replay", async () => {
    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict");
    expect(signedIn.headers["set-cookie"]).toContain("Secure");
    expect(signedIn.headers["cache-control"]).toBe("no-store");
    const cookie = cookieHeader(signedIn);
    await application.close();
    application = await buildApp({ authExchange: authExchangeOptions });
    const renewed = await refresh(cookie);
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toMatchObject({ principalId, organizationId });
    expect(cookieHeader(renewed)).not.toBe(cookie);
    expect((await refresh(cookie)).statusCode).toBe(401);
    const logout = await application.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { ...headers, cookie: cookieHeader(renewed) },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await refresh(cookieHeader(renewed))).statusCode).toBe(401);
  });
  it("rejects expired sessions without extending their absolute lifetime", async () => {
    const signedIn = await login();
    const cookie = cookieHeader(signedIn);
    const tokenHash = createHash("sha256")
      .update(cookie.slice(cookie.indexOf("=") + 1))
      .digest("hex");
    await database.query(
      "UPDATE auth_refresh_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = $1",
      [tokenHash],
    );
    expect((await refresh(cookie)).statusCode).toBe(401);
  });
  it("allows only one concurrent rotation", async () => {
    const cookie = cookieHeader(await login());
    const responses = await Promise.all([refresh(cookie), refresh(cookie)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  });
  it("rejects untrusted origins and missing CSRF headers before reading credentials", async () => {
    expect(
      (
        await application.inject({
          method: "POST",
          url: "/auth/refresh",
          headers: { origin: "https://attacker.example", "x-orbit-session": "1" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await application.inject({
          method: "POST",
          url: "/auth/refresh",
          headers: { origin: headers.origin },
        })
      ).statusCode,
    ).toBe(403);
    expect((await refresh("")).statusCode).toBe(401);
  });
  it("revokes the previous browser session on account exchange", async () => {
    const cookie = cookieHeader(await login());
    const replacement = await application.inject({
      method: "POST",
      url: "/auth/exchange",
      headers: { ...headers, cookie },
      payload: { idToken: "verified-by-test-adapter" },
    });
    expect(replacement.statusCode).toBe(200);
    expect((await refresh(cookie)).statusCode).toBe(401);
  });
  it("denies renewal after identity access is removed", async () => {
    const cookie = cookieHeader(await login());
    await database.query("DELETE FROM principal_oidc_identities WHERE principal_id = $1", [
      principalId,
    ]);
    expect((await refresh(cookie)).statusCode).toBe(401);
  });
});
