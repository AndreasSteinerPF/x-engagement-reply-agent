/** @type {import('next').NextConfig} */
const nextConfig = {
  // The shared contract package ships TypeScript source; let Next transpile it.
  transpilePackages: ["@agent-network/contract"],
  reactStrictMode: true,
  // The agent reads its code-managed config, prompts, and fixtures from disk at
  // runtime (loadConfig / FixtureXClient, resolved from process.cwd()). Trace
  // those files into the serverless bundle so the deployed run endpoint can read
  // them.
  experimental: {
    outputFileTracingIncludes: {
      "/api/run": ["./config/**/*", "./prompts/**/*", "./fixtures/**/*"],
      "/": ["./config/**/*", "./prompts/**/*"],
    },
  },
  webpack: (config) => {
    // The agent core and the contract package use NodeNext-style `./foo.js`
    // imports that resolve to `./foo.ts`. Teach webpack the same resolution.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
