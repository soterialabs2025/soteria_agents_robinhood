
Here's how the Demeter agent works and how to run it:

## How to start the main jobs

Run Demeter **without** `--coingecko`:

```bash
npm run demeter
```

That starts all loops in parallel (intervals from app/config/demeter-config.ts):
1. **Upkeep loop** – `keeperStrategy_performUpkeep` every `DEFAULT_POLL_MS`
2. **Harvest loop** – `keeperStrategy_performHarvest` every `DEFAULT_HARVEST_INTERVAL_MS`
3. **Change strategy loop** – `fetchTokenComparison` → top-ranked token → changeStrategyAsset every `DEFAULT_CHANGE_STRATEGY_INTERVAL_MS`
4. **Price check loop** – m30 price check every `DEFAULT_PRICE_CHECK_INTERVAL_MS`; triggers change strategy if drop ≤ `DEFAULT_PRICE_DROP_THRESHOLD_PCT`%

## Modes

| Command | Behavior |
|--------|----------|
| `npm run demeter` | Main mode: keeper + harvest + changeStrategy loops (continuous) |
| Chat: "Start demeter" or "Run demeter" | Starts the continuous loops via `demeter_startLoops` (same as npm run demeter) |
| Chat: "Stop demeter" or "Stop demeter loops" | Stops the loops via `demeter_stopLoops` (shuts down within a few seconds) |
| Chat: "Run one cycle" | One pass on demand via `demeter_runCycle` |
| `npm run demeter:coingecko` | Fetches token data only, then exits |
| `npm run demeter:coingecko:compare` | Fetches comparison + weighted ranking, then exits |

## Config (app/config/demeter-config.ts)

- `DEFAULT_KEEPER_ADDRESS` – RouletteKeeper contract address  
- `DEFAULT_STRATEGY_IDS` – e.g. `"1"` or `"0,1,2"`  
- `DEFAULT_NETWORK_ID` – e.g. `base-mainnet`  
- `DEFAULT_POLL_MS` – upkeep interval (e.g. 2 min)  
- `DEFAULT_HARVEST_INTERVAL_MS` – harvest interval (e.g. 4 hours)  
- `DEFAULT_CHANGE_STRATEGY_INTERVAL_MS` – scheduled change strategy interval (e.g. 12 hours)  
- `DEFAULT_PRICE_CHECK_INTERVAL_MS` – price check interval (e.g. 30 min)  
- `DEFAULT_PRICE_DROP_THRESHOLD_PCT` – trigger change strategy when m30 price change ≤ this (e.g. -6)  

## Required env vars (main mode)

- `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` – for AgentKit  
- `RPC_URL` – Base RPC endpoint  
- `OPENAI_API_KEY` – for the agent  

RouletteContractManager address is set in `app/config/demeter-config.ts` (`ROULETTE_CONTRACT_MANAGER_ADDRESS`); it is not read from env.

The change strategy loop uses `fetchTokenComparison` internally; you don’t run that separately.