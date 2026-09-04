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
| AutoOperatorRegistry (shared) | `0x7df1120a04D82eA92EA2d5AA005e3316B37b936E` |
| AutoKeeperRhV3 | `0xD35CE6610AcB37D545bb5ec4192fC50505Dd26Ad` |
| AutoFactoryRhV3 | `0xB3E65742e90af23f30527A9745B63F90DAA48B78` |
| AutoSwapRouterRhV3 | `0x8A8c18445792e04e8512D5c6CD680331F9575a3F` |
| AutoKeeperRhV4 | `0x79F9ea39E7e5304791DF8cfEe835F6592c35e022` |
| AutoFactoryRhV4 | `0x3D19ecDb90B06626f8EC860F7aec9A378E760E8D` |
| AutoSwapRouterRhV4 | `0x724265D83E2Ea8296Bd61177d7B86a92Ba7e2520` |
| AutoKeeperSv3 | `0x3Cb0A8c25356BF5764C4510A79458e73a6639372` |
| AutoFactorySv3 | `0x0bb7e7A4a57ad938a253d2302604D1256067785A` |
| AutoSwapRouterSv3 | `0x568dCA271e5F7edb9769f5eA6076e2DA8D4014e8` |
| UFloatKeeperV3 | `0xe2E744063446E372B9E28e4BB38aaBFcc6D43eE8` |
| UFloatStrategyFactoryV3 | `0xA8966d59f38e7bE263C533Ccda87F36eaf5FFefE` |
| UFloatSwapRouterV3 | `0x932f208D180dB8e375E17f88e86A9C1a81d7ACa8` |
| UFloatKeeper (V4) | `0x2cF7c9aB33a8248B07435d58cc7754eB1EaB8d12` |
| UFloatStrategyFactoryV4 | `0xBDE2231aC15DdbACa7A24837875e6F7DF0a855D9` |
| UFloatSwapRouter (V4) | `0x562cfd3C373A649932597AD5D7a7c1CEa8402A76` |

Full addresses: [docs/ADDRESSES.md](./docs/ADDRESSES.md). Pipeline config: `app/config/rh-keeper-pipelines.ts`.

Table values above are **code fallbacks**. Set the same names in `.env` to change them without a commit (restart Demeter / PM2 after edit).

| Env | Used for |
|-----|----------|
| `WETH_ADDRESS` | Canonical WETH (also Triton / Float V4 stable) |
| `USDG_ADDRESS` | Canonical USDG (Float V3 stable token) |
| `UNISWAP_V3_FACTORY` | Uniswap V3 factory (pool lookup) |
| `UNISWAP_V4_POOL_MANAGER` | Uniswap V4 PoolManager |
| `STABLE_USDG_WETH_POOL` | USDG/WETH v3 pool |
| `OPERATOR_REGISTRY_ADDRESS` | Shared OperatorRegistry (`AUTO_OPERATOR_REGISTRY_ADDRESS` also accepted) |
| `AUTO_KEEPER_RH_V3_ADDRESS` / `AUTO_FACTORY_RH_V3_ADDRESS` / `AUTO_SWAP_ROUTER_RH_V3_ADDRESS` | Auto Uni V3 |
| `AUTO_KEEPER_RH_V4_ADDRESS` / `AUTO_FACTORY_RH_V4_ADDRESS` / `AUTO_SWAP_ROUTER_RH_V4_ADDRESS` | Auto Uni V4 |
| `AUTO_KEEPER_SV3_ADDRESS` / `AUTO_FACTORY_SV3_ADDRESS` / `AUTO_SWAP_ROUTER_SV3_ADDRESS` | Auto Sushi V3 |
| `UFLOAT_KEEPER_RH_V3_ADDRESS` / `UFLOAT_FACTORY_RH_V3_ADDRESS` / `UFLOAT_SWAP_ROUTER_RH_V3_ADDRESS` | UFloat V3 |
| `UFLOAT_KEEPER_RH_V4_ADDRESS` / `UFLOAT_FACTORY_RH_V4_ADDRESS` / `UFLOAT_SWAP_ROUTER_RH_V4_ADDRESS` | UFloat V4 |

Shared helpers: `app/config/chain-config.ts`. Keeper checks (upkeep/harvest) shard across up to four operator keys — `DEMETER_PRIVATE_KEY`, `DEMETER_TWO_PRIVATE_KEY`, `TRITON_PRIVATE_KEY`, `TRITON_TWO_PRIVATE_KEY` — with txs serialized per address. UFloat `changeAsset` stays on Triton wallets.

## Auto / UFloat RH ABIs

| Dir | Keepers |
|-----|---------|
| `app/abi/auto-vaults-rh-v3/` | `AutoKeeperRhV3.abi.json` |
| `app/abi/auto-vaults-rh-v4/` | `AutoKeeperRhV4.abi.json` |
| `app/abi/auto-vault-sushi/` | `AutoKeeperSv3.abi.json` |
| `app/abi/ustrategy-rh-v3/` | `UFloatKeeperV3.abi.json` |
| `app/abi/ustrategy-rh-v4/` | `UFloatKeeper.abi.json` |

RhV3 / RhV4 / Sv3 AutoKeeper operator surfaces are identical (`performUpkeepBatch`, `performHarvestBatch(ids, skipIncreaseLiquidity)`, `watched` with `lastHarvest`). UFloat keepers omit `lastHarvest` on `watched` and name snapshots `snapshotPoolValue`.

Auto strategies have no `mode()`. Harvest uses per-strategy TVL tiers (or `AUTO_KEEPER_HARVEST_INTERVAL_MS` to pin one interval). Upkeep only after off-chain `keeperCheck`. Owner band control is one `setBandParams` tx. RhV4 also runs `refreshPriceRefBatch` at ≥10 min. UFloat still has mode and still skips `STABLE` on harvest.

Enable Auto pipelines with `AUTO_KEEPER_ENABLED=true`. Disable one with `AUTO_KEEPER_RH_V3_ENABLED=false` (or `RH_V4` / `SV3`). UFloat RH V3+V4 run when Triton keys are set; disable with `UFLOAT_KEEPER_RH_V3_ENABLED=false` / `UFLOAT_KEEPER_RH_V4_ENABLED=false`.

## Still Base (not RH keeper loops)

Float V3/V4 manager/keeper addresses in `demeter-config.ts` remain Base placeholders. Those pipelines stay off unless `STRATEGY_IDS` / `FLOAT_V4_STRATEGY_IDS` are set. LiquidStratMinV4 is still the Base contract unless separately redeployed.
