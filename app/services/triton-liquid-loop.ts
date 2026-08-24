/**
 * LiquidStratMinV4 rotation loop — runs inside Demeter (`TRITON_PRIVATE_KEY`) or standalone (`npm run triton`).
 */
import type { Address } from "viem";

import { fetchTokenComparisonV4 } from "../action-providers/coingecko-action-provider";
import {
  assertTritonWalletMatches,
  fetchTokenPriceUsd,
  getTritonWalletAddress,
  readLiquidStratAccess,
  readLiquidStratAssetAddr,
  readLiquidStratHeldAsset,
  hasV4PoolConfigForAsset,
  isTritonWethAddress,
  sendLiquidStratChangeAsset,
} from "../action-providers/liquid-strat-min-v4-action-provider";
import { getTritonPipelineLoopThresholds } from "../config/ranking-eligibility";
import { getRpcUrl } from "../config/chain-config";
import {
  getTopActionableOffensiveScore,
  passesVolatilityH24Band,
} from "../config/demeter-config";
import {
  evaluateTritonDefensiveExit,
  formatTritonDefensiveExitRulesSummary,
  getTritonDefensiveExitRules,
  pctFromEntryPrice,
} from "../config/triton-defensive-exit";
import { isTritonTieredDefensiveExitEnabled } from "../config/triton-defensive-exit-control";
import {
  describeTritonCustomRulesGap,
  evaluateTritonCustomPositionRules,
  formatTritonPositionRulesSummary,
  getLastLoadedTritonPositionRulesPath,
  getTritonPositionRulesPath,
  loadTritonPositionRules,
} from "../config/triton-position-rules";
import { getSoteriaRepoRoot } from "../config/soteria-runtime-paths";
import {
  clearTritonScheduledAction,
  formatTritonScheduledActionSummary,
  isTritonScheduledActionDue,
  loadTritonScheduledAction,
  msUntilTritonScheduledAction,
} from "../config/triton-scheduled-actions";
import { tokenNameForAddress } from "../config/triton-v4-token-registry";
import {
  getTritonOffensiveEntryEnabled,
  getTritonPriceCheckIntervalMs,
  getTritonPrivateKeyFromEnv,
  LIQUID_STRAT_MIN_V4_ADDRESS,
  getTritonWethAddress,
} from "../config/triton-config";
import { checkDemeterStopSignal, sleepWithStopCheck } from "../config/demeter-stop";
import {
  clearTritonPositionState,
  loadTritonPositionState,
  saveTritonPositionState,
} from "./triton-position-state";

type ComparisonShape = {
  weighted_ranking?: { ranked: Array<{ symbol: string; score: number }> };
  tokens_summary?: Array<{
    symbol: string;
    address: string;
    volume_h12?: number;
    liquidity_usd?: number | null;
    volatility_h24?: number;
  }>;
  excluded_offensive_momentum?: Array<{ symbol: string; reason: string }>;
  pre_momentum_eligible_count?: number;
  weighted_ranking_eligible?: number;
};

function pickTopOffensiveToken(comparison: ComparisonShape): {
  symbol: string;
  address: string;
  score: number;
} | null {
  const ranked = comparison.weighted_ranking?.ranked;
  const tokens = comparison.tokens_summary;
  if (!ranked?.length || !tokens?.length) return null;

  const loopCfg = getTritonPipelineLoopThresholds();
  const ranking = loopCfg.ranking;
  const minVol = ranking.minVolumeH12Usd;
  const minLiq = ranking.minPoolLiquidityUsd;
  const minVolatility = ranking.minVolatilityH24Usd;
  const maxVolatility = ranking.maxVolatilityH24Usd;
  const scoreFloor = loopCfg.scheduledChangeMinWeightedScore;

  if (scoreFloor > 0) {
    const topActionable = getTopActionableOffensiveScore(ranked, tokens, {
      minVolumeH12Usd: minVol,
      minPoolLiquidityUsd: minLiq,
      minVolatilityH24Usd: minVolatility,
      maxVolatilityH24Usd: maxVolatility,
      wethLower: getTritonWethAddress().toLowerCase(),
    });
    if (!topActionable || topActionable.score < scoreFloor) {
      console.log(
        `[Triton] No entry: top actionable score ${topActionable?.score.toFixed(3) ?? "n/a"} < min ${scoreFloor}`
      );
      return null;
    }
  }

  for (const { symbol, score } of ranked) {
    const token = tokens.find((t) => t.symbol === symbol);
    const addr = token?.address?.toLowerCase();
    if (!addr || addr === getTritonWethAddress().toLowerCase()) continue;
    if (token && typeof token.volume_h12 === "number" && token.volume_h12 < minVol) continue;
    if (token && (typeof token.liquidity_usd !== "number" || token.liquidity_usd < minLiq)) continue;
    if (!passesVolatilityH24Band(token?.volatility_h24, minVolatility, maxVolatility)) continue;
    return { symbol, address: token!.address, score };
  }
  return null;
}

