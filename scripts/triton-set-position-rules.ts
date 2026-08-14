#!/usr/bin/env npx tsx
/**
 * Set Triton custom TP/SL (applies to whatever token is held — not symbol-specific).
 *
 * Example:
 *   npx tsx scripts/triton-set-position-rules.ts --tp 5 --sl 2
 */
import "dotenv/config";
import { setTritonPositionRulesFromChat } from "../app/config/triton-position-rules";

function parseArgs(argv: string[]) {
  let tp: number | undefined;
  let sl: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tp" || a === "--take-profit") tp = Number(argv[++i]);
    else if (a === "--sl" || a === "--stop-loss") sl = Number(argv[++i]);
  }
  if (tp === undefined && sl === undefined) {
    console.error("Usage: npx tsx scripts/triton-set-position-rules.ts --tp 5 --sl 2");
    process.exit(1);
  }
  return { tp, sl };
}

async function main() {
  const { tp, sl } = parseArgs(process.argv.slice(2));
  const rules = setTritonPositionRulesFromChat({
    takeProfitPctFromEntry: tp,
    stopLossPctFromEntry: sl,
  });
  console.log(JSON.stringify(rules, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
