/**
 * The one thing every double in this directory must do first.
 *
 * These classes answer in the shape of a real integration while nothing behind
 * them is true, which is exactly what the application is not allowed to serve.
 * The application no longer imports any of them — but "no import today" is a
 * property of the current source, and the next person to reach for a quick
 * local fallback will find something here that fits perfectly.
 *
 * So the constraint is enforced at runtime rather than left as a convention:
 * constructing a double outside the test environment throws, and the message
 * says what to do instead. A double that reaches a user is worse than a feature
 * that is switched off, because the user cannot tell.
 */
export function assertTestOnly(what: string): void {
  if (process.env.NODE_ENV === "test") return;
  throw new Error(
    `${what} is a test double and cannot run with NODE_ENV=${process.env.NODE_ENV ?? "unset"}. ` +
      "It answers like the real integration while nothing behind it is true, so it " +
      "must never reach a running app. Configure the real credentials and set that " +
      'integration to "live", or leave it "disabled" so the feature switches off honestly.',
  );
}
