"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Artwork } from "@/components/site/Artwork";
import { Wordmark } from "@/components/brand/Mark";
import { apiFetch, mailboxConnectUrl, oauthUrl, RenewlyApiError } from "@/lib/api/client";
import type { MailboxConnection, MeResponse, PublicUser } from "@/lib/api/types";
import styles from "./onboarding.module.css";

type Stage = "account" | "verify" | "mandate";
type AuthMode = "signup" | "login";

interface AuthResponse {
  user: PublicUser;
  workspaceId: string;
  verificationRequired?: boolean;
  verificationCode?: string | null;
}

interface AuthConfig {
  providers: {
    password: boolean;
    googleRedirect: boolean;
  };
}

const fieldError = (error: unknown) => {
  if (!(error instanceof RenewlyApiError)) return "Something interrupted that request. Try again.";
  if (error.code === "CONFLICT")
    return "An account already exists for this email. Sign in instead.";
  if (error.code === "UNAUTHORIZED") return "That email and password do not match.";
  if (error.code === "RATE_LIMITED") return "Too many attempts. Give it a minute, then try again.";
  return error.message;
};

/**
 * Linq addresses recipients in E.164 and rejects anything else, so the shape is
 * settled here rather than at the far end of a queue where the failure would
 * arrive as an undelivered proposal. A bare ten-digit number is read as US,
 * which is what someone typing their own number usually means; anything else
 * has to carry its own country code.
 */
