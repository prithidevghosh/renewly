import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, numericCode } from "./crypto.js";

describe("secret box", () => {
  it("round-trips a token", () => {
    const token = "1//0eXAMPLEreFrEsH-t0ken_value";
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it("produces a different ciphertext every time", () => {
    // A fixed IV would let an observer see that two users hold the same token.
    const first = encryptSecret("same-token");
    const second = encryptSecret("same-token");

    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe("same-token");
    expect(decryptSecret(second)).toBe("same-token");
  });

  it("handles unicode and empty strings", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
    expect(decryptSecret(encryptSecret("café ☕ 日本語"))).toBe("café ☕ 日本語");
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const sealed = encryptSecret("sensitive");
    const parts = sealed.split(".");

    // Flip a byte in the ciphertext; GCM's tag check must catch it.
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = body[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString("base64url")].join(".");

    expect(decryptSecret(tampered)).toBeNull();
  });

  it("refuses a swapped authentication tag", () => {
    const a = encryptSecret("token-a").split(".");
    const b = encryptSecret("token-b").split(".");
    const spliced = [a[0], a[1], b[2], a[3]].join(".");

    expect(decryptSecret(spliced)).toBeNull();
  });

  it("returns null on malformed input instead of throwing", () => {
    for (const bad of ["", "not-sealed", "v1.only.three", "v2.a.b.c", "v1....."]) {
      expect(decryptSecret(bad), bad).toBeNull();
    }
  });

  it("never stores the plaintext in the sealed form", () => {
    const sealed = encryptSecret("super-secret-refresh-token");
    expect(sealed).not.toContain("super-secret");
  });
});

describe("numericCode", () => {
  it("is the requested length and all digits", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = numericCode(6);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("keeps leading zeros rather than shortening the code", () => {
    const codes = Array.from({ length: 400 }, () => numericCode(6));
    expect(codes.every((code) => code.length === 6)).toBe(true);
  });

  it("does not return the same code every time", () => {
    const codes = new Set(Array.from({ length: 100 }, () => numericCode(6)));
    expect(codes.size).toBeGreaterThan(90);
  });
});
