import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Makes Cloudflare bindings (R2, Queues) available in `next dev`.
initOpenNextCloudflareForDev();

const config: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "26mb" } },
  headers: async () => [{
    source: "/(.*)",
    headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Location is requested in-app only. No background geolocation.
      { key: "Permissions-Policy", value: "geolocation=(self), microphone=(self), camera=(self)" },
    ],
  }],
};

export default config;
