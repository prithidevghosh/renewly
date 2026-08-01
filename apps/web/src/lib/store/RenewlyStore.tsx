"use client";

/**
 * Client-side application store.
 *
 * Holds the whole mocked world so that an approval made in the agent chat is
 * immediately visible in the dashboard, the opportunities list and the ledger —
 * the Detect → Propose → Approve → Execute → Prove loop has to be felt across
 * screens, not just inside one.
 *
 * Every mutation delegates to `lib/mock/mockApi`. When the real backend lands,
 * this file stays as-is; only mockApi changes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Action,
  ChatMessage,
  Guardrails,
  LedgerEntry,
  Opportunity,
  Source,
  SpendSummary,
  Subscription,
  User,
} from "@/lib/domain/types";
import * as api from "@/lib/mock/mockApi";

interface RenewlyState {
  ready: boolean;
  user: User | null;
  sources: Source[];
  subscriptions: Subscription[];
  opportunities: Opportunity[];
  actions: Action[];
  ledger: LedgerEntry[];
  summary: SpendSummary | null;
  chat: ChatMessage[];

  /** Opportunity currently queued for the passkey sheet, if any. */
  pendingApproval: Opportunity | null;

  openApproval: (opportunityId: string) => void;
  closeApproval: () => void;
  /** Full approve → execute run. Returns the completed action. */
  runAction: (opportunityId: string) => Promise<Action | null>;
  dismiss: (opportunityId: string) => Promise<void>;
  connect: (sourceId: string) => Promise<void>;
  saveGuardrails: (patch: Partial<Guardrails>) => Promise<void>;
  revokeAll: () => Promise<void>;

  pushMessage: (msg: Omit<ChatMessage, "id" | "at"> & { id?: string }) => string;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  /** The action currently mid-execution, for the live trace. */
  liveAction: Action | null;
}

const Ctx = createContext<RenewlyState | null>(null);

let msgCounter = 0;
const nextId = (prefix: string) => `${prefix}_${(msgCounter += 1)}`;

export function RenewlyProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [pendingApproval, setPendingApproval] = useState<Opportunity | null>(null);
  const [liveAction, setLiveAction] = useState<Action | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* ---------------------------------------------------------------- load -- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [u, src, subs, opps, acts, led, chatHistory] = await Promise.all([
        api.getUser(),
        api.getSources(),
        api.getSubscriptions(),
        api.getOpportunities(),
        api.getActions(),
        api.getLedger(),
        api.getChatHistory(),
      ]);
      if (cancelled) return;
      setUser(u);
      setSources(src);
      setSubscriptions(subs);
      setOpportunities(opps);
      setActions(acts);
      setLedger(led);
      setChat(chatHistory);
      setSummary(api.computeSummary(subs, opps, led));
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Re-pull everything after a mutation so all screens agree. */
  const refresh = useCallback(async () => {
    const [subs, opps, acts, led] = await Promise.all([
      api.getSubscriptions(),
      api.getOpportunities(),
      api.getActions(),
      api.getLedger(),
    ]);
    if (!mounted.current) return;
    setSubscriptions(subs);
    setOpportunities(opps);
    setActions(acts);
    setLedger(led);
    setSummary(api.computeSummary(subs, opps, led));
  }, []);

  /* ---------------------------------------------------------------- chat -- */
  const pushMessage = useCallback((msg: Omit<ChatMessage, "id" | "at"> & { id?: string }) => {
    const id = msg.id ?? nextId("msg");
    setChat((prev) => [...prev, { ...msg, id, at: new Date().toISOString() }]);
    return id;
  }, []);

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setChat((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  /* ------------------------------------------------------------ approval -- */
  const openApproval = useCallback(
    (opportunityId: string) => {
      const opp = opportunities.find((o) => o.id === opportunityId);
      if (opp) setPendingApproval(opp);
    },
    [opportunities],
  );

  const closeApproval = useCallback(() => setPendingApproval(null), []);

  /**
   * The commit. Propose → approve → execute, streaming step updates into
   * `liveAction` so the execution trace animates in real time.
   */
  const runAction = useCallback(
    async (opportunityId: string): Promise<Action | null> => {
      try {
        const proposed = await api.proposeAction(opportunityId);
        const approved = await api.approveAction(proposed.id);
        if (mounted.current) setLiveAction(approved);

        const done = await api.executeAction(approved.id, (a) => {
          if (mounted.current) setLiveAction(a);
        });

        await refresh();
        if (mounted.current) setLiveAction(done);
        return done;
      } catch {
        if (mounted.current) setLiveAction(null);
        return null;
      }
    },
    [refresh],
  );

  const dismiss = useCallback(
    async (opportunityId: string) => {
      await api.dismissOpportunity(opportunityId);
      await refresh();
    },
    [refresh],
  );

  const connect = useCallback(async (sourceId: string) => {
    await api.connectSource(sourceId, () => {
      api.getSources().then((s) => mounted.current && setSources(s));
    });
    const s = await api.getSources();
    if (mounted.current) setSources(s);
  }, []);

  const saveGuardrails = useCallback(async (patch: Partial<Guardrails>) => {
    const next = await api.updateGuardrails(patch);
    if (mounted.current) setUser((u) => (u ? { ...u, guardrails: next } : u));
  }, []);

  const revokeAll = useCallback(async () => {
    await api.revokeAgentAccess();
    const [s, u, led] = await Promise.all([api.getSources(), api.getUser(), api.getLedger()]);
    if (!mounted.current) return;
    setSources(s);
    setUser(u);
    setLedger(led);
  }, []);

  const value = useMemo<RenewlyState>(
    () => ({
      ready,
      user,
      sources,
      subscriptions,
      opportunities,
      actions,
      ledger,
      summary,
      chat,
      pendingApproval,
      liveAction,
      openApproval,
      closeApproval,
      runAction,
      dismiss,
      connect,
      saveGuardrails,
      revokeAll,
      pushMessage,
      updateMessage,
    }),
    [
      ready,
      user,
      sources,
      subscriptions,
      opportunities,
      actions,
      ledger,
      summary,
      chat,
      pendingApproval,
      liveAction,
      openApproval,
      closeApproval,
      runAction,
      dismiss,
      connect,
      saveGuardrails,
      revokeAll,
      pushMessage,
      updateMessage,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRenewly(): RenewlyState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRenewly must be used inside <RenewlyProvider>");
  return ctx;
}
