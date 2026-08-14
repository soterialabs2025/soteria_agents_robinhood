/**
 * One-time FloatKeeper.performHarvest (V3 or V4).
 *
 * Env: ROBINHOOD_MAIN_RPC_URL (or RPC_URL), DEMETER_PRIVATE_KEY (must match keeper demeterAddr).
 *
 * Usage:
 *   npm run float:harvest-once -- --v4 --id 2
 *   npm run float:harvest-once -- --v3 --id 0
 *   npm run float:harvest-once -- --v4 --dry-run
 *   npm run float:harvest-once -- --v4 --id 2 --skip-increase-liquidity
 */
import "dotenv/config";
import { EvmWalletProvider } from "@coinbase/agentkit";
import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import { getRpcUrl, getViemChain, explorerTxUrl } from "../app/config/chain-config";

import { createViemWalletProviderFromEnv } from "../app/api/agent/evm-wallet-from-env";
import {
  executeKeeperHarvestWithConfirmation,
  getKeeperStrategyHarvestTimestamps,
  preflightFloatV4KeeperHarvest,
  resolveKeeperAbi,
} from "../app/action-providers/keeper-strategy-action-provider";
import {
  getFloatV4KeeperAddress,
  getFloatV4StrategyIds,
  getKeeperAddress,
  getStrategyIds,
} from "../app/config/demeter-config";
import {
  parseKeeperStrategyIdsFromConfig,
  type FloatKeeperPipelineId,
} from "../app/config/float-keeper-pipeline";

type CliOptions = {
  pipeline: FloatKeeperPipelineId;
  strategyId: number;
  dryRun: boolean;
  skipIncreaseLiquidity: boolean;
};

function printUsage(): void {
  console.log(`Usage:
  npm run float:harvest-once -- [--v3 | --v4] [--id N] [--dry-run] [--skip-increase-liquidity]

Defaults:
  --v4
  --id from FLOAT_V4_STRATEGY_IDS or STRATEGY_IDS (first id)
`);
}

function parseCli(argv: string[]): CliOptions | null {
  let pipeline: FloatKeeperPipelineId = "v4";
  let strategyId: number | undefined;
  let dryRun = false;
  let skipIncreaseLiquidity = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
    if (a === "--v3") pipeline = "v3";
    else if (a === "--v4") pipeline = "v4";
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--skip-increase-liquidity") skipIncreaseLiquidity = true;
    else if (a === "--id") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) {
        console.error("--id must be a non-negative integer");
        return null;
      }
      strategyId = n;
    } else {
      console.error(`Unknown argument: ${a}`);
      return null;
    }
  }

  if (strategyId === undefined) {
    const ids =
      pipeline === "v4"
        ? parseKeeperStrategyIdsFromConfig(getFloatV4StrategyIds(), "FLOAT_V4_STRATEGY_IDS")
        : parseKeeperStrategyIdsFromConfig(getStrategyIds(), "STRATEGY_IDS");
    if (ids.length === 0) {
      console.error(`No strategy ids configured for ${pipeline}; pass --id N`);
      return null;
    }
    strategyId = ids[0]!;
  }

  return { pipeline, strategyId, dryRun, skipIncreaseLiquidity };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (!opts) {
    printUsage();
    process.exit(1);
  }

  const rpcUrl = getRpcUrl();


  const keeperAddress = (
    opts.pipeline === "v4" ? getFloatV4KeeperAddress() : getKeeperAddress()
  ) as Address;
  const strategyRegistryKey =
    opts.pipeline === "v4" ? ("FloatStrategyV4" as const) : ("FloatStrategy" as const);

  const walletProvider = createViemWalletProviderFromEnv();
  if (!(walletProvider instanceof EvmWalletProvider)) {
    console.error("Expected EvmWalletProvider from createViemWalletProviderFromEnv");
    process.exit(1);
  }

  const sender = walletProvider.getAddress() as Address;
  const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });

  console.log("=== Float performHarvest (one-shot) ===");
  console.log("pipeline:", opts.pipeline);
  console.log("keeper:", keeperAddress);
  console.log("strategyId:", opts.strategyId);
  console.log("sender:", sender);
  console.log("skipIncreaseLiquidity:", opts.skipIncreaseLiquidity);
  console.log("dryRun:", opts.dryRun);

  const keeperDemeter = await client.readContract({
    address: keeperAddress,
    abi: resolveKeeperAbi(keeperAddress, opts.pipeline),
    functionName: "demeterAddr",
  });
  console.log("keeper.demeterAddr:", keeperDemeter);
  if (sender.toLowerCase() !== (keeperDemeter as string).toLowerCase()) {
    console.warn("WARN: sender does not match keeper.demeterAddr — tx may revert Unauthorized");
  }

  const before = await getKeeperStrategyHarvestTimestamps(
    keeperAddress,
    opts.strategyId,
    rpcUrl,
    strategyRegistryKey,
    opts.pipeline
  );
  console.log("before lastHarvest:", before.lastHarvest, "strategy:", before.strategyAddress);

  if (opts.pipeline === "v4") {
    const preflight = await preflightFloatV4KeeperHarvest(
      keeperAddress,
      before.strategyAddress as Address,
      rpcUrl,
      opts.skipIncreaseLiquidity
    );
    console.log("preflight:", preflight.canHarvest ? "OK" : "BLOCKED", "—", preflight.reason);
    if (!preflight.canHarvest && !opts.dryRun) {
      console.error("Preflight blocked; fix conditions or use --dry-run to simulate only.");
      process.exit(1);
    }
  }

  if (opts.dryRun) {
    const { request } = await client.simulateContract({
      address: keeperAddress,
      abi: resolveKeeperAbi(keeperAddress, opts.pipeline),
      functionName: "performHarvest",
      args: [BigInt(opts.strategyId), opts.skipIncreaseLiquidity],
      account: sender,
    });
    console.log("simulate performHarvest: OK");
    console.log("request:", request);
    return;
  }

  console.log("Submitting performHarvest…");
  const result = await executeKeeperHarvestWithConfirmation(
    walletProvider,
    keeperAddress,
    opts.strategyId,
    rpcUrl,
    strategyRegistryKey,
    opts.pipeline,
    opts.skipIncreaseLiquidity
  );

  console.log("result:", JSON.stringify(result, null, 2));
  if (result.ok) {
    console.log(
      result.txHash
        ? `${explorerTxUrl(result.txHash)}`
        : "(no tx hash — harvest state advanced without new tx?)"
    );
    process.exit(0);
  }

  console.error("Harvest failed:", result.reason);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
