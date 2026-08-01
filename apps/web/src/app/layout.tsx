import type { Metadata, Viewport } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
import "./globals.css";

/**
 * Two families, one argument each — see DESIGN.md §3.
 *   Newsreader  = the institution   (display only, with real italics)
 *   Public Sans = the interface     (all UI, and all figure figures)
 *
 * There is deliberately no monospace in this product.
 */
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
  style: ["normal", "italic"],
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://renewly.app"),
  title: {
    default: "Renewly — the agentic CFO for founders",
    template: "%s · Renewly",
  },
  description:
    "Rocket Money tells you you're overpaying. Renewly fixes it. An AI agent that watches your recurring software spend, catches renewals before they hit, and completes the action — with one human approval per money-moving step.",
  openGraph: {
    title: "Renewly — the agentic CFO for founders",
    description: "Rocket Money tells you you're overpaying. Renewly fixes it.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fbfaf7",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Supreme is the landing page's UI face and is not on Google Fonts,
            so it comes from Fontshare. Newsreader is self-hosted by next/font
            above and is shared by both the site and the product. */}
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=supreme@400,500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className={`${newsreader.variable} ${publicSans.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
