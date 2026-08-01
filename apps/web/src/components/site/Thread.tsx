"use client";

/**
 * The thread — the product, playable.
 *
 * Not one message frozen on a page: a session. Three renewals arrive in
 * sequence and each is genuinely resolvable, because the interesting thing
 * about this product is not that it can pay — it is what it does at the three
 * different kinds of edge:
 *
 *   Figma    money moves      → passkey, scoped card, receipt
 *   Loom     nothing moves    → no card and no biometric, and it says so
 *   Datadog  over the ceiling → it stops, and will not proceed until you
 *                               either approve that one or move the ceiling
 *
 * Every branch ends somewhere truthful, including the three where no money
 * moves, because the decline paths are what make the approve path believable.
 * The tally in the header only ever counts what was actually executed.
 *
 * Timing is owned by a run counter rather than a heap of cleared timeouts: any
 * new choice (or unmount) increments it, and every awaited step drops out if
 * the run it belongs to is no longer current.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Tone = "gain" | "hold";
type Line = { t: string; tone?: Tone; lead?: boolean };
type Msg = { id: number; who: "them" | "you"; lines: Line[] };

type OptKind = "approve" | "raise" | "decline";
type Opt = { label: string; kind: OptKind; primary?: boolean };

type Deal = {
  key: string;
  open: Line[][];
  prompt: string;
  options: Opt[];
  /** What the passkey authorises. 0 means no money moves, so no biometric. */
  charge: number;
  chargeLabel: string;
  realized: number;
  auth?: { nm: string; hint: string };
  exec?: string;
  done: Line[];
  declined: Line[];
  /** Shown when the ceiling is raised instead of a one-off approval. */
  raised?: Line[];
};

const DEALS: Deal[] = [
  {
    key: "figma",
    open: [
      [
        { t: "Figma renews Tuesday the 3rd — $144.", lead: true },
        { t: "Four seats. One has been opened since April." },
      ],
      [{ t: "Drop to one seat and renew: $36." }, { t: "You keep $108 this year.", tone: "gain" }],
    ],
    prompt: "One decision",
    options: [
      { label: "Approve", kind: "approve", primary: true },
      { label: "Keep all four", kind: "decline" },
    ],
    charge: 36,
    chargeLabel: "$36",
    realized: 108,
    auth: { nm: "Approve $36 to Figma", hint: "One card, one vendor, capped at $36." },
    exec: "Card minted — Figma only, capped at $36. Paid.",
    done: [
      { t: "Done. One seat, renewed at $36." },
      { t: "Three seats released. Confirmation FG-448210." },
      { t: "$108 realized.", tone: "gain" },
    ],
    declined: [
      { t: "Kept. Figma renews at $144 on the 3rd." },
      { t: "I'll flag the idle seat again in October.", tone: "hold" },
    ],
  },
  {
    key: "loom",
    open: [
      [
        { t: "Loom Business renews 12 August — $168.", lead: true },
        { t: "Two sign-ins in ninety days. Both yours." },
      ],
      [{ t: "Cancel it and keep $168 a year?" }],
    ],
    prompt: "Nothing to charge here",
    options: [
      { label: "Cancel it", kind: "approve", primary: true },
      { label: "Keep it", kind: "decline" },
    ],
    charge: 0,
    chargeLabel: "$0",
    realized: 168,
    exec: "No card and no Face ID — cancelling doesn't move money.",
    done: [
      { t: "Cancelled. Loom confirmed, no charge on the 12th." },
      { t: "Access until 11 August. Receipt LM-90114." },
      { t: "$168 realized.", tone: "gain" },
    ],
    declined: [{ t: "Kept. Loom renews at $168 on the 12th." }],
  },
  {
    key: "datadog",
    open: [
      [
        { t: "Datadog renews 26 August — $2,244.", lead: true },
        { t: "I can move you to annual for $1,796. Keeps $448." },
      ],
      [{ t: "That's over your $600 ceiling, so I've stopped.", tone: "hold" }],
    ],
    prompt: "Above your ceiling",
    options: [
      { label: "Approve this one", kind: "approve", primary: true },
      { label: "Raise the ceiling", kind: "raise" },
      { label: "Leave it", kind: "decline" },
    ],
    charge: 1796,
    chargeLabel: "$1,796",
    realized: 448,
    auth: { nm: "Approve $1,796 to Datadog", hint: "One card, one vendor, capped at $1,796." },
    exec: "Card minted — Datadog only, capped at $1,796. Paid.",
    done: [
      { t: "Done. Annual, $1,796. Confirmation DD-71330." },
      { t: "$448 realized.", tone: "gain" },
    ],
    declined: [{ t: "Left. Datadog renews at $2,244 on the 26th." }],
    raised: [
      { t: "Ceiling raised to $2,000." },
      { t: "This one sits inside it now, so it only needs your passkey." },
    ],
  },
];

