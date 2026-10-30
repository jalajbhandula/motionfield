import type { NextConfig } from "next";

/** Page routes were renamed to plain-language slugs — old codename URLs
 *  keep resolving here (bookmarks, docs links, seeded demos). API paths and
 *  endpoint ids are the stable contract and do NOT redirect. */
const ROUTE_RENAMES: [string, string][] = [
  ["/doppel/object", "/object-swap"],
  ["/doppel/restyle", "/restyle"],
  ["/doppel/quick", "/person-swap/quick"],
  ["/doppel", "/person-swap"],
  ["/recut", "/re-edit-video"],
  ["/vfx-lab", "/visual-effects"],
  ["/persona-builder", "/character-creator"],
  ["/persona-studio", "/character-studio"],
  ["/orchestrator", "/ai-assistant"],
  ["/ad-lab", "/product-ads"],
  ["/dub", "/dub-translate"],
  ["/layers", "/image-editor"],
  ["/palette", "/color-grade"],
  ["/stage", "/scene-3d"],
  ["/motion", "/motion-graphics"],
  ["/reshoot", "/new-camera-move"],
];

const nextConfig: NextConfig = {
  // Keep isolated validation builds from locking the running dev server.
  distDir: process.env.MOTIONFIELD_DIST_DIR || ".next",
  // Dev server is accessed via 127.0.0.1/LAN IP, not only "localhost" —
  // without this Next blocks /_next/hmr cross-origin, which kills the
  // Turbopack dev client bootstrap and hydration never runs.
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.29.8"],
  // pg + PGlite ship native/wasm artifacts — never bundle them
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  // No wildcard remotePatterns: an open image optimizer is an SSRF proxy.
  // App media is served same-origin from /files/* anyway.
  images: { remotePatterns: [] },
  async redirects() {
    return ROUTE_RENAMES.flatMap(([from, to]) => [
      { source: from, destination: to, permanent: false },
      { source: `${from}/:path*`, destination: `${to}/:path*`, permanent: false },
    ]);
  },
};

export default nextConfig;
