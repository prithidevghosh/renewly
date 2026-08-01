import { describe, expect, it } from "vitest";
import type { ApprovalState } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import {
  APPROVAL_STATES,
  acceptsIntent,
  allowedTransitions,
  assertTransition,
  canTransition,
  isExpirable,
  isTerminal,
  nextStateForApprove,
} from "./stateMachine.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof AppError ? error.code : "UNEXPECTED";
  }
}

describe("legal transitions", () => {
  const legal: Array<[ApprovalState, ApprovalState]> = [
    ["drafted", "notified"],
    ["notified", "awaiting_intent"],
    ["awaiting_intent", "awaiting_payment_auth"],
    ["awaiting_intent", "executing"],
    ["awaiting_payment_auth", "executing"],
    ["executing", "proved"],
    ["executing", "failed"],
  ];

  for (const [from, to] of legal) {
    it(`allows ${from} -> ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    });
  }

  it("walks the full paying path", () => {
    const path: ApprovalState[] = [
      "drafted",
      "notified",
      "awaiting_intent",
      "awaiting_payment_auth",
      "executing",
      "proved",
    ];
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it("walks the attested path, skipping the payment leg", () => {
    const path: ApprovalState[] = ["drafted", "notified", "awaiting_intent", "executing", "proved"];
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it("allows cancellation and expiry from every non-terminal, non-executing state", () => {
    for (const state of ["drafted", "notified", "awaiting_intent", "awaiting_payment_auth"] as const) {
      expect(canTransition(state, "cancelled_by_user")).toBe(true);
      expect(canTransition(state, "expired")).toBe(true);
    }
  });
});

describe("illegal transitions", () => {
  it("cannot skip straight from drafted to proved", () => {
    expect(codeOf(() => assertTransition("drafted", "proved"))).toBe("INVALID_STATE_TRANSITION");
  });

  it("cannot pay without being notified first", () => {
    expect(codeOf(() => assertTransition("drafted", "awaiting_payment_auth"))).toBe(
      "INVALID_STATE_TRANSITION",
    );
  });

  it("cannot cancel money that is already in flight", () => {
    expect(canTransition("executing", "cancelled_by_user")).toBe(false);
    expect(canTransition("executing", "expired")).toBe(false);
    expect(codeOf(() => assertTransition("executing", "cancelled_by_user"))).toBe(
      "INVALID_STATE_TRANSITION",
    );
  });

  it("cannot leave a terminal state", () => {
    for (const terminal of ["proved", "failed", "expired", "cancelled_by_user"] as const) {
      expect(allowedTransitions(terminal)).toEqual([]);
      for (const target of APPROVAL_STATES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it("cannot re-enter the same state, which is what makes a double APPROVE inert", () => {
    for (const state of APPROVAL_STATES) {
      expect(codeOf(() => assertTransition(state, state))).toBe("INVALID_STATE_TRANSITION");
    }
  });

  it("marks a same-state transition as idempotent rather than a hard error", () => {
    try {
      assertTransition("awaiting_payment_auth", "awaiting_payment_auth");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details.idempotent).toBe(true);
    }
  });

  it("cannot go backwards", () => {
    expect(canTransition("executing", "awaiting_intent")).toBe(false);
    expect(canTransition("awaiting_payment_auth", "notified")).toBe(false);
    expect(canTransition("notified", "drafted")).toBe(false);
  });

  it("every state pair is either explicitly allowed or rejected", () => {
    for (const from of APPROVAL_STATES) {
      for (const to of APPROVAL_STATES) {
        const allowed = canTransition(from, to);
        expect(typeof allowed).toBe("boolean");
        if (allowed) expect(allowedTransitions(from)).toContain(to);
      }
    }
  });
});

describe("helpers", () => {
  it("identifies terminal states", () => {
    expect(isTerminal("proved")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("cancelled_by_user")).toBe(true);
    expect(isTerminal("awaiting_intent")).toBe(false);
  });

  it("routes APPROVE by whether the action needs money", () => {
    expect(nextStateForApprove("awaiting_intent", true)).toBe("awaiting_payment_auth");
    expect(nextStateForApprove("awaiting_intent", false)).toBe("executing");
  });

  it("refuses APPROVE from a state that is not listening", () => {
    expect(codeOf(() => nextStateForApprove("proved", true))).toBe("INVALID_STATE_TRANSITION");
    expect(codeOf(() => nextStateForApprove("executing", true))).toBe("INVALID_STATE_TRANSITION");
  });

  it("accepts intents only while waiting on the user", () => {
    expect(acceptsIntent("notified")).toBe(true);
    expect(acceptsIntent("awaiting_intent")).toBe(true);
    expect(acceptsIntent("executing")).toBe(false);
    expect(acceptsIntent("proved")).toBe(false);
  });

  it("never expires an approval mid-execution", () => {
    expect(isExpirable("awaiting_intent")).toBe(true);
    expect(isExpirable("awaiting_payment_auth")).toBe(true);
    expect(isExpirable("executing")).toBe(false);
    expect(isExpirable("proved")).toBe(false);
  });
});
