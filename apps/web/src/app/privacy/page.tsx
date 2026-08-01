import type { Metadata } from "next";
import { LegalDocument, LegalSection } from "@/components/site/LegalDocument";

const NAV_ITEMS = [
  { id: "information", number: "01", title: "Information we collect" },
  { id: "use", number: "02", title: "How we use information" },
  { id: "sharing", number: "03", title: "Sharing and service providers" },
  { id: "retention", number: "04", title: "Retention and security" },
  { id: "rights", number: "05", title: "Your choices and rights" },
  { id: "children", number: "06", title: "Children and international use" },
  { id: "changes", number: "07", title: "Changes to this policy" },
] as const;

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Renewly collects, uses, and protects personal information.",
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      label="Legal"
      title="Privacy Policy"
      summary="This policy explains what information Renewly collects, why we use it, and the choices available to you."
      scope="Website and demonstration product"
      navItems={NAV_ITEMS}
    >
      <LegalSection id="information" number="01" title="Information we collect">
        <p>We collect information you choose to provide, including:</p>
        <ul>
          <li>Your name and email address when you join the waitlist or contact us.</li>
          <li>The contents of messages you submit through the contact form.</li>
          <li>
            Basic request data needed to operate and protect the service, such as timestamps,
            request identifiers, device or browser information, and IP address.
          </li>
        </ul>
        <p>
          The current product experience is a demonstration. It does not connect real vendor,
          banking, card, or accounting accounts, and the information shown inside it is simulated.
        </p>
      </LegalSection>

      <LegalSection id="use" number="02" title="How we use information">
        <p>We use personal information to:</p>
        <ul>
          <li>Manage the waitlist and communicate about Renewly access.</li>
          <li>Read and respond to questions sent through the contact form.</li>
          <li>Operate, troubleshoot, secure, and improve our website and services.</li>
          <li>Meet legal obligations and prevent fraud, abuse, or security incidents.</li>
        </ul>
        <p>We do not sell personal information or use contact-form messages for advertising.</p>
      </LegalSection>

      <LegalSection id="sharing" number="03" title="Sharing and service providers">
        <p>
          We may share information with service providers that help us host the site, deliver email,
          monitor reliability, or protect the service. They may process information only to provide
          those services to us. We may also disclose information when required by law, to protect
          rights and safety, or as part of a corporate transaction.
        </p>
      </LegalSection>

      <LegalSection id="retention" number="04" title="Retention and security">
        <p>
          We keep personal information only for as long as reasonably needed for the purposes above,
          including legal, accounting, and security needs. Retention periods vary by record type. We
          use administrative and technical safeguards designed to protect information, but no online
          system can guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection id="rights" number="05" title="Your choices and rights">
        <p>
          You may ask to access, correct, or delete personal information you have provided, or
          object to certain uses of it. Rights differ by location and may be subject to legal
          exceptions. Use the Contact form linked in the landing-page footer to make a request. We
          may need to verify your identity before completing it.
        </p>
      </LegalSection>

      <LegalSection id="children" number="06" title="Children and international use">
        <p>
          Renewly is intended for businesses and is not directed to children under 13. If
          information is processed outside your country, we use safeguards appropriate to the
          relevant legal requirements.
        </p>
      </LegalSection>

      <LegalSection id="changes" number="07" title="Changes to this policy">
        <p>
          We may update this policy as Renewly develops. We will publish the revised version here
          and update the date above. Material changes will be highlighted when appropriate.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
