/**
 * Robinhood Chain (mainnet) — this fork of soteria_agents targets chain id 4663 only.
 *
 * RPC: prefer `ROBINHOOD_MAIN_RPC_URL`, fall back to `RPC_URL`.
 * CoinGecko onchain network id: `robinhood`.
 */
import { defineChain, type Chain } from "viem";

/** Robinhood Chain mainnet (Arbitrum Orbit L2). */
export const ROBINHOOD_CHAIN_ID = 4663;

/** CoinGecko / GeckoTerminal onchain `network` path segment. */
export const COINGECKO_NETWORK = "robinhood" as const;

/** Demeter / AgentKit network id string. */
export const DEFAULT_NETWORK_ID = "robinhood-mainnet" as const;

/** Canonical WETH on Robinhood Chain. */
export const WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;

/** Canonical USDG (USD stable) on Robinhood Chain — use instead of Base USDC. */
export const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

/** Uniswap V3 factory on Robinhood Chain. */
export const UNISWAP_V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as const;

/** Uniswap V4 PoolManager on Robinhood Chain. */
export const UNISWAP_V4_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;

export const EXPLORER_BASE_URL = "https://robinhoodchain.blockscout.com" as const;

export const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: EXPLORER_BASE_URL,
    },
  },
});

/** Resolved viem chain for this deployment (always Robinhood). */
export function getViemChain(): Chain {
  return robinhood;
}

/**
 * RPC for all chain reads/writes.
 * Prefer `ROBINHOOD_MAIN_RPC_URL`; fall back to `RPC_URL` for local/legacy.
 */
export function getRpcUrl(): string {
  const url =
    process.env.ROBINHOOD_MAIN_RPC_URL?.trim() || process.env.RPC_URL?.trim() || "";
  if (!url) {
    throw new Error(
      "Set ROBINHOOD_MAIN_RPC_URL (preferred) or RPC_URL for Robinhood Chain RPC access."
    );
  }
  return url;
}

/** Optional RPC — returns undefined when neither env is set (callers that soft-fail). */
export function getRpcUrlOptional(): string | undefined {
  const url =
    process.env.ROBINHOOD_MAIN_RPC_URL?.trim() || process.env.RPC_URL?.trim() || "";
  return url || undefined;
}

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE_URL}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

export function explorerTokenUrl(address: string): string {
  return `${EXPLORER_BASE_URL}/token/${address}`;
}
