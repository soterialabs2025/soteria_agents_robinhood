# Soteria Agents — Robinhood Chain fork

This clone lives at `c:\code\soteria_agents_robinhood` (sibling of the Base original at `c:\code\soteria_agents`).

## Chain

| Item | Value |
|------|--------|
| Network | Robinhood Chain mainnet |
| Chain ID | **4663** |
| Explorer | https://robinhoodchain.blockscout.com |
| CoinGecko / GeckoTerminal network id | `robinhood` |
| Demeter `DEFAULT_NETWORK_ID` | `robinhood-mainnet` |

## RPC

Prefer **`ROBINHOOD_MAIN_RPC_URL`**. `getRpcUrl()` / `getRpcUrlOptional()` in `app/config/chain-config.ts` fall back to `RPC_URL` for local/legacy.

## Canonical addresses (Robinhood)

| Asset / contract | Address |
|------------------|---------|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG (stable) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| STABLE USDG/WETH pool (Demeter) | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` |
| AutoOperatorRegistry | `0x7df1120a04D82eA92EA2d5AA005e3316B37b936E` |
| AutoFactoryV3Rh | `0xFd6f1F71F2aAe90f89c5b11bdfa03871e263F13A` |
| AutoSwapRouterV3Rh | `0xB76cdfF814220334Bb46C247F5D7f5d6bE7c8d3B` |
| AutoKeeperV3Rh | `0x6ef6afF9Dc71202252B9A0c95E1193aD7D1e5795` |

Shared helpers: `app/config/chain-config.ts` (`getViemChain`, `getRpcUrl`, explorer URL builders, `COINGECKO_NETWORK`, `WETH_ADDRESS`, `USDG_ADDRESS`, `UNISWAP_V3_FACTORY`). Auto V3 RH addresses live in `app/config/auto-keeper-config.ts` (env overrides: `AUTO_KEEPER_ADDRESS`, `AUTO_FACTORY_ADDRESS`, `AUTO_OPERATOR_REGISTRY_ADDRESS`, `AUTO_SWAP_ROUTER_ADDRESS`).

## Auto vaults RH ABIs (`app/abi/auto-vaults-rh/`)

Robinhood Auto V3 package (Uniswap V3). AutoKeeper loop imports `AutoKeeper.abi.json` (raw ABI array, not `{ abi: [...] }`).

| File | Role |
|------|------|
| `AutoKeeper.abi.json` | Upkeep / harvest / watched[] — same surface as Base except snapshots |
| `AutoFactoryV3Rh.abi.json` | `deployVaultPackage` (strategy, vault, liquidShares, shareStaking, keeperId), `setPackageActive` |
| `AutoVaultV3Rh.abi.json` | Vault (`depositETH`, `liquidShares`, `shareStaking`, pool-value snapshots) |
| `AutoStrategyV3Rh.abi.json` | Strategy (pool / idle / harvest / mode) — old Base `AutoVault.json` mixed vault+strategy |
| `LiquidShares.abi.json` | ERC-20 shares minted by the vault (replaces liquid token) |
| `ShareStaking.abi.json` | Share staking / epoch rewards |
| `IWETHV3Rh.abi.json` | WETH deposit / ERC-20 |

Notable ABI diffs vs Base Auto:

- `snapshotVaultPoolValue(id)` / `snapshotVaultPoolValueBatch(ids)` — dropped `bool skipIncreaseLiquidity`
- Vault and strategy are separate contracts; eligibility still uses strategy `poolValue() + balanceOfIdle()` (no `totalValueWeth`)
- Strategy has no `changeAsset` / `allowedTokens` (Auto path is upkeep + harvest only)
- Mode is `NORMAL / DEFENSIVE / OFFENSIVE / STABLE` (no `NEUTRAL`). Neutral enter/exit (`enterNeutral`, `resumeNormal`, `MustBeNeutral`) is gone. Harvest skips `STABLE`.
- Vault deposits are `depositETH` only; `liquidToken` is now `liquidShares` + `shareStaking`

## Not yet redeployed (still Base placeholders)

Float / UFloat / LiquidStrat **manager, keeper, factory, and strategy contract addresses** in demeter/triton configs are still the Base deployments until those packages are redeployed on Robinhood Chain. Auto V3 RH (keeper, factory, operator registry, swap router) is live — see the table above.
