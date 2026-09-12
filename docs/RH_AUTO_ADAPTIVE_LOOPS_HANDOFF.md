# Handoff: Port AutoKeeper adaptive loops from Base → Robinhood

This is the RH copy of the handoff. Full source of truth also lives in Base repo:

`c:\code\soteria_agents\docs\RH_AUTO_ADAPTIVE_LOOPS_HANDOFF.md`

## RH-only deltas (read first)

1. **Bands:** one `setBandParams(rangeBelow, rangeAbove, innerBelow, innerAbove)` from a registered operator (Owner still allowed).
2. **Price ref:** on-chain `minRefUpdateInterval = 10 minutes` → agent loop default **10 min** (never denser).

## What to build (from Base)

Port these Base features into this RH codebase:

| # | Feature | Base files to mirror |
|---|---------|----------------------|
| 1 | Off-chain `keeperCheck` remint gate before `performUpkeepBatch` | `app/services/keeper-check-simulate.ts` (likely already here) |
| 2 | Per-strategy harvest from `poolValue` TVL tiers | `auto-adaptive-harvest.ts` + `auto-keeper-config` tiers |
| 3 | Adaptive ±1 tickSpacing bands | `auto-adaptive-band.ts` — one `setBandParams` (RH and Base) |
| 4 | `refreshPriceRefBatch` loop | `auto-keeper-loop` price-ref loop — **10 min default** |
| 5 | Operator ETH failover | `operator-eth-failover.ts` |
| 6 | Adaptive `targetAssetBps` | `auto-adaptive-target.ts` — see [RH_AUTO_ADAPTIVE_TARGET_HANDOFF.md](./RH_AUTO_ADAPTIVE_TARGET_HANDOFF.md) |

## Band apply (RH)

```ts
// One atomic tx — do not split outer/inner
await writeContract({
  address: strategy,
  abi: STRATEGY_BAND_ABI,
  functionName: "setBandParams",
  args: [
    BigInt(outerBelow),
    BigInt(outerAbove),
    BigInt(innerBelow),
    BigInt(innerAbove),
  ],
  account: operatorAccount, // OperatorRegistry.isOperator or owner()
});
```

## Price-ref (RH)

```ts
DEFAULT_AUTO_KEEPER_PRICE_REF_INTERVAL_MS = 10 * 60 * 1000; // match minRefUpdateInterval
// parseIntervalMs(..., minMs: 10 * 60 * 1000)
```

## Env (RH)

```bash
AUTO_ADAPTIVE_HARVEST=true
AUTO_ADAPTIVE_BAND=true
# Operators sign setBandParams / setTargetAssetBps (Owner key is optional fallback)
DEMETER_PRIVATE_KEY=0x...
# AUTO_BAND_OWNER_ADDRESS=0x...   # only if no operator keys

AUTO_KEEPER_PRICE_REF_ENABLED=true
AUTO_KEEPER_PRICE_REF_INTERVAL_MS=600000   # 10 minutes
```

## Checklist

1. ABI has `setBandParams` + `refreshPriceRefBatch`.
2. Harvest due filter + TVL tiers.
3. Band state machine → single `setBandParams` from an operator (Owner fallback if no operator keys).
4. Price-ref loop ≥ 10m, ABI-gated.
5. ETH failover on batch txs.
6. Smoke remint simulate; confirm band/target send from a registered operator.

See Base handoff for full tier tables, remint rules, and log shapes.
