import {
  areDemeterLoopsEnabled,
  demeterLoopsDisabledMessage,
  loadDemeterEnv,
} from "../config/demeter-loops";

loadDemeterEnv();
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import type { Address } from "viem";
import pRetry from "p-retry";

import floatKeeperAbi from "../abi/FloatKeeper.json";
import floatKeeperV4Abi from "../abi/FloatKeeperV4.json";
import { resolveTxGasLimit } from "../config/demeter-tx-gas";
import { getRpcUrl } from "../config/chain-config";
import {
  getFloatContractManagerAddress,
  getFloatContractManagerV4Address,
  getFloatV4KeeperAddress,
  getFloatV4StrategyIds,
  getKeeperAddress,
  getStrategyIds,
  getMergedConfig,
} from "../config/demeter-config";
import {
  formatFloatPipelineLoopRunLog,
  formatFloatPipelineLoopSkipLog,
  shouldLogFloatPipelineLoopSkip,
  parseKeeperStrategyIdsFromConfig,
  resolvePipelineRunEveryNLoops,
  sleepFloatPipelineStagger,
  tickFloatPipelineLoopGate,
  type FloatKeeperPipelineId,
} from "../config/float-keeper-pipeline";
import { getLastHarvestTimestamp, shouldStopFloatHarvestRetryAttempts } from "../action-providers/float-action-provider";
import {
  getKeeperStrategyHarvestTimestamps,
  KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS,
} from "../action-providers/keeper-strategy-action-provider";

// ============================================================================
// FloatKeeper ABI (app/abi/FloatKeeper.json — performUpkeep, batch, harvest, strategiesLength, watched)
// ============================================================================
const keeperAbi = (floatKeeperAbi as { abi: import("ethers").InterfaceAbi }).abi;
const keeperV4Abi = (floatKeeperV4Abi as { abi: import("ethers").InterfaceAbi }).abi;

// ============================================================================
// CONFIG: demeter-config.ts (KEEPER_ADDRESS, STRATEGY_IDS, POLL_MS)
// ENV: ROBINHOOD_MAIN_RPC_URL (or RPC_URL), PRIVATE_KEY, MAX_RETRIES
// ============================================================================

const { PRIVATE_KEY, MAX_RETRIES = "3" } = process.env;
let RPC_URL: string;
try {
  RPC_URL = getRpcUrl();
} catch {
  RPC_URL = "";
}

if (!RPC_URL || !PRIVATE_KEY) {
  console.error("Missing env values. Need ROBINHOOD_MAIN_RPC_URL (or RPC_URL), PRIVATE_KEY");
  process.exit(1);
}

const HARVEST_SUBMIT_RETRY_MS = 60_000;

const { pollMs: POLL_MS, harvestIntervalMs: HARVEST_INTERVAL_MS } = getMergedConfig();

const rpcUrl = RPC_URL;
const privateKey = PRIVATE_KEY.trim();

const v3StrategyIds = parseKeeperStrategyIdsFromConfig(getStrategyIds(), "STRATEGY_IDS");
const v4StrategyIds = parseKeeperStrategyIdsFromConfig(getFloatV4StrategyIds(), "FLOAT_V4_STRATEGY_IDS");

if (v3StrategyIds.length === 0 && v4StrategyIds.length === 0) {
  console.error(
    "No valid strategy ids. Edit app/config/demeter-config.ts (DEFAULT_STRATEGY_IDS / DEFAULT_FLOAT_V4_STRATEGY_IDS)."
  );
  process.exit(1);
}

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(privateKey, provider);

type KeeperDeployment = {
  label: string;
  address: string;
  contract: Contract;
  ids: number[];
  strategyRegistryKey: "FloatStrategy" | "FloatStrategyV4";
};

const keeperDeployments: KeeperDeployment[] = [];
if (v3StrategyIds.length > 0) {
  keeperDeployments.push({
    label: "Float V3",
    address: getKeeperAddress(),
    contract: new Contract(getKeeperAddress(), keeperAbi, wallet),
    ids: v3StrategyIds,
    strategyRegistryKey: "FloatStrategy",
  });
}
if (v4StrategyIds.length > 0) {
  keeperDeployments.push({
    label: "Float V4",
    address: getFloatV4KeeperAddress(),
    contract: new Contract(getFloatV4KeeperAddress(), keeperV4Abi, wallet),
    ids: v4StrategyIds,
    strategyRegistryKey: "FloatStrategyV4",
  });
}