function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function OnboardingContent() {
  const router = useRouter();
  const search = useSearchParams();
  const [stage, setStage] = useState<Stage>("account");
  const [mode, setMode] = useState<AuthMode>(search.get("mode") === "login" ? "login" : "signup");
  const [providers, setProviders] = useState<AuthConfig["providers"] | null>(null);
  const [authConfigReady, setAuthConfigReady] = useState(false);
  const [existingSession, setExistingSession] = useState<MeResponse | null>(null);
  const [email, setEmail] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [authVerified, setAuthVerified] = useState(false);
  const [mailboxes, setMailboxes] = useState<MailboxConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    search.get("error") === "access_denied" ? "Sign-in was cancelled. Nothing changed." : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState({ budget: "", ceiling: "", teamSize: "1", phone: "" });

  const activeMailbox = mailboxes.find((mailbox) => mailbox.status === "active") ?? null;

  const hydrateVerifiedSession = useCallback(async (advance: boolean) => {
    const me = await apiFetch<MeResponse>("/v1/me");
    setExistingSession(me);
    setEmail(me.user.email);

    if (!me.user.emailVerified) {
      setAuthVerified(false);
      setMailboxes([]);
      if (advance) setStage("verify");
      return { me, connections: [] as MailboxConnection[] };
    }

    // Do not trust an OAuth callback or a previous client state. Both the
    // verified session and the mailbox grant are read back from the API.
    const mailboxResponse = await apiFetch<{ connections: MailboxConnection[] }>("/v1/mailbox");
    setAuthVerified(true);
    setMailboxes(mailboxResponse.connections);
    // Functional update so a number already typed survives the re-hydrate that
    // follows an OAuth round trip. The API has nowhere to read it back from.
    setSettings((previous) => ({
      ...previous,
      budget: me.settings.aiMonthlyBudget ?? "",
      ceiling: me.settings.spendCeiling ?? "",
      teamSize: String(me.settings.teamSize),
    }));
    if (advance) setStage("mandate");
    return { me, connections: mailboxResponse.connections };
  }, []);

  useEffect(() => {
    const resumeFromCallback = search.get("auth") === "complete" || search.has("mailbox");

    void (async () => {
      try {
        const config = await apiFetch<AuthConfig>("/v1/auth/config");
        setProviders(config.providers);
        setAuthConfigReady(true);

        try {
          // A normal reload intentionally stays on step one. We inspect the
          // session so it can be resumed explicitly, but never restore a UI
          // step from client state. OAuth/mailbox callbacks are the exception.
          await hydrateVerifiedSession(resumeFromCallback);
          // Callback markers are single-use. Removing them means a browser
          // reload always re-enters at the account step instead of replaying
          // a previously completed OAuth/mailbox transition.
          if (resumeFromCallback) router.replace("/onboarding");
        } catch (caught) {
          if (caught instanceof RenewlyApiError && caught.code === "UNAUTHORIZED") return;
          throw caught;
        }
      } catch (caught) {
        setAuthConfigReady(false);
        setAuthVerified(false);
        setError(fieldError(caught));
      }
    })();
  }, [hydrateVerifiedSession, router, search]);

  useEffect(() => {
    const connected = search.get("mailbox");
    const address = search.get("address");
    if (connected === "connected") setNotice(`${address ?? "Mailbox"} is now connected read-only.`);
    if (search.get("mailbox_error"))
      setNotice("Mailbox access was declined. Connect Gmail to continue.");
  }, [search]);

  const progress = useMemo(() => ({ account: 1, verify: 2, mandate: 3 })[stage], [stage]);

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!authConfigReady) {
      setError("Authentication is unavailable because the backend configuration did not load.");
      return;
    }
    const data = new FormData(event.currentTarget);
    const nextEmail = String(data.get("email") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const response = await apiFetch<AuthResponse>("/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: nextEmail, password: String(data.get("password") ?? "") }),
        });
        setEmail(nextEmail);
        if (response.user.emailVerified) await hydrateVerifiedSession(true);
        else {
          await hydrateVerifiedSession(false);
          setStage("verify");
        }
      } else {
        const response = await apiFetch<AuthResponse>("/v1/auth/signup", {
          method: "POST",
          body: JSON.stringify({
            email: nextEmail,
            password: String(data.get("password") ?? ""),
            name: String(data.get("name") ?? "").trim(),
            workspaceName: String(data.get("workspaceName") ?? "").trim(),
          }),
        });
        setEmail(nextEmail);
        setDevCode(response.verificationCode ?? null);
        await hydrateVerifiedSession(false);
        setStage("verify");
      }
    } catch (caught) {
      setError(fieldError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").replace(/\s/g, "");
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/v1/auth/verify", { method: "POST", body: JSON.stringify({ email, code }) });
      await hydrateVerifiedSession(true);
    } catch (caught) {
      const attempts = caught instanceof RenewlyApiError ? caught.details?.attemptsRemaining : null;
      setError(
        `${fieldError(caught)}${typeof attempts === "number" ? ` ${attempts} attempts remain.` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ retryAfterSeconds: number }>("/v1/auth/resend-code", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setNotice(
        `A fresh code is on its way. You can request another in ${result.retryAfterSeconds}s.`,
      );
      setDevCode(null);
    } catch (caught) {
      setError(fieldError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveMandate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Re-check both gates at the commit boundary. This prevents stale state,
      // a forged callback query, or a mailbox revoked in another tab from
      // opening the product.
      const fresh = await hydrateVerifiedSession(true);
      if (!fresh.me.user.emailVerified) {
        throw new RenewlyApiError(403, {
          error: { code: "EMAIL_NOT_VERIFIED", message: "Verify your email before continuing." },
        });
      }
      const connected = fresh.connections.some((mailbox) => mailbox.status === "active");
      if (!connected) {
        setError("Connect Gmail before entering the control room.");
        return;
      }

      /*
       * A number to reach you on is not optional, and this is the only place in
       * the product that asks for one. Without it the agent reads the mail,
       * forms a decision, and has nowhere to send it — the sweep skips the
       * workspace and nothing ever says why.
       */
      const phone = normalizePhone(settings.phone);
      if (!phone) {
        setError("Add a mobile number so Renewly can text you before it acts.");
        return;
      }

      await apiFetch("/v1/channels/connect", {
        method: "POST",
        body: JSON.stringify({ channel: "imessage", externalId: phone }),
      });

      await apiFetch("/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({
          aiMonthlyBudget: settings.budget || null,
          spendCeiling: settings.ceiling || null,
          teamSize: Number(settings.teamSize),
          approvalMode: "ask_above_ceiling",
        }),
      });
      const latest = await apiFetch<{ session: unknown | null }>("/v1/agent/sessions/latest");
      if (!latest.session) {
        await apiFetch("/v1/agent/sessions", {
          method: "POST",
          body: JSON.stringify({ kind: "onboarding" }),
        });
      }
      router.push("/agent");
    } catch (caught) {
      if (
        caught instanceof RenewlyApiError &&
        (caught.code === "UNAUTHORIZED" || caught.code === "EMAIL_NOT_VERIFIED")
      ) {
        setAuthVerified(false);
        setMailboxes([]);
        setStage(caught.code === "EMAIL_NOT_VERIFIED" ? "verify" : "account");
        if (caught.code === "UNAUTHORIZED") setMode("login");
      }
      setError(fieldError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function continueExistingSession() {
    if (!authConfigReady || busy) return;
    setBusy(true);
    setError(null);
    try {
      await hydrateVerifiedSession(true);
    } catch (caught) {
      setError(fieldError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restartOnboarding() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/v1/auth/logout", { method: "POST" });
      setExistingSession(null);
      setAuthVerified(false);
      setMailboxes([]);
      setEmail("");
      setDevCode(null);
      setNotice(null);
      setSettings({ budget: "", ceiling: "", teamSize: "1", phone: "" });
      setMode("signup");
      setStage("account");
      router.replace("/onboarding");
    } catch (caught) {
      setError(fieldError(caught));
    } finally {
      setBusy(false);
    }
  }

  function returnToAccount() {
    setError(null);
    setNotice(null);
    setStage("account");
    router.replace("/onboarding");
  }

  return (
    <main className={styles.page}>
      <section className={styles.artPanel} aria-label="Renewly onboarding">
        <Artwork scene="onboarding" className={styles.art} />
        <div className={styles.artScrim} />
        <Link href="/" className={styles.backLink}>
          <ArrowLeft size={15} /> Back to Renewly
        </Link>
        <div className={styles.artCopy}>
          <p>Authority before autonomy</p>
          <blockquote>
            See every commitment.
            <br />
            <em>Decide what deserves to stay.</em>
          </blockquote>
          <span>Read-only signals · explicit limits · receipts for every outcome</span>
        </div>
      </section>

      <section className={styles.formPanel}>
        <header className={styles.mobileHeader}>
          <Link href="/">
            <Wordmark size={24} />
          </Link>
          <span>{progress} / 3</span>
        </header>

        <div className={styles.formInner}>
          <div className={styles.progress} aria-label={`Step ${progress} of 3`}>
            {[1, 2, 3].map((item) => (
              <i key={item} data-active={item <= progress} />
            ))}
          </div>

          {stage === "account" && (
            <div className={styles.stage}>
              <p className={styles.eyebrow}>
                {existingSession
                  ? "Workspace identity"
                  : mode === "signup"
                    ? "Begin with your mandate"
                    : "Welcome back"}
              </p>
              <h1>
                {existingSession ? (
                  <>
                    Your account is
                    <br />
                    <em>
                      {existingSession.user.emailVerified ? "verified." : "waiting for proof."}
                    </em>
                  </>
                ) : mode === "signup" ? (
                  <>
                    Own your spend.
                    <br />
                    <em>Keep your attention.</em>
                  </>
                ) : (
                  <>
                    Return to your
                    <br />
                    <em>control room.</em>
                  </>
                )}
              </h1>
              <p className={styles.lede}>
                {existingSession
                  ? `Signed in as ${existingSession.user.email}. Continue deliberately, or sign out and begin again.`
                  : mode === "signup"
                    ? "Create the workspace that will hold your recurring commitments, rules, and proof."
                    : "Sign in to resume your agent and its finance-grade memory."}
              </p>

              {existingSession ? (
                <div className={styles.sessionCard}>
                  <div>
                    <span>{existingSession.workspace.name}</span>
                    <strong>{existingSession.user.name}</strong>
                    <small>
                      {existingSession.user.emailVerified
                        ? activeMailbox
                          ? `${activeMailbox.emailAddress} connected`
                          : "Verified · mailbox still required"
                        : "Email verification incomplete"}
                    </small>
                  </div>
                  {error && (
                    <p className={styles.error} role="alert">
                      {error}
                    </p>
                  )}
                  <button
                    className={styles.primary}
                    onClick={() => void continueExistingSession()}
                    disabled={busy || !authConfigReady}
                  >
                    {busy
                      ? "Checking your access…"
                      : existingSession.user.emailVerified
                        ? "Continue this workspace"
                        : "Continue verification"}
                    <ArrowRight />
                  </button>
                  <button
                    className={styles.modeSwitch}
                    onClick={() => void restartOnboarding()}
                    disabled={busy}
                  >
                    Sign out and start over
                  </button>
                </div>
              ) : (
                <>
                  <div className={styles.socials}>
                    {providers?.googleRedirect ? (
                      <a href={oauthUrl("google", "/onboarding?auth=complete")}>
                        <span className={styles.google}>G</span> Continue with Google
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled
                        title={
                          authConfigReady
                            ? "Google sign-in is not configured on this deployment."
                            : "Google sign-in is waiting for the authentication service."
                        }
                      >
                        <span className={styles.google}>G</span> Continue with Google
                      </button>
                    )}
                  </div>

                  <div className={styles.or}>
                    <span>or use email</span>
                  </div>

                  <form className={styles.form} onSubmit={submitAccount}>
                    {mode === "signup" && (
                      <div className={styles.twoFields}>
                        <label>
                          <span>Your name</span>
                          <input
                            name="name"
                            autoComplete="name"
                            placeholder="Ada Lovelace"
                            required
                          />
                        </label>
                        <label>
                          <span>Workspace</span>
                          <input
                            name="workspaceName"
                            autoComplete="organization"
                            placeholder="Northwind"
                            required
                          />
                        </label>
                      </div>
                    )}
                    <label>
                      <span>Work email</span>
                      <input
                        name="email"
                        type="email"
                        autoComplete="email"
                        placeholder="ada@northwind.co"
                        required
                      />
                    </label>
                    <label>
                      <span>Password</span>
                      <div className={styles.password}>
                        <input
                          name="password"
                          type={passwordVisible ? "text" : "password"}
                          autoComplete={mode === "signup" ? "new-password" : "current-password"}
                          minLength={mode === "signup" ? 8 : 1}
                          placeholder={
                            mode === "signup" ? "At least 8 characters" : "Your password"
                          }
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setPasswordVisible((value) => !value)}
                          aria-label={passwordVisible ? "Hide password" : "Show password"}
                        >
                          {passwordVisible ? <EyeOff /> : <Eye />}
                        </button>
                      </div>
                    </label>
                    {error && (
                      <p className={styles.error} role="alert">
                        {error}
                      </p>
                    )}
                    <button className={styles.primary} disabled={busy || !authConfigReady}>
                      {!authConfigReady
                        ? "Authentication unavailable"
                        : busy
                          ? "Opening your workspace…"
                          : mode === "signup"
                            ? "Create my workspace"
                            : "Sign in"}
                      <ArrowRight />
                    </button>
                  </form>
                  <button
                    className={styles.modeSwitch}
                    onClick={() => {
                      setMode(mode === "signup" ? "login" : "signup");
                      setError(null);
                    }}
                  >
                    {mode === "signup"
                      ? "Already have a workspace? Sign in"
                      : "New to Renewly? Create a workspace"}
                  </button>
                </>
              )}
            </div>
          )}

          {stage === "verify" && (
            <div className={styles.stage}>
              <button type="button" className={styles.stageBack} onClick={returnToAccount}>
                <ArrowLeft /> Back to account
              </button>
              <div className={styles.seal}>
                <Mail />
              </div>
              <p className={styles.eyebrow}>Prove the address</p>
              <h1>
                Check your inbox.
                <br />
                <em>Then take control.</em>
              </h1>
              <p className={styles.lede}>
                We sent a six-digit code to <strong>{email}</strong>. The workspace is ready; this
                is the last gate.
              </p>
              {devCode && (
                <button
                  className={styles.devCode}
                  onClick={() => navigator.clipboard.writeText(devCode)}
                >
                  <span>Local development code</span>
                  <strong>{devCode}</strong>
                  <small>Click to copy</small>
                </button>
              )}
              <form className={styles.form} onSubmit={submitVerification}>
                <label>
                  <span>Verification code</span>
                  <input
                    className={styles.code}
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={12}
                    placeholder="000000"
                    autoFocus
                    required
                  />
                </label>
                {notice && <p className={styles.notice}>{notice}</p>}
                {error && (
                  <p className={styles.error} role="alert">
                    {error}
                  </p>
                )}
                <button className={styles.primary} disabled={busy}>
                  {busy ? "Verifying…" : "Verify and continue"}
                  <ArrowRight />
                </button>
              </form>
              <button className={styles.modeSwitch} onClick={() => void resend()} disabled={busy}>
                Send a new code
              </button>
            </div>
          )}

          {stage === "mandate" && (
            <div className={styles.stage}>
              <button type="button" className={styles.stageBack} onClick={returnToAccount}>
                <ArrowLeft /> Back to account
              </button>
              <p className={styles.eyebrow}>Set the first boundary</p>
              <h1>
                A mandate.
                <br />
                <em>Never a blank cheque.</em>
              </h1>
              <p className={styles.lede}>
                Give Renewly a ceiling and one read-only source. Anything outside it will wait for
                you.
              </p>

              <div className={styles.connectors}>
                <a href={mailboxConnectUrl("gmail")}>
                  <Mail />
                  <span>
                    <strong>Connect Gmail</strong>
                    <small>Billing mail only · read-only</small>
                  </span>
                  <ArrowRight />
                </a>
              </div>
              {activeMailbox && (
                <p className={styles.notice}>
                  <Check />
                  {activeMailbox.emailAddress} is connected through {activeMailbox.provider}.
                </p>
              )}
              {notice && (
                <p className={styles.notice}>
                  <Check />
                  {notice}
                </p>
              )}

              <form className={styles.form} onSubmit={saveMandate}>
                <div className={styles.mandateSheet}>
                  <label>
                    <span>Monthly recurring budget</span>
                    <div className={styles.moneyInput}>
                      <b>$</b>
                      <input
                        value={settings.budget}
                        onChange={(event) =>
                          setSettings({ ...settings, budget: event.target.value })
                        }
                        inputMode="decimal"
                        pattern="\d+(\.\d{1,2})?"
                        required
                      />
                    </div>
                    <small>The total envelope you want Renewly to watch.</small>
                  </label>
                  <label>
                    <span>Ask me above</span>
                    <div className={styles.moneyInput}>
                      <b>$</b>
                      <input
                        value={settings.ceiling}
                        onChange={(event) =>
                          setSettings({ ...settings, ceiling: event.target.value })
                        }
                        inputMode="decimal"
                        pattern="\d+(\.\d{1,2})?"
                        required
                      />
                    </div>
                    <small>Each action above this amount waits for approval.</small>
                  </label>
                  <label>
                    <span>Where we text you</span>
                    <input
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="+1 555 010 4477"
                      value={settings.phone}
                      onChange={(event) => setSettings({ ...settings, phone: event.target.value })}
                      required
                    />
                    <small>
                      Every renewal is proposed here first. Reply to approve — nothing is paid
                      without you.
                    </small>
                  </label>
                  <label>
                    <span>People in the workspace</span>
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      value={settings.teamSize}
                      onChange={(event) =>
                        setSettings({ ...settings, teamSize: event.target.value })
                      }
                      required
                    />
                    <small>Used to spot surplus seats.</small>
                  </label>
                </div>
                <div className={styles.assurances}>
                  <span>
                    <ShieldCheck /> Human approval above ${settings.ceiling || "0"}
                  </span>
                  <span>
                    <Sparkles /> Policy can be changed any time
                  </span>
                </div>
                {error && (
                  <p className={styles.error} role="alert">
                    {error}
                  </p>
                )}
                {!activeMailbox && (
                  <p className={styles.connectionRequired}>
                    A verified, read-only Gmail connection is required to continue.
                  </p>
                )}
                <button
                  className={styles.primary}
                  disabled={busy || !authVerified || !activeMailbox}
                >
                  {busy
                    ? "Checking your access…"
                    : activeMailbox
                      ? "Enter the control room"
                      : "Connect mail to continue"}
                  <ArrowRight />
                </button>
              </form>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingState}>
          <Wordmark size={30} />
          <span>Preparing your workspace…</span>
        </div>
      }
    >
      <OnboardingContent />
    </Suspense>
  );
}
