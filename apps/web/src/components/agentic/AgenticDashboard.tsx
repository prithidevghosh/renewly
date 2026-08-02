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
  Inbox,
  LoaderCircle,
  LogOut,
  Mail,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Mark, Wordmark } from "@/components/brand/Mark";
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
        ).then((fresh) =>
          setData((current) =>
            current ? { ...current, session: fresh.session, prompts: fresh.openPrompts } : current,
          ),
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
        body: JSON.stringify({ kind }),
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
    } finally {
      router.replace("/");
    }
  }

  if (loading)
    return (
      <div className={styles.loading}>
        <Mark state="scanning" size={40} />
        <p>Opening the control room…</p>
      </div>
    );
  if (!data)
    return (
      <div className={styles.loading}>
        <Mark size={40} />
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
        <Link href="/" aria-label="Renewly home">
          <Wordmark size={25} />
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
          <Link href="/ledger">Ledger</Link>
          <Link href="/settings">Settings</Link>
          <button onClick={() => void logout()} aria-label="Sign out">
            <LogOut />
          </button>
        </nav>
      </header>

      {error && (
        <div className={styles.globalError} role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <section className={styles.terminal}>
        <div className={styles.terminalHead}>
          <div>
            <p>Live agent terminal</p>
            <h1>
              {openPrompt
                ? "A decision is waiting for you."
                : running
                  ? "Renewly is reading the field."
                  : "Everything recurring, under one law."}
            </h1>
          </div>
          <div className={styles.runControls}>
            {canStart ? (
              <button onClick={() => void startRun("detect")} disabled={saving}>
                <Play /> Run a sweep
              </button>
            ) : (
              <button onClick={() => void cancelRun()} disabled={saving}>
                <CircleStop /> Stop run
              </button>
            )}
            <span data-live={streamState === "live"}>
              {streamState === "live"
                ? "Live"
                : data.session?.status
                  ? readable(data.session.status)
                  : "Ready"}
            </span>
          </div>
        </div>

        <div className={styles.transcript} ref={transcriptRef} aria-live="polite">
          {data.events.length === 0 ? (
            <div className={styles.emptyTranscript}>
              <Sparkles />
              <p>No run has written to this ledger yet.</p>
              <span>Start a sweep. Events will survive refreshes and reconnect without gaps.</span>
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
          <Mark size={27} state={openPrompt ? "thinking" : running ? "scanning" : "idle"} />
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
                    placeholder="Type your answer"
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
              <p>{running ? "The worker has the floor." : "The agent is at rest."}</p>
              <span>
                {running
                  ? "New steps and questions will appear here as durable events."
                  : "Run a sweep when you want Renewly to look again."}
              </span>
            </div>
          )}
        </div>
      </section>

      <section className={styles.lowerGrid}>
        <section className={styles.panel}>
          <PanelHeader
            icon={<Inbox />}
            label="Live commitments"
            meta={`${activeSubscriptions.length} found`}
          />
          <div className={styles.panelBody}>
            {activeSubscriptions.length === 0 ? (
              <EmptyPanel
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
            icon={<ExternalLink />}
            label="Company field notes"
            meta={newsState === "loading" ? "Reading" : `${news.length} recent`}
          />
          <div className={styles.panelBody}>
            {newsState === "loading" ? (
              <div className={styles.newsLoading}>
                {[1, 2, 3].map((item) => (
                  <i key={item} />
                ))}
              </div>
            ) : newsState === "error" ? (
              <EmptyPanel
                title="News is temporarily quiet"
                body="Subscriptions are unaffected. We’ll try the public feeds again on refresh."
                action={
                  <button onClick={() => location.reload()}>
                    Try again <RefreshCw />
                  </button>
                }
              />
            ) : news.length === 0 ? (
              <EmptyPanel
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

        <section className={styles.panel}>
          <PanelHeader
            icon={<Settings2 />}
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
      </section>
    </main>
  );
}

function PanelHeader({
  icon,
  label,
  meta,
}: {
  icon: React.ReactNode;
  label: string;
  meta: string;
}) {
  return (
    <header className={styles.panelHeader}>
      <div>
        {icon}
        <h2>{label}</h2>
      </div>
      <span>{meta}</span>
    </header>
  );
}

function EmptyPanel({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.emptyPanel}>
      <i />
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}
