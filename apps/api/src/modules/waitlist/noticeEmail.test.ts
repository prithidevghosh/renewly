import { describe, expect, it } from "vitest";
import { renderWaitlistNotice } from "./noticeEmail.js";

const base = {
  email: "ada@example.com",
  name: "Ada Lovelace",
  source: "landing-hero",
  referrer: "https://renewly.app/",
  position: 42,
  joinedAt: new Date("2026-01-01T09:30:00.000Z"),
};

describe("renderWaitlistNotice", () => {
  it("puts the position and address in the subject so the inbox is searchable", () => {
    const mail = renderWaitlistNotice(base);
    expect(mail.subject).toBe("Waitlist · No. 42 · ada@example.com");
  });

  it("lists every field a signup carries", () => {
    const mail = renderWaitlistNotice(base);
    for (const value of [
      "ada@example.com",
      "Ada Lovelace",
      "No. 42",
      "landing-hero",
      "https://renewly.app/",
      "2026-01-01T09:30:00.000Z",
    ]) {
      expect(mail.text).toContain(value);
      expect(mail.html).toContain(value.replace("No. ", "No.&nbsp;"));
    }
  });

  it("marks absent optional fields rather than leaving a blank", () => {
    const mail = renderWaitlistNotice({ ...base, name: null, referrer: null });
    expect(mail.text).toContain("Name      —");
    expect(mail.text).toContain("Referrer  —");
  });

  it("escapes anything that came from the request body", () => {
    const mail = renderWaitlistNotice({ ...base, name: "<script>alert(1)</script>" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("carries a plain-text twin with no markup", () => {
    const mail = renderWaitlistNotice(base);
    expect(mail.text).not.toMatch(/<[a-z/]/i);
  });
});
