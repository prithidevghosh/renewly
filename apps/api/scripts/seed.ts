import { eq } from "drizzle-orm";
import { createDatabase, setDatabaseHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { subscriptions, users, workspaceSettings } from "../src/db/schema.js";
import { env } from "../src/env.js";
import { newId } from "../src/lib/id.js";
import { logger } from "../src/lib/logger.js";
import { signup } from "../src/modules/auth/service.js";
import { createApproval } from "../src/modules/approvals/service.js";
import { connectChannel } from "../src/modules/conversations/service.js";
import { notifyApproval } from "../src/modules/conversations/runtime.js";
import { CATALOG } from "../src/modules/decisions/catalog.js";
import { generateDecisionPackage } from "../src/modules/decisions/service.js";
import { inboundAddressFor } from "../src/modules/intake/mail/service.js";
import { seedMerchants } from "../src/modules/merchants/service.js";
import { resolveAuthContext } from "../src/modules/auth/service.js";
import { canonicalizeMerchant } from "../src/modules/subscriptions/service.js";
import { drainOutbox } from "../src/modules/workers/runner.js";

const DEMO_EMAIL = "demo@renewly.app";
const DEMO_PASSWORD = "Demo1234!";
const DEMO_HANDLE = "+15550100001";

/**
 * Sample subscriptions are off by default. A demo that opens with somebody
 * else's invented spend teaches the operator nothing; the point is to forward a
 * real renewal email and watch it come through the pipeline.
 *
 * SEED_DEMO_FLOW=true goes further and leaves the demo account with an open
 * approval sitting in the simulator thread, which is the fastest way to see the
 * message-to-payment loop without any external keys.
 */
async function main(): Promise<void> {
  const handle = createDatabase();
  setDatabaseHandle(handle);
  await runMigrations(handle);
  const db = handle.db;

  const merchantsSeeded = await seedMerchants(db);

  const [existing] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
  if (existing) {
    logger.info({ email: DEMO_EMAIL, merchantsSeeded }, "demo user already exists, leaving it alone");
    await handle.close();
    return;
  }

  const result = await signup(
    {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      name: "Demo Founder",
      workspaceName: "Renewly Demo",
    },
    db,
  );

  await db
    .update(workspaceSettings)
    .set({
      aiMonthlyBudget: "150.00",
      approvalMode: "ask_above_ceiling",
      spendCeiling: "50.00",
      categoryCeilings: { ai: "80.00", design: "60.00" },
      primaryChannel: "simulator",
      updatedAt: new Date(),
    })
    .where(eq(workspaceSettings.workspaceId, result.workspaceId));

  // The simulator channel is connected out of the box so the loop is runnable
  // immediately, with no phone number and no provider account.
  await connectChannel(
    {
      workspaceId: result.workspaceId,
      userId: result.user.id,
      channel: "simulator",
      externalId: DEMO_HANDLE,
      metadata: { seeded: true },
    },
    db,
  );

  const sampleIds: string[] = [];
  if (env.SEED_SAMPLE_SUBS || env.SEED_DEMO_FLOW) {
    const claudeId = newId("sub");
    const midjourneyId = newId("sub");
    sampleIds.push(claudeId, midjourneyId);

    await db.insert(subscriptions).values([
      {
        id: claudeId,
        workspaceId: result.workspaceId,
        merchantName: "Anthropic",
        merchantCanonical: canonicalizeMerchant("Anthropic"),
        planName: "Claude Pro",
        amount: "20.00",
        currency: "USD",
        billingCycle: "monthly" as const,
        nextRenewalAt: daysFromNow(12),
        criticality: "must_keep" as const,
        jobCategory: "ai",
        usageNote: "Used daily for drafting and code review.",
        sourceType: "manual" as const,
        seatsTotal: 1,
        fieldConfidence: { amount: 1, merchant_name: 1, next_renewal_at: 1 },
        confirmedAt: new Date(),
        lastSignalAt: new Date(),
      },
      {
        id: midjourneyId,
        workspaceId: result.workspaceId,
        merchantName: "Midjourney",
        merchantCanonical: canonicalizeMerchant("Midjourney"),
        planName: "Standard",
        amount: "30.00",
        currency: "USD",
        billingCycle: "monthly" as const,
        nextRenewalAt: daysFromNow(5),
        criticality: "experimental" as const,
        jobCategory: "design",
        usageNote: "Unused for 60 days since the brand work finished.",
        sourceType: "manual" as const,
        seatsTotal: 1,
        fieldConfidence: { amount: 1, merchant_name: 1, next_renewal_at: 1 },
        confirmedAt: new Date(),
        lastSignalAt: new Date(),
      },
    ]);
  }

  let openApprovalId: string | null = null;
  if (env.SEED_DEMO_FLOW && sampleIds[0]) {
    const auth = await resolveAuthContext(result.user.id, result.workspaceId, db);
    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sampleIds[0]));

    if (subscription) {
      const decision = await generateDecisionPackage({
        auth,
        subscription,
        regenerate: true,
        db,
      });

      if (decision.recommendation !== "snooze") {
        const { approval } = await createApproval({ auth, subscription, decision, db });
        const notified = await notifyApproval({ auth, approval, subscription, decision, db });
        // Deliver immediately so the thread is populated when the demo starts.
        await drainOutbox(db);
        openApprovalId = notified.approval.id;
      }
    }
  }

  logger.info(
    {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      workspaceId: result.workspaceId,
      inboundAddress: inboundAddressFor(result.workspaceId, env.MAIL_INBOUND_DOMAIN),
      simulatorHandle: DEMO_HANDLE,
      catalogTools: CATALOG.length,
      merchantsSeeded,
      sampleSubscriptions: env.SEED_SAMPLE_SUBS || env.SEED_DEMO_FLOW,
      openApprovalId,
      driver: handle.kind,
    },
    "seed complete",
  );

  await handle.close();
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "seed failed");
  process.exit(1);
});
