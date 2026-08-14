import type { WalletProvider } from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { MemorySaver } from "@langchain/langgraph";import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { prepareAgentkitAndWalletProvider } from "./prepare-agentkit";
import { LIQUID_STRAT_MIN_V4_ADDRESS } from "../../config/triton-config";

/** OpenAI chat completions cap for `tools` array length. */
const MAX_OPENAI_TOOLS = 128;

/** AgentKit-langchain may emit duplicate tool entries (one per action provider). */
function dedupeLangChainTools<T extends { name: string }>(tools: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}

/**
 *
 * This file handles the core configuration of your AI agent's behavior and capabilities.
 *
 * Key Steps to Customize Your Agent:
 *
 * 1. Select your LLM:
 *    - Modify the `ChatOpenAI` instantiation to choose your preferred LLM
 *    - Configure model parameters like temperature and max tokens
 *
 * 2. Instantiate your Agent:
 *    - Pass the LLM, tools, and memory into `createReactAgent()`
 *    - Configure agent-specific parameters
 */

// The agent
let agent: ReturnType<typeof createReactAgent>;

/** Wallet provider used by the agent (set when createAgent runs). Used by Demeter to call changeStrategyAsset directly. */
let walletProvider: WalletProvider | null = null;

/** Returns the wallet provider after {@link initDemeterWalletProvider} or createAgent(). */
export function getWalletProvider(): WalletProvider | null {
  return walletProvider;
}

/** Sets the global wallet for Demeter loops without initializing the LangGraph agent (no OpenAI tools). */
export function initDemeterWalletProvider(wp: WalletProvider): void {
  walletProvider = wp;
}

/**
 * Initializes and returns an instance of the AI agent.
 * If an agent instance already exists, it returns the existing one.
 *
 * @function getOrInitializeAgent
 * @returns {Promise<ReturnType<typeof createReactAgent>>} The initialized AI agent.
 *
 * @description Handles agent setup
 *
 * @throws {Error} If the agent initialization fails.
 */
export async function createAgent(): Promise<ReturnType<typeof createReactAgent>> {
  // If agent has already been initialized, return it
  if (agent) {
    return agent;
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      "OPENAI_API_KEY is not set. Local: add to .env. Amplify: App settings → Environment variables, then redeploy (see amplify.yml)."
    );
  }

  const { agentkit, walletProvider: wp } = await prepareAgentkitAndWalletProvider({
    toolProfile: "chat",
  });
  walletProvider = wp;

  try {
    // Initialize LLM: https://platform.openai.com/docs/models#gpt-4o
    const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

    const tools = dedupeLangChainTools(await getLangChainTools(agentkit));
    if (tools.length > MAX_OPENAI_TOOLS) {
      throw new Error(
        `Agent has ${tools.length} unique tools (OpenAI max ${MAX_OPENAI_TOOLS}). Reduce action providers in prepare-agentkit chat profile.`
      );
    }
    console.log(`[AgentKit] Chat agent tools: ${tools.length} unique/${MAX_OPENAI_TOOLS}`);
    const memory = new MemorySaver();

    const systemPrompt = `
        You are Demeter, focused on **LiquidStratMinV4** (Triton "Liquid" strategy) on Robinhood Chain at ${LIQUID_STRAT_MIN_V4_ADDRESS}.

        **Liquid / Triton holdings (always use this first):**
        - "What token is Liquid holding?", "what is Triton holding?", "Liquid position" → call **liquidStratMinV4_getStatus** (reads on-chain ASSET() = token actually held; WETH = offensive parking). Status includes heldAssetName (e.g. grantr).
        - "What is the price of grantr?" → **liquidStratMinV4_getTokenPrice** with token name (not address)
        - "Change to grantr" / "rotate to nook" → **liquidStratMinV4_changeAsset** with token: "grantr"
        - "Exit when up 10%" / "sell if down 3%" → **liquidStratMinV4_setPositionRules** (TP/SL apply to **any held asset**, not one token name); first **liquidStratMinV4_setTieredDefensiveExits** enabled:false so tiered rules don't override custom exits
        - "Sell in 1 hour" / "exit to WETH in 30 minutes" → **liquidStratMinV4_scheduleExit** (delayMinutes / delayHours)
        - "Rotate to nook in 10 minutes" → **liquidStratMinV4_scheduleRotate** with token + delay
        - **liquidStratMinV4_getScheduledAction** / **liquidStratMinV4_clearScheduledAction** — view or cancel pending timed trade
        - **liquidStratMinV4_setTieredDefensiveExits** enabled:true|false — start/stop HIGH/MEDIUM/LOW tiered defensive exits in Triton loop
        - **liquidStratMinV4_listTokens** — all V4 token names
        - **liquidStratMinV4_compareTokens** rankingMode "offensive" → best offensive V4 token; rankingMode "default" → best default/defensive token
        - **liquidStratMinV4_getDefensiveExitRules** — tiered on/off + rule thresholds + active custom rules
        - **liquidStratMinV4_getPositionRules** — custom chat exit rules currently saved

        **CoinGecko:** coingecko_getTokenPrice also works with addresses; prefer liquidStratMinV4_getTokenPrice for named V4 tokens

        **Demeter service (Float keeper loops — not Liquid rotation):**
        - demeter_getConfig / demeter_updateConfig — intervals and ranking weights
        - demeter_startLoops / demeter_stopLoops — continuous loops (disabled locally when DEMETER_LOOPS_ENABLED=false or NODE_ENV=development; production EC2 runs them)
        - demeter_runCycle — one Float keeper cycle on demand

        Do NOT use Float float_* tools unless the user explicitly asks about Float V3/V4 keeper strategies (not available in chat profile).

        When including Robinhood Chain explorer links use https://robinhoodchain.blockscout.com/ (never etherscan.io).
        If there is a 5XX HTTP error, retry once.
        `;
    agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: memory,
      /** Plain string prompt — async trimMessages breaks in Next production bundle. */
      prompt: systemPrompt,
    });

    return agent;
  } catch (error) {
    console.error("Error initializing agent:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize agent: ${errorMessage}`);
  }
}
