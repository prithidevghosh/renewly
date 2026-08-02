import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOKBACK_DAYS,
  LOOKBACK_DAYS,
  isLookbackDays,
  lookbackFromState,
  lookbackLabel,
} from "./lookback.js";

describe("lookback windows", () => {
  it("offers a fortnight, one, two and three months", () => {
    expect([...LOOKBACK_DAYS]).toEqual([15, 30, 60, 90]);
  });

  it("defaults to a month", () => {
    expect(DEFAULT_LOOKBACK_DAYS).toBe(30);
    expect(isLookbackDays(DEFAULT_LOOKBACK_DAYS)).toBe(true);
  });
});

describe("isLookbackDays", () => {
  it("accepts every offered window", () => {
    for (const days of LOOKBACK_DAYS) expect(isLookbackDays(days)).toBe(true);
  });

  it("rejects a window nobody offered", () => {
    // The point of the constraint: an arbitrary number is a mailbox bill.
    expect(isLookbackDays(365)).toBe(false);
    expect(isLookbackDays(0)).toBe(false);
    expect(isLookbackDays(-30)).toBe(false);
    expect(isLookbackDays(31)).toBe(false);
  });

  it("rejects things that are not numbers at all", () => {
    expect(isLookbackDays("30")).toBe(false);
    expect(isLookbackDays(null)).toBe(false);
    expect(isLookbackDays(undefined)).toBe(false);
    expect(isLookbackDays({ days: 30 })).toBe(false);
  });
});

describe("lookbackLabel", () => {
  it("says months where a month is what the user picked", () => {
    expect(lookbackLabel(15)).toBe("15 days");
    expect(lookbackLabel(30)).toBe("1 month");
    expect(lookbackLabel(60)).toBe("2 months");
    expect(lookbackLabel(90)).toBe("3 months");
  });

  it("falls back to a day count for anything else", () => {
    expect(lookbackLabel(45)).toBe("45 days");
  });
});

describe("lookbackFromState", () => {
  it("reads the window the run was started with", () => {
    expect(lookbackFromState({ lookbackDays: 15 })).toBe(15);
    expect(lookbackFromState({ lookbackDays: 90 })).toBe(90);
  });

  it("defaults when the key is absent", () => {
    // A session row written before this option existed must still resume.
    expect(lookbackFromState({})).toBe(DEFAULT_LOOKBACK_DAYS);
    expect(lookbackFromState({ messageIds: ["a", "b"] })).toBe(DEFAULT_LOOKBACK_DAYS);
  });

  it("defaults rather than throwing on a value it does not recognise", () => {
    // State is a jsonb column, so anything could be in there. Refusing to run
    // is worse than reading a month.
    expect(lookbackFromState({ lookbackDays: 365 })).toBe(DEFAULT_LOOKBACK_DAYS);
    expect(lookbackFromState({ lookbackDays: "90" })).toBe(DEFAULT_LOOKBACK_DAYS);
    expect(lookbackFromState({ lookbackDays: null })).toBe(DEFAULT_LOOKBACK_DAYS);
  });
});
