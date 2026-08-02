"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleStop,
  ExternalLink,
  FileText,
  FolderOpen,
  LoaderCircle,
  Mail,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Artwork } from "@/components/site/Artwork";
import { apiFetch, API_ORIGIN, mailboxConnectUrl, RenewlyApiError } from "@/lib/api/client";
import type {
  AgentEvent,
  AgentPrompt,
  AgentSession,
  MailboxConnection,
  MeResponse,
  NewsArticle,
  SubscriptionDto,
  WorkspaceSettings,
} from "@/lib/api/types";
import styles from "./AgenticDashboard.module.css";

/**
 * How far back a sweep reads. Mirrors LOOKBACK_DAYS on the API, which is the
 * authority — it rejects anything not in this set, so the two lists have to
 * agree. A month is the default because every monthly plan bills at least once
 * inside it, and each wider window re-reads the mailbox in full.
 */
const LOOKBACK_OPTIONS = [
  { days: 15, label: "15 days" },
  { days: 30, label: "1 month" },
  { days: 60, label: "2 months" },
  { days: 90, label: "3 months" },
] as const;

const DEFAULT_LOOKBACK_DAYS = 30;

const EVENT_TYPES = [
  "session.started",
  "step.started",
  "step.progress",
  "step.completed",
  "log",
  "finding",
  "prompt",
  "prompt.answered",
  "proposal.sent",
  "session.completed",
  "session.failed",
  "error",
];

const readable = (value: string) =>
  value.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function money(amount: string | null, currency = "USD") {
  if (amount === null) return "Not set";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(amount));
}

function shortDate(value: string | null) {
  if (!value) return "Date unknown";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}

