import type { Metadata } from "next";
import "./site.css";
import { Motion } from "@/components/site/Motion";
import { Console } from "@/components/site/Console";
import { Chart } from "@/components/site/Chart";
import { Thread } from "@/components/site/Thread";
import { Logo, VENDORS } from "@/components/site/brand-marks";
import { Artwork } from "@/components/site/Artwork";

/**
 * Renewly — the landing page.
 *
 * Designed from the photographs outward. The art shows a person standing
 * perfectly still while light does the work; that is the product, attention
 * you no longer have to give. So the page is paced like the picture — slow,
 * warm, spacious, almost empty.
 *
 * Copy leads with the wedge: the category has solved detection and
 * notification, and Renewly's difference is that the decision arrives in your
 * messages and then *executes and pays*. Nothing here should ever describe it
 * as a cancellation tool or a tracker.
 *
 * Two numbers carry the argument: identified (what we found) and realized
 * (what actually left the bill). Only the second one is the claim.
 *
 * Styles live in ./site.css, imported here so they ship on this route only
 * and the product routes under (app) keep globals.css to themselves.
 */

export const metadata: Metadata = {
  title: "Renewly — renewals that finish themselves",
  description:
    "Renewly is the messaging-native renewal agent. Forward the email, approve the move with Face ID, and a one-time card settles the payment. Receipt in the same thread.",
};

