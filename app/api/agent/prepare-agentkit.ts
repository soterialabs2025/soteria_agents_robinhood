import {
  AgentKit,
  cdpApiActionProvider,
  cdpEvmWalletActionProvider,
  erc20ActionProvider,
  pythActionProvider,
  CdpEvmWalletProvider,
  walletActionProvider,
  WalletProvider,
  wethActionProvider,
  x402ActionProvider,
} from "@coinbase/agentkit";
import { coingeckoActionProvider } from "../../action-providers/coingecko-action-provider";
import { demeterConfigActionProvider } from "../../action-providers/demeter-config-action-provider";
import { demeterRunCycleActionProvider } from "../../action-providers/demeter-run-cycle-action-provider";
import { demeterStartActionProvider } from "../../action-providers/demeter-start-action-provider";
import { tritonConfigActionProvider } from "../../action-providers/triton-config-action-provider";
import { liquidStratMinV4ActionProvider } from "../../action-providers/liquid-strat-min-v4-action-provider";
import { floatActionProvider } from "../../action-providers/float-action-provider";
import { keeperStrategyActionProvider } from "../../action-providers/keeper-strategy-action-provider";
import {
  getKeeperAddress,
  getNetworkId,
  getFloatContractManagerAddress,
  getFloatContractManagerV4Address,
  getFloatV4KeeperAddress,
} from "../../config/demeter-config";
import { getRpcUrlOptional } from "../../config/chain-config";
import * as fs from "fs";
import type { Address } from "viem";

import { createViemWalletProviderFromEnv, getEvmWalletSignerMode } from "./evm-wallet-from-env";

import { loadDemeterEnv } from "../../config/demeter-loops";

loadDemeterEnv();
/**
 * AgentKit Integration Route
 *
 * It defines the core capabilities of your agent through WalletProvider
 * and ActionProvider configuration.
 *
 * ## Wallet signers
 * - **viem** (default): local signing via `ViemWalletProvider` — `DEMETER_PRIVATE_KEY`, `RPC_URL`. Optional `EOA_ADDRESS` must match the derived signer.
 * - **cdp**: set `EVM_WALLET_SIGNER=cdp` — `CdpEvmWalletProvider` with `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, optional `EOA_ADDRESS` / `wallet_data.txt`.
 *   In viem mode, CDP API keys are optional; if set, CDP action providers are still registered.
 *
 * Key Components:
 * 1. WalletProvider Setup:
 *    - https://github.com/coinbase/agentkit/tree/main/typescript/agentkit#evm-wallet-providers
 *
 * 2. ActionProviders Setup:
 *    - https://github.com/coinbase/agentkit/tree/main/typescript/agentkit#action-providers
 */

// Configure a file to persist the agent's EOA account data (CDP creates address; viem writes derived address for reference)
const WALLET_DATA_FILE = "wallet_data.txt";

type WalletData = {
  eoaAddress?: Address;
  walletSigner?: "cdp" | "viem";
};

/** Chat console: Triton/Liquid + CoinGecko + Demeter config only (<128 OpenAI tools). Full: CDP/wallet/keeper ops. */
export type AgentkitToolProfile = "chat" | "full";

function buildChatActionProviders() {
  return [
    liquidStratMinV4ActionProvider(),
    coingeckoActionProvider(),
    demeterConfigActionProvider(),
    /** Loop toggles only — position/schedule/tiered rules live on liquidStratMinV4_* tools. */
    tritonConfigActionProvider({ chatProfile: true }),
    demeterRunCycleActionProvider(),
    demeterStartActionProvider(),
  ];
}

function hasCdpApiCredentials(): boolean {
  return Boolean(process.env.CDP_API_KEY_ID?.trim() && process.env.CDP_API_KEY_SECRET?.trim());
}

/**
 * Prepares the AgentKit and WalletProvider.
 *
 * @throws {Error} If the agent initialization fails.
 */
