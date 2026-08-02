import { env, pravaApiBase } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { HttpPravaClient, type PravaClient } from "./pravaClient.js";

let client: PravaClient | null = null;

/**
 * The payment rail, or a refusal.
 *
 * There is no in-process stand-in to fall back to. A charge that reports
 * success while no money moved is the worst thing this system can do, so when
 * PRAVA_MODE is `disabled` the answer is an error naming the reason, raised
 * before anything in the payment path runs.
 */
export function getPravaClient(): PravaClient {
  // An installed client wins over the mode. Only a test can install one, and
  // checking the mode first would make the injection unreachable.
  if (client) return client;

  if (env.PRAVA_MODE === "disabled") {
    throw new AppError(
      "FEATURE_DISABLED",
      "Payments are turned off on this deployment. Set PRAVA_MODE to sandbox or " +
        "live and supply PRAVA_SECRET_KEY to enable them.",
    );
  }

  if (!client) {
    client = new HttpPravaClient({ mode: env.PRAVA_MODE });
    logger.info({ mode: env.PRAVA_MODE, baseUrl: pravaApiBase() }, "prava client ready");
  }
  return client;
}

/** Tests install their own client; passing null restores the env default. */
export function setPravaClient(next: PravaClient | null): void {
  client = next;
}
