import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./LegalDocument.module.css";

export type LegalNavItem = {
  id: string;
  number: string;
  title: string;
};

export function LegalDocument({
  label,
  title,
  summary,
  scope,
  navItems,
  children,
}: {
  label: string;
  title: string;
  summary: string;
  scope: string;
  navItems: readonly LegalNavItem[];
  children: ReactNode;
}) {
  return (
    <main className={styles.canvas}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.wordmark}>
            Renewly
          </Link>
          <span className={styles.headerRule} aria-hidden="true" />
          <span className={styles.trustLabel}>Trust centre</span>
          <Link href="/" className={styles.homeLink}>
            Back to home
          </Link>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>{label}</p>
          <h1>{title}</h1>
          <p className={styles.summary}>{summary}</p>
        </div>

        <aside className={styles.record} aria-label="Document information">
          <p className={styles.recordTitle}>Document record</p>
          <dl>
            <div>
              <dt>Effective</dt>
              <dd>1 August 2026</dd>
            </div>
            <div>
              <dt>Applies to</dt>
              <dd>{scope}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd className={styles.current}>
                <i aria-hidden="true" /> Current
              </dd>
            </div>
          </dl>
        </aside>
      </section>

      <div className={styles.documentShell}>
        <aside className={styles.index}>
          <nav aria-label="On this page">
            <p>In this document</p>
            <ol>
              {navItems.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`}>
                    <span>{item.number}</span>
                    {item.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <p className={styles.indexNote}>
            Questions about this document? Use Contact in the landing-page footer.
          </p>
        </aside>

        <article className={styles.document}>{children}</article>
      </div>

      <footer className={styles.footer}>
        <div>
          <span>© 2026 Renewly</span>
          <nav aria-label="Legal documents">
            <Link href="/security">Security</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/#site-footer">Contact</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}

export function LegalSection({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={styles.section}>
      <div className={styles.sectionHead}>
        <span>{number}</span>
        <h2>{title}</h2>
      </div>
      <div className={styles.prose}>{children}</div>
    </section>
  );
}
