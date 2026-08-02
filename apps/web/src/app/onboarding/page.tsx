"use client";

import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
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
import type { MeResponse, PublicUser } from "@/lib/api/types";
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
    microsoftRedirect: boolean;
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

function OnboardingContent() {
  const router = useRouter();
  const search = useSearchParams();
  const [stage, setStage] = useState<Stage>("account");
  const [mode, setMode] = useState<AuthMode>(search.get("mode") === "login" ? "login" : "signup");
  const [providers, setProviders] = useState<AuthConfig["providers"] | null>(null);
  const [email, setEmail] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    search.get("error") === "access_denied" ? "Sign-in was cancelled. Nothing changed." : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState({ budget: "200.00", ceiling: "50.00", teamSize: "1" });

  useEffect(() => {
    void apiFetch<AuthConfig>("/v1/auth/config")
      .then((value) => setProviders(value.providers))
      .catch(() => null);

    void apiFetch<MeResponse>("/v1/me")
      .then((me) => {
        setEmail(me.user.email);
        if (me.user.emailVerified) {
          setSettings({
            budget: me.settings.aiMonthlyBudget ?? "200.00",
            ceiling: me.settings.spendCeiling ?? "50.00",
            teamSize: String(me.settings.teamSize),
          });
          setStage("mandate");
        } else {
          setStage("verify");
        }
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    const connected = search.get("mailbox");
    const address = search.get("address");
    if (connected === "connected") setNotice(`${address ?? "Mailbox"} is now connected read-only.`);
    if (search.get("mailbox_error"))
      setNotice("Mailbox access was declined. You can connect it later.");
  }, [search]);

  const progress = useMemo(() => ({ account: 1, verify: 2, mandate: 3 })[stage], [stage]);

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
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
        setStage(response.user.emailVerified ? "mandate" : "verify");
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
      const me = await apiFetch<MeResponse>("/v1/me");
      setSettings({
        budget: me.settings.aiMonthlyBudget ?? "200.00",
        ceiling: me.settings.spendCeiling ?? "50.00",
        teamSize: String(me.settings.teamSize),
      });
      setStage("mandate");
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
      setError(fieldError(caught));
    } finally {
      setBusy(false);
    }
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
                {mode === "signup" ? "Begin with your mandate" : "Welcome back"}
              </p>
              <h1>
                {mode === "signup" ? (
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
                {mode === "signup"
                  ? "Create the workspace that will hold your recurring commitments, rules, and proof."
                  : "Sign in to resume your agent and its finance-grade memory."}
              </p>

              {(providers?.googleRedirect || providers?.microsoftRedirect) && (
                <div className={styles.socials}>
                  {providers.googleRedirect && (
                    <a href={oauthUrl("google")}>
                      <span className={styles.google}>G</span> Continue with Google
                    </a>
                  )}
                  {providers.microsoftRedirect && (
                    <a href={oauthUrl("microsoft")}>
                      <span className={styles.microsoft}>⊞</span> Continue with Microsoft
                    </a>
                  )}
                </div>
              )}

              {providers && (providers.googleRedirect || providers.microsoftRedirect) && (
                <div className={styles.or}>
                  <span>or use email</span>
                </div>
              )}

              <form className={styles.form} onSubmit={submitAccount}>
                {mode === "signup" && (
                  <div className={styles.twoFields}>
                    <label>
                      <span>Your name</span>
                      <input name="name" autoComplete="name" placeholder="Ada Lovelace" required />
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
                      placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
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
                <button className={styles.primary} disabled={busy}>
                  {busy
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
            </div>
          )}

          {stage === "verify" && (
            <div className={styles.stage}>
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
                <a href={mailboxConnectUrl("outlook")}>
                  <Mail />
                  <span>
                    <strong>Connect Outlook</strong>
                    <small>Billing mail only · read-only</small>
                  </span>
                  <ArrowRight />
                </a>
              </div>
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
                <button className={styles.primary} disabled={busy}>
                  {busy ? "Saving your mandate…" : "Enter the control room"}
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
