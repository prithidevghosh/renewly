import { describe, expect, it } from "vitest";
import { toHttpsUrl } from "./service.js";

/**
 * `merchant_details.url` is required by POST /v1/sessions and must be https,
 * but the merchant graph stores whatever a human typed.
 */
describe("toHttpsUrl", () => {
  it("keeps a well-formed https url", () => {
    expect(toHttpsUrl("https://claude.ai")).toBe("https://claude.ai");
  });

  it("upgrades http to https", () => {
    expect(toHttpsUrl("http://claude.ai")).toBe("https://claude.ai");
  });

  it("adds the scheme to a bare host", () => {
    expect(toHttpsUrl("claude.ai")).toBe("https://claude.ai");
  });

  it("keeps the path but drops the trailing slash", () => {
    expect(toHttpsUrl("anthropic.com/pricing")).toBe("https://anthropic.com/pricing");
    expect(toHttpsUrl("https://anthropic.com/")).toBe("https://anthropic.com");
  });

  it("trims surrounding whitespace", () => {
    expect(toHttpsUrl("  https://notion.so  ")).toBe("https://notion.so");
  });

  it("returns null for anything that is not a host", () => {
    expect(toHttpsUrl(null)).toBeNull();
    expect(toHttpsUrl(undefined)).toBeNull();
    expect(toHttpsUrl("")).toBeNull();
    expect(toHttpsUrl("   ")).toBeNull();
    expect(toHttpsUrl("localhost")).toBeNull();
    expect(toHttpsUrl("not a url")).toBeNull();
  });
});
