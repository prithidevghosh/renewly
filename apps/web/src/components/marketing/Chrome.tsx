"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { Wordmark } from "@/components/brand/Mark";
import { ButtonLink } from "@/components/ui/Button";
import { cx } from "@/lib/format";

const LINKS = [
  { href: "#loop", label: "The loop" },
  { href: "#difference", label: "Difference" },
  { href: "#trust", label: "Trust" },
  { href: "#pricing", label: "Pricing" },
] as const;

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cx(
        "fixed inset-x-0 top-0 z-50 transition-all duration-[var(--dur-base)]",
        scrolled ? "border-b border-rule bg-paper/85 backdrop-blur-md" : "border-b border-transparent",
      )}
    >
      <div className="shell-x mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between">
        <Link href="/" className="rounded-md">
          <Wordmark size={24} />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Sections">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-md px-3 py-2 text-body-s text-ink-3 transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/agent"
            className="hidden rounded-md px-3 py-2 text-body-s text-ink-3 transition-colors hover:text-ink sm:block"
          >
            Sign in
          </Link>
          <ButtonLink href="/onboarding" variant="primary" size="sm">
            Free audit
          </ButtonLink>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="-mr-1.5 rounded-md p-2 text-ink-3 md:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-rule bg-paper md:hidden">
          <nav className="shell-x mx-auto flex max-w-[1240px] flex-col py-2" aria-label="Sections">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-1 py-3 text-body text-ink-2"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Entrance reveal. One shared component so the whole page has one rhythm.
 *
 * Deliberately CSS-driven and **visible by default**: the element renders
 * opaque on the server and only becomes hidden once JS has confirmed it can
 * animate it back in. If JS never runs, or an IntersectionObserver never fires,
 * the content is still on screen — a hero that depends on JS to become visible
 * is a bug, not an effect.
 *
 * Elements already in view at mount animate immediately with their delay, which
 * gives the orchestrated page-load stagger; everything below the fold waits for
 * the observer.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // null = untouched (server render, always visible)
  const [mode, setMode] = useState<null | "load" | "below" | "in">(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Inside the fold: never hide it. Play a pure-CSS load animation instead,
    // so the opening composition is guaranteed to resolve without JS timing.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.94) {
      setMode("load");
      return;
    }

    setMode("below");

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setMode("in");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -72px 0px" },
    );
    io.observe(el);

    // Failsafe: if the observer never fires, reveal anyway. Content is never
    // allowed to stay hidden because an effect didn't land.
    const failsafe = setTimeout(() => {
      setMode("in");
      io.disconnect();
    }, 2500);

    return () => {
      io.disconnect();
      clearTimeout(failsafe);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={cx(
        mode === "load" && "rv-load",
        mode === "below" && "rv-scroll",
        mode === "in" && "rv-scroll rv-scroll-in",
        className,
      )}
      style={delay ? ({ "--rv-delay": `${delay * 1000}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cx("shell-x mx-auto w-full max-w-[1240px]", className)}>
      {children}
    </section>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lede,
  align = "left",
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: string;
  align?: "left" | "center";
}) {
  return (
    <div className={cx("max-w-[46rem]", align === "center" && "mx-auto text-center")}>
      <p
        className={cx(
          "flex items-center gap-2.5 label",
          align === "center" && "justify-center",
        )}
      >
        <span className="h-px w-6 bg-forest/60" aria-hidden />
        {eyebrow}
      </p>
      <h2 className="mt-5 font-serif text-display-l text-balance">{title}</h2>
      {lede && <p className="mt-5 max-w-[54ch] text-body text-ink-3 text-pretty">{lede}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function Footer() {
  return (
    <footer className="mt-32 border-t border-rule">
      <div className="shell-x mx-auto w-full max-w-[1240px] py-14">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Wordmark size={24} />
            <p className="mt-4 max-w-[34ch] text-body-s text-ink-3">
              The agentic CFO for founders. Catches the renewal, completes the action, proves the
              saving.
            </p>
            <p className="mt-5 label">
              Prototype · all data simulated
            </p>
          </div>

          {[
            { title: "Product", links: [["The loop", "#loop"], ["Trust", "#trust"], ["Pricing", "#pricing"], ["Agent", "/agent"]] },
            { title: "Company", links: [["About", "#"], ["Careers", "#"], ["Blog", "#"], ["Contact", "#"]] },
            { title: "Legal", links: [["Privacy", "#"], ["Terms", "#"], ["Security", "#"], ["Status", "#"]] },
          ].map((col) => (
            <div key={col.title}>
              <p className="label">{col.title}</p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map(([label, href]) => (
                  <li key={label}>
                    <Link
                      href={href}
                      className="text-body-s text-ink-3 transition-colors hover:text-ink"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-rule pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="label">
            © {new Date().getUTCFullYear()} Renewly
          </p>
          <p className="max-w-[62ch] text-caption text-ink-4">
            Demonstration build. No real vendors are contacted, no accounts are connected, and no
            money moves anywhere in this application.
          </p>
        </div>
      </div>
    </footer>
  );
}
