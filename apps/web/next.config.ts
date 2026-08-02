import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Auth, mailbox, policy, subscriptions and the resumable agent stream use
  // NEXT_PUBLIC_API_URL (localhost:4000 in development).
};

export default nextConfig;
