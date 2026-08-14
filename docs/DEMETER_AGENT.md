# Demeter Agent - AI-Powered Keeper for RouletteStrategy

## Overview

Demeter is an AI agent that replaces the simple bot (`index.js`) with intelligent decision-making for managing RouletteStrategy Uniswap V3 concentrated liquidity positions. It uses OpenAI's GPT-4o-mini model to make decisions based on:

- Current market prices from CoinGecko API
- Pool token composition
- Gas prices
- Position efficiency metrics

## Architecture

### Components

1. **CoinGecko Action Provider** (`app/action-providers/coingecko-action-provider.ts`)
   - Fetches cryptocurrency prices from CoinGecko API
   - Provides `getCoinPrice` and `getMultipleCoinPrices` actions

2. **KeeperStrategy Action Provider** (`app/action-providers/keeper-strategy-action-provider.ts`)
   - Interacts with the StrategyKeeper contract
   - Provides `performUpkeep`, `performHarvest`, and `getStrategiesLength` actions

3. **Demeter Agent Service** (`app/services/demeter-agent.ts`)
   - Main service that runs the agent
   - Replaces `index.js` with AI-powered decision making
   - Runs two parallel loops: upkeep and harvest

## Setup

### Environment Variables

Add these to your `.env` file:

```bash
# Required for AgentKit
CDP_API_KEY_ID=your-api-key-id
CDP_API_KEY_SECRET=your-api-key-secret
CDP_WALLET_SECRET=your-wallet-secret
NETWORK_ID=base-mainnet  # or your network
RPC_URL=your-rpc-url

# Required for OpenAI
OPENAI_API_KEY=your-openai-api-key

# Required for Keeper
KEEPER_ADDRESS=0x...  # StrategyKeeper contract address
STRATEGY_IDS=0,1,2    # Comma-separated strategy IDs

# Optional - timing configuration
POLL_MS=30000                    # Upkeep polling interval (default: 30 seconds)
HARVEST_INTERVAL_MS=21600000     # Harvest interval (default: 6 hours)
```

### Installation

```bash
npm install
```

## Running Demeter

### Development Mode

```bash
npm run demeter
```

### Production with PM2

```bash
# Install PM2 globally if not already installed
npm install -g pm2

# Start Demeter
npm run demeter:pm2

# Or directly:
pm2 start ecosystem.config.cjs

# Monitor logs
pm2 logs demeter

# Check status
pm2 status

# Stop Demeter
pm2 stop demeter

# Restart Demeter
pm2 restart demeter
```

## How It Works

### Upkeep Loop

- Runs continuously, polling every `POLL_MS` milliseconds (default: 30 seconds)
- For each strategy ID:
  1. AI agent checks current TERMS/WETH prices from CoinGecko
  2. AI agent decides if upkeep is needed
  3. Calls `performUpkeep()` on the KeeperStrategy contract if needed
  4. The contract handles out-of-range positions and token composition issues

### Harvest Loop

- Runs in parallel, executing every `HARVEST_INTERVAL_MS` (default: 6 hours)
- For each strategy ID:
  1. AI agent checks gas prices and current market conditions
  2. AI agent decides whether to skip liquidity increase (gas optimization)
  3. Calls `performHarvest()` with the optimal parameters
  4. Fees are collected and optionally compounded back into the position

## AI Decision Making

The agent uses natural language instructions to make decisions:

- **Price Monitoring**: Gets TERMS/WETH prices before making decisions
- **Gas Optimization**: Considers gas prices when deciding harvest parameters
- **Risk Management**: Monitors volatility and adjusts behavior accordingly
- **Efficiency**: Proactively maintains positions to maximize fee generation

## Differences from index.js

| Feature | index.js (Old) | Demeter (New) |
|---------|---------------|---------------|
| Decision Making | Always calls upkeep/harvest | AI decides when actions are needed |
| Price Awareness | None | Uses CoinGecko for price data |
| Gas Optimization | Fixed logic | AI optimizes based on conditions |
| Adaptability | Static | Learns and adapts to market conditions |
| Error Handling | Basic retries | Intelligent error recovery |

## Monitoring

### Logs

Logs are written to:
- `./logs/demeter-out.log` - Standard output
- `./logs/demeter-error.log` - Errors

### PM2 Monitoring

```bash
# Real-time logs
pm2 logs demeter

# Resource usage
pm2 monit

# Detailed info
pm2 describe demeter
```

## Troubleshooting

### Agent Not Starting

1. Check all environment variables are set
2. Verify CDP API keys are valid
3. Ensure OpenAI API key is valid
4. Check RPC URL is accessible

### Transactions Failing

1. Verify wallet has sufficient balance for gas
2. Check network configuration matches contract deployment
3. Ensure KEEPER_ADDRESS is correct
4. Verify strategy IDs are valid

### High Gas Costs

- The agent will automatically optimize gas usage
- Consider adjusting `HARVEST_INTERVAL_MS` to harvest less frequently
- The agent can use `skipIncreaseLiquidity=true` to reduce gas costs

## Next Steps

- Add more sophisticated price analysis
- Implement position efficiency metrics
- Add alerting for critical events
- Create dashboard for monitoring agent decisions

