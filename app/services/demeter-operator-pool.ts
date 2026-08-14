/**
 * Demeter operator wallets for Float keeper txs (performUpkeep / performHarvest).
 * Serialized per wallet; parallel across shards when multiple keys are configured.
 */
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DEMETER_TWO_WALLET_ADDRESS } from "../config/operator-registry-config";
import { pickShardWalletId } from "./operator-shard";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";

export type DemeterOperatorWalletId = "demeter" | "demeter_two";

export type DemeterOperatorWallet = {
  id: DemeterOperatorWalletId;
  privateKey: string;
  address: Address;
};

function normalizePrivateKey(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function resolveDemeterWallet(privateKey: string): DemeterOperatorWallet {
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  return {
    id: "demeter",
    privateKey,
    address: account.address,
  };
}

function resolveDemeterTwoWallet(privateKey: string): DemeterOperatorWallet {
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const expected = DEMETER_TWO_WALLET_ADDRESS.toLowerCase();
  if (account.address.toLowerCase() !== expected) {
    throw new Error(
      `DEMETER_TWO_PRIVATE_KEY derives ${account.address} but expected ${DEMETER_TWO_WALLET_ADDRESS}`
    );
  }
  return {
    id: "demeter_two",
    privateKey,
    address: account.address,
  };
}

/** Demeter operator wallets from env (DEMETER_PRIVATE_KEY + optional DEMETER_TWO_PRIVATE_KEY). */
export function resolveDemeterOperatorWallets(): DemeterOperatorWallet[] {
  const wallets: DemeterOperatorWallet[] = [];
  const pk1 = process.env.DEMETER_PRIVATE_KEY?.trim();
  if (pk1) {
    wallets.push(resolveDemeterWallet(pk1));
  }
  const pk2 = process.env.DEMETER_TWO_PRIVATE_KEY?.trim();
  if (pk2) {
    wallets.push(resolveDemeterTwoWallet(pk2));
  }
  return wallets;
}

export function isDemeterOperatorShardingEnabled(): boolean {
  return resolveDemeterOperatorWallets().length > 1;
}

export function getDemeterOperatorWalletIds(): readonly DemeterOperatorWalletId[] {
  return resolveDemeterOperatorWallets().map((w) => w.id);
}

export function getDemeterOperatorWallet(walletId: DemeterOperatorWalletId): DemeterOperatorWallet {
  const wallet = resolveDemeterOperatorWallets().find((w) => w.id === walletId);
  if (!wallet) {
    throw new Error(`Unknown Demeter operator wallet id: ${walletId} (not configured in env)`);
  }
  return wallet;
}

export function getDemeterWalletForStrategyId(strategyId: number): DemeterOperatorWallet {
  const walletIds = getDemeterOperatorWalletIds();
  if (walletIds.length === 0) {
    throw new Error("No Demeter operator wallets configured (DEMETER_PRIVATE_KEY)");
  }
  const walletId = pickShardWalletId(strategyId, walletIds);
  return getDemeterOperatorWallet(walletId);
}

/**
 * Run `fn` after prior txs on this Demeter operator address complete.
 * Address-keyed so AutoKeeper (same DEMETER_TWO key) cannot race Float shard txs.
 */
export function enqueueDemeterOperatorTx<T>(
  walletId: DemeterOperatorWalletId,
  fn: () => Promise<T>
): Promise<T> {
  const wallet = getDemeterOperatorWallet(walletId);
  return enqueueSerializedAddressTx(wallet.address, fn);
}
