
Here’s what’s in place for the token ranking framework:

## 1. **Metrics configuration** – edit `app/config/demeter-config.ts`

Single source of truth for weights and Demeter behavior:

| Metric | Weight | Description |
|--------|--------|-------------|
| `price_stability_h6` | 30% | 6h price stability (more important). Lower \|price change\| = more stable = good. |
| `buy_sell_ratio_h6` | 15% | Buy ratio (0–1). **Lower = oversold (good)**. Higher = overbought (likely to fall). |
| `price_stability_h24` | 15% | 24h price stability. Lower \|price change\| = more stable = good. |
| `volume_h6` | 10% | Fee generation, trading activity |
| `volume_h12` | 10% | Fee generation, trading activity |
| `buy_sell_ratio_h24` | 10% | 24h buy ratio (0–1). **Lower = oversold (good, likely to bounce)**. Higher = overbought (bad). |
| `volatility_h6` | 10% | 6h pool volume / liquidity (6h turnover). Higher = better execution quality tie-break. |




Weights total 1.0. Same file also defines poll interval, harvest interval, change strategy interval, price check interval, and price drop threshold.

## 2. **Weighted scoring**

`rankTokensByWeightedMetrics()`:

- Normalizes each metric to 0–1 (min–max)
- Uses `higherIsBetter` for direction
- Computes composite score = Σ (weight × normalized value)
- Returns ranked list plus per-token metric scores

## 3. **`coingecko_compareTokens` output**

The tool now returns:

- `tokens_summary` – per-token metrics
- `rankings.by_weighted_score` – order by composite score
- `weighted_ranking` – `ranked` (symbol, score, `metric_scores`), `metrics_used`
- `metrics_config` – weights and descriptions
- Existing per-metric rankings and ratios

## 4. **CLI usage**

```bash
npm run demeter:coingecko:compare
```

Prints the full comparison with weighted ranking.

## 5. **Changing weights and Demeter behavior**

**Via chat:** Run the web app (`npm run dev`) and chat with Demeter. Ask e.g.:
- "Start demeter" or "Run demeter" → `demeter_startLoops` (starts the continuous loops, same as npm run demeter)
- "Stop demeter" or "Stop demeter loops" → `demeter_stopLoops` (stops the loops, shuts down within a few seconds)
- "Run one cycle" → `demeter_runCycle` (one pass on demand)
- "Show current config" → `demeter_getConfig`
- "Set price_stability_h6 weight to 0.35" → `demeter_updateConfig`
- "Change price drop threshold to -15%" → `demeter_updateConfig`

Token ranking changes apply immediately. Restart `npm run demeter` for interval changes.

**Via file:** Edit **`app/config/demeter-config.ts`** for defaults. Chat overrides are stored in `app/config/config.overrides.json`.