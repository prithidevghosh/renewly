"use client";

import Link from "next/link";
import { forwardRef } from "react";
import { cx } from "@/lib/format";

/**
 * DESIGN.md §7. The primary action is **solid ink**, not a colour — the way a
 * well-set document uses a black rule for emphasis. Claret is reserved for
 * attention and for the agent's own hand, so it never competes with the CTA.
 *
 * No glows, no coloured shadows, no gradients.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "relative inline-flex items-center justify-center gap-2 rounded-md font-medium " +
  "whitespace-nowrap select-none transition-colors duration-[var(--dur-quick)] " +
  "ease-[var(--ease-settle)] disabled:pointer-events-none disabled:opacity-35";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-paper hover:bg-[#2b271f] active:bg-[#0f0e0a]",
  secondary: "border border-rule-firm bg-card text-ink hover:border-rule-ink hover:bg-hover",
  quiet: "text-ink-3 hover:text-ink hover:bg-hover",
  danger: "border border-claret/35 text-claret hover:border-claret hover:bg-[var(--claret-soft)]",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[0.8125rem]",
  md: "h-10 px-4 text-[0.875rem]",
  lg: "h-12 px-6 text-[0.9375rem]",
};

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
}

type ButtonProps = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={cx(base, variants[variant], sizes[size], className)} {...rest}>
      {children}
    </button>
  );
});

type ButtonLinkProps = CommonProps & { href: string; target?: string; rel?: string };

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  children,
  href,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link href={href} className={cx(base, variants[variant], sizes[size], className)} {...rest}>
      {children}
    </Link>
  );
}