const CLOSING: Line[] = [
  { t: "That's every renewal in the next thirty days." },
  { t: "I'll be back when the next one shows up." },
];

type Stage = "choose" | "auth" | "scanning" | "verified" | "busy" | "end";

/** Face ID bracket — corners, eyes and mouth light as the read completes. */
function FaceMark({ progress, done }: { progress: number; done: boolean }) {
  const lit = (t: number) => (done || progress > t ? "var(--ink)" : "var(--ink-4)");
  const ease = { transition: "stroke .45s var(--slow), fill .45s var(--slow)" };
  return (
    <svg viewBox="0 0 92 92" width="52" height="52" fill="none" aria-hidden="true">
      {(
        [
          ["M22 34V26a4 4 0 0 1 4-4h8", 0.08],
          ["M58 22h8a4 4 0 0 1 4 4v8", 0.32],
          ["M70 58v8a4 4 0 0 1-4 4h-8", 0.56],
          ["M34 70h-8a4 4 0 0 1-4-4v-8", 0.8],
        ] as const
      ).map(([d, t]) => (
        <path key={d} d={d} stroke={lit(t)} strokeWidth="2.6" strokeLinecap="round" style={ease} />
      ))}
      <circle cx="38" cy="42" r="2.4" fill={lit(0.18)} style={ease} />
      <circle cx="54" cy="42" r="2.4" fill={lit(0.18)} style={ease} />
      <path
        d="M38 56c2.5 2.5 5.5 3.5 8 3.5s5.5-1 8-3.5"
        stroke={lit(0.66)}
        strokeWidth="2.4"
        strokeLinecap="round"
        style={ease}
      />
    </svg>
  );
}

