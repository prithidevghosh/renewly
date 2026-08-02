import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxConnections } from "../src/db/schema.js";
import { decryptSecret } from "../src/lib/crypto.js";
import { resetMailboxClients } from "../src/modules/mailbox/mock.js";
import {
  accessTokenFor,
  activeConnection,
  fetchReceipts,
  getConnection,
} from "../src/modules/mailbox/service.js";
import { signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * Mailbox consent, token custody and reading receipts. Runs on the mock client,
 * which serves the repository's real email fixtures — so this exercises the
 * same parsing surface the detect pipeline will consume.
 */

let harness: TestHarness;
let client: ApiClient;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  const user = await signUp(client);
  workspaceId = user.workspaceId;
  userId = user.userId;
});

beforeEach(() => {
  resetMailboxClients();
});

afterAll(async () => {
  await harness.close();
});

interface ConnectionShape {
  id: string;
  provider: string;
  emailAddress: string;
  status: string;
  lastSyncAt: string | null;
}

/** Walks the consent redirect the way a browser would. */
async function connect(
  provider: "gmail" | "outlook",
  address = `demo@${provider}.example.com`,
): Promise<ConnectionShape> {
  const start = await harness.app.request(
    `http://localhost/v1/mailbox/connect/${provider}`,
    {
      headers: { authorization: `Bearer ${client.getToken()!}` },
      redirect: "manual",
    },
  );
  expect(start.status).toBe(302);

  const cookie = start.headers.get("set-cookie") ?? "";
  const flow = JSON.parse(
    decodeURIComponent(cookie.match(/renewly_mailbox=([^;]+)/)![1]!),
  ) as { state: string };

  const callback = await harness.app.request(
    `http://localhost/v1/mailbox/callback/${provider}?state=${flow.state}&code=${encodeURIComponent(`mock:${provider}:${address}`)}`,
    { headers: { cookie }, redirect: "manual" },
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toContain("mailbox=connected");

  const list = await client.get<{ connections: ConnectionShape[] }>("/v1/mailbox");
  return list.body.connections.find((row) => row.emailAddress === address)!;
}

describe("mailbox consent", () => {
  it("connects a Gmail mailbox and reports the granted address", async () => {
    const connection = await connect("gmail", "founder@gmail.example.com");

    expect(connection.provider).toBe("gmail");
    expect(connection.emailAddress).toBe("founder@gmail.example.com");
    expect(connection.status).toBe("active");
  });

  it("connects Outlook alongside Gmail", async () => {
    await connect("outlook", "founder@outlook.example.com");

    const list = await client.get<{ connections: ConnectionShape[] }>("/v1/mailbox");
    expect(list.body.connections.map((c) => c.provider).sort()).toContain("outlook");
  });

  it("stores tokens encrypted, never in the clear", async () => {
    const connection = await connect("gmail", "sealed@gmail.example.com");

    const [row] = await harness.handle.db
      .select()
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, connection.id));

    expect(row!.accessToken).toBeTruthy();
    expect(row!.accessToken).not.toContain("mock-mailbox-access");
    expect(decryptSecret(row!.accessToken!)).toContain("mock-mailbox-access");
    expect(decryptSecret(row!.refreshToken!)).toContain("mock-mailbox-refresh");
  });

  it("reconnecting the same address updates in place rather than duplicating", async () => {
    const first = await connect("gmail", "repeat@gmail.example.com");
    const second = await connect("gmail", "repeat@gmail.example.com");

    expect(second.id).toBe(first.id);

    const rows = await harness.handle.db
      .select()
      .from(mailboxConnections)
      .where(eq(mailboxConnections.emailAddress, "repeat@gmail.example.com"));
    expect(rows).toHaveLength(1);
  });

  it("rejects a callback whose state does not match", async () => {
    const start = await harness.app.request("http://localhost/v1/mailbox/connect/gmail", {
      headers: { authorization: `Bearer ${client.getToken()!}` },
      redirect: "manual",
    });
    const cookie = start.headers.get("set-cookie") ?? "";

    const response = await harness.app.request(
      "http://localhost/v1/mailbox/callback/gmail?state=forged&code=mock:gmail:x@example.com",
      { headers: { cookie }, redirect: "manual" },
    );
    expect(response.status).toBe(401);
  });

  it("treats a declined consent as an answer, not a failure", async () => {
    const start = await harness.app.request("http://localhost/v1/mailbox/connect/gmail", {
      headers: { authorization: `Bearer ${client.getToken()!}` },
      redirect: "manual",
    });
    const cookie = start.headers.get("set-cookie") ?? "";

    const response = await harness.app.request(
      "http://localhost/v1/mailbox/callback/gmail?error=access_denied",
      { headers: { cookie }, redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("mailbox_error=access_denied");
  });

  it("requires authentication to start consent", async () => {
    const anonymous = await harness.app.request("http://localhost/v1/mailbox/connect/gmail", {
      redirect: "manual",
    });
    expect(anonymous.status).toBe(401);
  });

  it("refuses an unknown provider", async () => {
    const response = await harness.app.request("http://localhost/v1/mailbox/connect/yahoo", {
      headers: { authorization: `Bearer ${client.getToken()!}` },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });
});

describe("reading receipts", () => {
  it("returns receipt-shaped mail from the window", async () => {
    const connection = await connect("gmail", "receipts@gmail.example.com");

    const response = await client.get<{
      count: number;
      monthsBack: number;
      receipts: Array<{ subject: string | null; from: string | null; receivedAt: string | null }>;
    }>(`/v1/mailbox/${connection.id}/receipts?months=120`);

    expect(response.status).toBe(200);
    expect(response.body.count).toBeGreaterThan(0);
    // The mock serves the real fixtures, so these are genuine renewal notices.
    expect(response.body.receipts.some((r) => /renew|receipt/i.test(r.subject ?? ""))).toBe(true);
  });

  it("honours the date window", async () => {
    const connection = await getConnection(
      workspaceId,
      (await connect("gmail", "window@gmail.example.com")).id,
    );

    const wide = await fetchReceipts({ connection, monthsBack: 240 });
    // Fixtures are dated 2026; a one-month window ending long after excludes them.
    const narrow = await fetchReceipts({
      connection,
      monthsBack: 1,
      now: new Date("2030-01-01T00:00:00Z"),
    });

    expect(wide.length).toBeGreaterThan(0);
    expect(narrow.length).toBe(0);
  });

  it("records the sync time so the sweep knows when it last looked", async () => {
    const connection = await connect("gmail", "synced@gmail.example.com");
    await client.get(`/v1/mailbox/${connection.id}/receipts?months=120`);

    const list = await client.get<{ connections: ConnectionShape[] }>("/v1/mailbox");
    const row = list.body.connections.find((c) => c.id === connection.id)!;
    expect(row.lastSyncAt).toBeTruthy();
  });

  it("exposes the newest connection as the one a detect run should read", async () => {
    await connect("gmail", "latest@gmail.example.com");
    const chosen = await activeConnection(workspaceId);
    expect(chosen).not.toBeNull();
    expect(chosen!.status).toBe("active");
  });
});

describe("token lifecycle", () => {
  it("refreshes an expired access token rather than failing", async () => {
    const connection = await connect("gmail", "expiring@gmail.example.com");

    await harness.handle.db
      .update(mailboxConnections)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(mailboxConnections.id, connection.id));

    const row = await getConnection(workspaceId, connection.id);
    const token = await accessTokenFor(row);

    // The mock mints a distinguishable token on refresh.
    expect(token).toContain("mock-mailbox-refreshed");

    const after = await getConnection(workspaceId, connection.id);
    expect(after.status).toBe("active");
    expect(after.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("asks for reconnection when there is no usable refresh token", async () => {
    const connection = await connect("gmail", "norefresh@gmail.example.com");

    await harness.handle.db
      .update(mailboxConnections)
      .set({ expiresAt: new Date(Date.now() - 60_000), refreshToken: null })
      .where(eq(mailboxConnections.id, connection.id));

    const row = await getConnection(workspaceId, connection.id);
    await expect(accessTokenFor(row)).rejects.toMatchObject({ code: "CHANNEL_NOT_CONNECTED" });

    // And the connection says so, rather than looking healthy.
    const after = await getConnection(workspaceId, connection.id);
    expect(after.status).toBe("error");
    expect(after.lastError).toBeTruthy();
  });

  it("drops the keys when a connection is revoked", async () => {
    const connection = await connect("gmail", "revoked@gmail.example.com");

    const response = await client.delete<{ connection: ConnectionShape }>(
      `/v1/mailbox/${connection.id}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.connection.status).toBe("revoked");

    const [row] = await harness.handle.db
      .select()
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, connection.id));

    // A revocation that leaves a working refresh token is a revocation in name only.
    expect(row!.accessToken).toBeNull();
    expect(row!.refreshToken).toBeNull();
  });
});

describe("isolation", () => {
  it("will not show or revoke another workspace's mailbox", async () => {
    const connection = await connect("gmail", "private@gmail.example.com");

    const intruder = new ApiClient(harness.app);
    await signUp(intruder, { email: `mailbox-intruder-${Date.now()}@example.com` });

    expect((await intruder.get("/v1/mailbox")).body).toMatchObject({ connections: [] });
    expect((await intruder.get(`/v1/mailbox/${connection.id}/receipts`)).status).toBe(404);
    expect((await intruder.delete(`/v1/mailbox/${connection.id}`)).status).toBe(404);
  });
});
