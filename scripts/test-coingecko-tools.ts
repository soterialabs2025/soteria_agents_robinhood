#!/usr/bin/env npx tsx
/**
 * Quick test of CoinGecko action provider tools.
 * Run: npx tsx scripts/test-coingecko-tools.ts
 */

import "dotenv/config";
import { createAgent } from "../app/api/agent/create-agent.js";

async function main() {
  console.log("Initializing agent...");
  const agent = await createAgent();

  console.log("Testing coingecko_getMultipleTokenPrices (uses TOKEN_ADDRESS_ARRAY)...");
  const priceRes = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content: "Call coingecko_getMultipleTokenPrices with no arguments to get prices for the configured Base tokens.",
        },
      ],
    },
    { configurable: { thread_id: `test_${Date.now()}` } }
  );

  const lastMsg = priceRes.messages[priceRes.messages.length - 1];
  console.log("Agent response:", typeof lastMsg.content === "string" ? lastMsg.content.slice(0, 500) : lastMsg.content);
  console.log("\n✓ Price test complete");

  console.log("\nTesting coingecko_getPoolInfo (uses TOKEN_POOL_ADDRESS_ARRAY when no address given)...");
  const poolRes = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content: "Call coingecko_getPoolInfo without a pool address to get info for all configured pools.",
        },
      ],
    },
    { configurable: { thread_id: `test_pool_${Date.now()}` } }
  );

  const poolMsg = poolRes.messages[poolRes.messages.length - 1];
  console.log("Agent response:", typeof poolMsg.content === "string" ? poolMsg.content.slice(0, 500) : poolMsg.content);
  console.log("\n✓ Pool test complete");

  console.log("\nAll tests passed.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
