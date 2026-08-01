import { describe, expect, it } from "vitest";
import { renderWaitlistWelcome } from "./welcomeEmail.js";

describe("renderWaitlistWelcome", () => {
  it("greets by first name and states the position", () => {
    const mail = renderWaitlistWelcome({
      email: "ada@example.com",
      name: "Ada Lovelace",
      position: 7,
    });

    expect(mail.subject).toBe("You are on the Renewly waitlist");
    expect(mail.text).toContain("Thank you for putting your name down, Ada.");
    expect(mail.text).toContain("No. 7");
    expect(mail.html).toContain("No.&nbsp;7");
  });

  it("drops the name from the greeting when there is none", () => {
    const mail = renderWaitlistWelcome({ email: "ada@example.com", name: null, position: 1 });
    expect(mail.text).toContain("Thank you for putting your name down.");
    expect(mail.text).not.toContain(", .");
  });

  it("groups a large position the way a reader would write it", () => {
    const mail = renderWaitlistWelcome({ email: "ada@example.com", position: 12345 });
    expect(mail.text).toContain("No. 12,345");
  });

  it("escapes anything that came from the request body", () => {
    const mail = renderWaitlistWelcome({
      email: "quote\"break@example.com",
      name: "<script>alert(1)</script>",
      position: 2,
    });

    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("quote&quot;break@example.com");
  });

  it("carries a plain-text twin with no markup", () => {
    const mail = renderWaitlistWelcome({ email: "ada@example.com", position: 3 });
    expect(mail.text).not.toMatch(/<[a-z/]/i);
    expect(mail.text).toContain("ada@example.com");
  });
});
