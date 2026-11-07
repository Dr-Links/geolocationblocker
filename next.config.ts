import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only packages loaded from node_modules at runtime instead of bundled
  // (bullmq resolves its child-process worker dynamically, which bundling breaks).
  serverExternalPackages: ["pino", "bcryptjs", "bullmq", "ioredis"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
