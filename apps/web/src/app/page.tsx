import type { Metadata } from "next";
import "./site.css";
import { Motion } from "@/components/site/Motion";
import { Console } from "@/components/site/Console";
import { Chart } from "@/components/site/Chart";
import { Thread } from "@/components/site/Thread";
import { Logo, VENDORS } from "@/components/site/brand-marks";
import { Artwork } from "@/components/site/Artwork";
import { WaitlistButton } from "@/components/site/WaitlistButton";
import { ContactButton } from "@/components/site/ContactButton";

/**
 * Renewly — the landing page.
 *
 * Designed from the photographs outward. The art shows a person standing
 * perfectly still while light does the work; that is the product, attention
 * you no longer have to give. So the page is paced like the picture — slow,
 * warm, spacious, almost empty.
 *
 * Copy leads with the category ambition: Renewly is the agentic control plane
 * for recurring spend. Renewals are the first high-intent workflow, not the
 * boundary of the product. Nothing here should describe it as a cancellation
 * tool, tracker, or advice-only assistant.
 *
 * Two numbers carry the argument: identified (what we found) and realized
 * (what actually left the bill). Only the second one is the claim.
 *
 * Styles live in ./site.css, imported here so they ship on this route only
 * and the product routes under (app) keep globals.css to themselves.
 */

export const metadata: Metadata = {
  title: { absolute: "Renewly — recurring spend, on purpose" },
  description:
    "Renewly is the agentic control plane for recurring spend: it perceives every commitment, decides the right move, acts within your authority, and proves the outcome.",
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
    title: "It perceives",
    body: "Mail, cards, books and vendor state become one living map of recurring commitments.",
  },
  {
    no: "02",
    title: "It decides",
    body: "Renew, right-size, change terms, cancel or switch — judged against cost, usage and policy.",
  },
  {
    no: "03",
    title: "You authorize",
    body: "Approve one move, or define an envelope for routine actions. You set the law.",
    yours: true,
  },
  {
    no: "04",
    title: "It executes",
    body: "Scoped payments and vendor runbooks carry the approved outcome into the real world.",
  },
  {
    no: "05",
    title: "It proves",
    body: "Every change closes with confirmation, reconciliation and a finance-grade trail.",
  },
];

