/**
 * Float V4 harvest diagnostics (read-only).
 * Compares manager FloatStrategyV4 vs keeper watched[strategyId] and harvest readiness.
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import floatKeeperV4Json from "../app/abi/FloatKeeperV4.json";
import floatStrategyV4Json from "../app/abi/FloatStrategyV4.json";
import { getRpcUrl, getViemChain } from "../app/config/chain-config";
import {
  getFloatContractManagerV4Address,
  getFloatV4KeeperAddress,
  getFloatV4StrategyIds,
} from "../app/config/demeter-config";
import { getTritonHarvestIntervalMs } from "../app/config/triton-config";
import { getPipelineLoopThresholds } from "../app/config/ranking-eligibility";
import {
  FLOAT_STRATEGY_V4_NEUTRAL_MODE,
  getKeeperStrategyHarvestTimestamps,
  getKeeperWatchedRow,
  getStrategyMode,
  preflightFloatV4KeeperHarvest,
  resolveKeeperAbi,
} from "../app/action-providers/keeper-strategy-action-provider";
import {
  getFloatPoolValue,
  getLastHarvestTimestamp,
  getStrategyHarvestTimestampsAtAddress,
  shouldStopFloatHarvestRetryAttempts,
} from "../app/action-providers/float-action-provider";
import { parseKeeperStrategyIdsFromConfig } from "../app/config/float-keeper-pipeline";

const rpcUrl: string = getRpcUrl();

const keeper = getFloatV4KeeperAddress() as Address;
const manager = getFloatContractManagerV4Address();
const ids = parseKeeperStrategyIdsFromConfig(getFloatV4StrategyIds(), "FLOAT_V4_STRATEGY_IDS");
const keeperAbi = resolveKeeperAbi(keeper, "v4");
const strategyAbi = floatStrategyV4Json.abi;

async function main() {
  const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });
  const block = await client.getBlock();
  const nowSec = Number(block.timestamp);

  console.log("=== Float V4 harvest diagnose ===");
  console.log("keeper:", keeper);
  console.log("manager:", manager);
  console.log("strategy_ids:", ids.join(", "));
  console.log(
    "demeter_v4_harvest_interval_min:",
    getPipelineLoopThresholds("v4").harvestIntervalMs / 60_000,
    "(TRITON_HARVEST_INTERVAL_MS / triton-config default 6h)"
  );
  console.log("triton_harvest_interval_ms getter:", getTritonHarvestIntervalMs());
  console.log("keeper_abi:", keeper.toLowerCase() === keeper.toLowerCase() ? "FloatKeeperV4.json" : "?");

  const managerLh = await getLastHarvestTimestamp(manager, rpcUrl, "FloatStrategyV4");
  const pool = await getFloatPoolValue(manager, rpcUrl, "FloatStrategyV4");
  console.log("\n--- manager FloatStrategyV4 ---");
  console.log("strategy:", pool.strategyAddress);
  console.log("poolValue:", pool.poolValue);
  console.log("lastHarvest:", managerLh);

  const len = await client.readContract({
    address: keeper,
    abi: keeperAbi,
    functionName: "strategiesLength",
  });
  console.log("\nkeeper strategiesLength:", Number(len));

  for (let id = 0; id < Number(len); id++) {
    if (!ids.includes(id)) {
      console.log(`\n--- watched[${id}] (not in FLOAT_V4_STRATEGY_IDS) ---`);
      try {
        const row = await client.readContract({
          address: keeper,
          abi: keeperAbi,
          functionName: "watched",
          args: [BigInt(id)],
        });
        const [stratAddr] = row as readonly [Address, number, number, boolean];
        const lh = await client.readContract({
          address: stratAddr,
          abi: strategyAbi,
          functionName: "lastHarvest",
        });
        console.log("stratAddr:", stratAddr, "lastHarvest:", Number(lh));
      } catch (e) {
        console.log("error:", e instanceof Error ? e.message : String(e));
      }
    }
  }

  for (const id of ids) {
    console.log(`\n--- watched[${id}] ---`);
    try {
      const watched = await getKeeperWatchedRow(keeper, id, rpcUrl, "v4");
      const stratAddr = watched.strategyAddress;
      const mode = await getStrategyMode(keeper, id, rpcUrl, "v4");
      const tsKeeper = await getKeeperStrategyHarvestTimestamps(
        keeper,
        id,
        rpcUrl,
        "FloatStrategyV4",
        "v4"
      );
      const tsDirect = await getStrategyHarvestTimestampsAtAddress(
        stratAddr,
        rpcUrl,
        "FloatStrategyV4"
      );
      const managerMatch =
        stratAddr.toLowerCase() === pool.strategyAddress.toLowerCase()
          ? "yes"
          : `NO (manager=${pool.strategyAddress})`;

      console.log("stratAddr:", stratAddr);
      console.log(
        "active:",
        watched.active,
        "minInterval:",
        watched.minIntervalSec,
        "lastAction:",
        watched.lastActionSec
      );
      const keeperHarvestDue =
        watched.lastActionSec <= 0 ||
        nowSec >= watched.lastActionSec + watched.minIntervalSec;
      console.log("keeper_minInterval_allows_harvest_now:", keeperHarvestDue);
      if (!keeperHarvestDue) {
        console.log(
          "keeper_harvest_blocked_for_sec:",
          watched.lastActionSec + watched.minIntervalSec - nowSec
        );
      }
      console.log(
        "mode:",
        mode,
        mode === FLOAT_STRATEGY_V4_NEUTRAL_MODE || mode === 4
          ? "(keeper performHarvest skips NEUTRAL/STABLE)"
          : "(keeper harvest intended in this mode)"
      );
      console.log("matches_manager_strategy:", managerMatch);

      const preflight = await preflightFloatV4KeeperHarvest(
        keeper,
        stratAddr,
        rpcUrl,
        false
      );
      console.log("preflight_keeper_harvest:", preflight.canHarvest ? "OK" : "BLOCKED");
      console.log("preflight_detail:", preflight.reason);
      console.log("lastHarvest (via keeper helper):", tsKeeper.lastHarvest, "prev:", tsKeeper.prevHarvestTime);
      console.log("lastHarvest (direct strat):", tsDirect.lastHarvest, "prev:", tsDirect.prevHarvestTime);

      const [minHarvestDelay, harvestOnDeposit, lastUniswapFeeTotal] = (await Promise.all([
        client.readContract({
          address: stratAddr,
          abi: strategyAbi,
          functionName: "minHarvestDelay",
        }),
        client.readContract({
          address: stratAddr,
          abi: strategyAbi,
          functionName: "harvestOnDeposit",
        }),
        client.readContract({
          address: stratAddr,
          abi: strategyAbi,
          functionName: "lastUniswapFeeTotal",
        }),
      ])) as [bigint, boolean, bigint];
      const minDelaySec = Number(minHarvestDelay);
      const elapsed = nowSec - tsDirect.lastHarvest;
      const harvestDelayOk = tsDirect.lastHarvest <= 0 || elapsed >= minDelaySec;
      console.log("chain_now:", nowSec);
      console.log("minHarvestDelay_sec:", minDelaySec);
      console.log("seconds_since_lastHarvest:", elapsed);
      console.log("minHarvestDelay_satisfied:", harvestDelayOk);
      console.log("harvestOnDeposit:", harvestOnDeposit);
      console.log("lastUniswapFeeTotal:", lastUniswapFeeTotal.toString());

      const keeperDemeter = await client.readContract({
        address: keeper,
        abi: keeperAbi,
        functionName: "demeterAddr",
      });
      console.log("keeper.demeterAddr:", keeperDemeter);

      const pk = process.env.DEMETER_PRIVATE_KEY?.trim();
      if (pk) {
        const account = privateKeyToAccount(
          (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`
        );
        console.log("DEMETER_PRIVATE_KEY wallet:", account.address);
        console.log(
          "wallet_matches_keeper_demeterAddr:",
          account.address.toLowerCase() === (keeperDemeter as string).toLowerCase()
        );
        const walletClient = createWalletClient({
          account,
          chain: getViemChain(),
          transport: http(rpcUrl),
        });
        try {
          const { request } = await client.simulateContract({
            address: keeper,
            abi: keeperAbi,
            functionName: "performHarvest",
            args: [BigInt(id), false],
            account: account.address,
          });
          console.log("simulate performHarvest: OK (would send from", account.address + ")");
          void request;
        } catch (e) {
          console.log("simulate performHarvest FAILED:", e instanceof Error ? e.message : e);
        }
      } else {
        console.log("(set DEMETER_PRIVATE_KEY to simulate performHarvest caller)");
      }
      console.log(
        "shouldStop_if_baseline_unchanged:",
        shouldStopFloatHarvestRetryAttempts(tsKeeper.lastHarvest, tsKeeper.lastHarvest, tsKeeper.prevHarvestTime)
      );

      try {
        const gas = await client.estimateContractGas({
          address: keeper,
          abi: keeperAbi,
          functionName: "performHarvest",
          args: [BigInt(id), false],
          account: process.env.EOA_ADDRESS as Address | undefined,
        });
        console.log("performHarvest estimateGas:", gas.toString());
      } catch (e) {
        console.log("performHarvest estimateGas FAILED:", e instanceof Error ? e.message : e);
      }
    } catch (e) {
      console.log("error:", e instanceof Error ? e.message : e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
