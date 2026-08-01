import type { Metadata } from "next";
import { LegalDocument, LegalSection } from "@/components/site/LegalDocument";

const NAV_ITEMS = [
  { id: "status", number: "01", title: "Current product status" },
  { id: "principles", number: "02", title: "Our security principles" },
  { id: "controls", number: "03", title: "Application and infrastructure controls" },
  { id: "disclosure", number: "04", title: "Responsible disclosure" },
  { id: "scope", number: "05", title: "Scope and updates" },
] as const;

export const metadata: Metadata = {
  title: "Security",
  description: "Renewly's security principles, controls, and responsible disclosure process.",
};

export default function SecurityPage() {
  return (
    <LegalDocument
      label="Trust"
      title="Security at Renewly"
      summary="Renewly is being built around bounded authority, minimal access, and evidence for every consequential action."
      scope="Website and demonstration product"
      navItems={NAV_ITEMS}
    >
      <LegalSection id="status" number="01" title="Current product status">
        <p>
          Renewly is currently a demonstration build. It uses simulated product data and does not
          connect real financial, accounting, email, or vendor accounts. No real payments or vendor
          changes are performed by the demonstration.
        </p>
      </LegalSection>

      <LegalSection id="principles" number="02" title="Our security principles">
        <ul>
          <li>
            <strong>Least privilege:</strong> people and systems receive only the access needed for
            a specific task.
          </li>
          <li>
            <strong>Bounded authority:</strong> automated actions are designed to stay within
            explicit merchant, amount, and policy limits.
          </li>
          <li>
            <strong>Human control:</strong> actions outside an approved mandate require a person to
            authorize them.
          </li>
          <li>
            <strong>Traceable outcomes:</strong> important decisions and actions are designed to
            produce an auditable record.
          </li>
          <li>
            <strong>Data minimization:</strong> we aim to collect and retain only the information
            needed to provide and protect the service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="controls" number="03" title="Application and infrastructure controls">
        <p>Controls in the current service include:</p>
        <ul>
          <li>Encrypted HTTPS connections in deployed environments.</li>
          <li>Security-focused browser headers and restrictive cross-origin policies.</li>
          <li>Schema validation and size limits for public form submissions.</li>
          <li>Rate limiting on public endpoints to reduce automated abuse.</li>
          <li>Request identifiers and structured operational logging for investigation.</li>
          <li>
            Environment-based secret handling so credentials are not committed with application
            code.
          </li>
        </ul>
        <p>
          These safeguards reduce risk but do not make any internet service invulnerable. Controls
          will continue to evolve before Renewly handles production financial workflows.
        </p>
      </LegalSection>

      <LegalSection id="disclosure" number="04" title="Responsible disclosure">
        <p>
          If you believe you have found a security issue, use the Contact form in the landing-page
          footer and clearly label the message “Security.” Include the affected page or feature,
          steps to reproduce, and the potential impact. Please do not access other people’s data,
          disrupt the service, or publicly disclose an unresolved issue.
        </p>
      </LegalSection>

      <LegalSection id="scope" number="05" title="Scope and updates">
        <p>
          This page describes Renewly’s present security posture and design direction; it is not a
          certification or guarantee. We will update it as the product, infrastructure, and external
          assurance program mature.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
