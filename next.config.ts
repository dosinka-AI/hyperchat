import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // the socket.io proxy below must see /socket.io/ WITHOUT next's automatic
  // trailing-slash 308 firing first (otherwise every polling request does a
  // redirect round-trip). harmless for normal pages: browsers normalize.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // beforeFiles so /socket.io is proxied before trailing-slash / page
    // matching can swallow the poll request (critical behind cloudflared).
    // Strip the /socket.io prefix: the sidecar Engine listens on path '/'.
    return {
      beforeFiles: [
        {
          source: "/socket.io",
          destination: "http://127.0.0.1:3003/",
        },
        {
          source: "/socket.io/:path*",
          destination: "http://127.0.0.1:3003/:path*",
        },
      ],
      afterFiles: [
        // the static hyperion client page (public/client/index.html)
        { source: "/client", destination: "/client/index.html" },
        { source: "/client/", destination: "/client/index.html" },
      ],
    };
  },
};

export default nextConfig;

