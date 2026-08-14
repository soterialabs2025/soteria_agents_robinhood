/**
 * Smoke: pool short-horizon Δ% (m5/m15/m30/h1) + h24 — same path as Demeter (`fetchTokenComparison` → `buildTokenComparison`).
 * Relates to `DEFAULT_MAX_NEGATIVE_PRICE_CHANGE_M5_M15_M30_H1_PCT` and Float / scheduled short-horizon gates.
 *
 * Run: npx tsx scripts/coingecko-short-horizon-smoke.ts
 */
import "dotenv/config";
import { fetchTokenComparison } from "../app/action-providers/coingecko-action-provider";
import { getMaxNegativePriceChangeM5M15M30Pct } from "../app/config/demeter-config";

async function main() {
  const gate = getMaxNegativePriceChangeM5M15M30Pct();
  const cmp = (await fetchTokenComparison()) as {
    tokens_summary?: Array<{
      symbol: string;
      address: string;
      price_change_m5_pct: number | null;
      price_change_m15_pct: number | null;
      price_change_m30_pct: number | null;
      price_change_h1_pct: number | null;
      price_change_h24_pct: number | null;
      volume_m5?: number;
      volume_m15?: number;
    }>;
    max_negative_price_change_m5_m15_m30_h1_pct?: number;
  };

  console.log(
    JSON.stringify(
      {
        max_negative_price_change_m5_m15_m30_h1_pct_from_comparison: cmp.max_negative_price_change_m5_m15_m30_h1_pct,
        getMaxNegativePriceChangeM5M15M30Pct: gate,
        note: "Values are pool price_change_percentage from CoinGecko onchain pools/multi; 0 can be a real API value.",
      },
      null,
      2
    )
  );
  console.log("");

  const rows = (cmp.tokens_summary ?? []).map((t) => ({
    symbol: t.symbol,
    m5_pct: t.price_change_m5_pct,
    m15_pct: t.price_change_m15_pct,
    m30_pct: t.price_change_m30_pct,
    h1_pct: t.price_change_h1_pct,
    h24_pct: t.price_change_h24_pct,
    vol_m5_usd: t.volume_m5 ?? null,
    vol_m15_usd: t.volume_m15 ?? null,
  }));

  console.table(rows);

  const withExactZero = rows.filter(
    (r) => r.m5_pct === 0 || r.m15_pct === 0 || r.m30_pct === 0 || r.h1_pct === 0
  );
  console.log(
    `Tokens with at least one window === 0 (exact): ${withExactZero.length}`,
    withExactZero.length ? `→ ${withExactZero.map((r) => r.symbol).join(", ")}` : ""
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
