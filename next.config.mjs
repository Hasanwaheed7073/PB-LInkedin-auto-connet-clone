/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The Playwright worker is a standalone Node process, never bundled into the
  // app. Listing these keeps an accidental import from pulling them into a
  // server bundle.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg', 'playwright'],

  // Do not auto-generate AGENTS.md / CLAUDE.md in the project root.
  agentRules: false,
};

export default nextConfig;