const Arrow = () => (
  <svg className="arw" width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
    <path
      d="M3 7.5h9m0 0-3.4-3.4M12 7.5l-3.4 3.4"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const MOVES = [
  {
    no: "01",
    title: "It detects",
    body: "Renewal mail, vendor, seats, amount and date — reconciled against the card line.",
  },
  {
    no: "02",
    title: "It proposes",
    body: "One message before the charge, with the exact move and dollars kept.",
  },
  {
    no: "03",
    title: "You approve",
    body: "Face ID once, scoped to that vendor and that amount.",
    yours: true,
  },
  {
    no: "04",
    title: "It executes",
    body: "It settles approved payments; for manual changes, it returns the exact steps.",
  },
  {
    no: "05",
    title: "It proves",
    body: "Confirmation, matched charge and an accountant-ready receipt.",
  },
];

const FIGURES = [
  {
    step: "01",
    kind: "Annual run-rate",
    count: "8633.88",
    prefix: "$",
    label: "Recurring spend a year, rebuilt from renewal mail and card lines.",
  },
  {
    step: "02",
    kind: "Opportunity found",
    count: "3078",
    prefix: "$",
    dec: "0",
    label: "Identified — idle seats, monthly billing, duplicate tools.",
  },
  {
    step: "03",
    kind: "Receipt-verified",
    count: "1235.88",
    prefix: "$",
    label: "Realized — executed and paid. Not a suggestion in a dashboard.",
    saved: true,
  },
];

export default function LandingPage() {
  return (
    <>
      <Motion />

      <header className="nav" id="site-nav">
        <div className="shell wide nav-in">
          <a className="mark" href="#top">
            Renewly
          </a>
          <span className="spacer" />
          <a className="quiet" href="#how">
            How it works
          </a>
          <a className="quiet" href="#thread">
            In the thread
          </a>
          <a className="btn" href="/onboarding">
            Start free
          </a>
        </div>
      </header>

      {/* ══ THE OPENING FRAME ══ */}
      <section className="open" id="top">
        <Artwork scene="hero" />
        <div className="shell wide open-in">
          <p className="hero-kicker up">The messaging-native renewal agent</p>
          <h1 data-words>
            Your next renewal
            <br />
            <em>can finish in a text.</em>
          </h1>
          <p className="lede up" data-d="180">
            Forward the email. Renewly finds the move and texts it to you. Approve with Face ID; a
            one-time card settles the payment, and the receipt returns to the same thread.
          </p>
          <div className="row up" data-d="320">
            <a className="btn pale" href="/onboarding">
              Forward your first renewal
              <Arrow />
            </a>
            <a className="btn line" href="#thread">
              Try the live thread
            </a>
          </div>
          <p className="fine up" data-d="420">
            Read-only until you approve. One card. One vendor. One amount.
          </p>
        </div>
      </section>

      {/* ══ THE QUIET COST ══ */}
      <section className="band cost-band">
        <div className="shell">
          <div className="head cost-head">
            <p className="eyebrow up">The quiet cost</p>
            <h2 className="up" data-d="90">
              Thirty-four subscriptions. You can name nineteen.
            </h2>
            <p className="lede up" data-d="180">
              It isn&rsquo;t one bad decision. It&rsquo;s the seat nobody released, the monthly plan
              nobody moved to annual, and the duplicate tool nobody had twenty minutes to cancel.
              Small in isolation. Expensive together.
            </p>
          </div>

          <div className="figures">
            {FIGURES.map((f, i) => (
              <article className={`fig up${f.saved ? " saved" : ""}`} key={f.count} data-d={60 + i * 100}>
                <div className="fig-top"><span>{f.step}</span><p>{f.kind}</p></div>
                <div className="n" data-count={f.count} data-prefix={f.prefix} data-dec={f.dec}>
                  {f.prefix}0
                </div>
                <p className="k">{f.label}</p>
              </article>
            ))}
          </div>

          <div className="industry-card up" data-d="120">
            <Artwork scene="quiet" />
            <div className="industry-copy">
              <p className="eyebrow">Industry data</p>
              <blockquote>
                SaaS spend now runs <em>$4,830 per employee</em> — up 21.9% in a single year.
              </blockquote>
              <p className="by">
                <a
                  href="https://zylo.com/news/2025-saas-management-index"
                  target="_blank"
                  rel="noreferrer"
                >
                  Zylo, 2025 SaaS Management Index — 40M+ licences and $40B of spend ↗
                </a>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ══ ONE DECISION ══ */}
      <section className="tband journey-band" id="how">
        <Artwork scene="thread" />
        <div className="shell">
          <div className="journey-intro">
            <div>
              <p className="eyebrow up">How it works</p>
              <h2 className="up" data-d="70">
                Five steps. <em>Exactly one is yours.</em>
              </h2>
            </div>
            <p className="lede up" data-d="130">
              Renewly does the reading, arithmetic and vendor work. Your decision arrives only when
              the exact move and amount are ready to approve.
            </p>
          </div>

          <div className="moves">
            {MOVES.map((m, i) => (
              <article className={`move up${m.yours ? " you" : ""}`} key={m.no} data-d={i * 55}>
                <span className="no">{m.no}</span>
                <h3>{m.title}</h3>
                <p className="aside">{m.body}</p>
              </article>
            ))}
          </div>

          <div className="vendors up" data-d="120">
            {VENDORS.map(([name, key]) => (
              <span key={key}>
                <Logo brand={key} />
                {name}
              </span>
            ))}
          </div>

          <div className="thread-stage" id="thread">
            <div className="thread-copy">
              <p className="eyebrow up">One decision, in the thread</p>
              <h2 className="up" data-d="90">
                See the move. <em>Then let it finish.</em>
              </h2>
              <p className="lede up" data-d="180">
                One pays, one cancels, and one is over your ceiling and stops. Answer them here and
                watch the receipt come back to the same conversation.
              </p>
            </div>

            <Thread />
          </div>
        </div>
      </section>

      {/* ══ CONTROL ══ */}
      <section className="band control-band">
        <div className="shell">
          <div className="head">
            <p className="eyebrow up">Control</p>
            <h2 className="up" data-d="90">
              It only ever does what you&rsquo;ve allowed.
            </h2>
            <p className="lede up" data-d="180">
              Every money-moving action is signed with your passkey and scoped to one vendor and one
              amount. Set the ceiling below and watch what it&rsquo;s allowed to settle change.
            </p>
          </div>

          <Console />
        </div>
      </section>

      {/* ══ PROOF ══ */}
      <section className="pband proof-chapter" id="spend">
        <div className="shell wide">
          <div className="proof-grid">
            <div className="proof-copy">
              <p className="eyebrow up">Proof, not projection</p>
              <blockquote className="up" data-d="70">
                Every dollar back,
                <br />
                <em>with a receipt behind it.</em>
              </blockquote>
              <p className="lede up" data-d="130">
                A saving enters your total only after the vendor confirms the change and the new
                charge matches. Until then, it is simply an opportunity.
              </p>
            </div>

            <div className="proof-portrait up" data-d="100">
              <Artwork scene="proof" />
              <div className="proof-receipt">
                <span>Realized this year</span>
                <strong>$1,235.88</strong>
                <small><i /> 12 vendor receipts matched</small>
              </div>
              <p className="proof-caption">The receipt is the claim.</p>
            </div>
          </div>

          <div className="proof-ledger">
            <div className="spend-intro">
              <div>
                <p className="eyebrow up">Twelve months, reconciled</p>
                <h2 className="up" data-d="70">
                  The line only moves when <em>the money does.</em>
                </h2>
              </div>
              <p className="lede up" data-d="140">
                Recurring spend after every executed cancellation, released seat and plan change.
                Suggestions never enter the total. Receipts do.
              </p>
            </div>

            <Chart />
          </div>
        </div>
      </section>

      {/* ══ CLOSING ══ */}
      <section className="close" id="start">
        <Artwork scene="closing" />
        <div className="shell wide close-in">
          <h2 className="up">
            Forward one
            <br />
            renewal <em>email.</em>
          </h2>
          <p className="lede up" data-d="150">
            You&rsquo;ll get your five biggest leaks back in dollars, in minutes. Connect a card when
            you want it to start acting on them.
          </p>
          <div className="row up" data-d="280">
            <a className="btn pale" href="/onboarding">
              Start free
              <Arrow />
            </a>
            <a className="btn line" href="#how">
              See how it works
            </a>
          </div>
        </div>
      </section>

      <footer>
        <div className="shell wide foot">
          <span>© 2026 Renewly — renewals that finish themselves.</span>
          <nav>
            <a href="#top">Security</a>
            <a href="#top">Privacy</a>
            <a href="#top">Docs</a>
            <a href="#top">Careers</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
