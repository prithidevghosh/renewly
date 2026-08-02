import type { ChannelName } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { LinqChannelAdapter } from "./linq/adapter.js";
import type { ChannelAdapter } from "./types.js";

/**
 * Adapters are constructed lazily and cached: a live adapter validates its keys
 * in the constructor, so building both eagerly would make a workspace that uses
 * only one of them fail to boot.
 */
const cache = new Map<ChannelName, ChannelAdapter>();

export function getChannelAdapter(channel: ChannelName): ChannelAdapter {
  const cached = cache.get(channel);
  if (cached) return cached;

  // The simulator has no implementation outside the test doubles. A workspace
  // still carrying it as its channel gets an error naming the problem, rather
  // than an in-process thread that looks delivered and reached nobody.
  if (channel === "simulator") {
    throw new AppError(
      "FEATURE_DISABLED",
      "The simulator channel is a test instrument and is not available at runtime. " +
        "Connect iMessage with real credentials to receive approvals.",
      { channel },
    );
  }

  // WhatsApp was removed. The enum value survives because existing rows still
  // reference it and dropping a Postgres enum member means rewriting the type;
  // nothing can send through it.
  if (channel === "whatsapp") {
    throw new AppError("FEATURE_DISABLED", "WhatsApp is no longer supported as a channel.", {
      channel,
    });
  }

  const adapter: ChannelAdapter = new LinqChannelAdapter();
  cache.set(channel, adapter);
  return adapter;
}

/** Tests install a double; passing null restores the env-derived adapter. */
export function setChannelAdapter(channel: ChannelName, adapter: ChannelAdapter | null): void {
  if (adapter) cache.set(channel, adapter);
  else cache.delete(channel);
}

export function resetChannelAdapters(): void {
  cache.clear();
}

export function assertKnownChannel(value: string): ChannelName {
  if (value === "imessage" || value === "whatsapp" || value === "simulator") return value;
  throw new AppError("VALIDATION_ERROR", `Unknown channel: ${value}`, { channel: value });
}
