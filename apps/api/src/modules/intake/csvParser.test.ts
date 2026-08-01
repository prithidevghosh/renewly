import { describe, expect, it } from "vitest";
import { fixture } from "../../test/factories.js";
import { cleanDescription, detectRecurring, parseCsv, splitCsvLine } from "./csvParser.js";

describe("splitCsvLine", () => {
  it("splits plain fields", () => {
    expect(splitCsvLine("2026-05-02,COFFEE,-6.75")).toEqual(["2026-05-02", "COFFEE", "-6.75"]);
  });

  it("respects quoted fields containing commas", () => {
    expect(splitCsvLine('2026-05-02,"ACME, INC",-6.75')).toEqual([
      "2026-05-02",
      "ACME, INC",
      "-6.75",
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(["a", 'say "hi"', "b"]);
  });
});

describe("parseCsv", () => {
  it("parses the bank fixture", () => {
    const rows = parseCsv(fixture("csv/small-bank.csv"), 5000);
    expect(rows).toHaveLength(17);
    expect(rows[0]?.description).toBe("SQ *BLUE BOTTLE COFFEE");
    expect(rows[0]?.amount).toBe("6.75");
    expect(rows[0]?.date?.toISOString()).toContain("2026-05-02");
  });

  it("normalises negative, parenthesised and unsigned amounts to magnitudes", () => {
    const rows = parseCsv(
      ["date,description,amount", "2026-01-01,A,-10.00", "2026-01-02,B,(20.00)", "2026-01-03,C,30.00"].join(
        "\n",
      ),
      100,
    );
    expect(rows.map((r) => r.amount)).toEqual(["10.00", "20.00", "30.00"]);
  });

  it("tolerates alternative header names", () => {
    const rows = parseCsv(
      ["Posted Date,Narrative,Debit,Currency", "2026-02-01,NOTION LABS,12.00,GBP"].join("\n"),
      100,
    );
    expect(rows[0]?.currency).toBe("GBP");
    expect(rows[0]?.description).toBe("NOTION LABS");
  });

  it("rejects a file with no usable columns", () => {
    expect(() => parseCsv("foo,bar\n1,2", 100)).toThrowError(/description column/);
  });

  it("rejects an empty file", () => {
    expect(() => parseCsv("", 100)).toThrowError(/empty/);
  });

  it("enforces the row limit", () => {
    const many = ["date,description,amount", ...Array.from({ length: 12 }, (_, i) => `2026-01-01,X,${i + 1}.00`)];
    expect(() => parseCsv(many.join("\n"), 10)).toThrowError(/row limit/);
  });
});

describe("detectRecurring", () => {
  const rows = parseCsv(fixture("csv/small-bank.csv"), 5000);
  const candidates = detectRecurring(rows);

  it("finds the three recurring merchants and ignores the noise", () => {
    const merchants = candidates.map((c) => c.merchantCanonical).sort();
    expect(merchants).toEqual(["anthropic claude ai", "midjourney", "notion"]);
  });

  it("does not treat variable coffee charges as a subscription", () => {
    expect(candidates.some((c) => c.merchantCanonical.includes("blue bottle"))).toBe(false);
  });

  it("infers a monthly cycle from evenly spaced charges", () => {
    for (const candidate of candidates) {
      expect(candidate.billingCycle).toBe("monthly");
      expect(candidate.occurrences).toBe(3);
    }
  });

  it("scores three regular occurrences highly", () => {
    const anthropic = candidates.find((c) => c.merchantCanonical.includes("anthropic"));
    expect(anthropic?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(anthropic?.amount).toBe("20.00");
  });

  it("uses the latest charge date as the anchor", () => {
    const midjourney = candidates.find((c) => c.merchantCanonical === "midjourney");
    expect(midjourney?.date?.toISOString()).toContain("2026-07-05");
  });

  it("accepts a single charge only when the description says subscription", () => {
    const single = detectRecurring(
      parseCsv(
        ["date,description,amount", "2026-01-01,LINEAR SUBSCRIPTION,-8.00", "2026-01-02,TAXI,-22.00"].join(
          "\n",
        ),
        100,
      ),
    );
    expect(single).toHaveLength(1);
    expect(single[0]?.merchantCanonical).toBe("linear");
    expect(single[0]?.confidence).toBeLessThan(0.7);
  });

  it("separates the same merchant at different amounts", () => {
    const mixed = detectRecurring(
      parseCsv(
        [
          "date,description,amount",
          "2026-01-05,VERCEL,-20.00",
          "2026-02-05,VERCEL,-20.00",
          "2026-03-05,VERCEL,-95.00",
        ].join("\n"),
        100,
      ),
    );
    expect(mixed).toHaveLength(1);
    expect(mixed[0]?.amount).toBe("20.00");
    expect(mixed[0]?.occurrences).toBe(2);
  });

  it("detects a yearly cycle", () => {
    const yearly = detectRecurring(
      parseCsv(
        ["date,description,amount", "2024-06-01,GITHUB TEAM,-48.00", "2025-06-02,GITHUB TEAM,-48.00"].join(
          "\n",
        ),
        100,
      ),
    );
    expect(yearly[0]?.billingCycle).toBe("yearly");
  });
});

describe("cleanDescription", () => {
  it("strips processor noise and reference numbers", () => {
    expect(cleanDescription("SQ *BLUE BOTTLE COFFEE 88213")).toBe("Blue Bottle Coffee");
    expect(cleanDescription("ANTHROPIC*CLAUDE.AI SUBSCR")).toContain("Anthropic");
  });

  it("never returns an empty string", () => {
    expect(cleanDescription("POS DEBIT")).not.toBe("");
  });
});
