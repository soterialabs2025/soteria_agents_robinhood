/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /** Avoid webpack bundling LangChain/AgentKit/viem — fixes prod "X is not a function" on /api/agent */
  serverExternalPackages: [
    "@coinbase/agentkit",
    "@coinbase/agentkit-langchain",
    "@coinbase/cdp-sdk",
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/openai",
    "langchain",
    "viem",
    "@noble/curves",
    "@noble/hashes",
  ],
};

export default nextConfig;
