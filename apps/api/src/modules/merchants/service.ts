import { and, eq, isNull, or } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { merchants, type Merchant } from "../../db/schema.js";
import { newId } from "../../lib/id.js";
import { canonicalizeMerchant } from "../subscriptions/service.js";

/**
 * The merchant graph. A card descriptor ("ANTHROPIC*CLAUDE.AI SUBSCR"), a
 * receipt sender ("Anthropic") and a typed name ("Claude") are the same vendor;
 * without a place for that to be true, every intake source creates a duplicate
 * subscription and the ledger double counts.
 */

/** Seeded into every workspace's lookup path. Aliases are pre-canonicalised. */
export const MERCHANT_SEEDS: Array<{
  canonicalName: string;
  aliases: string[];
  website: string;
  cancelUrl: string;
}> = [
  {
    canonicalName: "Anthropic",
    aliases: ["anthropic", "anthropic claude ai", "claude", "claude ai", "claude pro"],
    website: "https://claude.ai",
    cancelUrl: "https://claude.ai/settings/billing",
  },
  {
    canonicalName: "OpenAI",
    aliases: ["openai", "chatgpt", "chatgpt plus", "open ai"],
    website: "https://openai.com",
    cancelUrl: "https://chatgpt.com/#settings/Subscription",
  },
  {
    canonicalName: "Midjourney",
    aliases: ["midjourney", "midjourney basic", "midjourney standard"],
    website: "https://www.midjourney.com",
    cancelUrl: "https://www.midjourney.com/account",
  },
  {
    canonicalName: "Notion",
    aliases: ["notion", "notion labs", "notion plus"],
    website: "https://www.notion.so",
    cancelUrl: "https://www.notion.so/my-settings/billing",
  },
  {
    canonicalName: "Figma",
    aliases: ["figma", "figma professional"],
    website: "https://www.figma.com",
    cancelUrl: "https://www.figma.com/settings",
  },
  {
    canonicalName: "GitHub",
    aliases: ["github", "github team", "github copilot", "microsoft github"],
    website: "https://github.com",
    cancelUrl: "https://github.com/settings/billing",
  },
  {
    canonicalName: "Linear",
    aliases: ["linear", "linear basic", "linear app"],
    website: "https://linear.app",
    cancelUrl: "https://linear.app/settings/billing",
  },
  {
    canonicalName: "Vercel",
    aliases: ["vercel", "vercel pro"],
    website: "https://vercel.com",
    cancelUrl: "https://vercel.com/account/billing",
  },
  {
    canonicalName: "Slack",
    aliases: ["slack", "slack pro", "slack technologies"],
    website: "https://slack.com",
    cancelUrl: "https://slack.com/admin/billing",
  },
  {
    canonicalName: "Canva",
    aliases: ["canva", "canva pro"],
    website: "https://www.canva.com",
    cancelUrl: "https://www.canva.com/settings/billing",
  },
  {
    canonicalName: "Zoom",
    aliases: ["zoom", "zoom video", "zoom us"],
    website: "https://zoom.us",
    cancelUrl: "https://zoom.us/billing",
  },
  {
    canonicalName: "Atlassian",
    aliases: ["atlassian", "jira", "confluence"],
    website: "https://www.atlassian.com",
    cancelUrl: "https://admin.atlassian.com",
  },
];

export async function seedMerchants(db: Database = getDb()): Promise<number> {
  const existing = await db.select().from(merchants).where(isNull(merchants.workspaceId));
  if (existing.length > 0) return 0;

  await db.insert(merchants).values(
    MERCHANT_SEEDS.map((seed) => ({
      id: newId("mch"),
      workspaceId: null,
      canonicalName: seed.canonicalName,
      aliases: seed.aliases,
      website: seed.website,
      cancelUrl: seed.cancelUrl,
    })),
  );
  return MERCHANT_SEEDS.length;
}

/**
 * Resolves a raw merchant string to a canonical row, preferring a
 * workspace-local override over the shared catalog. Never invents a row for the
 * global catalog: unknown vendors become workspace-local so one user's typo
 * cannot pollute everyone else's graph.
 */
export async function resolveMerchant(
  workspaceId: string,
  rawName: string,
  db: Database = getDb(),
): Promise<Merchant | null> {
  const canonical = canonicalizeMerchant(rawName);
  if (!canonical) return null;

  const rows = await db
    .select()
    .from(merchants)
    .where(or(eq(merchants.workspaceId, workspaceId), isNull(merchants.workspaceId)));

  // Workspace-local rows win over the shared catalog.
  const ordered = [...rows].sort((a, b) => (a.workspaceId ? -1 : 1) - (b.workspaceId ? -1 : 1));

  const exact = ordered.find(
    (row) =>
      canonicalizeMerchant(row.canonicalName) === canonical ||
      (row.aliases ?? []).includes(canonical),
  );
  if (exact) return exact;

  // Partial: a statement descriptor often carries the brand plus noise.
  const words = canonical.split(" ").filter((word) => word.length >= 3);
  const partial = ordered.find((row) => {
    const target = canonicalizeMerchant(row.canonicalName);
    if (words.includes(target)) return true;
    return (row.aliases ?? []).some((alias) => {
      const aliasWords = alias.split(" ").filter((w) => w.length >= 3);
      return aliasWords.length > 0 && aliasWords.every((w) => words.includes(w));
    });
  });

  return partial ?? null;
}

/** Resolves, creating a workspace-local row when the vendor is unknown. */
export async function resolveOrCreateMerchant(
  workspaceId: string,
  rawName: string,
  db: Database = getDb(),
): Promise<Merchant | null> {
  const found = await resolveMerchant(workspaceId, rawName, db);
  if (found) return found;

  const canonical = canonicalizeMerchant(rawName);
  if (!canonical) return null;

  const [created] = await db
    .insert(merchants)
    .values({
      id: newId("mch"),
      workspaceId,
      canonicalName: rawName.trim(),
      aliases: [canonical],
      website: null,
      cancelUrl: null,
    })
    .returning();

  return created ?? null;
}

/** Adds a newly seen spelling so the next sighting resolves on the exact path. */
export async function learnAlias(
  merchantId: string,
  rawName: string,
  db: Database = getDb(),
): Promise<void> {
  const canonical = canonicalizeMerchant(rawName);
  if (!canonical) return;

  const [row] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
  if (!row || (row.aliases ?? []).includes(canonical)) return;

  await db
    .update(merchants)
    .set({ aliases: [...(row.aliases ?? []), canonical] })
    .where(eq(merchants.id, merchantId));
}

export interface CancelUrlResolution {
  url: string | null;
  /** True when the URL came from the graph rather than being absent. */
  verified: boolean;
}

export async function resolveCancelUrl(
  workspaceId: string,
  merchantCanonical: string,
  db: Database = getDb(),
): Promise<CancelUrlResolution> {
  const merchant = await resolveMerchant(workspaceId, merchantCanonical, db);
  if (merchant?.cancelUrl) return { url: merchant.cancelUrl, verified: true };
  return { url: null, verified: false };
}

export async function listMerchants(
  workspaceId: string,
  db: Database = getDb(),
): Promise<Merchant[]> {
  return db
    .select()
    .from(merchants)
    .where(or(eq(merchants.workspaceId, workspaceId), isNull(merchants.workspaceId)));
}

export async function getMerchant(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<Merchant | null> {
  const [row] = await db
    .select()
    .from(merchants)
    .where(
      and(
        eq(merchants.id, id),
        or(eq(merchants.workspaceId, workspaceId), isNull(merchants.workspaceId)),
      ),
    );
  return row ?? null;
}