function Verified() {
  return (
    <svg viewBox="0 0 92 92" width="52" height="52" fill="none" aria-hidden="true">
      <path
        d="M30 47l11 11 21-24"
        stroke="var(--sage)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const money = (n: number) => "$" + n.toLocaleString("en-US");

export function Thread() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [stage, setStage] = useState<Stage>("busy");
  const [deal, setDeal] = useState(0);
  const [typing, setTyping] = useState(false);
  const [progress, setProgress] = useState(0);
  const [realized, setRealized] = useState(0);
  const [reduce, setReduce] = useState(false);
  const [started, setStarted] = useState(false);

  const run = useRef(0);
  const seq = useRef(0);
  const stream = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    return () => {
      run.current += 1; // anything still in flight stops touching state
    };
  }, []);

  /* the stream keeps its own horizon */
  useEffect(() => {
    const el = stream.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, typing, stage]);

  const wait = useCallback(
    (ms: number) => new Promise<void>((r) => setTimeout(r, reduce ? 0 : ms)),
    [reduce],
  );

  const say = useCallback(
    async (id: number, who: Msg["who"], lines: Line[], think = 780) => {
      if (who === "them") {
        setTyping(true);
        await wait(think);
        if (run.current !== id) return;
        setTyping(false);
      }
      if (run.current !== id) return;
      setMsgs((m) => [...m, { id: (seq.current += 1), who, lines }]);
    },
    [wait],
  );

  /** Deal `i` arrives, or the thread closes out if there are none left. */
  const arrive = useCallback(
    async (id: number, i: number) => {
      setStage("busy");
      await wait(900);
      if (run.current !== id) return;

      if (i >= DEALS.length) {
        await say(id, "them", CLOSING);
        if (run.current !== id) return;
        setStage("end");
        return;
      }

      setDeal(i);
      for (const bubble of DEALS[i].open) await say(id, "them", bubble);
      if (run.current !== id) return;
      setStage("choose");
    },
    [say, wait],
  );

  /* the first proposal arrives only once the reader can see it */
  const begin = useCallback(() => {
    if (started) return;
    setStarted(true);
    arrive((run.current += 1), 0);
  }, [arrive, started]);

  useEffect(() => {
    const el = stream.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          begin();
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [begin]);

  const settle = useCallback(
    async (id: number, gained: number) => {
      if (run.current !== id) return;
      if (gained) setRealized((v) => v + gained);
      await arrive(id, deal + 1);
    },
    [arrive, deal],
  );

  const authenticate = useCallback(async () => {
    const id = (run.current += 1);
    const d = DEALS[deal];
    setStage("scanning");
    setProgress(0);

    // Stepped with timers rather than rAF: rAF stops in a background tab, which
    // would freeze the read half-lit even though it had already resolved.
    for (const p of [0.25, 0.5, 0.75, 1]) {
      await wait(210);
      if (run.current !== id) return;
      setProgress(p);
    }
    await wait(300);
    if (run.current !== id) return;
    setStage("verified");

    await wait(680);
    setStage("busy");
    if (d.exec) await say(id, "them", [{ t: d.exec }], 520);
    await say(id, "them", d.done);
    await settle(id, d.realized);
  }, [deal, say, settle, wait]);

  const choose = useCallback(
    async (opt: Opt) => {
      const id = (run.current += 1);
      const d = DEALS[deal];
      setStage("busy");
      await say(id, "you", [{ t: opt.label }]);

      if (opt.kind === "decline") {
        await say(id, "them", d.declined);
        await settle(id, 0);
        return;
      }

      if (opt.kind === "raise") {
        await say(id, "them", d.raised ?? []);
        if (run.current !== id) return;
        setStage("auth");
        return;
      }

      /* approve — a biometric only where money actually moves */
      if (d.charge === 0) {
        if (d.exec) await say(id, "them", [{ t: d.exec }]);
        await say(id, "them", d.done);
        await settle(id, d.realized);
        return;
      }

      await say(id, "them", [
        { t: `Face ID to authorize ${d.chargeLabel} to ${d.key === "figma" ? "Figma" : "Datadog"}.` },
        { t: `This card works once, at that vendor, up to ${d.chargeLabel}.` },
      ]);
      if (run.current !== id) return;
      setStage("auth");
    },
    [deal, say, settle],
  );

  const cancelAuth = useCallback(async () => {
    const id = (run.current += 1);
    const d = DEALS[deal];
    setStage("busy");
    setProgress(0);
    await say(id, "them", [
      { t: "Cancelled. Nothing was charged and no card was minted." },
      { t: d.declined[0].t, tone: "hold" },
    ]);
    await settle(id, 0);
  }, [deal, say, settle]);

  const replay = useCallback(() => {
    run.current += 1;
    seq.current = 0;
    setMsgs([]);
    setTyping(false);
    setProgress(0);
    setRealized(0);
    setDeal(0);
    arrive(run.current, 0);
  }, [arrive]);

  const d = DEALS[deal];

  return (
    <div className="tgrid">
      <div className="tpanel up" data-d="60">
        <div className="thead">
          <span className="tname">Renewly</span>
          <span className="tsub">Today</span>
          <span className="ttally">
            Realized <b>{money(realized)}</b>
          </span>
        </div>

        <div className="tstream" ref={stream}>
          <p className="day">August</p>

          {msgs.map((m) => (
            <div className={`msg ${m.who}`} key={m.id}>
              <div className="bub">
                {m.lines.map((l) => (
                  <span key={l.t} className={[l.tone, l.lead && "lead"].filter(Boolean).join(" ")}>
                    {l.t}
                  </span>
                ))}
              </div>
            </div>
          ))}

          {typing ? (
            <div className="msg them">
              <div className="bub typing" aria-label="Renewly is typing">
                <i />
                <i />
                <i />
              </div>
            </div>
          ) : null}
        </div>

        <div className="tdock">
          {stage === "choose" ? (
            <>
              <p className="tprompt">{d.prompt}</p>
              <div className="chips">
                {d.options.map((o) => (
                  <button
                    type="button"
                    className={`chip${o.primary ? " on" : ""}`}
                    key={o.label}
                    onClick={() => choose(o)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {stage === "auth" || stage === "scanning" || stage === "verified" ? (
            <div className="auth">
              <div className={`scan${stage === "scanning" ? " reading" : ""}`}>
                {stage === "verified" ? (
                  <Verified />
                ) : (
                  <FaceMark progress={progress} done={false} />
                )}
              </div>

              <div className="authtext" aria-live="polite">
                <div className="nm">
                  {stage === "auth"
                    ? d.auth?.nm
                    : stage === "scanning"
                      ? "Reading Face ID…"
                      : "Verified · paying"}
                </div>
                <div className="hint">
                  {stage === "auth" ? d.auth?.hint : "Renewly never sees the card."}
                </div>
              </div>

              {stage === "auth" ? (
                <div className="authrow">
                  <button type="button" className="chip on" onClick={authenticate}>
                    Approve with Face ID
                  </button>
                  <button type="button" className="chip" onClick={cancelAuth}>
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {stage === "busy" ? <p className="tprompt">Renewly is working…</p> : null}

          {stage === "end" ? (
            <div className="tend">
              <span className="fin">
                {realized ? `${money(realized)} realized in this thread.` : "Nothing moved."}
              </span>
              <button type="button" className="replay" onClick={replay}>
                Run it again
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
