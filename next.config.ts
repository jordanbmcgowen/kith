import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Makes Cloudflare bindings (R2, Queues) available in `next dev`.
initOpenNextCloudflareForDev();

const config: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "26mb" } },
  // Not here, and both were tried: `experimental.staleTimes`, and moving the
  // signed-in routes under a shared layout in a route group. Together they
  // made a tab tap cost no network at all, and they broke the back button:
  // going back from a person page while it was still loading changed the URL
  // to /find?q= and left the person on screen, permanently, about three times
  // in four. The route group was the half that did it (measured: the same
  // check passes 3/3 without it and fails 3/4 with it, on the deployment).
  // The speed came back a safer way, in src/lib/store.ts. If you try either
  // again, drive it: tap a person and go back before their page has settled.
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
