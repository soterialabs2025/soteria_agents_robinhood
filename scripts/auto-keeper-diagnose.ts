/**
 * One-shot AutoKeeper RH diagnostics (no txs) for Uni V3 / Uni V4 / Sushi V3.
 * Simulates strategy.keeperCheck() and AutoKeeper.performUpkeep(id).
 * Run: npx tsx scripts/auto-keeper-diagnose.ts
 */
import "dotenv/config";
import type { Abi, Address } from "viem";
import { createPublicClient, formatEther, http, zeroAddress } from "viem";

import { formatAutoStrategyMode } from "../app/abi/contract-enums";
import { getRpcUrl, getViemChain } from "../app/config/chain-config";
import { getEnabledAutoKeeperPipelines } from "../app/config/rh-keeper-pipelines";
import { listAutoWatchedRows, readAutoKeeperOperatorRegistry } from "../app/services/auto-keeper-loop";
import { readOperatorRegistryIsOperator } from "../app/services/operator-registry";
import { resolveRhOperatorWallets } from "../app/services/rh-operator-pool";
import { readStrategyPoolValueWei, MIN_STRATEGY_POOL_VALUE_WEI } from "../app/services/strategy-pool-value-eligibility";

const STRAT_ABI = [
  { type: "function", name: "ASSET", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "mode", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "poolValue", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOfIdle", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastHarvest", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "vault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "keeper", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "keeperCheck", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

function fmtTs(sec: number): string {
  if (!sec) return "0";
  return `${sec} (${new Date(sec * 1000).toISOString()})`;
}

async function main() {
  const rpcUrl = getRpcUrl();
  const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });
  const pipelines = getEnabledAutoKeeperPipelines();
  const wallets = (() => {
    try {
      return resolveRhOperatorWallets();
    } catch {
      return [];
    }
  })();

  console.log("=== AutoKeeper RH diagnose (read + simulate, no txs) ===");
  console.log("chain:", getViemChain().id);
  console.log("pipelines:", pipelines.map((p) => p.label).join(", ") || "(none)");
  console.log(
    "operator wallets:",
    wallets.length ? wallets.map((w) => `${w.id}=${w.address}`).join(", ") : "(none configured)"
  );

  if (pipelines.length === 0) {
    console.log("No AutoKeeper pipelines enabled.");
    return;
  }

  for (const pipeline of pipelines) {
    const keeper = pipeline.keeperAddress;
    const factory = pipeline.factoryAddress;
    const expectedRegistry = pipeline.operatorRegistryAddress;
    const abi = pipeline.abi;

    console.log(`\n========== ${pipeline.label} ==========`);
    console.log("keeper:", keeper);
    console.log("factory:", factory);
    console.log("swapRouter:", pipeline.swapRouterAddress);
    console.log("configured registry:", expectedRegistry);

    const [code, onChainRegistry, strategyFactory, strategiesLength] = await Promise.all([
      client.getCode({ address: keeper }),
      readAutoKeeperOperatorRegistry(keeper, rpcUrl, abi),
      client.readContract({
        address: keeper,
        abi,
        functionName: "strategyFactory",
      }) as Promise<Address>,
      client.readContract({
        address: keeper,
        abi,
        functionName: "strategiesLength",
      }) as Promise<bigint>,
    ]);

    console.log("keeper bytecode:", code && code !== "0x" ? `${(code.length - 2) / 2} bytes` : "MISSING");
    console.log("on-chain operatorRegistry:", onChainRegistry);
    if (onChainRegistry.toLowerCase() !== expectedRegistry.toLowerCase()) {
      console.warn("WARN: on-chain operatorRegistry ≠ configured");
    }
    console.log("on-chain strategyFactory:", strategyFactory);
    if (strategyFactory.toLowerCase() !== factory.toLowerCase()) {
      console.warn("WARN: keeper.strategyFactory ≠ configured factory");
    }
    console.log("strategiesLength:", Number(strategiesLength));

    for (const wallet of wallets) {
      const isOp = await readOperatorRegistryIsOperator(onChainRegistry, wallet.address, rpcUrl);
      console.log(`isOperator ${wallet.id} ${wallet.address}:`, isOp);
    }

    const rows = await listAutoWatchedRows(keeper, rpcUrl, abi);
    if (rows.length === 0) {
      console.log("No watched strategies.");
      continue;
    }

    const operator = wallets[0]?.address;
    for (const row of rows) {
      console.log(`\n--- ${pipeline.label} watched[${row.id}] ---`);
      console.log("strat:", row.stratAddr);
      console.log("active:", row.active);
      console.log("minInterval:", row.minInterval, "s");
      console.log("lastUpkeep:", fmtTs(row.lastUpkeep));
      console.log("lastHarvest:", fmtTs(row.lastHarvest));
      if (wallets.length > 0) {
        const shard = wallets[row.id % wallets.length]!;
        console.log("shard wallet:", shard.id, shard.address);
      }

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
        console.log("mode:", Number(mode), formatAutoStrategyMode(Number(mode)));
        console.log("poolValue:", poolValue.toString(), `(${formatEther(poolValue)} ETH)`);
        console.log("balanceOfIdle:", idle.toString(), `(${formatEther(idle)} ETH)`);
        console.log("strategy.lastHarvest:", fmtTs(Number(lastHarvest)));
        console.log("vault:", vault);
        console.log("strategy.keeper:", stratKeeper);
        if (stratKeeper.toLowerCase() !== keeper.toLowerCase()) {
          console.warn("WARN: strategy.keeper ≠ this AutoKeeper");
        }
      } catch (e) {
        console.warn("strategy view reads failed:", e instanceof Error ? e.message : e);
      }

      if (operator) {
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
            abi,
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
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
