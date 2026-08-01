"use client";

/**
 * The page's motion layer, lifted from the prototype: slow reveals, the
 * word-by-word headline build, the photographic plates drifting as you pass
 * them, the figures counting up, and the bar resting once you leave the hero.
 *
 * It only ever adds classes or writes inline transforms onto nodes React has
 * already rendered and will never re-render, so React and this never contend
 * for the same DOM. Every step guards against re-entry, because Strict Mode
 * runs effects twice in development.
 */

import { useEffect } from "react";

/** Midjourney cannot reliably control which way a subject faces. Flipping a
 *  plate moves the subject, the light and the shadow together, so it is the
 *  reliable fix rather than re-prompting. These rooms carry no lettering, so
 *  a horizontal flip is undetectable. */
const MIRROR: Record<string, boolean> = { open: false, close: false };

export function Motion() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups: Array<() => void> = [];

    /* ── which way the plates face ─────────────────────────────────── */
    document.querySelectorAll<HTMLElement>(".open .art, .close .art").forEach((el) => {
      const key = el.closest(".open") ? "open" : "close";
      el.style.setProperty("--flip", MIRROR[key] ? "-1" : "1");
    });

    /* ── headlines assemble word by word ───────────────────────────── */
    let n = 0;
    const wrapText = (node: Text) => {
      const frag = document.createDocumentFragment();
      node.textContent!.split(/(\s+)/).forEach((part) => {
        if (!part.trim()) {
          frag.appendChild(document.createTextNode(part));
          return;
        }
        const outer = document.createElement("span");
        outer.className = "w";
        const inner = document.createElement("span");
        inner.className = "wi";
        inner.textContent = part;
        inner.style.transitionDelay = `${n++ * 55}ms`;
        outer.appendChild(inner);
        frag.appendChild(outer);
      });
      node.replaceWith(frag);
    };
    const walk = (el: Element) => {
      [...el.childNodes].forEach((c) => {
        if (c.nodeType === 3 && c.textContent?.trim()) wrapText(c as Text);
        else if (c.nodeType === 1) walk(c as Element);
      });
    };
    document.querySelectorAll<HTMLElement>("[data-words]").forEach((h) => {
      if (h.dataset.split) return; // Strict Mode runs this twice in dev
      h.dataset.split = "1";
      n = 0;
      walk(h);
    });

    /* ── slow reveals ──────────────────────────────────────────────── */
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const el = e.target as HTMLElement;
          window.setTimeout(() => el.classList.add("in"), reduce ? 0 : Number(el.dataset.d ?? 0));
          io.unobserve(el);
        });
      },
      { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
    );
    /* The -8% bottom margin makes below-the-fold reveals fire slightly early,
       but it also means anything sitting in the bottom 8% on first paint never
       intersects and would stay invisible forever. Reveal what is already on
       screen directly, and only observe the rest. */
    document.querySelectorAll<HTMLElement>(".up").forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight) {
        window.setTimeout(() => el.classList.add("in"), reduce ? 0 : Number(el.dataset.d ?? 0));
      } else {
        io.observe(el);
      }
    });
    const litIo = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("lit");
          litIo.unobserve(e.target);
        });
      },
      { threshold: 0.3 },
    );
    document.querySelectorAll("[data-words]").forEach((el) => litIo.observe(el));
    cleanups.push(() => {
      io.disconnect();
      litIo.disconnect();
    });

    /* ── the bar rests once the hero is behind you ─────────────────── */
    const nav = document.getElementById("site-nav");
    const darkSections = [...document.querySelectorAll<HTMLElement>(".close")];
    const onScrollNav = () => {
      nav?.classList.toggle("rest", window.scrollY > window.innerHeight * 0.82);
      const navMidpoint = nav?.getBoundingClientRect().height
        ? nav.getBoundingClientRect().height / 2
        : 40;
      const overDark = darkSections.some((section) => {
        const rect = section.getBoundingClientRect();
        return rect.top <= navMidpoint && rect.bottom >= navMidpoint;
      });
      nav?.classList.toggle("over-dark", overDark);
    };
    window.addEventListener("scroll", onScrollNav, { passive: true });
    onScrollNav();
    cleanups.push(() => window.removeEventListener("scroll", onScrollNav));

    /* ── the plates drift, very slightly, as you pass them ─────────── */
    if (!reduce) {
      const plates = [...document.querySelectorAll<HTMLElement>(".art")].map((el) => {
        const cs = getComputedStyle(el); // read once, never per frame
        return {
          el,
          sec: el.parentElement as HTMLElement,
          z: parseFloat(cs.getPropertyValue("--z")) || 1,
          drift: parseFloat(cs.getPropertyValue("--drift")) || 5.5,
        };
      });
      let ticking = false;
      const place = () => {
        ticking = false;
        for (const { el, sec, z, drift } of plates) {
          const r = sec.getBoundingClientRect();
          if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
          const raw = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
          const p = Math.max(-1, Math.min(1, raw));
          el.style.transform =
            `translate3d(0,${(p * drift).toFixed(2)}%,0) scale(${z}) scaleX(var(--flip,1))`;
        }
      };
      const onScroll = () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(place);
        }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", place, { passive: true });
      place();
      cleanups.push(() => {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", place);
      });
    }

    /* ── figures count up slowly ───────────────────────────────────── */
    const cio = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const el = e.target as HTMLElement;
          cio.unobserve(el);
          if (el.dataset.counted) return;
          el.dataset.counted = "1";
          const to = Number(el.dataset.count);
          const pre = el.dataset.prefix ?? "";
          const dec = el.dataset.dec === undefined ? 2 : Number(el.dataset.dec);
          const out = (v: number) =>
            pre + v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
          if (reduce) {
            el.textContent = out(to);
            return;
          }
          const t0 = performance.now();
          const step = (t: number) => {
            const p = Math.min((t - t0) / 2200, 1);
            el.textContent = out(to * (1 - Math.pow(1 - p, 5)));
            if (p < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
      },
      { threshold: 0.8 },
    );
    const counters = [...document.querySelectorAll<HTMLElement>("[data-count]")];
    if (reduce) {
      /* Reduced motion also means no dependency on scrolling through 80% of a
         figure. Anchor jumps and Page Down should never leave the claim at $0. */
      counters.forEach((el) => {
        const to = Number(el.dataset.count);
        const pre = el.dataset.prefix ?? "";
        const dec = el.dataset.dec === undefined ? 2 : Number(el.dataset.dec);
        el.textContent = pre + to.toLocaleString("en-US", {
          minimumFractionDigits: dec,
          maximumFractionDigits: dec,
        });
        el.dataset.counted = "1";
      });
      cio.disconnect();
    } else {
      counters.forEach((el) => cio.observe(el));
      cleanups.push(() => cio.disconnect());
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return null;
}
