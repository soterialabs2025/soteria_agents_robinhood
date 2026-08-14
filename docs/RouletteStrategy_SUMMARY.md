# RouletteStrategy Contract Summary for Keeper Optimization

## Overview
`RouletteStrategy` manages a Uniswap V3 concentrated liquidity position for an asset/WETH pair (asset set via RouletteContractManager). It operates in three modes (**NORMAL**, **DEFENSIVE**, **OFFENSIVE**) and requires keeper monitoring to maintain optimal position efficiency.

## Key State Variables (Keeper-Relevant)

### Position State
- `liqPos.positionId` (uint256): Uniswap V3 NFT position ID. If 0, no position exists.
- `mode` (enum): `NORMAL` (active position), `DEFENSIVE` (no position, waiting for recovery), or `OFFENSIVE` (price above range, rebalancing path)
- `baselineTick` (int24): Reference tick for defensive recovery tracking
- `inRangeSince` (uint256): Timestamp when price entered recovery range (used for defensive recovery)
- `baseTokenShareBps` (uint256): Baseline asset token share (basis points) of position value
- `consecutiveOffensiveCount` (uint256): Number of consecutive times upkeep returned OFFENSIVE. Demeter uses this (e.g. when count === 2) to trigger a strategy asset change to the next-best token.
- `lastRebalanceTime` (uint256): Timestamp of last rebalance
- `UniswapFeesCollected` (uint256): Cumulative Uniswap fees collected (WETH value at collection time)
- `balanceOfIdle()` (view): Total value of idle asset + WETH held in the strategy (not in the position)

### Configuration Parameters (from StrategyManager)
- `deviationBands`: Thresholds for token composition deviation (`lowerBps`, `upperBps`, `maxTokenCapBps`)
- `recoveryRange` (int24): Tick range for defensive recovery (default: 150 ticks)
- `minHarvestDelay` (uint256): Minimum time between harvests (e.g. 30 minutes)
- `offensiveTargetAssetBps` (uint256): Target asset share when rebalancing from OFFENSIVE
- `startM` (int8): Position width multiplier for new positions
- `tickSpacing` (int24): Uniswap V3 tick spacing

## Critical Functions for Keepers

### 1. `keeperCheck() external returns (bool)`
**Purpose**: Primary keeper check. Returns `true` if action is needed.

**Logic**:
- If `mode == DEFENSIVE`: Always returns `true` (needs monitoring for recovery)
- Otherwise:
  - `_checkInRange()`: If out of range, decreases liquidity and may enter DEFENSIVE or OFFENSIVE
  - `_checkTokenShare()`: If token composition deviates beyond bands, may enter DEFENSIVE
  - Returns `true` if either check did work or mode became DEFENSIVE

**When to call**: Regularly (via RouletteKeeper `performUpkeep()` / `performUpkeepBatch()`)

### 2. `recordDefensiveTick() external`
**Purpose**: Records current tick for defensive recovery monitoring.

**Logic**:
- Requires `mode == DEFENSIVE` (reverts if not)
- If baseline is set: checks if current tick is within `baselineTick ± recoveryRange`
- If within range and stable long enough: recovers (mints new position, mode = NORMAL)
- If outside range: resets baseline and `inRangeSince`

**When to call**: When `keeperCheck()` returns `true` and strategy is in DEFENSIVE mode

### 3. `harvestBoolean(bool skipIncreaseLiquidity) external returns (uint256)`
**Purpose**: Collects Uniswap fees and optionally reinvests them.

**Logic**:
- Respects `minHarvestDelay`
- Collects fees; updates `UniswapFeesCollected`
- If `skipIncreaseLiquidity == false` and `mode == NORMAL`: balances tokens and adds liquidity to position
- Returns new total assets

**When to call**: Regularly (via RouletteKeeper `performHarvest()`) to compound fees

### 4. `readInRange() external view returns (bool)`
**Purpose**: View to check if position is currently in range.

**Logic**: Returns `false` if DEFENSIVE; otherwise result of `_inRange()` (pool tick within position bounds).

## Mode Lifecycle

### NORMAL (Active Position)
- Position exists and is in range; token composition within deviation bands.

**Transitions out of NORMAL**:
- **Out of range**: Pool tick leaves position range → liquidity decreased → **OFFENSIVE** (if tick >= upper) or **DEFENSIVE** (if below).
- **Token share deviation**: Asset share outside bands → liquidity decreased → DEFENSIVE or OFFENSIVE by tick.

### DEFENSIVE (No Position)
- No position; tokens idle. `consecutiveOffensiveCount` is reset to 0 when entering DEFENSIVE.
- Recovery: keeper calls `recordDefensiveTick()`; after price stable in recovery range, strategy mints new position and returns to NORMAL.

### OFFENSIVE (Price Above Range)
- Entered when pool tick >= position upper tick after decreasing liquidity. `consecutiveOffensiveCount` is incremented.
- Strategy rebalances to `offensiveTargetAssetBps`, mints new position; on success returns to NORMAL and resets `consecutiveOffensiveCount`.
- **Demeter**: When `consecutiveOffensiveCount === 2` (configurable), Demeter runs a change-strategy flow (token comparison → RouletteContractManager.changeStrategyAsset(next-best asset)) so the strategy can switch to a different asset.

## Integration with RouletteKeeper and Demeter

- **RouletteKeeper** (abi: `abi/RouletteKeeper.json`):
  - `performUpkeep(id)` / `performUpkeepBatch(ids)`: Calls strategy `keeperCheck()`; if DEFENSIVE, keeper can call `recordDefensiveTick()` (handled by contract flow).
  - `performHarvest(id, skipIncreaseLiquidity)`: Calls strategy `harvestBoolean(skipIncreaseLiquidity)`.
- **Demeter** uses `roulette_getStrategyStats` (RouletteContractManager + RouletteStrategy) to read `mode`, `consecutiveOffensiveCount`, `balanceOfPool`, `poolValue`, `balanceOfIdle`, `UniswapFeesCollected`, etc. When mode is DEFENSIVE or OFFENSIVE with count at threshold, Demeter calls RouletteContractManager `changeStrategyAsset(newAssetAddr)` with the next-best token from the comparison list (excluding WETH).

## Events to Monitor

- `StrategyEvent(0, ...)`: Contract setup
- `StrategyEvent(1, ...)`: Deposit completed
- `StrategyEvent(3, ...)`: Harvest completed
- `StrategyEvent(4, ...)`: New position minted (tickLower, tickUpper)
- `StrategyEvent(11, ...)`: Rebalance from OFFENSIVE (positionId, offensiveTargetAssetBps, 0)

## Notes

1. **Authorization**: Only authorized addresses (vault, demeter, keeper, manager, owner) can call restricted functions.
2. **Reentrancy**: State-changing functions use `nonReentrant`.
3. **Pausable**: Strategy can be paused, blocking deposits/harvests.
4. **Fees**: Single cumulative field `UniswapFeesCollected` (no separate token0/token1 fields).
5. **Idle balance**: Use `balanceOfIdle()` for value of tokens not currently in the Uniswap position.
