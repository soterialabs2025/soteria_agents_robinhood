/**
 * Smoke: pool m5/m15/m30 Δ% vs offensive momentum min/max bands (scheduled path).
 *
 * Run: npx tsx scripts/coingecko-offensive-momentum-m5-smoke.ts
 */
import "dotenv/config";
import { fetchTokenComparison } from "../app/action-providers/coingecko-action-provider";
import {
  getOffensiveMomentumMinM5Pct,
  getOffensiveMomentumMaxM5Pct,
  getOffensiveMomentumMinM15Pct,
  getOffensiveMomentumMaxM15Pct,
  getOffensiveMomentumMinM30Pct,
  getOffensiveMomentumMaxM30Pct,
  getOffensiveTokenRankingMetrics,
  offensiveMomentumExcludeReason,
  passesOffensiveMomentumPoolPctBand,
} from "../app/config/demeter-config";

async function main() {
  const bands = {
    m5: { min: getOffensiveMomentumMinM5Pct(), max: getOffensiveMomentumMaxM5Pct() },
    m15: { min: getOffensiveMomentumMinM15Pct(), max: getOffensiveMomentumMaxM15Pct() },
    m30: { min: getOffensiveMomentumMinM30Pct(), max: getOffensiveMomentumMaxM30Pct() },
  };

  const cmp = (await fetchTokenComparison(undefined, undefined, {
    rankingMetrics: getOffensiveTokenRankingMetrics(),
    changeStrategyStrictShortHorizons: true,
    offensiveMomentumAbsoluteGates: true,
  })) as {
    offensive_momentum_gates_active?: boolean;
    tokens_summary?: Array<{
      symbol: string;
      price_change_m5_pct: number | null;
      price_change_m15_pct: number | null;
      price_change_m30_pct: number | null;
      price_change_h12_pct: number | null;
      price_change_h24_pct: number | null;
      volume_m15: number;
      volume_m30: number;
      volume_h12: number;
    }>;
  };

  console.log(
    JSON.stringify(
      {
        offensive_momentum_gates_active: cmp.offensive_momentum_gates_active,
        bands,
        rule: "Pass when min ≤ Δ% ≤ max per window (m5 skipped when null; max ≤ 0 disables ceiling).",
      },
      null,
      2
    )
  );
  console.log("");

  const rows = (cmp.tokens_summary ?? []).map((t) => {
    const m5 = t.price_change_m5_pct;
    const m15 = t.price_change_m15_pct;
    const m30 = t.price_change_m30_pct;
    return {
      symbol: t.symbol,
      m5_pct: m5,
      m5_in_band: m5 == null ? "skip" : passesOffensiveMomentumPoolPctBand(m5, bands.m5.min, bands.m5.max),
      m15_pct: m15,
      m15_in_band:
        m15 == null ? "n/a" : passesOffensiveMomentumPoolPctBand(m15, bands.m15.min, bands.m15.max),
      m30_pct: m30,
      m30_in_band:
        m30 == null ? "n/a" : passesOffensiveMomentumPoolPctBand(m30, bands.m30.min, bands.m30.max),
      momentum_block: offensiveMomentumExcludeReason({
        price_change_h24_pct: t.price_change_h24_pct,
        price_change_h12_pct: t.price_change_h12_pct,
        price_change_m5_pct: t.price_change_m5_pct,
        price_change_m15_pct: t.price_change_m15_pct,
        price_change_m30_pct: t.price_change_m30_pct,
        volume_m15: t.volume_m15,
        volume_m30: t.volume_m30,
        volume_h12: t.volume_h12,
      }) ?? "(pass)",
    };
  });

  console.table(
    rows.map((r) => ({
      symbol: r.symbol,
      m5: r.m5_pct,
      m5_ok: r.m5_in_band,
      m15: r.m15_pct,
      m15_ok: r.m15_in_band,
      m30: r.m30_pct,
      m30_ok: r.m30_in_band,
    }))
  );

  const passAll = rows.filter((r) => r.momentum_block === "(pass)");
  console.log(`\nPass all momentum gates: ${passAll.length} / ${rows.length}`);
  const blocked = rows.filter((r) => r.momentum_block !== "(pass)");
  for (const r of blocked.slice(0, 20)) {
    console.log(`  ${r.symbol}: ${r.momentum_block}`);
  }
  if (blocked.length > 20) console.log(`  … and ${blocked.length - 20} more`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
