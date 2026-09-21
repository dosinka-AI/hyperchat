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
    return [
      // self-hosted realtime: browsers reach the socket.io sidecar (:3003)
      // THROUGH the web app itself, same-origin — one address (and one
      // tunnel) carries both the pages and the live connection. the sidecar
      // accepts any path prefix (it rides path '/'), and socket.io clients
      // start on polling and upgrade to websocket only if the proxy allows
      // it; voice/video calls are webrtc peer connections and never ride
      // this proxy at all. (the sandbox preview gateway's XTransformPort
      // flow uses path '/', so it never touches this rule — unchanged.)
      { source: "/socket.io/:path*", destination: "http://127.0.0.1:3003/socket.io/:path*" },
      // the static hyperion client page (public/client/index.html) — the
      // txt-reading discovery page clients use; serve it at a clean path
      { source: "/client", destination: "/client/index.html" },
      { source: "/client/", destination: "/client/index.html" },
    ];
  },
};

export default nextConfig;

