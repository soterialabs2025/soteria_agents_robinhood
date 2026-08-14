#!/usr/bin/env npx tsx
import "dotenv/config";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { prepareAgentkitAndWalletProvider } from "../app/api/agent/prepare-agentkit";

async function main() {
  for (const profile of ["chat", "full"] as const) {
    const { agentkit } = await prepareAgentkitAndWalletProvider({ toolProfile: profile });
    const raw = await getLangChainTools(agentkit);
    const seen = new Set<string>();
    const unique = raw.filter((t) => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });
    console.log(`\n${profile}: ${raw.length} raw → ${unique.length} unique tools`);
    for (const t of unique) console.log(`  ${t.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
