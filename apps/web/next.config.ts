import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Product screens remain locally simulated. The public landing waitlist talks
  // to the API directly through NEXT_PUBLIC_API_URL (localhost:4000 in development).
  // See apps/web/README.md § "Swapping the mock layer for a real API".
};

export default nextConfig;
