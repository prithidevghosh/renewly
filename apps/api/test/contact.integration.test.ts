import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/env.js";
import { setMailTransport } from "../src/lib/mailer.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import { captureTransport } from "../src/test/doubles/mailer.js";

let harness: TestHarness;
let client: ApiClient;

interface ContactBody {
  contact: {
    email: string;
    sentAt: string;
  };
}

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
});

afterAll(async () => {
  await harness.close();
});

describe("contact", () => {
  it("runs against a capture transport, never a real provider", () => {
    expect(env.MAIL_OUTBOUND_MODE).toBe("disabled");
    expect(env.MAIL_OUTBOUND_API_KEY).toBeUndefined();
  });

  it("mails the message and replies with the normalized address", async () => {
    const response = await client.post<ContactBody>("/v1/contact", {
      name: "  Ada Lovelace ",
      email: "  Ada@Example.COM ",
      message: "We renew Datadog in August.\nCan you take a look before then?",
    });

    expect(response.status).toBe(201);
    expect(response.body.contact.email).toBe("ada@example.com");
    expect(Date.parse(response.body.contact.sentAt)).not.toBeNaN();

    const mail = harness.mailbox().at(-1);
    expect(harness.mailbox()).toHaveLength(1);
    expect(mail?.to).toBe(env.CONTACT_NOTIFY_TO);
    expect(mail?.subject).toBe("Contact · Ada Lovelace · ada@example.com");
    expect(mail?.text).toContain("We renew Datadog in August.");
    expect(mail?.text).toContain("Can you take a look before then?");
    // Replying to the notice reaches the person who wrote in.
    expect(mail?.replyTo).toBe("ada@example.com");
  });

  it("stores nothing — the mail is the whole record", async () => {
    // The contact form owns no table; if that ever changes, this test is the
    // reminder to say so deliberately rather than by accident.
    const before = harness.mailbox().length;
    await client.post("/v1/contact", {
      name: "Grace Hopper",
      email: "grace@example.com",
      message: "Second message from a different sender.",
    });
    expect(harness.mailbox()).toHaveLength(before + 1);
  });

  it("rejects a malformed address without sending anything", async () => {
    const before = harness.mailbox().length;
    const response = await client.post("/v1/contact", {
      name: "Ada",
      email: "not-an-address",
      message: "Hello",
    });

    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");
    expect(harness.mailbox()).toHaveLength(before);
  });

  it("rejects an empty message and an empty name", async () => {
    const before = harness.mailbox().length;

    const noMessage = await client.post("/v1/contact", {
      name: "Ada",
      email: "ada@example.com",
      message: "   ",
    });
    expect(noMessage.status).toBe(400);

    const noName = await client.post("/v1/contact", {
      name: "",
      email: "ada@example.com",
      message: "Hello",
    });
    expect(noName.status).toBe(400);

    expect(harness.mailbox()).toHaveLength(before);
  });

  it("fails the request when the mail cannot be sent", async () => {
    setMailTransport(async () => {
      throw new Error("provider is down");
    });

    // Restored in `finally`, so a failed assertion cannot leave the broken
    // transport in place for every test after this one.
    try {
      const response = await client.post("/v1/contact", {
        name: "Ada Lovelace",
        email: "ada@example.com",
        message: "Anyone there?",
      });

      expect(response.status).toBe(502);
      expect(expectErrorCode(response.body)).toBe("CHANNEL_SEND_FAILED");
    } finally {
      setMailTransport(captureTransport());
    }
  });

  it("needs no session", async () => {
    const response = await client.post<ContactBody>(
      "/v1/contact",
      { name: "Anon", email: "anon@example.com", message: "Hello from a logged-out browser." },
      null,
    );
    expect(response.status).toBe(201);
  });

  // Last: exhausting the limiter poisons the bucket for the rest of the file.
  it("rate limits a flood from one address", async () => {
    let limited: Awaited<ReturnType<typeof client.post>> | null = null;

    for (let i = 0; i < 15; i += 1) {
      const response = await client.post("/v1/contact", {
        name: `Flood ${i}`,
        email: `flood-${i}@example.com`,
        message: "spam",
      });
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
