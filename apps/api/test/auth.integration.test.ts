import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import { auditTypes, signUp } from "../src/test/factories.js";
import { verificationCodeFor } from "../src/test/factories.js";

let harness: TestHarness;
let client: ApiClient;
let verificationCode: string;

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
});

afterAll(async () => {
  await harness.close();
});

describe("auth", () => {
  it("signs up unverified, creates a workspace and returns a token", async () => {
    const response = await client.post<{
      user: { id: string; email: string; name: string; emailVerified: boolean };
      workspaceId: string;
      token: string;
      expiresAt: string;
      verificationRequired: boolean;
    }>("/v1/auth/signup", {
      email: "Founder@Example.com",
      password: "Sup3rSecret!",
      name: "Ada Founder",
    });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe("founder@example.com");
    expect(response.body.workspaceId).toMatch(/^wsp_/);
    expect(response.body.token).toBeTruthy();
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    expect(JSON.stringify(response.body)).not.toContain("Sup3rSecret");

    // The account exists but is not usable yet.
    expect(response.body.verificationRequired).toBe(true);
    expect(response.body.user.emailVerified).toBe(false);

    client.setToken(response.body.token);

    // The code is never in the response — it is only ever in the mail. Reading
    // it from the captured message is the same thing the user does.
    expect(JSON.stringify(response.body)).not.toContain("verificationCode");
    verificationCode = verificationCodeFor("founder@example.com");
    expect(verificationCode).toMatch(/^\d{6}$/);
  });

  it("emails the code and unlocks the account when it is entered", async () => {
    const mail = harness.mailbox().at(-1);
    expect(mail?.to).toBe("founder@example.com");
    expect(mail?.text).toContain(verificationCode);

    // Blocked until verified, and with a code the client can act on.
    const blocked = await client.get("/v1/subscriptions");
    expect(blocked.status).toBe(403);
    expect(expectErrorCode(blocked.body)).toBe("EMAIL_NOT_VERIFIED");

    const verified = await client.post<{ user: { emailVerified: boolean } }>("/v1/auth/verify", {
      email: "founder@example.com",
      code: verificationCode,
    });
    expect(verified.status).toBe(200);
    expect(verified.body.user.emailVerified).toBe(true);

    // The token the client already held now works — no re-login.
    expect((await client.get("/v1/subscriptions")).status).toBe(200);
  });

  it("rejects a duplicate email", async () => {
    const response = await client.post("/v1/auth/signup", {
      email: "founder@example.com",
      password: "Sup3rSecret!",
      name: "Impostor",
    });
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("CONFLICT");
  });

  it("rejects a weak password at the boundary", async () => {
    const response = await client.post("/v1/auth/signup", {
      email: "short@example.com",
      password: "abc",
      name: "Short",
    });
    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");
  });

  it("logs in with correct credentials", async () => {
    const response = await client.post<{ token: string; workspaceId: string }>("/v1/auth/login", {
      email: "founder@example.com",
      password: "Sup3rSecret!",
    });
    expect(response.status).toBe(200);
    expect(response.body.token).toBeTruthy();
    client.setToken(response.body.token);
  });

  it("refuses a wrong password without disclosing whether the user exists", async () => {
    const wrongPassword = await client.post("/v1/auth/login", {
      email: "founder@example.com",
      password: "not-the-password",
    });
    const noSuchUser = await client.post("/v1/auth/login", {
      email: "ghost@example.com",
      password: "not-the-password",
    });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(JSON.stringify(wrongPassword.body)).toBe(JSON.stringify(noSuchUser.body));
  });

  it("returns the user, workspace and settings from /v1/me", async () => {
    const response = await client.get<{
      user: { email: string };
      workspace: { id: string; role: string };
      settings: { approvalMode: string; killSwitch: boolean; spendCeiling: string; primaryChannel: string };
    }>("/v1/me");

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe("founder@example.com");
    expect(response.body.workspace.role).toBe("owner");
    expect(response.body.settings.approvalMode).toBe("always_ask");
    expect(response.body.settings.killSwitch).toBe(false);
    expect(response.body.settings.spendCeiling).toBe("50.00");
    expect(response.body.settings.primaryChannel).toBe("simulator");
  });

  it("rejects a missing, malformed or forged token", async () => {
    expect((await client.get("/v1/me", null)).status).toBe(401);
    expect((await client.get("/v1/me", "not-a-jwt")).status).toBe(401);

    const forged =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfZmFrZSIsIndzcCI6IndzcF9mYWtlIn0.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect((await client.get("/v1/me", forged)).status).toBe(401);
  });

  it("isolates workspaces: one user cannot see another's subscriptions", async () => {
    const alice = new ApiClient(harness.app);
    const bob = new ApiClient(harness.app);
    await signUp(alice, { email: "alice@example.com" });
    await signUp(bob, { email: "bob@example.com" });

    const created = await alice.post<{ subscription: { id: string } }>("/v1/subscriptions", {
      merchantName: "Notion",
      amount: "12.00",
      billingCycle: "monthly",
    });
    const id = created.body.subscription.id;

    expect((await bob.get(`/v1/subscriptions/${id}`)).status).toBe(404);
    expect((await bob.get<{ subscriptions: unknown[] }>("/v1/subscriptions")).body.subscriptions).toHaveLength(0);
    expect((await alice.get(`/v1/subscriptions/${id}`)).status).toBe(200);
  });

  it("logs out and writes the audit trail", async () => {
    const logout = await client.post("/v1/auth/logout");
    expect(logout.status).toBe(200);

    const types = await auditTypes(client);
    expect(types).toContain("auth.signup");
    expect(types).toContain("auth.login");
    expect(types).toContain("auth.logout");
  });
});

describe("health and meta", () => {
  it("reports health", async () => {
    const response = await client.get<{ ok: boolean; version: string; env: string }>("/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.env).toBe("test");
  });

  it("reports configuration as booleans only", async () => {
    const response = await client.get<Record<string, unknown>>("/v1/demo/status");
    expect(response.status).toBe(200);
    expect(response.body.llmConfigured).toBe(false);
    expect(response.body.pravaMode).toBe("disabled");
    // Mode and credentials are now reported independently: a key may well be
    // present in .env while the rail is switched off. `configured` used to be
    // satisfied by a mock mode too, so a wholly fabricated deployment reported
    // itself fully configured.
    expect(typeof response.body.pravaConfigured).toBe("boolean");
    expect(JSON.stringify(response.body)).not.toMatch(/sk_|pk_/);
  });

  it("sets security headers and a request id", async () => {
    const response = await client.get("/health");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns a structured error for an unknown route", async () => {
    const response = await client.get("/v1/nope");
    expect(response.status).toBe(404);
    expect(expectErrorCode(response.body)).toBe("NOT_FOUND");
  });
});