async function tryOffensiveEntry(privateKey: string, rpcUrl: string): Promise<void> {
  const comparison = (await fetchTokenComparisonV4()) as ComparisonShape;

  if (
    comparison.excluded_offensive_momentum?.length &&
    (comparison.weighted_ranking_eligible ?? 0) === 0
  ) {
    const pre = comparison.pre_momentum_eligible_count ?? 0;
    console.log(
      `[Triton] On WETH — no momentum-qualified tokens (${pre} pre-momentum eligible). Sample rejections:`
    );
    for (const r of comparison.excluded_offensive_momentum.slice(0, 5)) {
      console.log(`  ${r.symbol}: ${r.reason}`);
    }
    return;
  }

  const pick = pickTopOffensiveToken(comparison);
  if (!pick) {
    console.log("[Triton] On WETH — no eligible offensive candidate after filters / score gate");
    return;
  }

  const pickAddr = pick.address as Address;
  const poolOk = await hasV4PoolConfigForAsset(rpcUrl, pickAddr);
  if (!poolOk) {
    console.error(
      `[Triton] Skip changeAsset(${pick.symbol}): no V4 pool config on LiquidStratMinV4 for ${pick.address}`
    );
    return;
  }

  console.log(
    `[Triton] Offensive pick ${pick.symbol} (score ${pick.score.toFixed(3)}) → changeAsset(${pick.address})`
  );
  const tx = await sendLiquidStratChangeAsset(privateKey, rpcUrl, pickAddr);
  if (!tx.success) {
    console.error(`[Triton] changeAsset failed: ${tx.error}`);
    return;
  }
  console.log(`[Triton] changeAsset tx: ${tx.transactionHash}`);

  const entryPrice = await fetchTokenPriceUsd(pick.address);
  if (entryPrice != null) {
    saveTritonPositionState({
      assetAddress: pick.address.toLowerCase(),
      entryPriceUsd: entryPrice,
      peakGainPctFromEntry: 0,
      enteredAtUtc: new Date().toISOString(),
    });
    console.log(`[Triton] Entry price $${entryPrice} recorded for ${pick.symbol}`);
  } else {
    clearTritonPositionState();
    console.warn("[Triton] Could not fetch entry price — defensive exit will bootstrap on next tick");
  }
  clearTritonScheduledAction();
}

