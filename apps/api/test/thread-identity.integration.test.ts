import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureThread,
  isPlaceholderThreadId,
  placeholderThreadId,
} from "../src/modules/conversations/service.js";
import { signUpWithChannel } from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * One person on one channel is one conversation.
 *
 * The proposal has to be addressed before the provider has told us what it
 * calls the chat, so outbound opens on a placeholder and the reply comes back
 * carrying Linq's real chat id. Keying threads on that id alone produced two
 * rows for the same conversation — and because approvals hang off the outbound
 * one, every reply read as "there is nothing waiting for approval right now".
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

const NUMBER = "+919352238571";

/**
 * A provider id is globally unique, and the index on
 * (channel, channel_thread_id) enforces that — so each case needs its own.
 */
let providerIds = 0;
const providerId = () => `chat_${(providerIds += 1)}_${Date.now().toString(36)}`;

async function workspace(): Promise<string> {
  const client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client);
  return user.workspaceId;
}

describe("thread identity", () => {
  it("treats a placeholder and the provider's id as the same conversation", async () => {
    const workspaceId = await workspace();

    const outbound = await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: placeholderThreadId(workspaceId, "imessage", NUMBER),
      participantExternalId: NUMBER,
    });

    const inbound = await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: providerId(),
      participantExternalId: NUMBER,
    });

    expect(inbound.id).toBe(outbound.id);
  });

  it("adopts the provider's id once it is known", async () => {
    const workspaceId = await workspace();

    await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: placeholderThreadId(workspaceId, "imessage", NUMBER),
      participantExternalId: NUMBER,
    });

    const real = providerId();
    const adopted = await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: real,
      participantExternalId: NUMBER,
    });

    expect(adopted.channelThreadId).toBe(real);
    expect(isPlaceholderThreadId(adopted.channelThreadId)).toBe(false);
  });

  it("never replaces a real id with a placeholder", async () => {
    const workspaceId = await workspace();

    const real = providerId();
    await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: real,
      participantExternalId: NUMBER,
    });

    const again = await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: placeholderThreadId(workspaceId, "imessage", NUMBER),
      participantExternalId: NUMBER,
    });

    expect(again.channelThreadId).toBe(real);
  });

  it("keeps different people apart", async () => {
    const workspaceId = await workspace();

    const mine = await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: placeholderThreadId(workspaceId, "imessage", NUMBER),
      participantExternalId: NUMBER,
    });
    const theirs = await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: placeholderThreadId(workspaceId, "imessage", "+15550001111"),
      participantExternalId: "+15550001111",
    });

    expect(theirs.id).not.toBe(mine.id);
  });

  it("keeps the same person on different channels apart", async () => {
    const workspaceId = await workspace();

    const imessage = await ensureThread({
      workspaceId,
      channel: "imessage",
      channelThreadId: placeholderThreadId(workspaceId, "imessage", NUMBER),
      participantExternalId: NUMBER,
    });
    const simulator = await ensureThread({
      workspaceId,
      channel: "simulator",
      channelThreadId: placeholderThreadId(workspaceId, "simulator", NUMBER),
      participantExternalId: NUMBER,
    });

    expect(simulator.id).not.toBe(imessage.id);
  });

  it("keeps the same number in different workspaces apart", async () => {
    const first = await workspace();
    const second = await workspace();

    const a = await ensureThread({
      workspaceId: first,
      channel: "imessage",
      channelThreadId: placeholderThreadId(first, "imessage", NUMBER),
      participantExternalId: NUMBER,
    });
    const b = await ensureThread({
      workspaceId: second,
      channel: "imessage",
      channelThreadId: providerId(),
      participantExternalId: NUMBER,
    });

    expect(b.id).not.toBe(a.id);
  });
});

describe("isPlaceholderThreadId", () => {
  it("recognises the ids we mint ourselves", () => {
    expect(isPlaceholderThreadId("linq_thread_+91123")).toBe(true);
    expect(isPlaceholderThreadId("sim_thread_+91123")).toBe(true);
    expect(isPlaceholderThreadId("wa_thread_+91123")).toBe(true);
  });

  it("does not mistake a provider id for one", () => {
    expect(isPlaceholderThreadId("e1e288af-a97b-4d14-aca0-533c35f59a7f")).toBe(false);
    expect(isPlaceholderThreadId("chat_abc123")).toBe(false);
  });
});
