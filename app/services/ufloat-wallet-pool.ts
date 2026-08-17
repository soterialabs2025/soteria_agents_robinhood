/**
 * UFloat on-chain tx wallets — serialized per wallet to avoid nonce conflicts when
 * multiple strategies changeAsset in the same offensive (or upkeep) tick.
 */
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getTritonWalletAddress } from "../action-providers/liquid-strat-min-v4-action-provider";
import { TRITON_TWO_WALLET_ADDRESS } from "../config/operator-registry-config";
import {
  getTritonPrivateKeyFromEnv,
  getTritonTwoPrivateKeyFromEnv,
} from "../config/triton-config";
import { pickShardWalletId } from "./operator-shard";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";

export type UfloatTxWalletId = "triton" | "triton_two";

export type UfloatTxWallet = {
  id: UfloatTxWalletId;
  privateKey: string;
  address: Address;
};

function normalizePrivateKey(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function resolveTritonWallet(privateKey: string): UfloatTxWallet {
  return {
    id: "triton",
    privateKey,
    address: getTritonWalletAddress(privateKey),
  };
}

function resolveTritonTwoWallet(privateKey: string): UfloatTxWallet {
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const expected = TRITON_TWO_WALLET_ADDRESS.toLowerCase();
  if (account.address.toLowerCase() !== expected) {
    throw new Error(
      `TRITON_TWO_PRIVATE_KEY derives ${account.address} but expected ${TRITON_TWO_WALLET_ADDRESS}`
    );
  }
  return {
    id: "triton_two",
    privateKey,
    address: account.address,
  };
}

/** Registered UFloat operator wallets from env (TRITON_PRIVATE_KEY + optional TRITON_TWO_PRIVATE_KEY). */
export function resolveUfloatTxWallets(): UfloatTxWallet[] {
  const wallets: UfloatTxWallet[] = [];
  const pk1 = process.env.TRITON_PRIVATE_KEY?.trim();
  if (pk1) {
    wallets.push(resolveTritonWallet(pk1));
  }
  const pk2 = getTritonTwoPrivateKeyFromEnv();
  if (pk2) {
    wallets.push(resolveTritonTwoWallet(pk2));
  }
  if (wallets.length === 0) {
    throw new Error("TRITON_PRIVATE_KEY or TRITON_TWO_PRIVATE_KEY is required for UFloat operator wallets");
  }
  return wallets;
}

export function getUfloatTxWalletIds(): readonly UfloatTxWalletId[] {
  return resolveUfloatTxWallets().map((w) => w.id);
}

export function getUfloatTxWallet(walletId: UfloatTxWalletId): UfloatTxWallet {
  const wallet = resolveUfloatTxWallets().find((w) => w.id === walletId);
  if (!wallet) {
    throw new Error(`Unknown UFloat tx wallet id: ${walletId} (not configured in env)`);
  }
  return wallet;
}

/** Shard wallet for a UFloat strategy id (keeper index). */
export function getUfloatWalletForStrategyId(strategyId: number): UfloatTxWallet {
  const walletIds = getUfloatTxWalletIds();
  const walletId = pickShardWalletId(strategyId, walletIds);
  return getUfloatTxWallet(walletId);
}

/** Run `fn` after prior txs on this wallet address complete (shared with AutoKeeper). */
export function enqueueUfloatWalletTx<T>(
  walletId: UfloatTxWalletId,
  fn: () => Promise<T>
): Promise<T> {
  const wallet = getUfloatTxWallet(walletId);
  return enqueueSerializedAddressTx(wallet.address, fn);
}

/** @deprecated Use {@link getTritonPrivateKeyFromEnv} when primary Triton key is required. */
export { getTritonPrivateKeyFromEnv };
