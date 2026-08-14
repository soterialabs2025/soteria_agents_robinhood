/**
 * CoinGecko Pro smoke: same URL shapes as `coingecko-action-provider`.
 *
 * Run:
 *   npx tsx scripts/coingecko-api-smoke.ts
 *   npx tsx scripts/coingecko-api-smoke.ts noice
 *   npx tsx scripts/coingecko-api-smoke.ts v4-full
 *   npx tsx scripts/coingecko-api-smoke.ts <token> <pool>
 *
 * Note: token and pool contract addresses are different; `noice` uses the
 * mapping from TOKEN_POOL_PAIRS in the action provider.
 */
import dotenv from "dotenv";

dotenv.config();

import {
  fetchTokenComparisonV4,
  TRITON_V4_TOKEN_ADDRESS_ARRAY,
} from "../app/action-providers/coingecko-action-provider";
import { COINGECKO_NETWORK } from "../app/config/chain-config";

const key = process.env.COIN_GECKO_API_KEY;
const base = "https://pro-api.coingecko.com/api/v3";

/** Matches `TOKEN_POOL_PAIRS` for noice (slot 5). */
const NOICE = {
  token: "0x9cb41fd9dc6891bae8187029461bfaadf6cc0c69",
  pool: "0xeff7f8fe083d7a446717b992bf84391253e54789",
} as const;

const DEFAULT_CLANKER = {
  token: "0x1bc0c42215582d5a085795f4badbac3ff36d1bcb",
  pool: "0xc1a6fbedae68e1472dbb91fe29b51f7a0bd44f97",
} as const;

function headers() {
  if (!key) throw new Error("COIN_GECKO_API_KEY missing in .env");
  return { accept: "application/json", "x-cg-pro-api-key": key } as const;
}

function pick(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p];
    } else return undefined;
  }
  return cur;
}

function ratioFromTx(tx: unknown, window: "h6" | "h24"): number | null {
  if (!tx || typeof tx !== "object") return null;
  const w = (tx as Record<string, { buys?: number; sells?: number }>)[window];
  if (!w) return null;
  const buys = w.buys ?? 0;
  const sells = w.sells ?? 0;
  const sum = buys + sells;
  return sum > 0 ? buys / sum : 0.5;
}

function resolveTargets(): { label: string; token: string; pool: string } | "v4-full" {
  const argv = process.argv.slice(2).map((a) => a.trim().toLowerCase());
  if (argv[0] === "v4-full") return "v4-full";
  if (argv[0] === "noice") {
    return { label: "noice", token: NOICE.token, pool: NOICE.pool };
  }
  if (argv.length >= 2 && argv[0].startsWith("0x") && argv[1].startsWith("0x")) {
    return { label: "cli", token: argv[0], pool: argv[1] };
  }
  return { label: "clanker (default)", token: DEFAULT_CLANKER.token, pool: DEFAULT_CLANKER.pool };
}

async function main() {
  const targets = resolveTargets();
  if (targets === "v4-full") {
    console.log(`\n--- Smoke: Float V4 full universe (${TRITON_V4_TOKEN_ADDRESS_ARRAY.length} tokens) ---`);
    console.log("Same path as Demeter Float periodic scheduled comparison.\n");
    try {
      const comparison = await fetchTokenComparisonV4(COINGECKO_NETWORK);
      const ranked = (comparison as { weighted_ranking?: { ranked?: unknown[] } }).weighted_ranking?.ranked;
      console.log("status: 200 (fetchTokenComparisonV4 ok)");
      console.log("tokens:", TRITON_V4_TOKEN_ADDRESS_ARRAY.length);
      console.log("ranked count:", ranked?.length ?? 0);
    } catch (e) {
      console.error("v4-full failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
    return;
  }

  const { label, token, pool } = targets;
  const network = COINGECKO_NETWORK;

  console.log(`\n--- Smoke: ${label} ---`);
  console.log("token:", token);
  console.log("pool: ", pool);
  if (token.toLowerCase() === pool.toLowerCase()) {
    console.warn(
      "Warning: token and pool are identical — CoinGecko pool endpoints expect the **pair** address, not the token address.\n"
    );
  }

  console.log("=== 1) simple/token_price (Base) ===\n");
  const u1 = `${base}/simple/token_price/${network}?contract_addresses=${token}&vs_currencies=usd`;
  const r1 = await fetch(u1, { headers: headers() });
  console.log("URL:", u1);
  console.log("status:", r1.status, r1.statusText);
  console.log("body:", JSON.stringify(await r1.json(), null, 2).slice(0, 800));

  const tokenQ = new URLSearchParams({ include: "top_pools", include_composition: "true" });
  console.log("\n=== 2) onchain tokens/multi (this token only) ===\n");
  const u2 = `${base}/onchain/networks/${network}/tokens/multi/${encodeURIComponent(token)}?${tokenQ}`;
  const r2 = await fetch(u2, { headers: headers() });
  console.log("status:", r2.status);
  const j2 = await r2.json();
  console.log("data[0].attributes keys:", Object.keys((j2 as { data?: { attributes?: object }[] }).data?.[0]?.attributes ?? {}));
  console.log("included length:", (j2 as { included?: unknown[] }).included?.length ?? 0);

  const poolQ = new URLSearchParams({
    include: "base_token,quote_token,dex",
    include_composition: "true",
    include_volume_breakdown: "true",
  });
  console.log("\n=== 3) onchain pools/multi (1 pool) ===\n");
  const u3 = `${base}/onchain/networks/${network}/pools/multi/${encodeURIComponent(pool)}?${poolQ}`;
  const r3 = await fetch(u3, { headers: headers() });
  console.log("status:", r3.status);
  const j3 = await r3.json();
  const vol = pick(j3, ["data", "0", "attributes", "volume_usd"]);
  console.log("data[0].attributes.volume_usd:", JSON.stringify(vol, null, 2));

  console.log("\n=== 4) onchain pools/{address} (single pool stats) ===\n");
  const u4 = `${base}/onchain/networks/${network}/pools/${pool}?${poolQ}`;
  const r4 = await fetch(u4, { headers: headers() });
  console.log("status:", r4.status);
  const j4 = await r4.json();
  const d = (j4 as { data?: { attributes?: Record<string, unknown> } }).data;
  const a = d?.attributes;
  const tx = a?.transactions;
  console.log(
    "sample:",
    JSON.stringify(
      {
        name: a?.name,
        reserve_in_usd: a?.reserve_in_usd,
        volume_usd: a?.volume_usd,
        price_change_percentage: a?.price_change_percentage,
        transactions_h6: pick(j4, ["data", "attributes", "transactions", "h6"]),
        transactions_h24: pick(j4, ["data", "attributes", "transactions", "h24"]),
      },
      null,
      2
    )
  );
  console.log(
    "derived (same as buildTokenComparison): buy_sell_ratio_h6=",
    ratioFromTx(tx, "h6"),
    "buy_sell_ratio_h24=",
    ratioFromTx(tx, "h24")
  );

  console.log("\n=== 5) coins/robinhood/contract/.../market_chart/range (last ~48h, hourly) ===\n");
  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - 48 * 3600;
  const u5 = `${base}/coins/${network}/contract/${token}/market_chart/range?vs_currency=usd&from=${fromSec}&to=${toSec}&interval=hourly&precision=18`;
  const r5 = await fetch(u5, { headers: headers() });
  console.log("status:", r5.status);
  const j5 = await r5.json() as { prices?: [number, number][] };
  console.log("prices points:", j5.prices?.length ?? 0, "first:", j5.prices?.[0]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
