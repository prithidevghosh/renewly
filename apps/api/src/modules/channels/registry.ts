import type { ChannelName } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { LinqChannelAdapter } from "./linq/adapter.js";
import { SimulatorChannelAdapter } from "./simulator/adapter.js";
import { WhatsAppChannelAdapter } from "./whatsapp/adapter.js";
import type { ChannelAdapter } from "./types.js";

/**
 * Adapters are constructed lazily and cached: a live adapter validates its keys
 * in the constructor, so building all three eagerly would make a workspace that
 * only uses the simulator fail to boot.
 */
const cache = new Map<ChannelName, ChannelAdapter>();

export function getChannelAdapter(channel: ChannelName): ChannelAdapter {
  const cached = cache.get(channel);
  if (cached) return cached;

  const adapter: ChannelAdapter =
    channel === "simulator"
      ? new SimulatorChannelAdapter()
      : channel === "imessage"
        ? new LinqChannelAdapter()
        : new WhatsAppChannelAdapter();

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
