/**
 * One-shot report: each configured Demeter token row with 24h pool turnover
 * (pool volume_usd.h24 ÷ liquidity; liquidity = reserve_in_usd when positive else base+quote).
 *
 * Run: npx tsx scripts/report-token-volatility-h24.ts
 */
import "dotenv/config";
import { fetchTokenComparison } from "../app/action-providers/coingecko-action-provider";
import { getMaxVolatilityH24Usd, getMinVolatilityH24Usd, passesVolatilityH24Band } from "../app/config/demeter-config";

type SummaryRow = {
  symbol: string;
  address: string;
  pool_volume_h24_usd?: number;
  pool_reserve_in_usd?: number | null;
  liquidity_usd?: number | null;
  volatility_h24?: number;
};

async function main() {
  const minGate = getMinVolatilityH24Usd();
  const maxGate = getMaxVolatilityH24Usd();
  const cmp = (await fetchTokenComparison()) as {
    tokens_summary?: SummaryRow[];
    min_volatility_h24_usd?: number;
    max_volatility_h24_usd?: number;
    market_breadth_defensive_active?: boolean;
  };

  const rows = cmp.tokens_summary ?? [];
  const minFromComparison = cmp.min_volatility_h24_usd;
  const maxFromComparison = cmp.max_volatility_h24_usd;

  console.log(
    JSON.stringify(
      {
        min_volatility_h24_usd_getter: minGate,
        max_volatility_h24_usd_getter: maxGate,
        min_volatility_h24_usd_comparison: minFromComparison,
        max_volatility_h24_usd_comparison: maxFromComparison,
        market_breadth_defensive_active: cmp.market_breadth_defensive_active ?? false,
        note: "volatility_h24 = pool_volume_h24_usd ÷ (pool_reserve_in_usd if set else liquidity_usd base+quote). passes_gate when value is within min/max (each bound disabled when ≤ 0).",
      },
      null,
      2
    )
  );
  console.log("");

  const dataRows = rows.filter((r) => r.address?.toLowerCase() !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");

  const table = dataRows.map((r) => {
    const v = r.volatility_h24;
    const pass = passesVolatilityH24Band(v, minGate, maxGate);
    return {
      symbol: r.symbol,
      address: r.address,
      pool_vol_h24_usd: r.pool_volume_h24_usd ?? null,
      reserve_in_usd: r.pool_reserve_in_usd ?? null,
      liquidity_base_plus_quote_usd: r.liquidity_usd ?? null,
      volatility_h24: v ?? null,
      passes_volatility_gate: pass,
    };
  });

  console.table(table);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
