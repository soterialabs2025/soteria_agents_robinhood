# Handoff: Adaptive `targetAssetBps` (RH → other agent)

Copy this into the Base (or other-chain) agent. RH source of truth:

- `app/services/auto-adaptive-target.ts` — mix, step, operator write
- `app/services/auto-adaptive-band.ts` — `targetOffset` in the same JSON as `bandOffset`; write-before-upkeep
- `app/config/auto-keeper-config.ts` — `AUTO_ADAPTIVE_TARGET` + `AUTO_TARGET_*`
- `app/services/auto-keeper-loop.ts` — remint path writes target **before** `performUpkeepBatch`

Harvest **never** reads or writes `targetAssetBps`. The write only matters on the next remint or deposit.

## Why

The agent does not pick a trend. It measures the mix remint would flatten (`_balanceTokens` leftover) and moves the flatten-point toward that mix so remint stops buying the dump / selling the dump.

```text
skew = mixBps - 5000
|skew| < 1200  → 5000
skew > 0       → 7000   leftover is ASSET; don't sell it back
skew < 0       → 3000   leftover is WETH; don't buy ASSET back
```

That is token-order safe. V4 leftover ETH → mix &lt; 5000 → 3000. V3 leftover CASHCAT → mix &gt; 5000 → 7000.

## Contract (all Auto stacks)

```text
strategy.setTargetAssetBps(uint256 bps)   // operator or owner; no cap, no event
strategy.targetAssetBps() view
```

Clamp in the agent. The setter accepts `0` (all WETH) or `>10000` (all ASSET). Read `targetAssetBps()` after send — there is no event.

Signed by a registered operator (same shard pool as remint). Owner still works. Do not skip because `strategy.owner()` is a different EOA.

**Do not change `reserveBps`.** Empty V4 reserve is remints consuming inventory.

## Env

```bash
AUTO_ADAPTIVE_TARGET=true          # default on when an operator or Owner key is present
AUTO_TARGET_BASE_BPS=5000
AUTO_TARGET_STEP_BPS=2000          # stacks: 3000 / 5000 / 7000
AUTO_TARGET_MIN_BPS=3000
AUTO_TARGET_MAX_BPS=7000
AUTO_TARGET_DEADBAND_BPS=1200
AUTO_TARGET_MIN_IDLE_WEI=1000000000000000   # 1e15; ignore dust leftover
```

Prefer the keeper operator keys (`DEMETER_*` / `TRITON_*`). Owner key (`AUTO_BAND_OWNER_ADDRESS` as a 32-byte key, or `RH_DEPLOYER_KEY` / `AUTO_BAND_OWNER_KEY`) is fallback only.

## Persist

Same file as bands: `logs/auto-adaptive-band-state.json`.

```ts
targetOffset: -1 | 0 | 1    // 3000 / 5000 / 7000
lastTargetWriteMs: number
```

Restarts must not flip 3000→7000 in one shot. One step per remint, or restore to 5000 on quiet. Reject writes where `|desired - onChain| != STEP` unless restoring to 5000.

## Mix (what remint would swap)

```text
deployableAsset = ASSET.balanceOf(strat) - reservedAsset
deployableWeth  = wethBal - reservedWeth
  V3 wethBal = WETH.balanceOf(strategy)
  V4 wethBal = strategy.balance          // native; not aeWETH

If (priced deployable) < AUTO_TARGET_MIN_IDLE_WEI:
    use balanceOfPool() (assetAmt, wethAmt)   // leftover is still in the LP

Price ASSET in WETH from poolValue − poolWeth over poolAsset
  (same NAV units the strategy uses).

mixBps = 10000 * assetValue / (assetValue + wethValue)
```

Optional side check (`lastBandBaseTick` + inner widths + V4 `refTick` / V3 pool `slot0`). If side and mix disagree, **trust mix** and log.

## Skip / fail-closed

- no registered operator (and no Owner key fallback)
- `hasBandBase == false` (no mint yet)
- V3 `poolValueTwap() == 0` (spot off TWAP; remint would skip the swap)
- `poolValue` below harvest dust tier (default 0.05 ETH)
- on-chain already equals the step we would write
- jump that is not ±STEP and not restore to 5000

## Loop placement

```text
upkeep tick
  → simulate keeperCheck
  → remint ring buffer
  → if remint-true:
        maybe setTargetAssetBps     // FIRST (operator, await confirm)
        then performUpkeepBatch     // remint sees new target

band loop (5 min)
  → widen / tighten / restore bands
  → setBandParams if needed
  → same pass: recompute desired target; write only if remint since last write
       or quiet restore

harvest loop
  → do not write target
```

Do **not** change target on every 5 min wake. Restore to 5000 when there has been **no remint for one harvest interval** and `|mix − 5000| < deadband` — same quiet clock as band tighten.

Target and remint use the same shard operator address queue: `setTargetAssetBps` then `performUpkeep`. Owner is only a fallback if no operator keys are configured.

## Couple to bands, lightly

Same pass is fine; do not require both to move.

- Frequent remints → widen (existing) **and** step target toward that leftover.
- Quiet → tighten band **and** restore target to 5000.
- Remint while tightened → band back to 0 (existing). Leave target until mix says otherwise; do not slam 5000 on the remint that just proved the trend.

## RH vs Base

Both chains use one `setBandParams` signed by a registered operator (Owner still allowed). Copy RH target + band apply as-is.

| Item | Robinhood (this repo) | Base / other |
|------|------------------------|--------------|
| Band apply | one `setBandParams` | one `setBandParams` |
| Target apply | `setTargetAssetBps` | `setTargetAssetBps` |
| V4 WETH idle | `strategy.balance` (native) | confirm native vs WETH |
| V3 TWAP skip | `poolValueTwap()==0` | same if the view exists |
| Price-ref | ≥10 min (`minRefUpdateInterval`) | Base may differ |

## Checklist for the other agent

1. ABI has `setTargetAssetBps` / `targetAssetBps` / `reservedAsset` / `reservedWeth` / `balanceOfPool` / `poolValue` / `hasBandBase`.
2. Persist `targetOffset` next to `bandOffset`.
3. Write in band loop + immediately before remint. Harvest untouched.
4. Clamp to 3000/5000/7000. Read back after send.
5. `AUTO_ADAPTIVE_TARGET` default on when an operator or Owner key is present.
6. Restart PM2 after env/code change.
