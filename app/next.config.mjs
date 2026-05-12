/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Skip lint during production build — Next 14's bundled ESLint
  // (parser pulled in via @next/next/no-img-element) misreads
  // multi-line comments after `// eslint-disable-next-line` as
  // additional rule names. Local `next build` runs OK; Railway's
  // build container hits a stricter ESLint config that errors on
  // those "rule definitions not found" lines and fails the build.
  // Enforce lint via `next lint` in CI / pre-commit instead.
  eslint: { ignoreDuringBuilds: true },
  // Server-only externals — Next must NOT bundle these for server routes.
  //
  // - @bundlr-network/client transitively imports aptos →
  //   @aptos-labs/aptos-client which requires `got`. Webpack tries to
  //   bundle that for server routes and fails because `got` isn't a
  //   project dep.
  // - arbundles (a Bundlr dep) ships an ESM build whose internal
  //   imports omit `.js` extensions (e.g. `signing/constants.js` →
  //   `./keys/curve25519` with no extension). Node's strict ESM
  //   resolver rejects those, throwing
  //   `ERR_MODULE_NOT_FOUND: Cannot find module
  //   .../arbundles/build/web/esm/src/signing/keys/curve25519.js`
  //   at runtime when /api/arweave-upload is called. Externalizing
  //   forces CommonJS resolution (which is lenient about extensions)
  //   and sidesteps the issue.
  //
  // Marking these as external makes Next require() them at runtime
  // from node_modules instead of bundling.
  experimental: {
    serverComponentsExternalPackages: [
      "@bundlr-network/client",
      "arbundles",
    ],
  },
  webpack: (config, { isServer }) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    // Stub Node built-ins ONLY for the client bundle. Applying them
    // server-side made arbundles' package-exports `"browser"`
    // condition match for /api routes too, pulling in its broken
    // web-ESM build (missing `signing/keys/` subdir) and 500-ing
    // /api/arweave-upload at runtime. Server-side keeps real fs +
    // crypto so arbundles resolves to its node-cjs build instead.
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, crypto: false };
    }
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
