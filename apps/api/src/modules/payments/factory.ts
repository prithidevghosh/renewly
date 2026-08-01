import { env, pravaApiBase } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { HttpPravaClient, type PravaClient } from "./pravaClient.js";
import { MockPravaClient } from "./pravaMock.js";

let client: PravaClient | null = null;

export function getPravaClient(): PravaClient {
  if (!client) {
    client =
      env.PRAVA_MODE === "mock"
        ? new MockPravaClient()
        : new HttpPravaClient({ mode: env.PRAVA_MODE });
    logger.info(
      { mode: env.PRAVA_MODE, baseUrl: env.PRAVA_MODE === "mock" ? "in-process" : pravaApiBase() },
      "prava client ready",
    );
  }
  return client;
}

/** Tests install their own client; passing null restores the env default. */
export function setPravaClient(next: PravaClient | null): void {
  client = next;
}
