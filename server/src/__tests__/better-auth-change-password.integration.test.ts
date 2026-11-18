/**
 * The Settings > Profile "Change password" form calls Better Auth's documented
 * endpoint and nothing else:
 *   POST /api/auth/change-password { currentPassword, newPassword, revokeOtherSessions: true }
 *   https://better-auth.com/docs/authentication/email-password#update-password
 *   https://better-auth.com/docs/concepts/session-management (revokeOtherSessions)
 *
 * This suite drives that call through the real Better Auth mount, the real
 * auth config (`createBetterAuthInstance`) and a migrated Postgres, and proves
 * what the person changing a fleet-generated password relies on: the change
 * succeeds, the old password stops working, the new one works, every other
 * session is signed out, and the browser that made the change stays signed in.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const EMAIL = "owner@example.com";
const OLD_PASSWORD = "fleet-generated-vault-password";
const NEW_PASSWORD = "owner-chosen-password";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

function sessionCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find((value) => value.includes("session_token=") && !value.includes("session_token=;"));
  expect(cookie, "a session cookie").toBeTruthy();
  return cookie!.split(";")[0]!;
}

describeEmbeddedPostgres("Better Auth change-password against the real auth config", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-change-password-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-change-password-");
    const db = createDb(database.connectionString);
    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  async function signIn(password: string) {
    return request(app).post("/api/auth/sign-in/email").set("origin", ORIGIN).send({ email: EMAIL, password });
  }

  async function sessionUserEmail(cookie: string) {
    const res = await request(app).get("/api/auth/get-session").set("origin", ORIGIN).set("cookie", cookie);
    expect(res.status).toBe(200);
    return (res.body as { user?: { email?: string } } | null)?.user?.email ?? null;
  }

  it("changes the password, rejects the old one and signs out only the other sessions", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: OLD_PASSWORD, name: "Owner" });
    expect(signUp.status).toBe(200);

    const thisBrowser = sessionCookie(await signIn(OLD_PASSWORD));
    const otherDevice = sessionCookie(await signIn(OLD_PASSWORD));
    expect(await sessionUserEmail(otherDevice)).toBe(EMAIL);

    const wrong = await request(app)
      .post("/api/auth/change-password")
      .set("origin", ORIGIN)
      .set("cookie", thisBrowser)
      .send({ currentPassword: "not-the-password", newPassword: NEW_PASSWORD, revokeOtherSessions: true });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: "INVALID_PASSWORD" });
    expect(await sessionUserEmail(otherDevice)).toBe(EMAIL);

    const changed = await request(app)
      .post("/api/auth/change-password")
      .set("origin", ORIGIN)
      .set("cookie", thisBrowser)
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true });
    expect(changed.status).toBe(200);
    expect(changed.body?.user?.email).toBe(EMAIL);

    // This browser stays signed in on the replacement cookie Better Auth sets.
    const replacement = sessionCookie(changed);
    expect(await sessionUserEmail(replacement)).toBe(EMAIL);
    // Every other session, including the old cookie of the other device, is gone.
    expect(await sessionUserEmail(otherDevice)).toBeNull();

    const oldPassword = await signIn(OLD_PASSWORD);
    expect(oldPassword.status).toBe(401);
    expect(oldPassword.body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });

    const newPassword = await signIn(NEW_PASSWORD);
    expect(newPassword.status).toBe(200);
    expect(newPassword.body?.user?.email).toBe(EMAIL);
  });
});