async function txOpts(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  const fee = await provider.getFeeData();
  const maxFeePerGas = fee.maxFeePerGas ? (fee.maxFeePerGas * 110n) / 100n : undefined;
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ? (fee.maxPriorityFeePerGas * 110n) / 100n : undefined;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

// ---------------------------------------------------------------------------
// Keeper manager for one or more strategy indices (0-based into watched[])
// ---------------------------------------------------------------------------
class KeeperStrategyManager {
  label: string;
  keeper: Contract;
  keeperAddress: string;
  ids: number[];
  /** Strategy indices used for FloatKeeper harvest. */
  harvestIds: number[];
  strategyRegistryKey: "FloatStrategy" | "FloatStrategyV4";

  constructor(
    label: string,
    keeper: Contract,
    keeperAddress: string,
    ids: number[],
    harvestIds: number[],
    strategyRegistryKey: "FloatStrategy" | "FloatStrategyV4"
  ) {
    this.label = label;
    this.keeper = keeper;
    this.keeperAddress = keeperAddress;
    this.ids = ids;
    this.harvestIds = harvestIds;
    this.strategyRegistryKey = strategyRegistryKey;
  }

  async ensureKeeperDeployed(): Promise<void> {
    const code = await provider.getCode(this.keeperAddress);
    if (!code || code === "0x") {
      throw new Error(`No contract code at ${this.label} keeper ${this.keeperAddress}. Check RPC_URL / address.`);
    }

    try {
      const len = await this.keeper.strategiesLength();
      const lenNum = Number(len);
      for (const id of this.ids) {
        if (id < 0 || id >= lenNum) {
          throw new Error(`[${this.label}] Strategy index ${id} out of range. Keeper has ${lenNum} strategies (indices 0..${lenNum - 1}).`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Error reading strategiesLength from FloatKeeper: ${msg}`);
    }
  }

  /** Run upkeep for all managed strategies. Uses performUpkeepBatch when multiple; performUpkeep for single. */
  async performUpkeep(): Promise<void> {
    const idList = this.ids.join(",");
    const fn = this.ids.length > 1 ? "performUpkeepBatch" : "performUpkeep";
    console.log(new Date().toISOString(), `[${this.label} keeper:${this.keeperAddress} ids:[${idList}]] ${fn}()`);

    await pRetry(
      async () => {
        const opts = await txOpts();
        const gasEstimate =
          this.ids.length > 1
            ? await this.keeper.performUpkeepBatch.estimateGas(this.ids.map(BigInt), opts)
            : await this.keeper.performUpkeep.estimateGas(this.ids[0], opts);
        const gasLimit = resolveTxGasLimit(gasEstimate);
        const txOptsWithGas = { ...opts, gasLimit };
        const tx =
          this.ids.length > 1
            ? await this.keeper.performUpkeepBatch(this.ids.map(BigInt), txOptsWithGas)
            : await this.keeper.performUpkeep(this.ids[0], txOptsWithGas);
        console.log(`[ids:[${idList}]] submitted:`, tx.hash);

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const rcpt = await Promise.race([
            tx.wait(),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error("Confirmation timeout")), 120000); // 2 min
            }),
          ]);
          if (timeoutId) clearTimeout(timeoutId);
          console.log(`[ids:[${idList}]] confirmed in block`, rcpt?.blockNumber);
        } catch (e) {
          if (timeoutId) clearTimeout(timeoutId);
          if (e instanceof Error && e.message === "Confirmation timeout") {
            console.warn(`[ids:[${idList}]] tx pending longer than expected:`, tx.hash);
          } else {
            throw e;
          }
        }
      },
      {
        retries: Number(MAX_RETRIES),
        onFailedAttempt: (e) => console.warn(`[ids:[${idList}]] attempt failed:`, e.message),
      }
    );
  }

  /** Run harvest for configured Float strategies. */
  async performHarvest(skipIncreaseLiquidity = false): Promise<void> {
    for (const id of this.harvestIds) {
      console.log(
        new Date().toISOString(),
        `[${this.label} keeper:${this.keeperAddress} id:${id}] performHarvest(skipIncreaseLiquidity=${skipIncreaseLiquidity})`
      );

      let baselineLastHarvest = 0;
      try {
        baselineLastHarvest = (
          await getKeeperStrategyHarvestTimestamps(
            this.keeperAddress as Address,
            id,
            rpcUrl,
            this.strategyRegistryKey
          )
        ).lastHarvest;
      } catch {
        /* ignore */
      }

      let tx: Awaited<ReturnType<typeof this.keeper.performHarvest>> | null = null;
      for (;;) {
        try {
          const opts = await txOpts();

          const gasEstimate = await this.keeper.performHarvest.estimateGas(id, skipIncreaseLiquidity);
          const gasLimit = resolveTxGasLimit(gasEstimate);

          console.log(
            `[id:${id}] harvest gasEstimate=${gasEstimate.toString()} gasLimit=${gasLimit.toString()}`
          );

          tx = await this.keeper.performHarvest(id, skipIncreaseLiquidity, {
            ...opts,
            gasLimit,
          });

          console.log(`[id:${id}] harvest submitted:`, tx.hash);
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          try {
            const ts = await getKeeperStrategyHarvestTimestamps(
              this.keeperAddress as Address,
              id,
              rpcUrl,
              this.strategyRegistryKey
            );
            if (
              shouldStopFloatHarvestRetryAttempts(
                baselineLastHarvest,
                ts.lastHarvest,
                ts.prevHarvestTime
              )
            ) {
              console.warn(
                `[id:${id}] harvest submit stopped: on-chain lastHarvest=${ts.lastHarvest} PrevHarvestTime=${ts.prevHarvestTime} — treating as done`
              );
              tx = null;
              break;
            }
          } catch {
            /* ignore */
          }
          console.warn(
            `[id:${id}] harvest submit failed (${msg}); retrying in ${HARVEST_SUBMIT_RETRY_MS / 1000 / 60} min…`
          );
          await new Promise((r) => setTimeout(r, HARVEST_SUBMIT_RETRY_MS));
        }
      }

      if (tx) {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const rcpt = await Promise.race([
            tx.wait(),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error("Confirmation timeout")),
                120000 // 2 min
              );
            }),
          ]);
          if (timeoutId) clearTimeout(timeoutId);
          console.log(`[id:${id}] harvest confirmed in block`, rcpt?.blockNumber);
        } catch (e) {
          if (timeoutId) clearTimeout(timeoutId);
          if (e instanceof Error && e.message === "Confirmation timeout") {
            console.warn(`[id:${id}] harvest tx pending longer than expected:`, tx.hash);
          } else {
            throw e;
          }
        }
      }

      if (this.harvestIds.length > 1) {
        await new Promise((r) => setTimeout(r, 1000)); // spacing between harvests
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Harvest loop — pacing from FloatStrategy.lastHarvest + interval (same as Demeter), not a blind fixed timer.
// ---------------------------------------------------------------------------
async function harvestLoop(managers: KeeperStrategyManager[]): Promise<never> {
  for (;;) {
    try {
      let waitMs = HARVEST_INTERVAL_MS;
      try {
        for (const manager of managers) {
          const managerAddr =
            manager.label === "Float V4"
              ? getFloatContractManagerV4Address()
              : getFloatContractManagerAddress();
          const strategyKey =
            manager.label === "Float V4" ? ("FloatStrategyV4" as const) : ("FloatStrategy" as const);
          const lhSec = await getLastHarvestTimestamp(managerAddr, rpcUrl, strategyKey);
          waitMs = Math.min(waitMs, Math.max(0, lhSec * 1000 + HARVEST_INTERVAL_MS - Date.now()));
        }
      } catch (e) {
        console.warn(new Date().toISOString(), "[harvest] lastHarvest read failed, fixed interval:", e);
      }
      await new Promise((r) => setTimeout(r, waitMs));

      console.log(new Date().toISOString(), "Starting harvest cycle for all strategies");

      const activePipelineIds: FloatKeeperPipelineId[] = managers.map((m) =>
        m.label === "Float V4" ? "v4" : "v3"
      );
      for (const m of managers) {
        try {
          await sleepFloatPipelineStagger(
            m.label === "Float V4" ? "v4" : "v3",
            activePipelineIds,
            (ms) => new Promise((r) => setTimeout(r, ms))
          );
          await m.performHarvest(false);
          await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          console.error(`[harvest ids:[${m.harvestIds.join(",")}]] harvest error:`, e);
        }
      }
    } catch (e) {
      console.error("harvest loop error:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function mainLoop(): Promise<never> {
  const managers = keeperDeployments.map(
    (d) =>
      new KeeperStrategyManager(
        d.label,
        d.contract,
        d.address,
        d.ids,
        d.ids,
        d.strategyRegistryKey
      )
  );
  for (const m of managers) {
    await m.ensureKeeperDeployed();
  }

  console.log("Agent wallet:", wallet.address);
  for (const d of keeperDeployments) {
    console.log(`${d.label} keeper:`, d.address, "| ids:", d.ids.join(", "));
  }
  console.log("Polling every", POLL_MS, "ms");
  console.log("Harvest interval:", HARVEST_INTERVAL_MS / 1000 / 60, "minutes");
  if (Number.isFinite(KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS)) {
    console.log(
      "snapshotVaultPoolValue at most every",
      KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS / (60 * 60 * 1000),
      "hours (same loop as upkeep)"
    );
  } else {
    console.log("snapshotVaultPoolValue: disabled");
  }

  const pollMsNumber = POLL_MS;
  let lastSnapshotVaultPoolValueMs = 0;

  harvestLoop(managers).catch((err) => {
    console.error("harvest loop fatal:", err);
  });

  for (;;) {
    try {
      const now = Date.now();
      if (now - lastSnapshotVaultPoolValueMs >= KEEPER_SNAPSHOT_VAULT_POOL_INTERVAL_MS) {
        for (const d of keeperDeployments) {
        try {
          const opts = await txOpts();
          const stx = await d.contract.snapshotVaultPoolValue(opts);
          console.log(new Date().toISOString(), `[${d.label}] snapshotVaultPoolValue submitted:`, stx.hash);
          lastSnapshotVaultPoolValueMs = Date.now();
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              stx.wait(),
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("Confirmation timeout")), 120000);
              }),
            ]);
            if (timeoutId) clearTimeout(timeoutId);
          } catch (e) {
            if (timeoutId) clearTimeout(timeoutId);
            if (e instanceof Error && e.message === "Confirmation timeout") {
              console.warn("snapshotVaultPoolValue tx pending longer than expected:", stx.hash);
            } else {
              console.warn("snapshotVaultPoolValue wait:", e);
            }
          }
        } catch (e) {
          console.warn(`[${d.label}] snapshotVaultPoolValue failed:`, e);
        }
        }
      }
      const v4RunEvery = resolvePipelineRunEveryNLoops("v4");
      const activePipelineIds: FloatKeeperPipelineId[] = managers.map((m) =>
        m.label === "Float V4" ? "v4" : "v3"
      );
      for (const m of managers) {
        if (m.label === "Float V4" && v4RunEvery != null && v4RunEvery > 1) {
          const gate = tickFloatPipelineLoopGate(
            { id: "v4", label: m.label, runEveryNLoops: v4RunEvery },
            "upkeep"
          );
          if (!gate.shouldRun) {
            if (shouldLogFloatPipelineLoopSkip(gate.loopNumber, gate.runEvery)) {
              console.log(
                new Date().toISOString(),
                formatFloatPipelineLoopSkipLog(m, "upkeep", gate.loopNumber, gate.runEvery)
              );
            }
            continue;
          }
          console.log(
            new Date().toISOString(),
            formatFloatPipelineLoopRunLog(m, "upkeep", gate.loopNumber, gate.runEvery)
          );
        }
        await sleepFloatPipelineStagger(
          m.label === "Float V4" ? "v4" : "v3",
          activePipelineIds,
          (ms) => new Promise((r) => setTimeout(r, ms))
        );
        await m.performUpkeep();
      }
    } catch (e) {
      console.error("main loop error:", e);
    }

    await new Promise((r) => setTimeout(r, pollMsNumber));
  }
}

if (!areDemeterLoopsEnabled()) {
  console.log("[Keeper]", demeterLoopsDisabledMessage());
  process.exit(0);
}

mainLoop().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
