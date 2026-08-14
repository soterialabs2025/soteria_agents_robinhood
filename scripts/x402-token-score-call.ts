/**
 * Paid call to the Bankr x402 `token-score` endpoint (~$0.01 USDG on Robinhood Chain).
 *
 * Signer: DEMETER_TWO_PRIVATE_KEY (must hold USDG on Robinhood Chain).
 *
 * Usage:
 *   npm run x402:token-score
 *   npm run x402:token-score -- 0xTokenA 0xTokenB
 *   npm run x402:token-score -- --url https://x402.bankr.bot/0xYourWallet/token-score 0xA 0xB
 *
 * Env:
 *   DEMETER_TWO_PRIVATE_KEY   required
 *   X402_TOKEN_SCORE_URL      Bankr paid URL (or pass --url)
 */
import "dotenv/config";

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const DEFAULT_TOKENS = [
  "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH Robinhood
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG Robinhood
] as const;

function normalizePk(raw: string): Hex {
  const t = raw.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as Hex;
}

function parseArgs(argv: string[]): { url: string | undefined; tokens: string[] } {
  let url: string | undefined;
  const tokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") {
      url = argv[++i]?.trim();
      continue;
    }
    if (a.startsWith("--url=")) {
      url = a.slice("--url=".length).trim();
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    }
    tokens.push(a.trim());
  }
  return { url, tokens };
}

async function main(): Promise<void> {
  const { url: urlArg, tokens: tokenArgs } = parseArgs(process.argv.slice(2));
  const url = (urlArg || process.env.X402_TOKEN_SCORE_URL?.trim() || "").replace(/\/$/, "");
  if (!url) {
    throw new Error(
      "Set X402_TOKEN_SCORE_URL or pass --url https://x402.bankr.bot/<wallet>/token-score"
    );
  }

  const pkRaw = process.env.DEMETER_TWO_PRIVATE_KEY?.trim();
  if (!pkRaw) throw new Error("DEMETER_TWO_PRIVATE_KEY is required");

  const account = privateKeyToAccount(normalizePk(pkRaw));
  const tokens = tokenArgs.length >= 2 ? tokenArgs : [...DEFAULT_TOKENS];

  const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`[x402] payer=${account.address}`);
  console.log(`[x402] POST ${url}`);
  console.log(`[x402] tokens=${JSON.stringify(tokens)}`);

  const res = await fetchWithPayment(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ tokens }),
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    /* keep raw */
  }

  console.log(`[x402] status=${res.status}`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));

  if (!res.ok) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
