/**
 * One-shot AutoKeeper V3 RH diagnostics (no txs).
 * Simulates strategy.keeperCheck() and AutoKeeper.performUpkeep(id).
 * Run: npx tsx scripts/auto-keeper-diagnose.ts
 */
import "dotenv/config";
import type { Abi, Address } from "viem";
import { createPublicClient, formatEther, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import autoKeeperRhAbi from "../app/abi/auto-vaults-rh/AutoKeeper.abi.json";
import autoStrategyRhAbi from "../app/abi/auto-vaults-rh/AutoStrategyV3Rh.abi.json";
import { formatFloatStrategyMode } from "../app/abi/contract-enums";
import {
  AUTO_FACTORY_V3_RH_ADDRESS,
  AUTO_KEEPER_V3_RH_ADDRESS,
  AUTO_OPERATOR_REGISTRY_ADDRESS,
  AUTO_SWAP_ROUTER_V3_RH_ADDRESS,
  getAutoFactoryAddress,
  getAutoKeeperAddress,
  getAutoKeeperPrivateKey,
  getAutoOperatorRegistryAddress,
  getAutoSwapRouterAddress,
} from "../app/config/auto-keeper-config";
import { getRpcUrl, getViemChain } from "../app/config/chain-config";
import { DEMETER_TWO_WALLET_ADDRESS } from "../app/config/operator-registry-config";
import { listAutoWatchedRows, readAutoKeeperOperatorRegistry } from "../app/services/auto-keeper-loop";
import { readOperatorRegistryIsOperator } from "../app/services/operator-registry";
import { readStrategyPoolValueWei, MIN_STRATEGY_POOL_VALUE_WEI } from "../app/services/strategy-pool-value-eligibility";

const KEEPER_ABI = autoKeeperRhAbi as Abi;
const STRAT_ABI = autoStrategyRhAbi as Abi;

function fmtTs(sec: number): string {
  if (!sec) return "0";
  return `${sec} (${new Date(sec * 1000).toISOString()})`;
}

async function main() {
  const rpcUrl = getRpcUrl();
  const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });
  const keeper = getAutoKeeperAddress();
  const factory = getAutoFactoryAddress();
  const expectedRegistry = getAutoOperatorRegistryAddress();
  const swapRouter = getAutoSwapRouterAddress();

  console.log("=== AutoKeeper V3 RH diagnose (read + simulate, no txs) ===");
  console.log("chain:", getViemChain().id);
  console.log("keeper:", keeper, keeper === AUTO_KEEPER_V3_RH_ADDRESS ? "(canonical)" : "(env override)");
  console.log("factory:", factory, factory === AUTO_FACTORY_V3_RH_ADDRESS ? "(canonical)" : "(env override)");
  console.log("swapRouter:", swapRouter, swapRouter === AUTO_SWAP_ROUTER_V3_RH_ADDRESS ? "(canonical)" : "(env override)");
  console.log("configured AutoOperatorRegistry:", expectedRegistry);

  const [code, onChainRegistry, strategyFactory, strategiesLength] = await Promise.all([
    client.getCode({ address: keeper }),
    readAutoKeeperOperatorRegistry(keeper, rpcUrl),
    client.readContract({
      address: keeper,
      abi: KEEPER_ABI,
      functionName: "strategyFactory",
    }) as Promise<Address>,
    client.readContract({
      address: keeper,
      abi: KEEPER_ABI,
      functionName: "strategiesLength",
    }) as Promise<bigint>,
  ]);

  console.log("keeper bytecode:", code && code !== "0x" ? `${(code.length - 2) / 2} bytes` : "MISSING");
  console.log("on-chain operatorRegistry:", onChainRegistry);
  if (onChainRegistry.toLowerCase() !== expectedRegistry.toLowerCase()) {
    console.warn("WARN: on-chain operatorRegistry ≠ configured", AUTO_OPERATOR_REGISTRY_ADDRESS);
  }
  console.log("on-chain strategyFactory:", strategyFactory);
  if (strategyFactory.toLowerCase() !== factory.toLowerCase()) {
    console.warn("WARN: keeper.strategyFactory ≠ configured AutoFactoryV3Rh");
  }
  console.log("strategiesLength:", Number(strategiesLength));

  const pk = getAutoKeeperPrivateKey();
  const operator = pk
    ? privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`).address
    : DEMETER_TWO_WALLET_ADDRESS;
  const isOp = await readOperatorRegistryIsOperator(onChainRegistry, operator, rpcUrl);
  console.log("operator wallet:", operator);
  console.log("isOperator:", isOp);

  const rows = await listAutoWatchedRows(keeper, rpcUrl);
  if (rows.length === 0) {
    console.log("\nNo watched strategies.");
    return;
  }

  for (const row of rows) {
    console.log(`\n--- watched[${row.id}] ---`);
    console.log("strat:", row.stratAddr);
    console.log("active:", row.active);
    console.log("minInterval:", row.minInterval, "s");
    console.log("lastUpkeep:", fmtTs(row.lastUpkeep));
    console.log("lastHarvest:", fmtTs(row.lastHarvest));

    if (!row.stratAddr || row.stratAddr === zeroAddress) {
      console.log("skip: zero strategy");
      continue;
    }

    const valueWei = await readStrategyPoolValueWei(row.stratAddr, rpcUrl);
    console.log(
      "pool+idle wei:",
      valueWei == null ? "unreadable" : `${valueWei} (${formatEther(valueWei)} ETH)`,
      valueWei != null && valueWei < MIN_STRATEGY_POOL_VALUE_WEI ? `< floor ${MIN_STRATEGY_POOL_VALUE_WEI}` : ""
    );

    try {
      const [asset, mode, poolValue, idle, lastHarvest, vault, stratKeeper] = await Promise.all([
        client.readContract({ address: row.stratAddr, abi: STRAT_ABI, functionName: "ASSET" }) as Promise<Address>,
        client.readContract({ address: row.stratAddr, abi: STRAT_ABI, functionName: "mode" }) as Promise<number>,
        client.readContract({ address: row.stratAddr, abi: STRAT_ABI, functionName: "poolValue" }) as Promise<bigint>,
        client.readContract({ address: row.stratAddr, abi: STRAT_ABI, functionName: "balanceOfIdle" }) as Promise<bigint>,
        client.readContract({ address: row.stratAddr, abi: STRAT_ABI, functionName: "lastHarvest" }) as Promise<bigint>,
        client.readContract({ address: row.stratAddr, abi: STRAT_ABI, functionName: "vault" }) as Promise<Address>,
        client.readContract({ address: row.stratAddr, abi: STRAT_ABI, functionName: "keeper" }) as Promise<Address>,
      ]);
      console.log("ASSET:", asset);
      console.log("mode:", Number(mode), formatFloatStrategyMode(Number(mode)));
      console.log("poolValue:", poolValue.toString(), `(${formatEther(poolValue)} ETH)`);
      console.log("balanceOfIdle:", idle.toString(), `(${formatEther(idle)} ETH)`);
      console.log("strategy.lastHarvest:", fmtTs(Number(lastHarvest)));
      console.log("vault:", vault);
      console.log("strategy.keeper:", stratKeeper);
      if (stratKeeper.toLowerCase() !== keeper.toLowerCase()) {
        console.warn("WARN: strategy.keeper ≠ AutoKeeperV3Rh");
      }
    } catch (e) {
      console.warn("strategy view reads failed:", e instanceof Error ? e.message : e);
    }

    try {
      const sim = await client.simulateContract({
        address: row.stratAddr,
        abi: STRAT_ABI,
        functionName: "keeperCheck",
        account: operator,
      });
      console.log("keeperCheck (simulate):", Boolean(sim.result));
    } catch (e) {
      console.warn("keeperCheck simulate failed:", e instanceof Error ? e.message : e);
    }

    try {
      await client.simulateContract({
        address: keeper,
        abi: KEEPER_ABI,
        functionName: "performUpkeep",
        args: [BigInt(row.id)],
        account: operator,
      });
      console.log("performUpkeep(id) simulate: ok");
    } catch (e) {
      console.warn("performUpkeep(id) simulate failed:", e instanceof Error ? e.message : e);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
