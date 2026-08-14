# Summary: index.js KeeperStrategy Agent

## Overview
This is an automated keeper/agent bot that monitors and maintains multiple DeFi strategies through a `StrategyKeeper` smart contract. It runs two parallel loops: a continuous upkeep loop and a periodic harvest loop.

## Architecture

### Contract Interaction
- **Contract**: `StrategyKeeper` (address from `KEEPER_ADDRESS` env var)
- **ABI Methods Used**:
  - `performUpkeep(uint256 id)` - Main upkeep function called periodically
  - `performHarvest(uint256 id, bool skipIncreaseLiquidity)` - Harvest function called every 6 hours
  - `strategiesLength()` - View function to validate strategy IDs

### Configuration
- **Environment Variables**:
  - `KEEPER_ADDRESS` - Address of the StrategyKeeper contract
  - `STRATEGY_IDS` - Comma-separated list of strategy IDs to monitor (e.g., "0,1,2")
  - `RPC_URL` - Ethereum RPC endpoint
  - `PRIVATE_KEY` - Private key of the keeper wallet
  - `POLL_MS` - Polling interval in milliseconds (default: 30000 = 30 seconds)
  - `MAX_RETRIES` - Maximum retry attempts for transactions (default: 3)

### Core Components

#### 1. KeeperStrategyManager Class
Each strategy ID gets its own manager instance that handles:

- **Validation**: `ensureKeeperDeployed()` - Verifies the keeper contract exists and validates the strategy ID is within range
- **Upkeep**: `performUpkeep()` - Calls the keeper's `performUpkeep(id)` function
- **Harvest**: `performHarvest(skipIncreaseLiquidity)` - Calls the keeper's `performHarvest(id, skipIncreaseLiquidity)` with gas estimation

#### 2. Main Upkeep Loop (`mainLoop`)
- Runs continuously, polling every `POLL_MS` milliseconds (default: 30 seconds)
- For each strategy ID:
  - Calls `performUpkeep()` unconditionally
  - The keeper contract internally decides if any action is needed
  - Includes 1-second delay between strategy calls to avoid RPC rate limits
- Error handling: Continues processing other strategies even if one fails

#### 3. Harvest Loop (`harvestLoop`)
- Runs in parallel with the upkeep loop (separate async function)
- Executes every **6 hours** (`HARVEST_INTERVAL_MS = 6 hours`)
- For each strategy ID:
  - Calls `performHarvest(false)` - with `skipIncreaseLiquidity = false`
  - Includes 1-second delay between harvest calls

### Transaction Handling

#### Gas Management
- **Upkeep transactions**: Uses automatic gas estimation with 10% buffer on fees
- **Harvest transactions**: Explicit gas estimation with 30% buffer:
  1. Estimates gas using `estimateGas()`
  2. Adds 1.3x buffer (30% increase)
  3. Sends transaction with explicit `gasLimit`

#### Retry Logic
- Uses `p-retry` library with `MAX_RETRIES` attempts
- Transient failures are retried automatically
- Failed attempts are logged with warnings

#### Timeout Handling
- Transaction confirmation timeout: **2 minutes** (120,000ms)
- If timeout occurs:
  - Logs a warning
  - Continues processing (doesn't throw error to avoid unnecessary retries)
  - Transaction continues to confirm in the background

### Flow Summary

1. **Initialization**:
   - Parses `STRATEGY_IDS` from env (comma-separated numbers)
   - Creates `KeeperStrategyManager` instance for each ID
   - Validates keeper contract exists and all IDs are valid

2. **Parallel Execution**:
   - **Upkeep Loop** (continuous): Polls every 30s (or `POLL_MS`), calls `performUpkeep()` for all strategies
   - **Harvest Loop** (periodic): Waits 6 hours, then calls `performHarvest(false)` for all strategies

3. **Error Isolation**:
   - Each strategy's operations are wrapped in try-catch
   - Failures in one strategy don't block others
   - Errors are logged but don't crash the process

### Key Design Decisions

- **Unconditional upkeep calls**: The agent always calls `performUpkeep()`, letting the smart contract decide if action is needed
- **Separate harvest loop**: Harvest operations run on a different schedule (6 hours) than upkeep (30 seconds)
- **Gas estimation for harvest**: Harvest transactions explicitly estimate and set gas limits to avoid out-of-gas errors
- **Sequential processing**: Strategies are processed one at a time to avoid nonce conflicts and RPC rate limits
- **Background execution**: Harvest loop runs as a separate async function, independent of the main loop

### Monitoring
All operations are logged with timestamps and strategy IDs:
- `[keeper:{ADDRESS} id:{ID}]` prefix for all logs
- Transaction hashes for tracking
- Block numbers for confirmation
- Gas estimates and limits for harvest operations

