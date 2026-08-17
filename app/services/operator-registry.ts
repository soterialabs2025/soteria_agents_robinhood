/**
 * OperatorRegistry reads — validate configured operator wallets against on-chain allowlist.
 */
import type { Abi, Address } from "viem";

import operatorRegistryJson from "../abi/OperatorRegistry.json";
import { createTritonPublicClient } from "../action-providers/liquid-strat-min-v4-action-provider";
import { getOperatorRegistryAddress } from "../config/operator-registry-config";

const OPERATOR_REGISTRY_ABI = operatorRegistryJson.abi as Abi;

export async function readOperatorRegistryIsOperator(
  registryAddress: Address,
  account: Address,
  rpcUrl: string
): Promise<boolean> {
  const client = createTritonPublicClient(rpcUrl);
  return (await client.readContract({
    address: registryAddress,
    abi: OPERATOR_REGISTRY_ABI,
    functionName: "isOperator",
    args: [account],
  })) as boolean;
}

export type OperatorWalletCheck = {
  id: string;
  address: Address;
  isOperator: boolean;
};

/**
 * Keep wallets that are registered; skip the rest with a warning.
 * Throws only if none remain.
 */
export async function filterRegisteredOperatorWallets<T extends { id: string; address: Address }>(
  wallets: readonly T[],
  rpcUrl: string,
  registryAddress: Address,
  logTag = "OperatorRegistry"
): Promise<T[]> {
  const registered: T[] = [];
  for (const wallet of wallets) {
    const isOperator = await readOperatorRegistryIsOperator(registryAddress, wallet.address, rpcUrl);
    if (isOperator) {
      registered.push(wallet);
      continue;
    }
    console.warn(
      `[${logTag}] skipping ${wallet.id} ${wallet.address} — not registered on ${registryAddress}`
    );
  }
  if (registered.length === 0) {
    throw new Error(
      `No operator wallets are registered on OperatorRegistry ${registryAddress}`
    );
  }
  return registered;
}

/** Verify every wallet is registered on OperatorRegistry; throws on first failure. */
export async function assertOperatorWalletsRegistered(
  wallets: Array<{ id: string; address: Address }>,
  rpcUrl: string,
  registryAddress: Address = getOperatorRegistryAddress()
): Promise<OperatorWalletCheck[]> {
  const checks: OperatorWalletCheck[] = [];
  for (const wallet of wallets) {
    const isOperator = await readOperatorRegistryIsOperator(registryAddress, wallet.address, rpcUrl);
    checks.push({ id: wallet.id, address: wallet.address, isOperator });
    if (!isOperator) {
      throw new Error(
        `Operator wallet ${wallet.id} (${wallet.address}) is not registered on OperatorRegistry ${registryAddress}`
      );
    }
  }
  return checks;
}
