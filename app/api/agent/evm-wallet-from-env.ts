/**
 * Local viem signing for AgentKit (`ViemWalletProvider`) — default unless `EVM_WALLET_SIGNER=cdp`.
 *
 * Env:
 * - `DEMETER_PRIVATE_KEY` — 32-byte hex key (`0x` + 64 hex chars)
 * - `ROBINHOOD_MAIN_RPC_URL` (preferred) or `RPC_URL` — Robinhood Chain RPC
 * - `EOA_ADDRESS` — optional; if set, must match the address derived from the private key
 *
 * Network: Robinhood mainnet (`robinhood-mainnet` → chain id 4663).
 */

import { ViemWalletProvider } from "@coinbase/agentkit";
import type { Chain } from "viem";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  DEFAULT_NETWORK_ID,
  getRpcUrl,
  getViemChain,
  robinhood,
} from "../../config/chain-config";
import { getNetworkId } from "../../config/demeter-config";

const NETWORK_ID_TO_CHAIN: Record<string, Chain> = {
  [DEFAULT_NETWORK_ID]: robinhood,
};

export type EvmWalletSignerMode = "cdp" | "viem";

/**
 * `EVM_WALLET_SIGNER` or `WALLET_SIGNER`: omit or any value except `cdp` → **viem** (local `DEMETER_PRIVATE_KEY`).
 * Set to `cdp` for Coinbase CDP-hosted signing (`CDP_API_KEY_*`, optional `EOA_ADDRESS`).
 */
export function getEvmWalletSignerMode(): EvmWalletSignerMode {
  const raw = (process.env.EVM_WALLET_SIGNER ?? process.env.WALLET_SIGNER ?? "viem").trim().toLowerCase();
  if (raw === "cdp") return "cdp";
  return "viem";
}

export function resolveViemChainForNetworkId(networkId: string): Chain {
  const chain = NETWORK_ID_TO_CHAIN[networkId] ?? (networkId.includes("robinhood") ? robinhood : undefined);
  if (!chain) {
    throw new Error(
      `Viem wallet: unsupported networkId "${networkId}". This fork only supports robinhood-mainnet (4663).`
    );
  }
  return chain;
}

function normalizePrivateKeyHex(raw: string): `0x${string}` {
  const t = raw.trim();
  if (!t) {
    throw new Error("DEMETER_PRIVATE_KEY is empty.");
  }
  const with0x = (t.startsWith("0x") ? t : `0x${t}`) as `0x${string}`;
  if (with0x.length !== 66) {
    throw new Error("DEMETER_PRIVATE_KEY must be 32 bytes (64 hex characters), with optional 0x prefix.");
  }
  return with0x;
}

/**
 * Builds a {@link ViemWalletProvider} for the configured Demeter network (`getNetworkId`) and Robinhood RPC.
 */
function resolveDemeterPrivateKeyFromEnv(): string {
  const pk =
    process.env.DEMETER_PRIVATE_KEY?.trim() ||
    process.env.WALLET_PRIVATE_KEY?.trim() ||
    process.env.EVM_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error(
      "Viem wallet signer requires DEMETER_PRIVATE_KEY (or legacy WALLET_PRIVATE_KEY / EVM_PRIVATE_KEY) in the environment."
    );
  }
  return pk;
}

export function createViemWalletProviderFromEnv(): ViemWalletProvider {
  const pkRaw = resolveDemeterPrivateKeyFromEnv();
  const rpcUrl = getRpcUrl();

  const networkId = getNetworkId();
  const chain = resolveViemChainForNetworkId(networkId);
  const account = privateKeyToAccount(normalizePrivateKeyHex(pkRaw));

  const expected = process.env.EOA_ADDRESS?.trim();
  if (expected && account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `EOA_ADDRESS (${expected}) does not match the address derived from DEMETER_PRIVATE_KEY (${account.address}).`
    );
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  // AgentKit bundles viem; TypeScript sees two `WalletClient` types. Runtime shape matches.
  return new ViemWalletProvider(walletClient as never, { rpcUrl });
}

/** Re-export for callers that only need the chain object. */
export { getViemChain };
