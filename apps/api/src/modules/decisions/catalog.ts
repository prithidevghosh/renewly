import { annualize, cmp, mul } from "../../lib/money.js";
import { canonicalizeMerchant } from "../subscriptions/service.js";

/**
 * Curated tool catalog. The LLM may only propose alternatives from this list,
 * with these prices — that is the whole point of curating it. Prices are
 * indicative list prices in USD per seat per month and will drift; they are a
 * planning input, not a quote.
 */

export type CatalogCategory =
  | "ai_assistant"
  | "ai_image"
  | "design"
  | "docs"
  | "dev_tools"
  | "hosting"
  | "project_management"
  | "communication"
  | "analytics";

export interface CatalogTool {
  slug: string;
  name: string;
  category: CatalogCategory;
  /** Indicative list price per seat per month, USD. */
  monthlyPrice: string;
  /** Per-seat price when billed annually, USD per month equivalent. */
  annualMonthlyPrice: string | null;
  freeTier: boolean;
  note: string;
  switchFriction: "low" | "medium" | "high";
  pros: string[];
  cons: string[];
}

export const CATALOG: CatalogTool[] = [
  {
    slug: "claude-pro",
    name: "Claude Pro",
    category: "ai_assistant",
    monthlyPrice: "20.00",
    annualMonthlyPrice: "17.00",
    freeTier: true,
    note: "Anthropic's consumer assistant tier.",
    switchFriction: "low",
    pros: ["Strong long-context reasoning", "Free tier covers light use"],
    cons: ["Usage limits on the Pro tier under heavy load"],
  },
  {
    slug: "chatgpt-plus",
    name: "ChatGPT Plus",
    category: "ai_assistant",
    monthlyPrice: "20.00",
    annualMonthlyPrice: null,
    freeTier: true,
    note: "OpenAI's consumer assistant tier.",
    switchFriction: "low",
    pros: ["Broad tool ecosystem", "Free tier covers light use"],
    cons: ["No annual discount"],
  },
  {
    slug: "github-copilot",
    name: "GitHub Copilot",
    category: "dev_tools",
    monthlyPrice: "10.00",
    annualMonthlyPrice: "8.33",
    freeTier: true,
    note: "In-editor code completion and chat.",
    switchFriction: "low",
    pros: ["Cheapest per-seat coding assistant", "Free tier for limited use"],
    cons: ["Weaker at multi-file refactors than agentic tools"],
  },
  {
    slug: "cursor-pro",
    name: "Cursor Pro",
    category: "dev_tools",
    monthlyPrice: "20.00",
    annualMonthlyPrice: "16.00",
    freeTier: true,
    note: "Agentic code editor.",
    switchFriction: "medium",
    pros: ["Whole-repo edits", "Bundles multiple model providers"],
    cons: ["Editor switch has a learning cost"],
  },
  {
    slug: "midjourney-basic",
    name: "Midjourney Basic",
    category: "ai_image",
    monthlyPrice: "10.00",
    annualMonthlyPrice: "8.00",
    freeTier: false,
    note: "Entry image generation tier, roughly 200 images a month.",
    switchFriction: "low",
    pros: ["Lowest Midjourney tier", "Same model as higher tiers"],
    cons: ["No relax mode", "Hard generation cap"],
  },
  {
    slug: "midjourney-standard",
    name: "Midjourney Standard",
    category: "ai_image",
    monthlyPrice: "30.00",
    annualMonthlyPrice: "24.00",
    freeTier: false,
    note: "Adds unlimited relax-mode generation.",
    switchFriction: "low",
    pros: ["Unlimited relax generations"],
    cons: ["Three times the Basic price"],
  },
  {
    slug: "figma-professional",
    name: "Figma Professional",
    category: "design",
    monthlyPrice: "15.00",
    annualMonthlyPrice: "12.00",
    freeTier: true,
    note: "Per full seat; viewers are free.",
    switchFriction: "high",
    pros: ["Industry default for handoff", "Free viewer seats"],
    cons: ["Seat count creeps as the team grows"],
  },
  {
    slug: "penpot",
    name: "Penpot",
    category: "design",
    monthlyPrice: "0.00",
    annualMonthlyPrice: null,
    freeTier: true,
    note: "Open-source design tool, self-hostable.",
    switchFriction: "high",
    pros: ["No licence cost", "Open file format"],
    cons: ["Smaller plugin ecosystem", "Migration effort is real"],
  },
  {
    slug: "notion-plus",
    name: "Notion Plus",
    category: "docs",
    monthlyPrice: "12.00",
    annualMonthlyPrice: "10.00",
    freeTier: true,
    note: "Per seat; the free tier is generous for small teams.",
    switchFriction: "medium",
    pros: ["Free tier fits teams under about five people", "Annual saves 17 percent"],
    cons: ["Search degrades in large workspaces"],
  },
  {
    slug: "coda",
    name: "Coda",
    category: "docs",
    monthlyPrice: "12.00",
    annualMonthlyPrice: "10.00",
    freeTier: true,
    note: "Docs with embedded tables and automations; overlaps Notion's job.",
    switchFriction: "medium",
    pros: ["Stronger built-in tables and automations", "Free tier for small docs"],
    cons: ["Per-doc-maker pricing surprises teams", "Smaller template ecosystem"],
  },
  {
    slug: "linear-basic",
    name: "Linear Basic",
    category: "project_management",
    monthlyPrice: "8.00",
    annualMonthlyPrice: "6.67",
    freeTier: true,
    note: "Per seat issue tracker.",
    switchFriction: "medium",
    pros: ["Free tier up to 250 issues", "Fast"],
    cons: ["Free tier issue cap arrives quickly"],
  },
  {
    slug: "github-team",
    name: "GitHub Team",
    category: "dev_tools",
    monthlyPrice: "4.00",
    annualMonthlyPrice: "3.67",
    freeTier: true,
    note: "Per seat; free for public repositories.",
    switchFriction: "high",
    pros: ["Cheap per seat", "Free for open source"],
    cons: ["Advanced security features are Enterprise-only"],
  },
  {
    slug: "vercel-pro",
    name: "Vercel Pro",
    category: "hosting",
    monthlyPrice: "20.00",
    annualMonthlyPrice: null,
    freeTier: true,
    note: "Per seat plus usage.",
    switchFriction: "medium",
    pros: ["Zero-config deploys", "Hobby tier covers side projects"],
    cons: ["Usage overages are billed separately"],
  },
  {
    slug: "netlify-pro",
    name: "Netlify Pro",
    category: "hosting",
    monthlyPrice: "19.00",
    annualMonthlyPrice: null,
    freeTier: true,
    note: "Comparable static and edge hosting.",
    switchFriction: "medium",
    pros: ["Similar feature set to Vercel Pro"],
    cons: ["Framework integrations lag for Next.js"],
  },
  {
    slug: "slack-pro",
    name: "Slack Pro",
    category: "communication",
    monthlyPrice: "8.75",
    annualMonthlyPrice: "7.25",
    freeTier: true,
    note: "Per active seat.",
    switchFriction: "high",
    pros: ["Free tier retains 90 days of history"],
    cons: ["Billed per active member, so cost tracks headcount"],
  },
  {
    slug: "plausible-growth",
    name: "Plausible Growth",
    category: "analytics",
    monthlyPrice: "9.00",
    annualMonthlyPrice: "7.50",
    freeTier: false,
    note: "Privacy-first analytics, priced by pageviews.",
    switchFriction: "low",
    pros: ["No cookie banner required", "Cheap at low traffic"],
    cons: ["Fewer funnels than a full product-analytics suite"],
  },
];

