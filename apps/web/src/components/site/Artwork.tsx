import type { CSSProperties } from "react";

/**
 * The single source of truth for Renewly's photographic plates.
 *
 * Midjourney outputs are intentionally kept as clean source files in /public,
 * while crop, focal point, responsive variant and loading policy live here.
 * A new plate should be added here instead of being wired into page CSS.
 */
const ARTWORKS = {
  hero: {
    src: "/assets/hero.jpg",
    mobileSrc: "/assets/hero-vertical.jpg",
    position: "64% 0%",
    mobilePosition: "50% 50%",
    scale: 1.08,
    mobileScale: 1,
    eager: true,
  },
  quiet: {
    src: "/assets/light-01.jpg",
    position: "50% 50%",
    mobilePosition: "56% 50%",
    scale: 1.03,
    mobileScale: 1.06,
  },
  thread: {
    src: "/assets/thread_plate.jpg",
    position: "58% 50%",
    mobilePosition: "64% 50%",
    scale: 1,
    mobileScale: 1.02,
  },
  proof: {
    src: "/assets/smiling_vertical.jpg",
    position: "100% 38%",
    mobilePosition: "100% 36%",
    scale: 1.16,
    mobileScale: 1.12,
    origin: "86% 30%",
    mobileOrigin: "88% 30%",
  },
  closing: {
    src: "/assets/closing.jpg",
    position: "50% 40%",
    mobilePosition: "68% 50%",
    scale: 1.02,
    mobileScale: 1.06,
  },
} as const;

export type ArtworkScene = keyof typeof ARTWORKS;

type ArtworkStyle = CSSProperties & {
  "--art-position": string;
  "--art-position-mobile": string;
  "--art-scale": number;
  "--art-scale-mobile": number;
  "--art-origin": string;
  "--art-origin-mobile": string;
};

export function Artwork({ scene, className = "" }: { scene: ArtworkScene; className?: string }) {
  const art = ARTWORKS[scene];
  const style: ArtworkStyle = {
    "--art-position": art.position,
    "--art-position-mobile": art.mobilePosition,
    "--art-scale": art.scale,
    "--art-scale-mobile": art.mobileScale,
    "--art-origin": "origin" in art ? art.origin : "50% 50%",
    "--art-origin-mobile": "mobileOrigin" in art ? art.mobileOrigin : "50% 50%",
  };

  return (
    <span className={`art art-${scene} ${className}`.trim()} style={style} aria-hidden="true">
      <picture>
        {"mobileSrc" in art ? <source media="(max-aspect-ratio: 1/1)" srcSet={art.mobileSrc} /> : null}
        <img
          src={art.src}
          alt=""
          loading={"eager" in art && art.eager ? "eager" : "lazy"}
          fetchPriority={"eager" in art && art.eager ? "high" : "auto"}
          decoding="async"
        />
      </picture>
    </span>
  );
}
