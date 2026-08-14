# Demeter Agent Implementation Summary

## What Was Built

I've created an AI-powered agent system (Demeter) that replaces the simple `index.js` bot with intelligent decision-making capabilities. The agent uses OpenAI's GPT-4o-mini model to make decisions about when to perform upkeep and harvest operations on RouletteStrategy contracts.

## Files Created

### 1. Action Providers

#### `app/action-providers/coingecko-action-provider.ts`
- **Purpose**: Fetches cryptocurrency prices from CoinGecko API
- **Actions**:
  - `getCoinPrice`: Get price for a single coin (TERMS, WETH, etc.)
  - `getMultipleCoinPrices`: Get prices for multiple coins at once
- **Usage**: Agent uses this to get TERMS/WETH prices before making decisions

#### `app/action-providers/keeper-strategy-action-provider.ts`
- **Purpose**: Interacts with the StrategyKeeper contract
- **Actions**:
  - `performUpkeep`: Check and fix position issues (out of range, token composition)
  - `performHarvest`: Collect fees and optionally compound them
  - `getStrategiesLength`: Validate strategy IDs
- **Usage**: Agent uses this to perform the actual contract operations

### 2. Main Agent Service

#### `app/services/demeter-agent.ts`
- **Purpose**: Main service that runs Demeter continuously
- **Features**:
  - Two parallel loops: upkeep (every 30s) and harvest (every 6 hours)
  - Uses AI agent to make intelligent decisions
  - Replaces the logic from `index.js`
  - PM2-compatible for production deployment

### 3. Configuration Files

#### `ecosystem.config.cjs`
- PM2 configuration for running Demeter in production
- Handles logging, auto-restart, and resource limits

#### Updated `app/api/agent/prepare-agentkit.ts`
- Added CoinGecko and KeeperStrategy action providers
- Conditionally loads KeeperStrategy provider if `KEEPER_ADDRESS` is set

#### Updated `app/api/agent/create-agent.ts`
- Updated agent prompt to specialize Demeter for RouletteStrategy management
- Includes decision-making guidelines and best practices

### 4. Documentation

#### `docs/DEMETER_AGENT.md`
- Complete setup and usage guide
- Troubleshooting section
- Comparison with old `index.js` approach

## Key Features

### AI-Powered Decision Making
- **Price Awareness**: Gets TERMS/WETH prices from CoinGecko before decisions
- **Gas Optimization**: Considers gas prices when deciding harvest parameters
- **Adaptive Behavior**: Learns from market conditions and adjusts strategy

### Intelligent Upkeep
- Checks prices before deciding if upkeep is needed
- Only calls `performUpkeep()` when conditions warrant it
- Handles multiple strategies independently

### Smart Harvesting
- Decides whether to compound fees (`skipIncreaseLiquidity=false`) or just collect (`skipIncreaseLiquidity=true`)
- Considers gas costs and market conditions
- Respects `minHarvestDelay` from the contract

## Environment Variables Required

```bash
# AgentKit/CDP
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
NETWORK_ID=base-mainnet
RPC_URL=...

# OpenAI
OPENAI_API_KEY=...

# Keeper Configuration
KEEPER_ADDRESS=0x...
STRATEGY_IDS=0,1,2

# Optional Timing
POLL_MS=30000
HARVEST_INTERVAL_MS=21600000
```

## Running the Agent

### Development
```bash
npm run demeter
```

### Production (PM2)
```bash
npm run demeter:pm2
# or
pm2 start ecosystem.config.cjs
```

## Differences from index.js

| Aspect | index.js (Old) | Demeter (New) |
|--------|---------------|---------------|
| **Decision Logic** | Always calls functions | AI decides when needed |
| **Price Data** | None | CoinGecko integration |
| **Gas Optimization** | Fixed 30% buffer | AI optimizes dynamically |
| **Error Handling** | Basic retries | Intelligent recovery |
| **Adaptability** | Static behavior | Learns from conditions |

## Next Steps

1. **Install dependencies**: `npm install` (tsx will be added)
2. **Configure environment**: Add all required env vars
3. **Test in development**: Run `npm run demeter` to test
4. **Deploy with PM2**: Use `npm run demeter:pm2` for production
5. **Monitor**: Use `pm2 logs demeter` to watch agent decisions

## Architecture Flow

```
Demeter Agent Service
├── Upkeep Loop (every 30s)
│   └── AI Agent decides → CoinGecko prices → performUpkeep()
│
└── Harvest Loop (every 6h)
    └── AI Agent decides → Gas prices → performHarvest()
```

Both loops run in parallel and use the same AI agent instance, which has access to:
- CoinGecko API (price data)
- KeeperStrategy contract (upkeep/harvest)
- Wallet provider (transaction execution)
- Other AgentKit tools (ERC20, wallet, etc.)

## Integration Points

The agent integrates with:
1. **CoinGecko API**: For TERMS/WETH price data
2. **StrategyKeeper Contract**: For performing upkeep and harvest
3. **RouletteStrategy Contract**: Managed through KeeperStrategy
4. **CDP Wallet Provider**: For executing transactions
5. **OpenAI API**: For AI decision-making

All of these are abstracted through AgentKit action providers, making the agent extensible and maintainable.