const BY_CANONICAL = new Map<string, CatalogTool>();
for (const tool of CATALOG) {
  BY_CANONICAL.set(canonicalizeMerchant(tool.name), tool);
}

/** Best-effort catalog match for a merchant string from a receipt or statement. */
export function findCatalogTool(merchantName: string): CatalogTool | null {
  const canonical = canonicalizeMerchant(merchantName);
  if (!canonical) return null;

  const exact = BY_CANONICAL.get(canonical);
  if (exact) return exact;

  // "Anthropic" should reach "Claude Pro"; "Midjourney" should reach a
  // Midjourney tier. Match on any shared word of three or more characters.
  const words = canonical.split(" ").filter((w) => w.length >= 3);
  for (const tool of CATALOG) {
    const toolWords = canonicalizeMerchant(tool.name).split(" ");
    if (words.some((word) => toolWords.includes(word))) return tool;
  }

  const brandAliases: Record<string, string> = {
    anthropic: "claude-pro",
    openai: "chatgpt-plus",
    "chat gpt": "chatgpt-plus",
    microsoft: "github-copilot",
  };
  for (const [alias, slug] of Object.entries(brandAliases)) {
    if (canonical.includes(alias)) return CATALOG.find((t) => t.slug === slug) ?? null;
  }

  return null;
}

export function findBySlug(slug: string): CatalogTool | null {
  return CATALOG.find((tool) => tool.slug === slug) ?? null;
}

/**
 * Cheaper tools in the same category, plus the annual-billing variant of the
 * tool itself when one exists.
 */
export function cheaperAlternatives(
  tool: CatalogTool | null,
  currentAnnualCost: string,
  seatCount: number,
): CatalogTool[] {
  if (!tool) return [];
  return CATALOG.filter(
    (candidate) =>
      candidate.slug !== tool.slug &&
      candidate.category === tool.category &&
      cmp(catalogAnnualCost(candidate, seatCount), currentAnnualCost) < 0,
  ).sort((a, b) =>
    cmp(catalogAnnualCost(a, seatCount), catalogAnnualCost(b, seatCount)),
  );
}

export function catalogAnnualCost(
  tool: CatalogTool,
  seatCount: number,
  billAnnually = false,
): string {
  const monthly =
    billAnnually && tool.annualMonthlyPrice ? tool.annualMonthlyPrice : tool.monthlyPrice;
  return mul(annualize(monthly, "monthly", "USD"), Math.max(1, Math.trunc(seatCount)), "USD");
}
