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