function formatPctFromEntry(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

async function recordTritonEntryState(assetAddress: string, symbol: string): Promise<void> {
  const entryPrice = await fetchTokenPriceUsd(assetAddress);
  if (entryPrice != null) {
    saveTritonPositionState({
      assetAddress: assetAddress.toLowerCase(),
      entryPriceUsd: entryPrice,
      peakGainPctFromEntry: 0,
      enteredAtUtc: new Date().toISOString(),
    });
    console.log(`[Triton] Entry price $${entryPrice} recorded for ${symbol}`);
  } else {
    clearTritonPositionState();
    console.warn(`[Triton] Could not fetch entry price for ${symbol} — defensive exit will bootstrap on next tick`);
  }
}

/** Returns true when a due scheduled exit/rotate was attempted (success or fail). */
async function tryExecuteScheduledAction(
  held: Address,
  privateKey: string,
  rpcUrl: string
): Promise<boolean> {
  const action = loadTritonScheduledAction();
  if (!action || !isTritonScheduledActionDue(action)) return false;

  const heldLc = held.toLowerCase();

  if (action.kind === "exit_to_weth") {
    if (isTritonWethAddress(held)) {
      console.log("[Triton] Scheduled exit to WETH skipped — already on WETH");
      clearTritonScheduledAction();
      return false;
    }
    console.log(`[Triton] Scheduled exit due → changeAsset(WETH) (${action.notes ?? "time-based"})`);
    const tx = await sendLiquidStratChangeAsset(privateKey, rpcUrl, getTritonWethAddress() as Address);
    if (!tx.success) {
      console.error(`[Triton] Scheduled exit changeAsset(WETH) failed: ${tx.error}`);
      return true;
    }
    console.log(`[Triton] Scheduled exit tx: ${tx.transactionHash}`);
    clearTritonPositionState();
    clearTritonScheduledAction();
    return true;
  }

  const target = action.tokenAddress as Address;
  if (heldLc === target.toLowerCase()) {
    console.log(`[Triton] Scheduled rotate skipped — already holding ${action.tokenName}`);
    clearTritonScheduledAction();
    return false;
  }

  const poolOk = await hasV4PoolConfigForAsset(rpcUrl, target);
  if (!poolOk) {
    console.error(
      `[Triton] Scheduled rotate to ${action.tokenName} failed: no V4 pool config for ${action.tokenAddress}`
    );
    clearTritonScheduledAction();
    return true;
  }

  console.log(
    `[Triton] Scheduled rotate due → changeAsset(${action.tokenName}) (${action.notes ?? "time-based"})`
  );
  const tx = await sendLiquidStratChangeAsset(privateKey, rpcUrl, target);
  if (!tx.success) {
    console.error(`[Triton] Scheduled rotate changeAsset failed: ${tx.error}`);
    return true;
  }
  console.log(`[Triton] Scheduled rotate tx: ${tx.transactionHash}`);
  clearTritonScheduledAction();
  if (isTritonWethAddress(target)) {
    clearTritonPositionState();
  } else {
    await recordTritonEntryState(target, action.tokenName);
  }
  return true;
}

async function checkDefensiveExit(
  currentAsset: Address,
  privateKey: string,
  rpcUrl: string
): Promise<void> {
  const assetLc = currentAsset.toLowerCase();
  let state = loadTritonPositionState();
  if (state && state.assetAddress.toLowerCase() !== assetLc) {
    state = null;
    clearTritonPositionState();
  }

  const currentPrice = await fetchTokenPriceUsd(currentAsset);
  if (currentPrice == null) {
    console.warn(`[Triton] Holding ${currentAsset} — could not fetch USD price`);
    return;
  }

  const rules = getTritonDefensiveExitRules();

  if (!state) {
    const bootstrapPct = pctFromEntryPrice(currentPrice, currentPrice);
    saveTritonPositionState({
      assetAddress: assetLc,
      entryPriceUsd: currentPrice,
      peakGainPctFromEntry: bootstrapPct,
      enteredAtUtc: new Date().toISOString(),
    });
    console.log(
      `[Triton] Bootstrapped entry $${currentPrice} for ${currentAsset} (no prior state; peak 0%)`
    );
    return;
  }

  const currentPct = pctFromEntryPrice(state.entryPriceUsd, currentPrice);
  const peakPct = Math.max(state.peakGainPctFromEntry, currentPct);
  if (peakPct > state.peakGainPctFromEntry) {
    state = { ...state, peakGainPctFromEntry: peakPct };
    saveTritonPositionState(state);
  }

  const customRules = loadTritonPositionRules();
  const tokenLabel = tokenNameForAddress(assetLc) ?? currentAsset.slice(0, 10);
  const customEval = evaluateTritonCustomPositionRules(
    assetLc,
    currentPct,
    peakPct,
    customRules,
    tokenLabel
  );

  if (customEval?.exit) {
    console.log(
      `[Triton] ${tokenLabel} now ${formatPctFromEntry(currentPct)} vs entry, peak ${formatPctFromEntry(peakPct)} — custom exit: ${customEval.reason}`
    );
    console.log(`[Triton] Custom exit → changeAsset(WETH)`);
    const tx = await sendLiquidStratChangeAsset(privateKey, rpcUrl, getTritonWethAddress() as Address);
    if (!tx.success) {
      console.error(`[Triton] changeAsset(WETH) failed: ${tx.error}`);
      return;
    }
    console.log(`[Triton] changeAsset(WETH) tx: ${tx.transactionHash}`);
    clearTritonPositionState();
    clearTritonScheduledAction();
    return;
  }

  const tieredEnabled = isTritonTieredDefensiveExitEnabled();
  const customNote =
    customEval && !customEval.exit ? ` | ${customEval.reason}` : "";
  const customGap = customEval ? null : describeTritonCustomRulesGap(assetLc, customRules);
  const gapNote = customGap ? ` | ${customGap}` : "";
  const pendingSchedule = loadTritonScheduledAction();
  const scheduleNote = pendingSchedule
    ? ` | scheduled: ${formatTritonScheduledActionSummary(pendingSchedule)}`
    : "";

  if (!tieredEnabled) {
    console.log(
      `[Triton] ${tokenLabel} now ${formatPctFromEntry(currentPct)} vs entry, peak ${formatPctFromEntry(peakPct)} — tiered defensive exits OFF (custom rules only)${customNote}${gapNote}${scheduleNote}`
    );
    return;
  }

  const evaluation = evaluateTritonDefensiveExit(currentPct, peakPct, rules);
  console.log(
    `[Triton] ${tokenLabel} now ${formatPctFromEntry(currentPct)} vs entry, peak ${formatPctFromEntry(peakPct)} — ${evaluation.reason}${customNote}${gapNote}${scheduleNote}`
  );

  if (!evaluation.exit) return;

  console.log(`[Triton] Defensive exit (${evaluation.tier}): ${evaluation.reason} → changeAsset(WETH)`);
  const tx = await sendLiquidStratChangeAsset(privateKey, rpcUrl, getTritonWethAddress() as Address);
  if (!tx.success) {
    console.error(`[Triton] changeAsset(WETH) failed: ${tx.error}`);
    return;
  }
  console.log(`[Triton] changeAsset(WETH) tx: ${tx.transactionHash}`);
  clearTritonPositionState();
  clearTritonScheduledAction();
}

/** LiquidStratMinV4 loop — uses TRITON_PRIVATE_KEY; respects Demeter stop signal when embedded. */
export async function tritonLiquidLoop(): Promise<void> {
  const privateKey = getTritonPrivateKeyFromEnv();
  const rpcUrl = getRpcUrl();
  if (!process.env.COIN_GECKO_API_KEY) {
    throw new Error("COIN_GECKO_API_KEY is required for Triton token ranking");
  }

  const intervalMs = getTritonPriceCheckIntervalMs();
  const wallet = getTritonWalletAddress(privateKey);
  const access = await readLiquidStratAccess(rpcUrl);
  assertTritonWalletMatches(wallet, access);
  const [initialAssetAddr, initialHeld] = await Promise.all([
    readLiquidStratAssetAddr(rpcUrl),
    readLiquidStratHeldAsset(rpcUrl),
  ]);

  console.log("[Triton] LiquidStratMinV4 loop starting (embedded in Demeter)");
  console.log(`[Triton] Wallet: ${wallet}`);
  console.log(`[Triton] Contract: ${LIQUID_STRAT_MIN_V4_ADDRESS}`);
  console.log(`[Triton] assetAddr: ${initialAssetAddr}`);
  console.log(
    `[Triton] ASSET (held): ${initialHeld} (${isTritonWethAddress(initialHeld) ? "WETH — scan for entry" : "token — defensive watch"})`
  );
  if (
    isTritonWethAddress(initialHeld) &&
    !isTritonWethAddress(initialAssetAddr)
  ) {
    console.warn(
      `[Triton] assetAddr (${initialAssetAddr}) != WETH while ASSET is WETH — using ASSET for loop branch (stale assetAddr)`
    );
  }
  console.log(`[Triton] owner: ${access.owner}, tritonAddr: ${access.tritonAddr}, mode: ${access.mode}`);
  console.log(`[Triton] Price check interval: ${intervalMs}ms`);
  console.log(`[Triton] Repo root: ${getSoteriaRepoRoot()}`);
  console.log(
    `[Triton] Tiered defensive exits: ${isTritonTieredDefensiveExitEnabled() ? "ON" : "OFF (custom rules only)"}`
  );
  const customRulesAtStart = loadTritonPositionRules();
  if (customRulesAtStart) {
    console.log(
      `[Triton] Custom position rules (any held asset): ${formatTritonPositionRulesSummary(customRulesAtStart)} (loaded from ${getLastLoadedTritonPositionRulesPath() ?? getTritonPositionRulesPath()})`
    );
  } else {
    console.log(
      `[Triton] Custom position rules: none (save via console → ${getTritonPositionRulesPath()})`
    );
  }
  const scheduledAtStart = loadTritonScheduledAction();
  if (scheduledAtStart) {
    const mins = Math.ceil(msUntilTritonScheduledAction(scheduledAtStart) / 60_000);
    console.log(`[Triton] Scheduled action: ${formatTritonScheduledActionSummary(scheduledAtStart)}`);
    if (mins <= 0) console.log("[Triton] Scheduled action is due — will run on first price tick");
  } else {
    console.log(
      "[Triton] Scheduled action: none (use triton_scheduleExit / triton_scheduleRotate for time-based trades)"
    );
  }
  console.log(`[Triton] Defensive exit rules: ${formatTritonDefensiveExitRulesSummary()}`);
  console.log(`[Triton] Min weighted score: ${getTritonPipelineLoopThresholds().scheduledChangeMinWeightedScore}`);
  const offensiveEntry = getTritonOffensiveEntryEnabled();
  console.log(
    `[Triton] Offensive auto-entry (WETH → token): ${offensiveEntry ? "enabled" : "disabled"} (TRITON_OFFENSIVE_ENTRY_ENABLED)`
  );

  for (;;) {
    if (checkDemeterStopSignal()) {
      console.log("[Triton] Stop signal received, exiting LiquidStrat loop");
      return;
    }
    try {
      const held = await readLiquidStratHeldAsset(rpcUrl);
      const scheduledHandled = await tryExecuteScheduledAction(held, privateKey, rpcUrl);
      if (!scheduledHandled) {
        if (isTritonWethAddress(held)) {
          if (getTritonOffensiveEntryEnabled()) {
            await tryOffensiveEntry(privateKey, rpcUrl);
          }
        } else {
          await checkDefensiveExit(held, privateKey, rpcUrl);
        }
      }
    } catch (e) {
      console.error("[Triton] Loop error:", e instanceof Error ? e.message : e);
    }
    await sleepWithStopCheck(intervalMs);
  }
}
