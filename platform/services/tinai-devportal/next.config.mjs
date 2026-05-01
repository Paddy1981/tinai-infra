/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["shiki"],
    turbopack: {},
  },
};

export default nextConfig;