export async function prepareAgentkitAndWalletProvider(options?: {
  toolProfile?: AgentkitToolProfile;
}): Promise<{
  agentkit: AgentKit;
  walletProvider: WalletProvider;
}> {
  const toolProfile = options?.toolProfile ?? "full";
  const signerMode = getEvmWalletSignerMode();

  if (signerMode === "cdp" && !hasCdpApiCredentials()) {
    throw new Error(
      "EVM_WALLET_SIGNER=cdp requires CDP_API_KEY_ID and CDP_API_KEY_SECRET. To use local viem signing, remove EVM_WALLET_SIGNER=cdp (default is viem) and set DEMETER_PRIVATE_KEY + RPC_URL."
    );
  }

  let walletData: WalletData | null = null;
  let eoaAddress: Address | undefined = undefined;

  if (fs.existsSync(WALLET_DATA_FILE)) {
    try {
      walletData = JSON.parse(fs.readFileSync(WALLET_DATA_FILE, "utf8")) as WalletData;
      eoaAddress = walletData.eoaAddress;
    } catch (error) {
      console.error("Error reading wallet data:", error);
    }
  }

  const accountAddressForCdp = (process.env.EOA_ADDRESS || eoaAddress || "0x3ec00017066Eb2e2348D82d0e21D5fDB3357CE16") as Address;

  try {
    let walletProvider: WalletProvider;

    if (signerMode === "viem") {
      walletProvider = createViemWalletProviderFromEnv();
      console.log(
        `[AgentKit] Wallet signer: viem (local) — address ${walletProvider.getAddress()} on ${walletProvider.getNetwork().networkId}`
      );
    } else {
      // CDP-hosted EOA: https://docs.cdp.coinbase.com/agentkit/docs/wallet-management
      walletProvider = await CdpEvmWalletProvider.configureWithWallet({
        apiKeyId: process.env.CDP_API_KEY_ID!,
        apiKeySecret: process.env.CDP_API_KEY_SECRET!,
        networkId: getNetworkId(),
        rpcUrl: getRpcUrlOptional(),
        address: accountAddressForCdp,
      });
      console.log(
        `[AgentKit] Wallet signer: CDP — network ${walletProvider.getNetwork().networkId}`
      );
    }

    const keeperAddress = getKeeperAddress() as `0x${string}`;
    const floatAddress = getFloatContractManagerAddress();

    const actionProviders =
      toolProfile === "full"
        ? [
            liquidStratMinV4ActionProvider(),
            coingeckoActionProvider(),
            demeterConfigActionProvider(),
            tritonConfigActionProvider(),
            demeterRunCycleActionProvider(),
            demeterStartActionProvider(),
          ]
        : buildChatActionProviders();

    if (toolProfile === "full") {
      actionProviders.unshift(
        wethActionProvider(),
        pythActionProvider(),
        walletActionProvider(),
        erc20ActionProvider(),
        x402ActionProvider()
      );
      actionProviders.push(
        floatActionProvider(floatAddress),
        floatActionProvider(getFloatContractManagerV4Address() as Address, {
          toolPrefix: "floatV4",
          strategyRegistryKey: "FloatStrategyV4",
        })
      );

      if (hasCdpApiCredentials()) {
        actionProviders.push(cdpApiActionProvider(), cdpEvmWalletActionProvider());
      } else if (signerMode === "viem") {
        console.warn(
          "[AgentKit] CDP_API_KEY_ID / CDP_API_KEY_SECRET not set — skipping cdpApiActionProvider and cdpEvmWalletActionProvider."
        );
      }

      actionProviders.push(
        keeperStrategyActionProvider(keeperAddress, { pipelineId: "v3" })
      );
      actionProviders.push(
        keeperStrategyActionProvider(getFloatV4KeeperAddress() as Address, {
          toolPrefix: "keeperStrategyV4",
          pipelineId: "v4",
        })
      );
    } else {
      console.log(
        `[AgentKit] toolProfile=chat — ${actionProviders.length} action providers (LiquidStratMinV4/Triton, CoinGecko, Demeter); Float/keeper/CDP tools omitted`
      );
    }

    const agentkit = await AgentKit.from({
      walletProvider,
      actionProviders,
    });

    if (signerMode === "cdp" && walletProvider instanceof CdpEvmWalletProvider) {
      const exportedWallet = await walletProvider.exportWallet();
      if (!walletData || !walletData.eoaAddress) {
        fs.writeFileSync(
          WALLET_DATA_FILE,
          JSON.stringify({
            eoaAddress: exportedWallet.address,
            walletSigner: "cdp",
          } as WalletData)
        );
      }
      console.log(`Using EOA account: ${exportedWallet.address} on network: ${walletProvider.getNetwork().networkId}`);
    } else {
      const addr = walletProvider.getAddress() as Address;
      if (!walletData?.eoaAddress || walletData.walletSigner !== "viem") {
        fs.writeFileSync(
          WALLET_DATA_FILE,
          JSON.stringify({ eoaAddress: addr, walletSigner: "viem" } as WalletData)
        );
      }
      console.log(`Using viem signer account: ${addr} on network: ${walletProvider.getNetwork().networkId}`);
    }

    return { agentkit, walletProvider };
  } catch (error) {
    console.error("Error initializing agent:", error);
    throw new Error("Failed to initialize agent");
  }
}
