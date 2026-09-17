import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // beforeFiles so /socket.io is proxied before trailing-slash redirects
  // eat the request. Local clients usually hit :3003 directly with cookies;
  // this rewrite is the same-origin / Trae fallback.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/socket.io",
          destination: "http://127.0.0.1:3003/socket.io",
        },
        {
          source: "/socket.io/:path*",
          destination: "http://127.0.0.1:3003/socket.io/:path*",
        },
      ],
    };
  },
};

export default nextConfig;

