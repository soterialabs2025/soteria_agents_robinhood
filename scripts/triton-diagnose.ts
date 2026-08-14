/**
 * One-shot Triton / LiquidStratMinV4 diagnostics (no txs).
 * Run: npm run triton:diagnose
 */
import "dotenv/config";
import { createPublicClient, http } from "viem";

import {
  assertTritonWalletMatches,
  getTritonWalletAddress,
  hasV4PoolConfigForAsset,
  readLiquidStratAccess,
  readLiquidStratAssetAddr,
  readLiquidStratHeldAsset,
  isTritonWethAddress,
} from "../app/action-providers/liquid-strat-min-v4-action-provider";
import { fetchTokenComparisonV4 } from "../app/action-providers/coingecko-action-provider";
import { getPipelineLoopThresholds, getTritonPipelineLoopThresholds } from "../app/config/ranking-eligibility";
import { formatTritonDefensiveExitRulesSummary } from "../app/config/triton-defensive-exit";
import {
  getTritonMinPoolLiquidityUsd,
  getTritonOffensiveMomentumExcludePriceChangeH24PctGte,
  getTritonPrivateKeyFromEnv,
  getTritonScheduledChangeMinWeightedScore,
  LIQUID_STRAT_MIN_V4_ADDRESS,
  TRITON_WALLET_ADDRESS,
  TRITON_WETH_ADDRESS,
} from "../app/config/triton-config";
import { resolveViemChainForNetworkId } from "../app/api/agent/evm-wallet-from-env";
import { getRpcUrl } from "../app/config/chain-config";
import { getNetworkId } from "../app/config/demeter-config";

async function main() {
  const rpcUrl = getRpcUrl();
  const pk = getTritonPrivateKeyFromEnv();
  const wallet = getTritonWalletAddress(pk);
  const access = await readLiquidStratAccess(rpcUrl);
  const assetAddr = await readLiquidStratAssetAddr(rpcUrl);
  const heldAsset = await readLiquidStratHeldAsset(rpcUrl);

  console.log("=== Triton diagnose ===");
  console.log("expected_triton_wallet:", TRITON_WALLET_ADDRESS);
  console.log("triton_wallet:", wallet);
  console.log("contract:", LIQUID_STRAT_MIN_V4_ADDRESS);
  console.log("assetAddr:", assetAddr);
  console.log("ASSET_held:", heldAsset);
  console.log(
    "loop_branch:",
    isTritonWethAddress(heldAsset) ? "offensive (WETH held)" : "defensive (token held)"
  );
  if (isTritonWethAddress(heldAsset) && !isTritonWethAddress(assetAddr)) {
    console.warn(
      "stale_assetAddr: assetAddr does not match WETH parking — old code used assetAddr and may have sent changeAsset(WETH) no-ops"
    );
  }
  const wethPool = await hasV4PoolConfigForAsset(rpcUrl, TRITON_WETH_ADDRESS as `0x${string}`);
  const assetPool = await hasV4PoolConfigForAsset(rpcUrl, heldAsset);
  console.log("v4_pool_config_weth:", wethPool);
  console.log("v4_pool_config_held_asset:", assetPool);
  console.log("owner:", access.owner);
  console.log("tritonAddr:", access.tritonAddr);
  console.log("mode:", access.mode);
  console.log("defensive_exit_rules:", formatTritonDefensiveExitRulesSummary());

  try {
    assertTritonWalletMatches(wallet, access);
    console.log("can_change_asset: true");
  } catch (e) {
    console.log("can_change_asset: false");
    console.log("WARN:", e instanceof Error ? e.message : e);
  }

  const client = createPublicClient({
    chain: resolveViemChainForNetworkId(getNetworkId()),
    transport: http(rpcUrl),
  });
  const balance = await client.getBalance({ address: wallet });
  console.log("triton_eth_balance_wei:", balance.toString());

  if (process.env.COIN_GECKO_API_KEY) {
    const comparison = (await fetchTokenComparisonV4()) as {
      weighted_ranking?: { ranked: Array<{ symbol: string; score: number }> };
      weighted_ranking_eligible?: number;
      pre_momentum_eligible_count?: number;
      excluded_offensive_momentum?: Array<{ symbol: string; reason: string }>;
    };
    const top = comparison.weighted_ranking?.ranked?.[0];
    console.log("min_weighted_score:", getTritonScheduledChangeMinWeightedScore());
    console.log("triton_loop_thresholds:", getTritonPipelineLoopThresholds());
    console.log("float_v4_loop_thresholds:", getPipelineLoopThresholds("v4"));
    console.log(
      "triton_exclude_h24_pct_gte:",
      getTritonOffensiveMomentumExcludePriceChangeH24PctGte(),
      "(Float uses demeter-config DEFAULT_OFFENSIVE_MOMENTUM_EXCLUDE_PRICE_CHANGE_H24_PCT_GTE)"
    );
    console.log(
      "triton_min_pool_liquidity_usd:",
      getTritonMinPoolLiquidityUsd(),
      "(Float uses demeter-config DEFAULT_MIN_POOL_LIQUIDITY_USD)"
    );
    console.log("v4_ranked_top:", top ? `${top.symbol} (${top.score.toFixed(3)})` : "none");
    console.log("weighted_ranking_eligible:", comparison.weighted_ranking_eligible ?? "n/a");
    console.log("pre_momentum_eligible:", comparison.pre_momentum_eligible_count ?? "n/a");
    if (comparison.excluded_offensive_momentum?.length) {
      console.log("momentum_reject_sample:", comparison.excluded_offensive_momentum.slice(0, 3));
    }
  } else {
    console.log("skip comparison: COIN_GECKO_API_KEY missing");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