const FIGURES = [
  {
    step: "01",
    kind: "Commitments mapped",
    count: "34",
    prefix: "",
    dec: "0",
    label: "Every recurring tool and service, reconciled across mail, cards and books.",
  },
  {
    step: "02",
    kind: "Decisions due",
    count: "7",
    prefix: "",
    dec: "0",
    label: "Renew, change terms, release, cancel or stop in the next thirty days.",
  },
  {
    step: "03",
    kind: "Inside policy",
    count: "3",
    prefix: "",
    dec: "0",
    label: "Actions already covered by a mandate you can inspect and revoke.",
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
            The control loop
          </a>
          <a className="quiet" href="#thread">
            In the thread
          </a>
          <WaitlistButton source="landing-nav" className="btn">
            Join the waitlist
          </WaitlistButton>
        </div>
      </header>

      {/* ══ THE OPENING FRAME ══ */}
      <section className="open" id="top">
        <Artwork scene="hero" />
        <div className="shell wide open-in">
          <p className="hero-kicker up">The agentic control plane for recurring spend</p>
          <h1 data-words>
            Every recurring <span className="hero-dollar">dollar</span>
            <br />
            <em>leaves on purpose.</em>
          </h1>
          <p className="lede up" data-d="180">
            Renewly watches every recurring commitment, decides what should continue, and asks once
            when you&rsquo;re needed. Then it carries the outcome through — from a scoped payment or
            vendor change to finance-grade proof.
          </p>
          <div className="row up" data-d="320">
            <WaitlistButton source="landing-hero" className="btn pale">
              Join the waitlist
              <Arrow />
            </WaitlistButton>
            <a className="btn line" href="#thread">
              Watch it work
            </a>
          </div>
          <p className="fine up" data-d="420">
            Human approval by default. Enforceable limits always. Every outcome proved.
          </p>
        </div>
      </section>

      {/* ══ THE QUIET COST ══ */}
      <section className="band cost-band">
        <div className="shell">
          <div className="head cost-head">
            <p className="eyebrow up">The cost of drift</p>
            <h2 className="up" data-d="90">
              The company changed. The contracts didn&rsquo;t.
            </h2>
            <p className="lede up" data-d="180">
              Tools outlive owners. Seats outlive teams. Old terms quietly become today&rsquo;s
              defaults. Recurring spend is rarely one spectacular mistake — it is hundreds of
              decisions nobody was asked to make again.
            </p>
          </div>

          <div className="figures">
            {FIGURES.map((f, i) => (
              <article
                className={`fig up${f.saved ? " saved" : ""}`}
                key={f.count}
                data-d={60 + i * 100}
              >
                <div className="fig-top">
                  <span>{f.step}</span>
                  <p>{f.kind}</p>
                </div>
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
              <p className="eyebrow">The scale of drift</p>
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
              <p className="eyebrow up">The control loop</p>
              <h2 className="up" data-d="70">
                Complex work. <em>One clear moment for you.</em>
              </h2>
            </div>
            <p className="lede up" data-d="130">
              Signals become a decision. The decision becomes enforceable authority. The authority
              becomes a real-world outcome — with proof returned to the same place it began.
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
              <p className="eyebrow up">Chat is the product</p>
              <h2 className="up" data-d="90">
                The decision finds you. <em>The dashboard doesn&rsquo;t have to.</em>
              </h2>
              <p className="lede up" data-d="180">
                Renewly meets you in the thread with one move, one number and one primary action.
                Approve it there; the execution and evidence return to the same conversation.
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
            <p className="eyebrow up">Authority before autonomy</p>
            <h2 className="up" data-d="90">
              Give the agent a mandate. <em>Never a blank cheque.</em>
            </h2>
            <p className="lede up" data-d="180">
              Autonomy is earned inside rules you can see and stop. Every payment is merchant-scoped
              and amount-capped; anything outside policy waits for your passkey.
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
                Nothing counts
                <br />
                <em>until it can be proved.</em>
              </blockquote>
              <p className="lede up" data-d="130">
                Renewly keeps recommendations, actions and verified outcomes separate. Nothing
                closes until vendor state, payment evidence or an explicit policy stop supports the
                claim.
              </p>
            </div>

            <div className="proof-portrait up" data-d="100">
              <Artwork scene="proof" />
              <div className="proof-receipt">
                <span>Evidence coverage</span>
                <strong>12 / 12</strong>
                <small>
                  <i /> Every closed decision reconciled
                </small>
              </div>
              <p className="proof-caption">Proof is the product.</p>
            </div>
          </div>

          <div className="proof-ledger">
            <div className="spend-intro">
              <div>
                <p className="eyebrow up">Finance-grade memory</p>
                <h2 className="up" data-d="70">
                  The memory behind <em>every recurring decision.</em>
                </h2>
              </div>
              <p className="lede up" data-d="140">
                What continued, what changed, who authorized it and what actually moved — reconciled
                into a living record your finance team can trust.
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
            One renewal is
            <br />
            where <em>control begins.</em>
          </h2>
          <p className="lede up" data-d="150">
            Forward one email. Renewly turns it into a decision, an authorized action and proof —
            the first entry in a living system for everything your company pays on repeat.
          </p>
          <div className="row up" data-d="280">
            <WaitlistButton source="landing-closing" className="btn pale">
              Join the waitlist
              <Arrow />
            </WaitlistButton>
            <a className="btn line" href="#how">
              See the control loop
            </a>
          </div>
        </div>
      </section>

      <footer id="site-footer">
        <div className="shell wide foot">
          <span>© 2026 Renewly — recurring spend, on purpose.</span>
          <nav aria-label="Footer">
            <a href="/security">Security</a>
            <a href="/privacy">Privacy</a>
            <ContactButton />
          </nav>
        </div>
      </footer>
    </>
  );
}
