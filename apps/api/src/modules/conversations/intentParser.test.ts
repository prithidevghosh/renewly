import { describe, expect, it } from "vitest";
import { isAffirmative, isDeclining, parseIntent } from "./intentParser.js";

const intentOf = (text: string) => parseIntent(text).intent;

describe("approval", () => {
  it("reads the obvious yeses", () => {
    for (const text of [
      "APPROVE",
      "approve",
      "Approve.",
      "yes",
      "yep",
      "yeah",
      "ok",
      "okay",
      "go",
      "do it",
      "send it",
      "confirm",
      "proceed",
      "go ahead",
      "sure",
    ]) {
      expect(intentOf(text), text).toBe("APPROVE");
    }
  });

  it("reads a thumbs-up emoji as approval", () => {
    expect(intentOf("👍")).toBe("APPROVE");
    expect(intentOf("✅")).toBe("APPROVE");
  });

  it("reads a tapback as approval without any text", () => {
    expect(parseIntent({ text: "", tapback: "like" }).intent).toBe("APPROVE");
    expect(parseIntent({ text: "", tapback: "👍" }).intent).toBe("APPROVE");
  });

  it("reads a dislike tapback as a refusal, not approval", () => {
    expect(parseIntent({ text: "", tapback: "dislike" }).intent).toBe("KEEP");
  });

  it("is confident about an exact match", () => {
    expect(parseIntent("APPROVE").confidence).toBeGreaterThan(0.9);
  });
});

describe("negation must never approve", () => {
  it("treats a negated approval as a refusal", () => {
    for (const text of [
      "no",
      "no, don't approve",
      "do not approve",
      "don't do it",
      "nope",
      "not yet",
      "hold off",
    ]) {
      const intent = intentOf(text);
      expect(intent, text).not.toBe("APPROVE");
    }
  });

  it("does not cancel when the user says do not cancel", () => {
    expect(intentOf("don't cancel it")).toBe("KEEP");
    expect(intentOf("no, do not cancel")).toBe("KEEP");
  });
});

describe("other intents", () => {
  it("reads KEEP", () => {
    for (const text of ["keep", "keep it", "leave it", "no change", "as is", "skip"]) {
      expect(intentOf(text), text).toBe("KEEP");
    }
  });

  it("reads CANCEL", () => {
    for (const text of ["cancel", "cancel it", "kill it", "drop it"]) {
      expect(intentOf(text), text).toBe("CANCEL");
    }
  });

  it("reads SNOOZE", () => {
    for (const text of ["later", "snooze", "not now", "remind me", "next week"]) {
      expect(intentOf(text), text).toBe("SNOOZE");
    }
  });

  it("reads WHY", () => {
    for (const text of ["why", "why?", "explain", "details", "how come"]) {
      expect(intentOf(text), text).toBe("WHY");
    }
  });

  it("reads STOP even when it is phrased as a refusal", () => {
    expect(intentOf("stop")).toBe("STOP");
    expect(intentOf("unsubscribe")).toBe("STOP");
    // "no, stop messaging me" contains a negation but is unambiguously STOP.
    expect(intentOf("no, stop messaging me")).toBe("STOP");
  });

  it("reads HELP", () => {
    expect(intentOf("help")).toBe("HELP");
    expect(intentOf("?")).toBe("HELP");
    expect(intentOf("what can you do")).toBe("HELP");
  });

  it("reads RETRY", () => {
    expect(intentOf("retry")).toBe("RETRY");
    expect(intentOf("try again")).toBe("RETRY");
  });

  it("reads DONE, which is how an attested action is confirmed", () => {
    for (const text of ["done", "did it", "cancelled it", "finished"]) {
      expect(intentOf(text), text).toBe("DONE");
    }
    expect(intentOf("i have cancelled it")).toBe("DONE");
  });
});

describe("unknown input", () => {
  it("does not guess", () => {
    expect(intentOf("what is the weather in Lisbon")).toBe("UNKNOWN");
    expect(intentOf("")).toBe("UNKNOWN");
    expect(intentOf("   ")).toBe("UNKNOWN");
  });

  it("reports zero confidence for an empty message", () => {
    expect(parseIntent("").confidence).toBe(0);
  });
});

describe("classification helpers", () => {
  it("only APPROVE counts as affirmative", () => {
    expect(isAffirmative("APPROVE")).toBe(true);
    expect(isAffirmative("DONE")).toBe(false);
    expect(isAffirmative("KEEP")).toBe(false);
  });

  it("KEEP and STOP close the approval", () => {
    expect(isDeclining("KEEP")).toBe(true);
    expect(isDeclining("STOP")).toBe(true);
    expect(isDeclining("WHY")).toBe(false);
  });
});