function relativeNewsDate(value: string) {
  const days = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

function eventCopy(event: AgentEvent): { title: string; body?: string; tone?: string } {
  const payload = event.payload;
  const message = typeof payload.message === "string" ? payload.message : undefined;
  switch (event.type) {
    case "session.started":
      return {
        title: `${readable(String(payload.kind ?? "agent"))} run opened`,
        body: "The append-only session is ready and its event stream is attached.",
      };
    case "step.started":
      return { title: String(payload.label ?? readable(event.step ?? "Working")), tone: "working" };
    case "step.progress":
      return {
        title: message ?? "Working",
        body:
          typeof payload.total === "number"
            ? `${payload.current ?? 0} of ${payload.total}`
            : undefined,
        tone: "working",
      };
    case "step.completed":
      return {
        title: `${readable(event.step ?? "Step")} settled`,
        body: summarizePayload(payload),
        tone: "done",
      };
    case "finding":
      return {
        title: readable(String(payload.kind ?? "Finding")),
        body: summarizePayload(payload),
        tone: "finding",
      };
    case "prompt":
      return {
        title: "Your authority is required",
        body: String(payload.question ?? "The agent is waiting for an answer."),
        tone: "prompt",
      };
    case "prompt.answered":
      return {
        title: "Instruction recorded",
        body: `Answer: ${String(payload.answer ?? "—")}`,
        tone: "done",
      };
    case "proposal.sent":
      return {
        title: "Proposal sent",
        body: `Delivered via ${String(payload.channel ?? "your channel")}.`,
        tone: "finding",
      };
    case "session.completed":
      return { title: "Run complete", body: summarizePayload(payload), tone: "done" };
    case "session.failed":
      return {
        title: "Run stopped",
        body: message ?? "The worker could not finish this run.",
        tone: "error",
      };
    case "error":
      return { title: "The agent recovered from an error", body: message, tone: "error" };
    default:
      return { title: message ?? readable(event.type), body: summarizePayload(payload) };
  }
}

function summarizePayload(payload: Record<string, unknown>) {
  const entries = Object.entries(payload).filter(([, value]) =>
    ["string", "number", "boolean"].includes(typeof value),
  );
  return (
    entries
      .slice(0, 3)
      .map(([key, value]) => `${readable(key)}: ${String(value)}`)
      .join(" · ") || undefined
  );
}

interface DashboardData {
  me: MeResponse;
  mailboxes: MailboxConnection[];
  subscriptions: SubscriptionDto[];
  settings: WorkspaceSettings;
  session: AgentSession | null;
  prompts: AgentPrompt[];
  events: AgentEvent[];
}

export function AgenticDashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"offline" | "connecting" | "live">("offline");
  const [promptAnswer, setPromptAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [newsState, setNewsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [lookbackDays, setLookbackDays] = useState<number>(DEFAULT_LOOKBACK_DAYS);
  const eventCursor = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const sessionId = data?.session?.id;
  const sessionStatus = data?.session?.status;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [me, mailboxResponse, subscriptionResponse, settingsResponse, latest] =
        await Promise.all([
          apiFetch<MeResponse>("/v1/me"),
          apiFetch<{ connections: MailboxConnection[] }>("/v1/mailbox"),
          apiFetch<{ subscriptions: SubscriptionDto[] }>("/v1/subscriptions?limit=50"),
          apiFetch<{ settings: WorkspaceSettings }>("/v1/settings"),
          apiFetch<{ session: AgentSession | null; openPrompts: AgentPrompt[] }>(
            "/v1/agent/sessions/latest",
          ),
        ]);
      if (!me.user.emailVerified) {
        router.replace("/onboarding");
        return;
      }
      const eventsResponse = latest.session
        ? await apiFetch<{ events: AgentEvent[] }>(
            `/v1/agent/sessions/${latest.session.id}/events?after=0&limit=500`,
          )
        : { events: [] };
      eventCursor.current = eventsResponse.events.at(-1)?.seq ?? 0;
      setData({
        me,
        mailboxes: mailboxResponse.connections,
        subscriptions: subscriptionResponse.subscriptions,
        settings: settingsResponse.settings,
        session: latest.session,
        prompts: latest.openPrompts,
        events: eventsResponse.events,
      });
    } catch (caught) {
      if (
        caught instanceof RenewlyApiError &&
        (caught.code === "UNAUTHORIZED" || caught.code === "EMAIL_NOT_VERIFIED")
      ) {
        router.replace(
          caught.code === "EMAIL_NOT_VERIFIED" ? "/onboarding" : "/onboarding?mode=login",
        );
        return;
      }
      setError(caught instanceof Error ? caught.message : "The control plane did not answer.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (
      !sessionId ||
      !sessionStatus ||
      ["completed", "failed", "cancelled"].includes(sessionStatus)
    ) {
      setStreamState("offline");
      return;
    }
    setStreamState("connecting");
    const source = new EventSource(
      `${API_ORIGIN}/v1/agent/sessions/${sessionId}/stream?after=${eventCursor.current}`,
      { withCredentials: true },
    );
    const onOpen = () => setStreamState("live");
    const onAgentEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as AgentEvent;
      eventCursor.current = Math.max(eventCursor.current, event.seq);
      setData((current) =>
        current
          ? {
              ...current,
              events: current.events.some((known) => known.seq === event.seq)
                ? current.events
                : [...current.events, event],
            }
          : current,
      );
      if (
        event.type === "prompt" ||
        event.type === "prompt.answered" ||
        event.type.startsWith("session.")
      ) {
        void apiFetch<{ session: AgentSession; openPrompts: AgentPrompt[] }>(
          `/v1/agent/sessions/${sessionId}`,
        )
          .then((fresh) =>
            setData((current) =>
              current
                ? { ...current, session: fresh.session, prompts: fresh.openPrompts }
                : current,
            ),
          )
          .catch((caught) =>
            setError(caught instanceof Error ? caught.message : "The session did not refresh."),
          );
      }
    };
    EVENT_TYPES.forEach((name) => source.addEventListener(name, onAgentEvent as EventListener));
    source.addEventListener("stream.open", onOpen);
    source.addEventListener("stream.close", () => {
      source.close();
      setStreamState("offline");
      void load();
    });
    source.onerror = () => setStreamState("connecting");
    return () => source.close();
  }, [sessionId, sessionStatus, load]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [data?.events.length, data?.prompts.length]);

  const merchantNames = useMemo(
    () =>
      [
        ...new Set(
          (data?.subscriptions ?? [])
            .filter((sub) => sub.status === "active")
            .map((sub) => sub.merchantName),
        ),
      ].slice(0, 4),
    [data?.subscriptions],
  );

  useEffect(() => {
    if (merchantNames.length === 0) {
      setNews([]);
      setNewsState("ready");
      return;
    }
    const controller = new AbortController();
    setNewsState("loading");
    const params = new URLSearchParams();
    merchantNames.forEach((company) => params.append("company", company));
    fetch(`/api/news?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("News unavailable");
        return response.json() as Promise<{ articles: NewsArticle[] }>;
      })
      .then((result) => {
        setNews(result.articles);
        setNewsState("ready");
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setNewsState("error");
      });
    return () => controller.abort();
  }, [merchantNames]);

  async function startRun(kind: AgentSession["kind"] = "detect") {
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<{ session: AgentSession }>("/v1/agent/sessions", {
        method: "POST",
        body: JSON.stringify({ kind, lookbackDays }),
      });
      eventCursor.current = 0;
      setData((current) =>
        current ? { ...current, session: result.session, prompts: [], events: [] } : current,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The run could not be started.");
    } finally {
      setSaving(false);
    }
  }

  async function cancelRun() {
    if (!data?.session) return;
    setSaving(true);
    try {
      const result = await apiFetch<{ session: AgentSession }>(
        `/v1/agent/sessions/${data.session.id}/cancel`,
        { method: "POST" },
      );
      setData({ ...data, session: result.session, prompts: [] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The run could not be stopped.");
    } finally {
      setSaving(false);
    }
  }

  async function answerPrompt(answer: string) {
    if (!data?.session || !data.prompts[0] || !answer.trim()) return;
    const prompt = data.prompts[0];
    setSaving(true);
    try {
      await apiFetch(`/v1/agent/sessions/${data.session.id}/input`, {
        method: "POST",
        body: JSON.stringify({ promptKey: prompt.promptKey, answer: answer.trim() }),
      });
      const fresh = await apiFetch<{ session: AgentSession; openPrompts: AgentPrompt[] }>(
        `/v1/agent/sessions/${data.session.id}`,
      );
      setData({ ...data, session: fresh.session, prompts: fresh.openPrompts });
      setPromptAnswer("");
    } catch (caught) {
      if (caught instanceof RenewlyApiError && caught.code === "CONFLICT") await load();
      else setError(caught instanceof Error ? caught.message : "That answer was not recorded.");
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    const values = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const result = await apiFetch<{ settings: WorkspaceSettings }>("/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({
          aiMonthlyBudget: String(values.get("budget") || "") || null,
          spendCeiling: String(values.get("ceiling") || "") || null,
        }),
      });
      setData({ ...data, settings: result.settings });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Policy was not saved.");
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    try {
      await apiFetch("/v1/auth/logout", { method: "POST" });
      router.replace("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign out failed.");
    }
  }

  if (loading)
    return (
      <div className={styles.loading}>
        <span className={styles.loadingMark}>Renewly</span>
        <p>Opening the control room…</p>
      </div>
    );
  if (!data)
    return (
      <div className={styles.loading}>
        <span className={styles.loadingMark}>Renewly</span>
        <h1>The control plane is quiet.</h1>
        <p>{error}</p>
        <button
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          <RefreshCw /> Try again
        </button>
      </div>
    );

  const activeSubscriptions = data.subscriptions.filter(
    (sub) => sub.status === "active" || sub.status === "pending_cancel",
  );
  const openPrompt = data.prompts[0];
  const canStart =
    !data.session || ["completed", "failed", "cancelled"].includes(data.session.status);
  const running = data.session && ["running", "awaiting_input"].includes(data.session.status);

  return (
    <main className={styles.cockpit}>
      <header className={styles.header}>
        <Link href="/" aria-label="Renewly home" className={styles.wordmark}>
          Renewly
        </Link>
        <div className={styles.workspace}>
          <span>{data.me.workspace.name}</span>
          <i />{" "}
          <small>
            {streamState === "live"
              ? "Agent stream live"
              : running
                ? "Reconnecting"
                : "Agent at rest"}
          </small>
        </div>
        <nav>
          <a href="#subscriptions">Commitments</a>
          <a href="#configuration">Mandate</a>
          <button onClick={() => void logout()}>Sign out</button>
        </nav>
      </header>

      {error && (
        <div className={styles.globalError} role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <section className={styles.terminal} aria-labelledby="agent-heading">
        <aside className={styles.agentField}>
          <Artwork scene="agent" className={styles.terminalArtwork} />
          <div className={styles.terminalScrim} />
          <div className={styles.terminalHead}>
            <div>
              <p>{data.me.workspace.name}</p>
              <h1 id="agent-heading">
                {openPrompt
                  ? "One decision needs your authority."
                  : running
                    ? "The field is being read."
                    : "Recurring spend, held to your law."}
              </h1>
            </div>
            <div className={styles.runControls}>
              {canStart ? (
                <>
                  {/* Offered before the run, not during: the window is fixed
                      once a sweep has started reading. */}
                  <fieldset className={styles.lookback}>
                    <legend>Read the last</legend>
                    <div role="radiogroup" aria-label="How far back to read the mailbox">
                      {LOOKBACK_OPTIONS.map((option) => (
                        <button
                          key={option.days}
                          type="button"
                          role="radio"
                          aria-checked={lookbackDays === option.days}
                          data-selected={lookbackDays === option.days}
                          disabled={saving}
                          onClick={() => setLookbackDays(option.days)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <button onClick={() => void startRun("detect")} disabled={saving}>
                    <Play /> Begin a sweep
                  </button>
                </>
              ) : (
                <button onClick={() => void cancelRun()} disabled={saving}>
                  <CircleStop /> Stop this run
                </button>
              )}
              <span data-live={streamState === "live"}>
                {streamState === "live"
                  ? "Live now"
                  : data.session?.status
                    ? readable(data.session.status)
                    : "Ready when you are"}
              </span>
            </div>
          </div>
          <p className={styles.fieldNote}>
            Read-only signals first. Explicit authority before action. A receipt after every
            outcome.
          </p>
        </aside>

        <section className={styles.conversation} aria-label="Agent workspace thread">
          <header className={styles.conversationHeader}>
            <div>
              <p>Workspace thread</p>
              <span>
                {data.session
                  ? `${readable(data.session.kind)} · ${readable(data.session.status)}`
                  : "No active run"}
              </span>
            </div>
            <span>{data.events.length} durable events</span>
          </header>

          <div className={styles.transcript} ref={transcriptRef} aria-live="polite">
            {data.events.length === 0 ? (
              <div className={styles.emptyTranscript}>
                <span className={styles.emptyRule} />
                <p>The ledger is ready for its first reading.</p>
                <span>
                  Begin a sweep when you want Renewly to read the workspace. Nothing appears here
                  unless the control plane returns it.
                </span>
              </div>
            ) : (
              data.events.map((event) => {
                const copy = eventCopy(event);
                const current =
                  typeof event.payload.current === "number" ? event.payload.current : null;
                const total = typeof event.payload.total === "number" ? event.payload.total : null;
                return (
                  <article className={styles.event} data-tone={copy.tone} key={event.seq}>
                    <div className={styles.eventRail}>
                      <i />
                      {copy.tone === "working" ? (
                        <LoaderCircle className={styles.spin} />
                      ) : copy.tone === "done" ? (
                        <Check />
                      ) : (
                        <ChevronRight />
                      )}
                    </div>
                    <div>
                      <span>
                        {String(event.seq).padStart(2, "0")} ·{" "}
                        {event.step ? readable(event.step) : "Session"}
                      </span>
                      <h2>{copy.title}</h2>
                      {copy.body && <p>{copy.body}</p>}
                      {current !== null && total ? (
                        <div className={styles.eventProgress}>
                          <i style={{ width: `${Math.min(100, (current / total) * 100)}%` }} />
                        </div>
                      ) : null}
                    </div>
                    <time>
                      {new Date(event.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </article>
                );
              })
            )}
          </div>

          <div className={styles.promptBar} data-active={Boolean(openPrompt)}>
            <span
              className={styles.agentState}
              data-active={Boolean(openPrompt || running)}
              aria-hidden="true"
            />
            {openPrompt ? (
              <div className={styles.promptBody}>
                <p>{openPrompt.question}</p>
                {openPrompt.options.length > 0 ? (
                  <div className={styles.promptOptions}>
                    {openPrompt.options.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => void answerPrompt(option.value)}
                        disabled={saving}
                      >
                        <strong>{option.label}</strong>
                        {option.description && <small>{option.description}</small>}
                      </button>
                    ))}
                  </div>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void answerPrompt(promptAnswer);
                    }}
                  >
                    <input
                      value={promptAnswer}
                      onChange={(event) => setPromptAnswer(event.target.value)}
                      placeholder="Write your instruction"
                      autoFocus
                    />
                    <button disabled={saving || !promptAnswer.trim()} aria-label="Send answer">
                      <ArrowRight />
                    </button>
                  </form>
                )}
                {openPrompt.skippable && (
                  <button className={styles.skip} onClick={() => void answerPrompt("skip")}>
                    Skip this question
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.terminalIdle}>
                <p>{running ? "Renewly has the floor." : "No decision is waiting."}</p>
                <span>
                  {running
                    ? "New evidence and questions will settle here as they arrive."
                    : "Begin a sweep from the photograph when you want another reading."}
                </span>
              </div>
            )}
          </div>
        </section>
      </section>

      <section className={styles.operations} aria-labelledby="workspace-evidence">
        <header className={styles.operationsIntro}>
          <div>
            <p>Workspace evidence</p>
            <h2 id="workspace-evidence">The commitments, context and law behind every move.</h2>
          </div>
          <p>
            Every row is read from your connected workspace. If a source fails, the failure stays
            visible here instead of being replaced with a plausible number.
          </p>
        </header>

        <div className={styles.lowerGrid}>
          <section className={styles.panel} id="subscriptions">
            <PanelHeader label="Live commitments" meta={`${activeSubscriptions.length} found`} />
            <div className={styles.panelBody}>
              {activeSubscriptions.length === 0 ? (
                <EmptyPanel
                  icon={<FileText />}
                  title="No subscriptions yet"
                  body={
                    data.mailboxes.some((mailbox) => mailbox.status === "active")
                      ? "Your mailbox is connected. Run a detect sweep when receipts are ready."
                      : "Connect a mailbox so Renewly can read billing receipts."
                  }
                  action={
                    !data.mailboxes.some((mailbox) => mailbox.status === "active") ? (
                      <a href={mailboxConnectUrl("gmail", "/agent")}>
                        Connect Gmail <ArrowRight />
                      </a>
                    ) : undefined
                  }
                />
              ) : (
                <ul className={styles.subscriptions}>
                  {activeSubscriptions.map((sub) => (
                    <li key={sub.id}>
                      <span className={styles.vendorMark}>
                        {sub.merchantName.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <strong>{sub.merchantName}</strong>
                        <small>
                          {sub.planName ?? readable(sub.billingCycle)} · renews{" "}
                          {shortDate(sub.nextRenewalAt)}
                        </small>
                      </div>
                      <div className={styles.subMoney}>
                        <strong>{money(sub.amount, sub.currency)}</strong>
                        <small>
                          /
                          {sub.billingCycle === "yearly"
                            ? "yr"
                            : sub.billingCycle === "weekly"
                              ? "wk"
                              : "mo"}
                        </small>
                        {sub.requiresConfirmation && <em>Verify</em>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <PanelHeader
              label="Company field notes"
              meta={newsState === "loading" ? "Reading" : `${news.length} recent`}
            />
            <div className={styles.panelBody}>
              {newsState === "loading" ? (
                <div className={styles.newsLoading}>
                  <LoaderCircle className={styles.spin} />
                  <p>Reading public company sources…</p>
                </div>
              ) : newsState === "error" ? (
                <EmptyPanel
                  icon={<FolderOpen />}
                  title="Company news could not be loaded"
                  body="The public news API failed. No substitute articles or sample data are being shown."
                  action={
                    <button onClick={() => location.reload()}>
                      Try again <RefreshCw />
                    </button>
                  }
                />
              ) : news.length === 0 ? (
                <EmptyPanel
                  icon={<FolderOpen />}
                  title="No relevant coverage found"
                  body={
                    activeSubscriptions.length
                      ? "There are no recent public stories for these companies."
                      : "Company news will appear after subscriptions are detected."
                  }
                />
              ) : (
                <ul className={styles.news}>
                  {news.map((article) => (
                    <li key={`${article.url}-${article.company}`}>
                      <a href={article.url} target="_blank" rel="noreferrer">
                        <span>
                          {article.company} · {relativeNewsDate(article.publishedAt)}
                        </span>
                        <strong>{article.title}</strong>
                        <small>
                          {article.source}
                          <ExternalLink />
                        </small>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className={styles.panel} id="configuration">
            <PanelHeader
              label="Mandate & connections"
              meta={`Policy v${data.settings.policyVersion}`}
            />
            <div className={styles.panelBody}>
              <div className={styles.connections}>
                <p>Connected mail</p>
                {data.mailboxes
                  .filter((mailbox) => mailbox.status !== "revoked")
                  .map((mailbox) => (
                    <div key={mailbox.id}>
                      <Mail />
                      <span>
                        <strong>{mailbox.emailAddress}</strong>
                        <small>
                          {readable(mailbox.provider)} · {readable(mailbox.status)}
                        </small>
                      </span>
                      <i data-ok={mailbox.status === "active"} />
                    </div>
                  ))}
                {data.mailboxes.filter((mailbox) => mailbox.status !== "revoked").length === 0 && (
                  <span className={styles.noConnection}>
                    No read-only mail source{" "}
                    <a href={mailboxConnectUrl("gmail", "/agent")}>Connect</a>
                  </span>
                )}
              </div>
              <form className={styles.policy} onSubmit={saveSettings}>
                <label>
                  <span>Monthly max cap</span>
                  <div>
                    <b>$</b>
                    <input
                      name="budget"
                      defaultValue={data.settings.aiMonthlyBudget ?? ""}
                      inputMode="decimal"
                      placeholder="No cap"
                    />
                  </div>
                </label>
                <label>
                  <span>Ask above</span>
                  <div>
                    <b>$</b>
                    <input
                      name="ceiling"
                      defaultValue={data.settings.spendCeiling ?? ""}
                      inputMode="decimal"
                      placeholder="Always ask"
                    />
                  </div>
                </label>
                <div className={styles.policyState}>
                  <ShieldCheck />
                  <span>
                    <strong>{readable(data.settings.approvalMode)}</strong>
                    <small>
                      {data.settings.killSwitch ? "Agent spend is stopped" : "Kill switch ready"}
                    </small>
                  </span>
                </div>
                <button disabled={saving}>{saving ? "Saving…" : "Save mandate"}</button>
              </form>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function PanelHeader({ label, meta }: { label: string; meta: string }) {
  return (
    <header className={styles.panelHeader}>
      <h2>{label}</h2>
      <span>{meta}</span>
    </header>
  );
}

function EmptyPanel({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.emptyPanel}>
      <span className={styles.emptyIcon}>{icon}</span>
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}
