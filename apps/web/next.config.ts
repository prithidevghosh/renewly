import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The web app is fully client-mocked; there is no backend to proxy to yet.
  // See apps/web/README.md § "Swapping the mock layer for a real API".
};

export default nextConfig;
