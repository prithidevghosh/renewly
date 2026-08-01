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
    default: "Renewly — recurring spend, on purpose",
    template: "%s · Renewly",
  },
  description:
    "The agentic control plane for recurring spend. Renewly perceives every commitment, decides the right move, acts within your authority, and proves the outcome.",
  openGraph: {
    title: "Renewly — recurring spend, on purpose",
    description: "Every recurring commitment, decided and executed under human-set authority.",
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
