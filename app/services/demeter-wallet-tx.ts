/**
 * Demeter/Triton EVM sends with `estimateGas` + headroom + min gas floor (see {@link resolveTxGasLimit}).
 */
import type { EvmWalletProvider } from "@coinbase/agentkit";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getRpcUrl, getViemChain } from "../config/chain-config";
import {
  getTxMinGasLimit,
  resolveChangeAssetTxGasLimit,
  resolveTxGasLimit,
} from "../config/demeter-tx-gas";

function resolveDemeterRpcUrl(rpcUrl?: string): string {
  const url = rpcUrl?.trim() || (() => {
    try {
      return getRpcUrl();
    } catch {
      return "";
    }
  })();
  if (!url) {
    throw new Error("ROBINHOOD_MAIN_RPC_URL (or RPC_URL) is required for Demeter gas estimation with headroom");
  }
  return url;
}

function isNonceTooLowError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    const details = (error as { details?: string }).details;
    if (typeof details === "string") parts.push(details);
    const short = (error as { shortMessage?: string }).shortMessage;
    if (typeof short === "string") parts.push(short);
  } else {
    parts.push(String(error));
  }
  const text = parts.join(" ").toLowerCase();
  return text.includes("nonce too low") || text.includes("nonce provided for the transaction is lower");
}

/** When RPC rejects a resubmit, details often include the hash of the tx that consumed the nonce. */
export function extractSubmittedTxHashFromError(error: unknown): Hash | null {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    const details = (error as { details?: string }).details;
    if (typeof details === "string") parts.push(details);
  } else {
    parts.push(String(error));
  }
  const match = parts.join(" ").match(/0x[a-fA-F0-9]{64}/);
  return match ? (match[0] as Hash) : null;
}

/**
 * Estimate gas, apply headroom, then submit via AgentKit wallet provider.
 */
export async function sendEvmTxWithGasHeadroom(
  walletProvider: EvmWalletProvider,
  tx: { to: Address; data: `0x${string}`; value?: bigint },
  rpcUrl?: string
): Promise<string> {
  const url = resolveDemeterRpcUrl(rpcUrl);
  const from = walletProvider.getAddress() as Address;
  const client = createPublicClient({ chain: getViemChain(), transport: http(url) });

  const estimate = await client.estimateGas({
    account: from,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  const gas = resolveTxGasLimit(estimate);

  return walletProvider.sendTransaction({
    to: tx.to,
    data: tx.data,
    gas,
    ...(tx.value !== undefined && tx.value > 0n ? { value: tx.value } : {}),
  });
}

/** Gas from viem `simulateContract` request — headroom + {@link getTxMinGasLimit} floor. */
export function gasLimitFromSimulateRequest(request: { gas?: bigint | null }): bigint {
  return resolveTxGasLimit(request.gas ?? getTxMinGasLimit());
}

/** Gas for `changeAsset` — {@link resolveChangeAssetTxGasLimit} (batch-grade headroom + floor). */
export function gasLimitFromSimulateRequestForChangeAsset(request: { gas?: bigint | null }): bigint {
  return resolveChangeAssetTxGasLimit(request.gas ?? getTxMinGasLimit());
}

function normalizePrivateKey(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

const PRIVATE_KEY_TX_MAX_ATTEMPTS = 3;

/**
 * Estimate gas, apply headroom, then submit via viem wallet client (operator shard paths).
 * Uses explicit pending nonce and retries on nonce-too-low (parallel loop / RPC lag).
 */
export async function sendEvmTxWithGasHeadroomFromPrivateKey(
  privateKey: string,
  tx: { to: Address; data: `0x${string}`; value?: bigint },
  rpcUrl?: string
): Promise<Hash> {
  const url = resolveDemeterRpcUrl(rpcUrl);
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const publicClient = createPublicClient({ chain: getViemChain(), transport: http(url) });
  const walletClient = createWalletClient({
    account,
    chain: getViemChain(),
    transport: http(url),
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= PRIVATE_KEY_TX_MAX_ATTEMPTS; attempt++) {
    try {
      const nonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
      const estimate = await publicClient.estimateGas({
        account: account.address,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
      });
      const gas = resolveTxGasLimit(estimate);

      return await walletClient.sendTransaction({
        account,
        chain: getViemChain(),
        to: tx.to,
        data: tx.data,
        gas,
        nonce,
        ...(tx.value !== undefined && tx.value > 0n ? { value: tx.value } : {}),
      });
    } catch (error) {
      lastError = error;
      const submitted = extractSubmittedTxHashFromError(error);
      if (submitted) {
        return submitted;
      }
      if (isNonceTooLowError(error) && attempt < PRIVATE_KEY_TX_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/** viem writeContract with headroom + min gas floor (Triton wallet paths). */
export async function writeViemContractWithGasHeadroom(
  walletClient: WalletClient,
  request: { gas?: bigint | null } & Record<string, unknown>
): Promise<Hash> {
  return walletClient.writeContract({
    ...(request as Parameters<WalletClient["writeContract"]>[0]),
    gas: gasLimitFromSimulateRequest(request),
  });
}

/** viem writeContract for `changeAsset` — batch-grade gas (heavy swap paths). */
export async function writeViemContractWithChangeAssetGasHeadroom(
  walletClient: WalletClient,
  request: { gas?: bigint | null } & Record<string, unknown>
): Promise<Hash> {
  return walletClient.writeContract({
    ...(request as Parameters<WalletClient["writeContract"]>[0]),
    gas: gasLimitFromSimulateRequestForChangeAsset(request),
  });
}
