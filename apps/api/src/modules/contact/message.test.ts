import { describe, expect, it } from "vitest";
import { renderContactMessage } from "./message.js";

const base = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  message: "We renew Datadog in August.\nCan you take a look before then?",
  receivedAt: new Date("2026-01-01T09:30:00.000Z"),
};

describe("renderContactMessage", () => {
  it("puts the sender in the subject so the inbox is searchable", () => {
    const mail = renderContactMessage(base);
    expect(mail.subject).toBe("Contact · Ada Lovelace · ada@example.com");
  });

  it("carries every field the form collects", () => {
    const mail = renderContactMessage(base);
    for (const value of ["Ada Lovelace", "ada@example.com", "2026-01-01T09:30:00.000Z"]) {
      expect(mail.text).toContain(value);
      expect(mail.html).toContain(value);
    }
  });

  it("keeps the message verbatim, line breaks and all", () => {
    const mail = renderContactMessage(base);
    expect(mail.text).toContain(base.message);
    expect(mail.html).toContain("white-space:pre-wrap");
    expect(mail.html).toContain("Can you take a look before then?");
  });

  it("escapes anything that came from the request body", () => {
    const mail = renderContactMessage({
      ...base,
      name: "<script>alert(1)</script>",
      message: "<img src=x onerror=alert(1)>",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("carries a plain-text twin with no markup", () => {
    const mail = renderContactMessage(base);
    expect(mail.text).not.toMatch(/<[a-z/]/i);
  });
});
