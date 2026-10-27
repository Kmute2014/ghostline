import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "socket.io",
    "engine.io",
    "@prisma/client",
    "@prisma/adapter-pg",
    "@google-cloud/cloud-sql-connector",
    "pg",
    "firebase-admin",
  ],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
