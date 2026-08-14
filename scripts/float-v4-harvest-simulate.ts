/**
 * Decode why FloatKeeperV4.performHarvest → harvestBoolean returns didAct=false.
 */
import "dotenv/config";
import { createPublicClient, decodeErrorResult, http } from "viem";

import floatKeeperV4Json from "../app/abi/FloatKeeperV4.json";
import floatStrategyV4Json from "../app/abi/FloatStrategyV4.json";
import { getRpcUrl, getViemChain } from "../app/config/chain-config";
import { getFloatV4KeeperAddress } from "../app/config/demeter-config";

const rpcUrl = getRpcUrl();

const keeper = getFloatV4KeeperAddress() as `0x${string}`;
const strat = "0xa40A982190d31Ae334a4D97b1B11CF9b1E769aef" as `0x${string}`;
const demeter = "0x3ec00017066Eb2e2348D82d0e21D5fDB3357CE16" as `0x${string}`;
const keeperAbi = floatKeeperV4Json.abi;
const stratAbi = floatStrategyV4Json.abi;

const client = createPublicClient({ chain: getViemChain(), transport: http(rpcUrl) });

async function sim(
  label: string,
  fn: () => Promise<unknown>
): Promise<void> {
  try {
    await fn();
    console.log(label, "→ OK (no revert)");
  } catch (e: unknown) {
    const err = e as { shortMessage?: string; message?: string; data?: `0x${string}` };
    console.log(label, "→ REVERT:", err.shortMessage ?? err.message);
    if (err.data) {
      try {
        console.log("  decoded:", decodeErrorResult({ abi: stratAbi, data: err.data }));
      } catch {
        try {
          console.log("  decoded (keeper):", decodeErrorResult({ abi: keeperAbi, data: err.data }));
        } catch {
          console.log("  raw data:", err.data);
        }
      }
    }
  }
}

async function main() {
  const block = await client.getBlock();
  console.log("chain now:", Number(block.timestamp));
  console.log("keeper:", keeper);
  console.log("strategy:", strat);

  const reads = [
    "managerAddress",
    "mode",
    "getPositionId",
    "poolValue",
    "lastHarvest",
    "PrevHarvestTime",
    "minHarvestDelay",
    "harvestOnDeposit",
    "paused",
  ] as const;

  for (const name of reads) {
    try {
      const r = await client.readContract({
        address: strat,
        abi: stratAbi,
        functionName: name,
      });
      console.log(`${name}:`, r);
    } catch (e) {
      console.log(`${name}: (read failed)`, e instanceof Error ? e.message : e);
    }
  }

  // Compare keeper address to strategy's configured keeper slot (if exposed)
  for (const name of ["keeperCheck"] as const) {
    try {
      await sim(`harvestBoolean dry-run via ${name}`, () =>
        client.simulateContract({
          address: strat,
          abi: stratAbi,
          functionName: name,
          account: keeper,
        })
      );
    } catch {
      /* optional */
    }
  }

  const harvestData = (
    await import("viem")
  ).encodeFunctionData({
    abi: stratAbi,
    functionName: "harvestBoolean",
    args: [false],
  });
  try {
    await client.call({
      to: strat,
      data: harvestData,
      account: keeper,
    });
    console.log("harvestBoolean(false) call → OK");
  } catch (e: unknown) {
    const err = e as { data?: `0x${string}`; shortMessage?: string };
    console.log("harvestBoolean(false) call → REVERT data:", err.data ?? "(none)");
    console.log("  message:", err.shortMessage);
    if (err.data) {
      try {
        console.log("  decoded:", decodeErrorResult({ abi: stratAbi, data: err.data }));
      } catch {
        /* unknown */
      }
    }
  }

  await sim("harvestBoolean(false) msg.sender=keeper", () =>
    client.simulateContract({
      address: strat,
      abi: stratAbi,
      functionName: "harvestBoolean",
      args: [false],
      account: keeper,
    })
  );

  await sim("harvestBoolean(true) msg.sender=keeper", () =>
    client.simulateContract({
      address: strat,
      abi: stratAbi,
      functionName: "harvestBoolean",
      args: [true],
      account: keeper,
    })
  );

  await sim("performHarvest(0,false) msg.sender=demeter", () =>
    client.simulateContract({
      address: keeper,
      abi: keeperAbi,
      functionName: "performHarvest",
      args: [0n, false],
      account: demeter,
    })
  );

  // Trace failed on-chain tx (first from user logs)
  const failedTx =
    "0xbb9cdfa17b525c4220602325fc9f87d7bdae5dc03e77a817bf190b3f88449f74" as const;
  try {
    await client.call({
      to: keeper,
      data: (
        await import("viem")
      ).encodeFunctionData({
        abi: keeperAbi,
        functionName: "performHarvest",
        args: [0n, false],
      }),
      account: demeter,
      blockNumber: (await client.getTransactionReceipt({ hash: failedTx })).blockNumber,
    });
    console.log("historical call at failed tx block: OK");
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.log("historical call at failed tx block:", err.message?.slice(0, 200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
