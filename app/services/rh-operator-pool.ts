/**
 * Shared Robinhood operator wallets for keeper checks (upkeep / harvest).
 * Up to four keys: DEMETER_PRIVATE_KEY, DEMETER_TWO_PRIVATE_KEY,
 * TRITON_PRIVATE_KEY, TRITON_TWO_PRIVATE_KEY.
 *
 * Strategy ids shard with id % walletCount. All txs serialize per address
 * so the same wallet cannot nonce-collide across Auto + UFloat keepers.
 *
 * UFloat changeAsset stays on Triton wallets ({@link ufloat-wallet-pool}).
 */
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getTritonWalletAddress } from "../action-providers/liquid-strat-min-v4-action-provider";
import { TRITON_TWO_WALLET_ADDRESS } from "../config/operator-registry-config";
import { getTritonTwoPrivateKeyFromEnv } from "../config/triton-config";
import { resolveDemeterOperatorWallets } from "./demeter-operator-pool";
import { pickShardWalletId } from "./operator-shard";
import { enqueueSerializedAddressTx } from "./operator-tx-queue";

export type RhOperatorWalletId = "demeter" | "demeter_two" | "triton" | "triton_two";

export type RhOperatorWallet = {
  id: RhOperatorWalletId;
  privateKey: string;
  address: Address;
};

function normalizePrivateKey(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function resolveTritonWallet(privateKey: string): RhOperatorWallet {
  return {
    id: "triton",
    privateKey,
    address: getTritonWalletAddress(privateKey),
  };
}

function resolveTritonTwoWallet(privateKey: string): RhOperatorWallet {
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

/** All configured operator wallets (1–4). Throws if none are set. */
export function resolveRhOperatorWallets(): RhOperatorWallet[] {
  const wallets: RhOperatorWallet[] = [];
  for (const w of resolveDemeterOperatorWallets()) {
    wallets.push(w);
  }
  const tritonPk = process.env.TRITON_PRIVATE_KEY?.trim();
  if (tritonPk) {
    wallets.push(resolveTritonWallet(tritonPk));
  }
  const tritonTwoPk = getTritonTwoPrivateKeyFromEnv();
  if (tritonTwoPk) {
    wallets.push(resolveTritonTwoWallet(tritonTwoPk));
  }
  if (wallets.length === 0) {
    throw new Error(
      "No operator wallets configured. Set DEMETER_PRIVATE_KEY, DEMETER_TWO_PRIVATE_KEY, TRITON_PRIVATE_KEY, and/or TRITON_TWO_PRIVATE_KEY."
    );
  }
  const seen = new Set<string>();
  for (const w of wallets) {
    const key = w.address.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `Operator wallet collision: ${w.id} derives ${w.address} which is already in the pool`
      );
    }
    seen.add(key);
  }
  return wallets;
}

export function getRhOperatorWalletIds(): readonly RhOperatorWalletId[] {
  return resolveRhOperatorWallets().map((w) => w.id);
}

export function getRhOperatorWallet(walletId: RhOperatorWalletId): RhOperatorWallet {
  const wallet = resolveRhOperatorWallets().find((w) => w.id === walletId);
  if (!wallet) {
    throw new Error(`Unknown RH operator wallet id: ${walletId} (not configured in env)`);
  }
  return wallet;
}

export function getRhWalletForStrategyId(strategyId: number): RhOperatorWallet {
  const walletIds = getRhOperatorWalletIds();
  const walletId = pickShardWalletId(strategyId, walletIds);
  return getRhOperatorWallet(walletId);
}

export function hasRhOperatorWallets(): boolean {
  return Boolean(
    process.env.DEMETER_PRIVATE_KEY?.trim() ||
      process.env.DEMETER_TWO_PRIVATE_KEY?.trim() ||
      process.env.TRITON_PRIVATE_KEY?.trim() ||
      process.env.TRITON_TWO_PRIVATE_KEY?.trim()
  );
}

export function enqueueRhOperatorTx<T>(wallet: RhOperatorWallet, fn: () => Promise<T>): Promise<T> {
  return enqueueSerializedAddressTx(wallet.address, fn);
}
