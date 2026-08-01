import { describe, expect, it } from "vitest";
import {
  add,
  annualize,
  cmp,
  currencyExponent,
  deannualize,
  fromMinor,
  isValidAmount,
  mul,
  normalizeAmount,
  percentOf,
  sub,
  sum,
  toMinor,
} from "./money.js";

describe("toMinor / fromMinor", () => {
  it("round-trips whole and fractional amounts", () => {
    expect(toMinor("20.00")).toBe(2000n);
    expect(toMinor("20")).toBe(2000n);
    expect(toMinor("0.01")).toBe(1n);
    expect(fromMinor(2000n)).toBe("20.00");
    expect(fromMinor(1n)).toBe("0.01");
    expect(fromMinor(0n)).toBe("0.00");
  });

  it("handles negatives", () => {
    expect(toMinor("-12.34")).toBe(-1234n);
    expect(fromMinor(-1234n)).toBe("-12.34");
  });

  it("rounds half-up at the currency exponent", () => {
    expect(toMinor("0.125")).toBe(13n);
    expect(toMinor("0.124")).toBe(12n);
    expect(toMinor("1.005")).toBe(101n);
  });

  it("respects zero-decimal and three-decimal currencies", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(toMinor("1200", "JPY")).toBe(1200n);
    expect(fromMinor(1200n, "JPY")).toBe("1200");
    expect(toMinor("1.234", "KWD")).toBe(1234n);
    expect(fromMinor(1234n, "KWD")).toBe("1.234");
  });

  it("rejects malformed amounts", () => {
    expect(isValidAmount("20.00")).toBe(true);
    expect(isValidAmount("20.")).toBe(false);
    expect(isValidAmount("abc")).toBe(false);
    expect(isValidAmount("")).toBe(false);
    expect(() => toMinor("$20")).toThrowError(/Invalid money amount/);
  });

  it("does not accumulate float error", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point.
    expect(add("0.10", "0.20")).toBe("0.30");
    let running = "0.00";
    for (let i = 0; i < 100; i += 1) running = add(running, "0.07");
    expect(running).toBe("7.00");
  });
});

describe("arithmetic", () => {
  it("adds, subtracts and multiplies", () => {
    expect(add("20.00", "5.50")).toBe("25.50");
    expect(sub("20.00", "5.50")).toBe("14.50");
    expect(sub("5.00", "20.00")).toBe("-15.00");
    expect(mul("20.00", 12)).toBe("240.00");
    expect(mul("19.99", 3)).toBe("59.97");
  });

  it("rejects fractional multipliers", () => {
    expect(() => mul("20.00", 1.5)).toThrowError(/integer factor/);
  });

  it("compares", () => {
    expect(cmp("20.00", "20.000")).toBe(0);
    expect(cmp("19.99", "20.00")).toBe(-1);
    expect(cmp("20.01", "20.00")).toBe(1);
  });

  it("sums a list", () => {
    expect(sum(["20.00", "30.00", "12.00"])).toBe("62.00");
    expect(sum([])).toBe("0.00");
  });

  it("normalizes to the canonical form", () => {
    expect(normalizeAmount("20")).toBe("20.00");
    expect(normalizeAmount("20.5")).toBe("20.50");
    expect(normalizeAmount("020.500")).toBe("20.50");
  });
});

describe("annualize / deannualize", () => {
  it("scales by cycle", () => {
    expect(annualize("20.00", "monthly")).toBe("240.00");
    expect(annualize("240.00", "yearly")).toBe("240.00");
    expect(annualize("5.00", "weekly")).toBe("260.00");
  });

  it("treats an unknown cycle as monthly", () => {
    expect(annualize("20.00", "unknown")).toBe("240.00");
  });

  it("inverts, rounding half-up", () => {
    expect(deannualize("240.00", "monthly")).toBe("20.00");
    expect(deannualize("240.00", "yearly")).toBe("240.00");
    expect(deannualize("100.00", "monthly")).toBe("8.33");
    expect(deannualize("101.00", "monthly")).toBe("8.42");
  });

  it("round-trips within one minor unit", () => {
    for (const amount of ["19.99", "20.00", "7.77", "1.01"]) {
      const back = deannualize(annualize(amount, "monthly"), "monthly");
      expect(back).toBe(amount);
    }
  });
});

describe("percentOf", () => {
  it("takes a percentage rounding half-up", () => {
    expect(percentOf("240.00", 60)).toBe("144.00");
    expect(percentOf("100.00", 33.5)).toBe("33.50");
    expect(percentOf("0.01", 50)).toBe("0.01");
  });
});
