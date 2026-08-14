/**
 * OperatorRegistry — on-chain allowlist for Demeter/Triton operator wallets (wallet sharding).
 */
import type { Address } from "viem";

/** Deployed OperatorRegistry on Base mainnet. Override via OPERATOR_REGISTRY_ADDRESS. */
export const DEFAULT_OPERATOR_REGISTRY_ADDRESS =
  "0x704618C4E8C201F45536DFD583911F8335e853Dd" as const;

/** Expected address for TRITON_TWO_PRIVATE_KEY (operator shard 2). */
export const TRITON_TWO_WALLET_ADDRESS =
  "0xDaFb1B9789F4ECb75A006F65F99081802c871Ed4" as const;

/** Expected address for DEMETER_TWO_PRIVATE_KEY (operator shard 2). */
export const DEMETER_TWO_WALLET_ADDRESS =
  "0xa16c8cc08674F7c120A64d94f432377D427901a0" as const;

export function getOperatorRegistryAddress(): Address {
  const raw = process.env.OPERATOR_REGISTRY_ADDRESS?.trim();
  return (raw || DEFAULT_OPERATOR_REGISTRY_ADDRESS) as Address;
}
