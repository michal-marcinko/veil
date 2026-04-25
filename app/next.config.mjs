/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, crypto: false };
    return config;
  },
  // Umbra's ZK-asset CDN (CloudFront) serves no Access-Control-Allow-Origin
  // header, so browsers block direct fetches of the Groth16 zkey/wasm files.
  // Rewrite to a same-origin path so the browser treats it as a simple GET.
  async rewrites() {
    return [
      {
        source: "/umbra-cdn/:path*",
        destination: "https://d3j9fjdkre529f.cloudfront.net/:path*",
      },
    ];
  },
};
export default nextConfig;
