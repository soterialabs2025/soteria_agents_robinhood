# context_length_exceeded (Demeter)

## Where this comes from

- **Trigger:** Demeter’s upkeep or harvest loop calls the LangGraph agent; the agent eventually calls the OpenAI API. The error is thrown by **OpenAI** when the request exceeds the model’s context limit (128k for gpt-4o-mini).
- **Call path:**
  1. **`app/services/demeter-agent.ts`** – `upkeepLoop()` (lines 115–120) or `harvestLoop()` (lines 202–214) calls `agent.invoke({ messages: [{ role: "user", content }] }, { configurable: { thread_id: "…" }, recursionLimit: 50 })`.
  2. **`app/api/agent/create-agent.ts`** – The agent is built with `createReactAgent()` from `@langchain/langgraph/prebuilt`, using `ChatOpenAI` (model: gpt-4o-mini). No message trimming is applied.
  3. The prebuilt graph runs a loop: **model → tool calls → tool results → model → …** Each step **appends** to the graph state’s `messages` array. When the graph invokes the LLM again, it sends **the entire** `messages` array to the API.
- **Token breakdown in the error:** ~624,491 tokens in **messages** (conversation), ~19,978 tokens in **functions** (tool schemas from `getLangChainTools(agentkit)`). Total ~644k > 128k limit.

## What is being sent

- **What we send initially:** A single short user message, e.g.  
  `"Call keeperStrategy_performUpkeep for strategy 1."` or  
  `"Call keeperStrategy_performHarvest for strategy 1 with skipIncreaseLiquidity=false."`
- **What the API actually receives when it fails:** The **full** `messages` array from the graph state at the next model turn. That array contains:
  - The initial user message (tiny).
  - A long **system** block from `messageModifier` in `create-agent.ts` (instructions, tool list, guidelines).
  - Then, for each turn: **assistant** message (with `tool_calls`) and **tool** messages (tool results). Tool results can be very large (e.g. transaction receipts, logs, token/pool data from CoinGecko, keeper/roulette responses). With `recursionLimit: 50`, many such turns can occur, so the array grows to hundreds of thousands of tokens and eventually exceeds 128k.

So the “message” that blows the limit is **the whole accumulated conversation** (user + system + all assistant/tool turns) in a **single** `invoke`, not a single user message.

## Purpose — and does it need to send all of it?

- **Purpose:** The prebuilt ReAct-style agent sends the full message history so the LLM can decide the **next** step (e.g. "I called performUpkeep; the tool returned success, I'm done" or "I need to call another tool"). The model must see the **latest** tool inputs and results to choose the next action or final answer. So some history is required.
- **Does it need to send *all* of it?** No. For a single upkeep or harvest we only need a short chain: user instruction, model's tool call, tool result, model's "done" (or one more tool). The agent does **not** need 50 turns or full raw payloads (entire receipts, full API responses). We only need the user message, system prompt, and **recent** assistant/tool turns; tool results can be **summarized** (e.g. "Tx 0x… succeeded") instead of full logs. So sending the entire unbounded history with full tool output is **more than necessary** — trimming (e.g. last N messages or last 80k tokens) and smaller tool returns would still let the model finish the task.

## Mitigations

- **Reduce recursion:** Lower `AGENT_RECURSION_LIMIT` in `demeter-agent.ts` (e.g. to 15–20) so the agent cannot add as many tool rounds.
- **Trim messages:** If the prebuilt agent supports a `preModelHook` or similar, use it to trim `state.messages` to a token budget (e.g. last 80k tokens) before each LLM call; or adopt an agent setup that trims/summarizes history.
- **Shrink tool outputs:** Ensure tools return concise summaries (e.g. “Tx submitted: 0x…”) instead of full receipts/logs when possible.

---

## Raw log (for reference)

0|demeter  | 2026-03-02 23:56:18 +00:00:   },
0|demeter  | 2026-03-02 23:56:18 +00:00:   request_id: 'req_869251728e9f416989979720d83e6b55',
0|demeter  | 2026-03-02 23:56:18 +00:00:   error: {
0|demeter  | 2026-03-02 23:56:18 +00:00:     message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 644469 tokens (624491 in the messages, 19978 in the functions). Please reduce the length of the messages or functions.",
0|demeter  | 2026-03-02 23:56:18 +00:00:     type: 'invalid_request_error',
0|demeter  | 2026-03-02 23:56:18 +00:00:     param: 'messages',
0|demeter  | 2026-03-02 23:56:18 +00:00:     code: 'context_length_exceeded'
0|demeter  | 2026-03-02 23:56:18 +00:00:   },
0|demeter  | 2026-03-02 23:56:18 +00:00:   code: 'context_length_exceeded',
0|demeter  | 2026-03-02 23:56:18 +00:00:   param: 'messages',
0|demeter  | 2026-03-02 23:56:18 +00:00:   type: 'invalid_request_error',
0|demeter  | 2026-03-02 23:56:18 +00:00:   attemptNumber: 1,
0|demeter  | 2026-03-02 23:56:18 +00:00:   retriesLeft: 6,
0|demeter  | 2026-03-02 23:56:18 +00:00:   pregelTaskId: '0580df89-88b8-58ac-b0dd-2b7055d8f688'
0|demeter  | 2026-03-02 23:56:18 +00:00: }
