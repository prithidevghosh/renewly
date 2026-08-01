import { Logo } from "./brand-marks";

/**
 * The decision ledger — proof of control, not another savings chart.
 *
 * A falling run-rate made Renewly look like a spend optimiser. The product is
 * broader: recurring decisions can be paid, changed, cancelled, or stopped by
 * policy. Every terminal state belongs in the same append-only memory and
 * every row needs evidence.
 */

type Tone = "paid" | "changed" | "cancelled" | "stopped";

type Decision = {
  date: string;
  vendor: string;
  brand: string;
  move: string;
  authority: string;
  outcome: string;
  evidence: string;
  tone: Tone;
};

const DECISIONS: Decision[] = [
  {
    date: "08 Jul",
    vendor: "Datadog",
    brand: "datadog",
    move: "Moved to annual",
    authority: "Passkey · $1,796 cap",
    outcome: "$448 realized",
    evidence: "DD-71330 · charge matched",
    tone: "changed",
  },
  {
    date: "19 Jun",
    vendor: "Figma",
    brand: "figma",
    move: "Released three seats",
    authority: "Policy · under $600",
    outcome: "$108 realized",
    evidence: "FG-448210 · seats verified",
    tone: "changed",
  },
  {
    date: "02 Jun",
    vendor: "Linear",
    brand: "linear",
    move: "Renewed eight seats",
    authority: "Passkey · $768 cap",
    outcome: "$768 paid",
    evidence: "LN-11802 · receipt matched",
    tone: "paid",
  },
  {
    date: "21 May",
    vendor: "Loom",
    brand: "loom",
    move: "Cancelled Business",
    authority: "Cancel envelope",
    outcome: "$168 avoided",
    evidence: "LM-90114 · vendor confirmed",
    tone: "cancelled",
  },
  {
    date: "14 May",
    vendor: "AWS",
    brand: "amazonwebservices",
    move: "Increase commitment",
    authority: "Over $600 ceiling",
    outcome: "Stopped",
    evidence: "No credential issued",
    tone: "stopped",
  },
];

export function Chart() {
  return (
    <div className="decision-card up" data-d="120">
      <div className="decision-summary">
        <div className="decision-primary">
          <span>Decisions closed this year</span>
          <strong>12</strong>
          <small>Paid, changed, cancelled or deliberately stopped</small>
        </div>
        <dl>
          <div>
            <dt>Executed</dt>
            <dd>8</dd>
          </div>
          <div>
            <dt>Stopped by policy</dt>
            <dd className="held">4</dd>
          </div>
          <div>
            <dt>Evidence-linked</dt>
            <dd className="proved">12 / 12</dd>
          </div>
        </dl>
      </div>

      <div className="ledger-head" aria-hidden="true">
        <span>Date</span>
        <span>Commitment</span>
        <span>Authority</span>
        <span>Outcome</span>
        <span>Evidence</span>
      </div>

      <div className="decision-ledger" role="table" aria-label="Recent recurring decisions">
        {DECISIONS.map((decision) => (
          <div className="ledger-row" role="row" key={`${decision.date}-${decision.vendor}`}>
            <div className="ledger-date" role="cell">
              <span className="ledger-label">Date</span>
              {decision.date}
            </div>
            <div className="ledger-commitment" role="cell">
              <Logo brand={decision.brand} size={19} />
              <div>
                <strong>{decision.vendor}</strong>
                <span>{decision.move}</span>
              </div>
            </div>
            <div className="ledger-authority" role="cell">
              <span className="ledger-label">Authority</span>
              {decision.authority}
            </div>
            <div className={`ledger-outcome ${decision.tone}`} role="cell">
              <span className="ledger-label">Outcome</span>
              <i />
              {decision.outcome}
            </div>
            <div className="ledger-evidence" role="cell">
              <span className="ledger-label">Evidence</span>
              {decision.evidence}
            </div>
          </div>
        ))}
      </div>

      <div className="ledger-foot">
        <span>
          <i className="receipt-mark" /> Append-only decision record
        </span>
        <span>Latest proof · 08 Jul, 14:32</span>
      </div>
    </div>
  );
}
