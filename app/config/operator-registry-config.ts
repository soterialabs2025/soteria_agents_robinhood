/**
 * OperatorRegistry — on-chain allowlist for Demeter/Triton operator wallets (wallet sharding).
 */
import type { Address } from "viem";

import { requireAddrAny } from "./env-address";

/** Expected address for TRITON_TWO_PRIVATE_KEY (operator shard 2). */
export const TRITON_TWO_WALLET_ADDRESS =
  "0xDaFb1B9789F4ECb75A006F65F99081802c871Ed4" as const;

/** Expected address for DEMETER_TWO_PRIVATE_KEY (operator shard 2). */
export const DEMETER_TWO_WALLET_ADDRESS =
  "0xa16c8cc08674F7c120A64d94f432377D427901a0" as const;

/** Env: `OPERATOR_REGISTRY_ADDRESS` or `AUTO_OPERATOR_REGISTRY_ADDRESS`. */
export function getOperatorRegistryAddress(): Address {
  return requireAddrAny(["OPERATOR_REGISTRY_ADDRESS", "AUTO_OPERATOR_REGISTRY_ADDRESS"]);
}
