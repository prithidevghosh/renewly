import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitlistEntries } from "../src/db/schema.js";
import { env } from "../src/env.js";
import { setMailTransport, type OutboundEmail } from "../src/lib/mailer.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import { captureTransport } from "../src/test/doubles/mailer.js";

let harness: TestHarness;
let client: ApiClient;

interface WaitlistBody {
  waitlist: {
    email: string;
    position: number;
    alreadyJoined: boolean;
    mail: string;
    joinedAt: string;
  };
}

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
});

afterAll(async () => {
  await harness.close();
});

describe("waitlist", () => {
  it("runs against the mock mailer, never a real provider", () => {
    // If this ever reads "live", the suite is one bug away from mailing
    // strangers from a developer's .env. See src/test/setup.ts.
    expect(env.MAIL_OUTBOUND_MODE).toBe("disabled");
    expect(env.MAIL_OUTBOUND_API_KEY).toBeUndefined();
  });

  it("succeeds only after the row, the welcome and the notice are all done", async () => {
    const response = await client.post<WaitlistBody>("/v1/waitlist", {
      email: "  Founder@Example.COM ",
    });

    expect(response.status).toBe(201);
    expect(response.body.waitlist.email).toBe("founder@example.com");
    expect(response.body.waitlist.position).toBe(1);
    expect(response.body.waitlist.alreadyJoined).toBe(false);
    expect(response.body.waitlist.mail).toBe("sent");

    const [row] = await harness.handle.db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.email, "founder@example.com"));
    expect(row?.id).toMatch(/^wlt_/);
    expect(row?.mailStatus).toBe("sent");
    expect(row?.welcomeSentAt).toBeInstanceOf(Date);
    expect(row?.noticeSentAt).toBeInstanceOf(Date);
    expect(row?.mailError).toBeNull();

    // Welcome first, then the notice — the notice says the welcome landed.
    const [welcome, notice] = harness.mailbox();
    expect(harness.mailbox()).toHaveLength(2);
    expect(welcome?.to).toBe("founder@example.com");
    expect(welcome?.subject).toBe("You are on the Renewly waitlist");
    expect(notice?.to).toBe(env.WAITLIST_NOTIFY_TO);
    expect(notice?.subject).toBe("Waitlist · No. 1 · founder@example.com");
    expect(notice?.text).toContain("founder@example.com");
    // Replying to the notice reaches the person who signed up.
    expect(notice?.replyTo).toBe("founder@example.com");
  });

  it("treats a repeat address as idempotent and sends nothing further", async () => {
    const response = await client.post<WaitlistBody>("/v1/waitlist", {
      email: "founder@example.com",
    });

    expect(response.status).toBe(200);
    expect(response.body.waitlist.alreadyJoined).toBe(true);
    expect(response.body.waitlist.position).toBe(1);
    expect(harness.mailbox()).toHaveLength(2);

    const rows = await harness.handle.db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.email, "founder@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("rejects a malformed address without storing or sending anything", async () => {
    const response = await client.post("/v1/waitlist", { email: "not-an-address" });

    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");

    const rows = await harness.handle.db.select().from(waitlistEntries);
    expect(rows).toHaveLength(1);
    expect(harness.mailbox()).toHaveLength(2);
  });

  it("records name, source and referrer, and puts them in the notice", async () => {
    const response = await client.request<WaitlistBody>("POST", "/v1/waitlist", {
      body: { email: "ada@example.com", name: "Ada Lovelace", source: "landing-hero" },
      headers: { referer: "https://renewly.app/" },
    });

    expect(response.status).toBe(201);
    expect(response.body.waitlist.position).toBe(2);

    const [row] = await harness.handle.db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.email, "ada@example.com"));
    expect(row?.name).toBe("Ada Lovelace");
    expect(row?.source).toBe("landing-hero");
    expect(row?.referrer).toBe("https://renewly.app/");

    const notice = harness.mailbox().at(-1);
    expect(notice?.to).toBe(env.WAITLIST_NOTIFY_TO);
    expect(notice?.text).toContain("Ada Lovelace");
    expect(notice?.text).toContain("landing-hero");
    expect(notice?.text).toContain("https://renewly.app/");
    expect(notice?.text).toContain("No. 2");
  });

  it("fails the request when a mail cannot be sent, and keeps the row", async () => {
    // The welcome lands, the internal notice does not: a half-finished loop is
    // still a failure.
    const delivered: OutboundEmail[] = [];
    setMailTransport(async (email) => {
      if (email.to === env.WAITLIST_NOTIFY_TO) throw new Error("provider is down");
      delivered.push(email);
      return { id: "stub", mode: "transport" as const };
    });

    const failed = await client.post("/v1/waitlist", { email: "grace@example.com" });

    expect(failed.status).toBe(502);
    expect(expectErrorCode(failed.body)).toBe("CHANNEL_SEND_FAILED");
    expect(delivered.map((m) => m.to)).toEqual(["grace@example.com"]);

    const [stored] = await harness.handle.db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.email, "grace@example.com"));
    expect(stored?.mailStatus).toBe("failed");
    expect(stored?.mailError).toBe("provider is down");
    // How far it got, so the retry knows what is still owed.
    expect(stored?.welcomeSentAt).toBeInstanceOf(Date);
    expect(stored?.noticeSentAt).toBeNull();
  });

  it("resumes the loop on retry rather than repeating it", async () => {
    setMailTransport(captureTransport());
    const before = harness.mailbox().length;

    const retried = await client.post<WaitlistBody>("/v1/waitlist", { email: "grace@example.com" });

    expect(retried.status).toBe(200);
    expect(retried.body.waitlist.alreadyJoined).toBe(true);
    expect(retried.body.waitlist.mail).toBe("sent");
    // Position is unchanged by the failure: the row was never in doubt.
    expect(retried.body.waitlist.position).toBe(3);

    // Only the notice was owed, so only the notice was sent — no second
    // welcome to someone who already has one.
    const sent = harness.mailbox().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(env.WAITLIST_NOTIFY_TO);
    expect(sent[0]?.subject).toContain("grace@example.com");

    const [row] = await harness.handle.db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.email, "grace@example.com"));
    expect(row?.mailStatus).toBe("sent");
    expect(row?.noticeSentAt).toBeInstanceOf(Date);
    expect(row?.mailError).toBeNull();
  });

  it("needs no session", async () => {
    const response = await client.post<WaitlistBody>(
      "/v1/waitlist",
      { email: "anon@example.com" },
      null,
    );
    expect(response.status).toBe(201);
  });

  // Last: exhausting the limiter poisons the bucket for the rest of the file.
  it("rate limits a flood from one address", async () => {
    let limited: Awaited<ReturnType<typeof client.post>> | null = null;

    for (let i = 0; i < 25; i += 1) {
      const response = await client.post("/v1/waitlist", { email: `flood-${i}@example.com` });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(expectErrorCode(limited?.body)).toBe("RATE_LIMITED");
    expect(limited?.headers.get("retry-after")).toBeTruthy();
  });
});
