// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/INonfungiblePositionManager.sol";
import "../interfaces/IUniswapV3PoolMinimal.sol";
import "../interfaces/IUniswapV3Factory.sol";
import "./StrategyManager.sol";
import "../interfaces/ISwapRouter.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../libraries/LiquidityLibrary.sol";
import "../interfaces/IRouletteStrategy.sol";

contract RouletteStrategy is IRouletteStrategy, StrategyManager, ReentrancyGuard, IERC721Receiver {         
    error Unauthorized();
    error ZeroValue();
    error ZeroAddress();
    error NotDefensive();
    error InvalidManager();
    error PositionExists();
    using SafeERC20 for IERC20;
    using LiquidityLibrary for LiquidityLibrary.PositionState;
    INonfungiblePositionManager public immutable nonfungiblePositionManager;
    LiquidityLibrary.PositionState private liqPos;
    IUniswapV3PoolMinimal private pool;
    IUniswapV3Factory private factory;
    ISwapRouter private swapRouter;
    address public managerAddress;
    IERC20 private ASSET;
    IERC20 private WETH;
    address private immutable v3FactoryAddr = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address private immutable baseWETH = 0x4200000000000000000000000000000000000006;
    address private immutable nonfungiblePosManAddr = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address private vaultAddr;
    address private assetPoolV3;
    address private swapRouterAddr; 
    address public assetAddr;
    address private demeterAddr;
    address private keeperStratAddr;
    int24 public baselineTick;
    uint256 public inRangeSince;
    bool public harvestOnDeposit = true;
    uint256 public lastHarvest; 
    uint256 public baseTokenShareBps; 
    uint256 public UniswapFeesCollected; // cumulative fees in WETH value at time of collection
    struct Deposit {address owner; uint128 liquidity; address token0; address token1;}
    mapping(uint256 => Deposit) public deposits;
    enum Mode { NORMAL, DEFENSIVE, OFFENSIVE }
    Mode public mode;
    uint256 public lastRebalanceTime;
    uint256 public consecutiveOffensiveCount;
    event StrategyEvent(uint8 indexed eventType, uint256 indexed data1, uint256 data2, uint256 data3);
    event ContractSetUp(address indexed caller);
    bool public contractSetUp;
    modifier onlyAuthorized() {
        address s = _msgSender();
        if (s != vaultAddr && s != demeterAddr && s != keeperStratAddr && s != managerAddress && s != owner()) revert Unauthorized();
        _;
    }
    constructor() StrategyManager() {
        WETH = IERC20(baseWETH);
        nonfungiblePositionManager = INonfungiblePositionManager(nonfungiblePosManAddr);
        factory = IUniswapV3Factory(v3FactoryAddr);
        deviationBands = StrategyManager.DeviationBands({lowerBps: 1500, upperBps: 1500, maxTokenCapBps: 8500});
        emit StrategyEvent(0, uint256(uint160(_msgSender())), 0, 0);
    }
    function setUpContract(address _assetAddr, address _assetPoolV3Addr, address _managerAddr, address _swapRouterAddr, address _vaultAddr, address _demeterAddr, address _keeperStrategyAddr) external onlyOwner {
        if (_assetAddr == address(0) || _assetPoolV3Addr == address(0) || _vaultAddr == address(0) || _swapRouterAddr == address(0)) revert ZeroAddress();
        managerAddress = _managerAddr;
        assetAddr = _assetAddr;
        swapRouterAddr = _swapRouterAddr;
        assetPoolV3 = _assetPoolV3Addr;
        vaultAddr = _vaultAddr;
        demeterAddr = _demeterAddr;
        keeperStratAddr = _keeperStrategyAddr;
        pool = IUniswapV3PoolMinimal(assetPoolV3);
        swapRouter = ISwapRouter(swapRouterAddr);
        ASSET = IERC20(assetAddr);
        _giveAllowances();
        contractSetUp = true;
        emit ContractSetUp(_msgSender());
    }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
    function beforeDeposit() external override onlyAuthorized whenNotPaused {
        if (harvestOnDeposit) {
            try this.harvestBoolean(true) returns (uint256) {
            } catch {
            }
        }
    }
    function deposit(uint256 amount) external override onlyAuthorized whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroValue();
        if (liqPos.positionId == 0) {
            _deposit();
            return;
        }
        if (mode == Mode.NORMAL && _inRange()) {
            _deposit();
            return;
        }
        if (mode == Mode.NORMAL && !_inRange() && liqPos.positionId != 0) {
            _deposit();
            return;
        }
        if (mode == Mode.DEFENSIVE) {
            _checkDefensiveRecoveryInternal();
            if (mode == Mode.NORMAL) {
                _deposit();
                return;
            }
            (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
            if (assetBal > 0 || wethBal > 0) {
                _balanceTokens(assetBal, wethBal);
            }
            emit StrategyEvent(1, poolValue(), 0, 0);
            return;
        }
    }
    function withdraw(uint256 userShares, uint256 totalSupply_, address receiver) external override onlyAuthorized nonReentrant {
        if (userShares == 0) revert ZeroValue();
        if (totalSupply_ == 0) revert ZeroValue();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 idleAssetBefore = ASSET.balanceOf(address(this));
        uint256 idleWethBefore  = WETH.balanceOf(address(this));
        if (liqPos.positionId != 0) {
            uint256 poolVal = poolValue();
            if (poolVal > 0) {
                uint256 amountFromPool = Math.mulDiv(poolVal, userShares, totalSupply_);
                if (amountFromPool > 0) {
                    _decreaseLiquidity(amountFromPool);
                }
            }
        }
        uint256 assetAfter = ASSET.balanceOf(address(this));
        uint256 wethAfter  = WETH.balanceOf(address(this));
        uint256 assetFromPool = assetAfter > idleAssetBefore ? assetAfter - idleAssetBefore : 0;
        uint256 wethFromPool = wethAfter > idleWethBefore ? wethAfter - idleWethBefore : 0;
        uint256 userIdleAsset = Math.mulDiv(idleAssetBefore, userShares, totalSupply_);
        uint256 userIdleWeth  = Math.mulDiv(idleWethBefore,  userShares, totalSupply_);
        uint256 totalUserAsset = assetFromPool + userIdleAsset;
        uint256 totalUserWeth  = wethFromPool  + userIdleWeth;
        uint256 assetFee = Math.mulDiv(totalUserAsset, withdrawalFeeBps, DIVISOR);
        uint256 wethFee  = Math.mulDiv(totalUserWeth,  withdrawalFeeBps, DIVISOR);
        totalUserAsset -= assetFee;
        totalUserWeth -= wethFee;
        uint256 wethBeforeSwap = WETH.balanceOf(address(this));
        _swap(ASSET, WETH, totalUserAsset);
        uint256 wethFromAsset = WETH.balanceOf(address(this)) - wethBeforeSwap;
        totalUserWeth += wethFromAsset;
        WETH.safeTransfer(receiver, totalUserWeth);
        emit StrategyEvent(2, poolValue(), 0, 0);
    }
    function harvestBoolean(bool skipIncreaseLiquidity) external onlyAuthorized nonReentrant returns (uint256 newAssets) {
        _harvest(skipIncreaseLiquidity);
        return poolValue();
    }
    function _harvest(bool skipIncreaseLiquidity) internal whenNotPaused {
        if (minHarvestDelay > 0 && lastHarvest != 0 && block.timestamp - lastHarvest < minHarvestDelay) {
            return;
        }
        if (mode == Mode.DEFENSIVE) {
            _checkDefensiveRecoveryInternal();
            if (mode == Mode.NORMAL && liqPos.positionId == 0) {
                (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
                if (assetBal > 0 || wethBal > 0) {
                    _deposit();
                }
                lastHarvest = block.timestamp;
                return;
            }
            if (liqPos.positionId != 0) {
                uint256 beforeValDefensive = balanceOfIdle();
                (, , uint256 valueInWethDefensive) = _collectAllFees(true);
                if (valueInWethDefensive > 0) {
                    emit StrategyEvent(7, liqPos.positionId, valueInWethDefensive, 0);
                }
                uint256 afterValDefensive = balanceOfIdle();
                uint256 wantHarvestedDefensive = afterValDefensive > beforeValDefensive ? (afterValDefensive - beforeValDefensive) : 0;
                emit StrategyEvent(3, uint256(uint160(_msgSender())), wantHarvestedDefensive, poolValue());
            }
            lastHarvest = block.timestamp;
            return;
        }
        if (liqPos.positionId == 0) {
            lastHarvest = block.timestamp;
            return;
        }
        uint256 beforeVal = balanceOfIdle();
        (, , uint256 valueInWeth) = _collectAllFees(true);
        if (valueInWeth == 0) {
            lastHarvest = block.timestamp;
            return;
        }
        emit StrategyEvent(7, liqPos.positionId, valueInWeth, 0);
        if (!skipIncreaseLiquidity && mode == Mode.NORMAL) {
            (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
            _balanceTokens(assetBal, wethBal);
            _increaseLiquidityInternal();
        }
        uint256 afterVal      = balanceOfIdle();
        uint256 wantHarvested = afterVal > beforeVal ? (afterVal - beforeVal) : 0;
        lastHarvest = block.timestamp;
        emit StrategyEvent(3, uint256(uint160(_msgSender())), wantHarvested, poolValue());
    }
    function _inRange() internal view returns (bool) {
        if (liqPos.positionId == 0) return false;
        (, int24 poolTick, , , , , ) = pool.slot0();
        (, , , int24 posTickLower, int24 posTickUpper, ) = liqPos.getPositionData(nonfungiblePositionManager);
        return poolTick >= posTickLower && poolTick < posTickUpper;
    }
    function readInRange() external view override returns (bool) {
        if (mode == Mode.DEFENSIVE) return false;
        return _inRange();
    }
    function _checkInRange() internal returns (bool) {
        if (mode == Mode.DEFENSIVE) return true;
        if (_inRange()) return false;
        if (liqPos.positionId == 0) {
            _enterDefensive();
            return true;
        }
        _decreaseAllLiquidity();
        uint128 remainingLiq = liqPos.getPositionLiquidity(nonfungiblePositionManager);
        if (remainingLiq != 0) return true;
        liqPos.positionId = 0;
        _enterOffensiveOrDefensiveByTick();
        return true;
    }
    function keeperCheck() external nonReentrant returns (bool) {
        if (mode == Mode.DEFENSIVE) return true;
        bool outOfRange = _checkInRange();
        bool tokenShareIssue = _checkTokenShare();
        return outOfRange || tokenShareIssue || (mode == Mode.DEFENSIVE);
    }
    function _enterDefensive() internal {
        if (liqPos.positionId != 0) revert PositionExists();
        consecutiveOffensiveCount = 0;
        inRangeSince = 0;
        (, int24 poolTick, , , , , ) = pool.slot0();
        baselineTick = poolTick;
        mode = Mode.DEFENSIVE;
    }
    function _enterOffensiveOrDefensiveByTick() internal {
        (, int24 poolTick, , , , , ) = pool.slot0();
        (, , , , int24 posTickUpper, ) = liqPos.getPositionData(nonfungiblePositionManager);
        if (poolTick >= posTickUpper) _enterOffensive();
        else _enterDefensive();
    }
    function _enterOffensive() internal {
        if (liqPos.positionId != 0) revert PositionExists();
        consecutiveOffensiveCount++;
        (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
        uint256 p = _spotPrice1e18();
        uint256 totalValue = assetBal + (p == 0 ? 0 : Math.mulDiv(wethBal, p, 1e18));
        if (assetBal == 0 && wethBal == 0 || p == 0 || totalValue == 0) {
            _enterDefensive();
            return;
        }
        _balanceTokensToTarget(assetBal, wethBal, totalValue, p, offensiveTargetAssetBps);
        _mintNewPosition(startM);
        if (liqPos.positionId != 0) {
            baseTokenShareBps = offensiveTargetAssetBps;
            mode = Mode.NORMAL;
            inRangeSince = 0;
            baselineTick = 0;
            lastRebalanceTime = block.timestamp;
            emit StrategyEvent(11, liqPos.positionId, offensiveTargetAssetBps, 0);
        } else {
            _enterDefensive();
        }
    }
    function _mintNewPosition(int24 mValue) internal {
        (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
        if (assetBal == 0 && wethBal == 0) return;
        LiquidityLibrary.MintContext memory ctx = LiquidityLibrary.MintContext({npm: nonfungiblePositionManager, factory: factory, pool: pool, weth: address(WETH), tokens: address(ASSET), assetPoolV3: assetPoolV3, fee: v3Fee, tickSpacing: tickSpacing, m: mValue, slippageBps: slippageBps, dust: 1_000_000_000_000});
        (uint256 newId, uint128 liq) = liqPos.mintNewPosition(ctx, assetBal, wethBal);
        if (newId != 0 && liq > 0) {
            (address token0, address token1, , , , uint128 liquidity) = liqPos.getPositionData(nonfungiblePositionManager);
            deposits[newId] = Deposit(address(this), liquidity, token0, token1);
            emit StrategyEvent(4, newId, uint256(uint32(int32(liqPos.tickLower))), uint256(uint32(int32(liqPos.tickUpper))));
            (uint256 assetAmt, uint256 wethAmt) = balanceOfPool();
            uint256 p = _spotPrice1e18();
            if (p != 0) {
                uint256 wethAsTokens = Math.mulDiv(wethAmt, p, 1e18);
                uint256 totalValue = assetAmt + wethAsTokens;
                if (totalValue != 0) {
                    baseTokenShareBps = Math.mulDiv(assetAmt, 10_000, totalValue);
                }
            }
        }
        _handleLeftoverTokensWithLimit(0);
    }
    function _deposit() internal {
        if (liqPos.positionId != 0) {
            _checkTokenShare();
            if (mode == Mode.DEFENSIVE) {
                return;
            }
        }
        (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
        if (assetBal == 0 && wethBal == 0) return;
        _balanceTokens(assetBal, wethBal);
        if (liqPos.positionId != 0 && !_inRange()) {
            _decreaseAllLiquidity();
            liqPos.positionId = 0;
            _enterOffensiveOrDefensiveByTick();
            return;
        }
        if (liqPos.positionId == 0) {
            _mintNewPosition(startM);
            if (liqPos.positionId != 0 && !_inRange()) {
                _decreaseAllLiquidity();
                liqPos.positionId = 0;
                _enterOffensiveOrDefensiveByTick();
                return;
            }
        } else {
            _increaseLiquidityInternal();
            _handleLeftoverTokensWithLimit(0);
            if (liqPos.positionId != 0 && !_inRange()) {
                _decreaseAllLiquidity();
                liqPos.positionId = 0;
                _enterDefensive();
                return;
            }
        }
        emit StrategyEvent(1, poolValue(), 0, 0);
    }
    function _collectAllFees(bool trackFees) internal returns (uint256 amount0, uint256 amount1, uint256 valueInWeth) {
        if (liqPos.positionId == 0) return (0, 0, 0);
        if (nonfungiblePositionManager.ownerOf(liqPos.positionId) != address(this)) {
            revert Unauthorized();
        }
        INonfungiblePositionManager.CollectParams memory params = INonfungiblePositionManager.CollectParams({tokenId: liqPos.positionId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max});
        (amount0, amount1) = nonfungiblePositionManager.collect(params);
        valueInWeth = 0;
        if (amount0 > 0 || amount1 > 0) {
            address p0 = pool.token0();
            uint256 feesWeth  = p0 == address(WETH) ? amount0 : amount1;
            uint256 feesAsset = p0 == address(WETH) ? amount1 : amount0;
            uint256 p = _spotPrice1e18();
            valueInWeth = feesWeth;
            if (feesAsset > 0 && p > 0) {
                valueInWeth += Math.mulDiv(feesAsset, 1e18, p);
            }
            if (trackFees) {
                UniswapFeesCollected += valueInWeth;
            }
            emit StrategyEvent(8, liqPos.positionId, valueInWeth, 0);
        }
    }
    function _spotPrice1e18() internal view returns (uint256) {
        (uint160 sqrtP, , , , , , ) = pool.slot0();
        address p0 = pool.token0();
        uint256 price = Math.mulDiv(uint256(sqrtP), uint256(sqrtP), (uint256(1) << 192) / 1e18);
        if (p0 == address(WETH)) {
            return price;
        } else {
            if (price == 0) return 0;
            return Math.mulDiv(1e18, 1e18, price);
        }
    }
    function _getTokenBalances() internal view returns (uint256 assetBal, uint256 wethBal) {
        assetBal = ASSET.balanceOf(address(this));
        wethBal  = WETH.balanceOf(address(this));
    }
    function _balanceTokens(uint256 assetBal, uint256 wethBal) internal {
        if (assetBal == 0 && wethBal == 0) return;
        uint256 p = _spotPrice1e18();
        if (p == 0) return;
        uint256 wethAsTokens = Math.mulDiv(wethBal, p, 1e18);
        uint256 totalValue   = assetBal + wethAsTokens;
        if (totalValue == 0) return;
        uint256 targetBps = offensiveTargetAssetBps != 0 ? offensiveTargetAssetBps : 5_000;
        _balanceTokensToTarget(assetBal, wethBal, totalValue, p, targetBps);
    }
    function _balanceTokensToTarget(uint256 assetBal, uint256 wethBal, uint256 totalValue, uint256 p, uint256 targetAssetBps) internal {
        if (totalValue == 0) return;
        uint256 target = Math.mulDiv(totalValue, targetAssetBps, 10_000);
        if (assetBal > target) {
            uint256 toSell = assetBal - target;
            if (toSell > 0) _swap(ASSET, WETH, toSell);
        } else if (assetBal < target) {
            uint256 deficit    = target - assetBal;
            uint256 wethToSell = Math.mulDiv(deficit, 1e18, p);
            if (wethToSell > wethBal) wethToSell = wethBal;
            if (wethToSell > 0) _swap(WETH, ASSET, wethToSell);
        }
    }
    function _increaseLiquidityInternal() internal {
        if (liqPos.positionId == 0) return;
        address p0 = pool.token0();
        address p1 = pool.token1();
        LiquidityLibrary.IncreaseContext memory ctx = LiquidityLibrary.IncreaseContext({npm: nonfungiblePositionManager, pool: pool, fee: v3Fee, slippageBps: slippageBps, dust: 1_000_000_000_000});
        uint128 liqAdded = liqPos.increaseLiquidityInternal(ctx, IERC20(p0), IERC20(p1));
        if (liqAdded > 0) {
            deposits[liqPos.positionId].liquidity += liqAdded;
            (uint256 assetAmt, uint256 wethAmt) = balanceOfPool();
            uint256 p = _spotPrice1e18();
            if (p != 0) {
                uint256 wethAsTokens = Math.mulDiv(wethAmt, p, 1e18);
                uint256 totalValue = assetAmt + wethAsTokens;
                if (totalValue != 0) {
                    baseTokenShareBps = Math.mulDiv(assetAmt, 10_000, totalValue);
                }
            }
            emit StrategyEvent(5, liqPos.positionId, liqAdded, 0);
        }
    }
    function _decreaseAllLiquidity() internal {
        if (liqPos.positionId != 0) {
            (, , uint256 valueInWeth) = _collectAllFees(true);
            if (valueInWeth > 0) {
                emit StrategyEvent(7, liqPos.positionId, valueInWeth, 0);
            }
        }
        _decreaseLiquidityInternal(0, true);
    }
    function _decreaseLiquidity(uint256 amount) internal {
        uint256 liqToRemove = _calculateLiquidityToRemove(amount);
        if (liqToRemove == 0) return;
        _decreaseLiquidityInternal(uint128(liqToRemove), false);
    }
    function _decreaseLiquidityInternal(uint128 liquidityToRemove, bool removeAll) internal {
        if (liqPos.positionId == 0) return;

        LiquidityLibrary.DecreaseContext memory ctx = LiquidityLibrary.DecreaseContext({npm: nonfungiblePositionManager, pool: pool});
        uint128 removed;
        uint256 positionId = liqPos.positionId; 
        if (removeAll) {
            removed = liqPos.decreaseAllLiquidity(ctx);
            deposits[positionId].liquidity = 0;
            uint128 remainingLiq = liqPos.getPositionLiquidity(nonfungiblePositionManager);
            if (remainingLiq > 0) {
                removed = liqPos.decreaseAllLiquidity(ctx);
                deposits[positionId].liquidity = 0;
            }
        } else {
            if (liquidityToRemove == 0) return;
            removed = liqPos.decreaseLiquidityByAmount(ctx, liquidityToRemove);
            deposits[positionId].liquidity = liqPos.getPositionLiquidity(nonfungiblePositionManager);
        }
        _collectAllFees(false);
        emit StrategyEvent(6, positionId, removed, 0);
    }
    function _handleLeftoverTokensWithLimit(uint256 iter) internal {
        if (iter >= 1) return;
        (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
        if (assetBal <= 1_000_000_000_000 && wethBal <= 1_000_000_000_000) return;
        _balanceTokens(assetBal, wethBal);
        if (liqPos.positionId != 0) {
            _increaseLiquidityInternal();
            _handleLeftoverTokensWithLimit(iter + 1);
        }
    }
    function _checkTokenShare() internal returns (bool) {
        if (liqPos.positionId == 0) return false;
        if (mode == Mode.DEFENSIVE) return true;
        (uint256 assetAmt, uint256 wethAmt) = balanceOfPool();
        uint256 p = _spotPrice1e18();
        if (p == 0) return false;
        uint256 wethAsTokens = Math.mulDiv(wethAmt, p, 1e18);
        uint256 totalValue   = assetAmt + wethAsTokens;
        if (totalValue == 0) return false;
        uint256 currentBps = Math.mulDiv(assetAmt, 10_000, totalValue);
        uint256 baseline   = baseTokenShareBps == 0 ? currentBps : baseTokenShareBps;
        if (currentBps >= deviationBands.maxTokenCapBps || currentBps <= deviationBands.lowerBps) {
            _decreaseAllLiquidity();
            liqPos.positionId = 0;
            if (currentBps >= deviationBands.maxTokenCapBps) _enterDefensive();
            else _enterOffensive();
            return true;
        }
        uint256 delta = currentBps > baseline ? (currentBps - baseline) : (baseline - currentBps);
        uint256 maxDev = currentBps > baseline ? deviationBands.upperBps : deviationBands.lowerBps;
        if (delta >= maxDev) {
            _decreaseAllLiquidity();
            liqPos.positionId = 0;
            _enterDefensive();
            return true;
        }
        return false;
    }
    function recordDefensiveTick() external nonReentrant {
        if (mode != Mode.DEFENSIVE) revert NotDefensive();
        _checkDefensiveRecoveryInternal();
    }
    function _checkDefensiveRecoveryInternal() internal {
        if (mode != Mode.DEFENSIVE) return;
        (, int24 poolTick, , , , , ) = pool.slot0();
        if (baselineTick == 0) {
            baselineTick = poolTick;
            inRangeSince = 0;
            return;
        }
        int24 baseline = baselineTick;
        int24 tickRange = recoveryRange;
        int24 rangeLower = baseline - tickRange;
        int24 rangeUpper = baseline + tickRange;
        bool withinRange = poolTick >= rangeLower && poolTick <= rangeUpper;
        if (withinRange) {
            if (inRangeSince == 0) {
                inRangeSince = block.timestamp;
            } else if (block.timestamp - inRangeSince >= 20 minutes) {
                _recoverFromDefensive();
            }
        } else {
            baselineTick = poolTick;
            inRangeSince = 0;
        }
    }
    function _recoverFromDefensive() internal {
        (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
        if (assetBal == 0 && wethBal == 0) {
            return;
        }
        mode = Mode.NORMAL;
        inRangeSince = 0;
        baselineTick = 0;
        _mintNewPosition(startM);
        if (liqPos.positionId == 0) {
            mode = Mode.DEFENSIVE;
            (, int24 poolTick, , , , , ) = pool.slot0();
            baselineTick = poolTick;
            inRangeSince = 0;
            return;
        }
        lastRebalanceTime = block.timestamp;
    }
    function _swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amount) internal {
        if (amount == 0) return;
        uint256 bal = tokenIn.balanceOf(address(this));
        if (amount > bal) amount = bal;
        if (amount == 0) return;
        swapRouter.swapExactInputFromStrategy(address(tokenIn), address(tokenOut), amount, address(this));
    }
    function totalLiquidity() external view override returns (uint128) { return liqPos.getPositionLiquidity(nonfungiblePositionManager); }
    function poolValue() public view override returns (uint256) {
        (uint256 assetInPool, uint256 wethInPool) = balanceOfPool();
        uint256 price = _spotPrice1e18();
        uint256 assetAsWeth = price != 0 ? Math.mulDiv(assetInPool, 1e18, price) : 0;
        return wethInPool + assetAsWeth;
    }
    function balanceOfIdle() public view override returns (uint256) {
        (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
        uint256 p = _spotPrice1e18();
        uint256 assetAsWeth = p != 0 ? Math.mulDiv(assetBal, 1e18, p) : 0;
        return wethBal + assetAsWeth;
    }
    function balanceOfPool() public view override returns (uint256 assetAmt, uint256 wethAmt) {
        if (liqPos.positionId == 0) return (0, 0);
        uint128 liquidity = liqPos.getPositionLiquidity(nonfungiblePositionManager);
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        (uint160 sqrtLowerX96, uint160 sqrtUpperX96) = LiquidityLibrary.getSqrtRatios(liqPos.tickLower, liqPos.tickUpper);
        (uint256 amount0, uint256 amount1) = LiquidityLibrary.getAmountsForLiquidity(sqrtPriceX96, sqrtLowerX96, sqrtUpperX96, liquidity);
        address p0 = pool.token0();
        return p0 == address(WETH) ? (amount1, amount0) : (amount0, amount1);
    }
    function _calculateLiquidityToRemove(uint256 amount) internal view returns (uint256) {
        if (liqPos.positionId == 0) return 0;
        (,,,int24 _tickLower,int24 _tickUpper,uint128 liquidity) = liqPos.getPositionData(nonfungiblePositionManager);
        (uint160 sqrtP, , , , , , ) = pool.slot0();
        uint128 positionLiquidity = liqPos.getPositionLiquidity(nonfungiblePositionManager);
        (uint160 sqrtLowerX96, uint160 sqrtUpperX96) = LiquidityLibrary.getSqrtRatios(_tickLower, _tickUpper);
        (uint256 amount0, uint256 amount1) = LiquidityLibrary.getAmountsForLiquidity(sqrtP, sqrtLowerX96, sqrtUpperX96, positionLiquidity);
        address p0 = pool.token0();
        (uint256 assetAmt, uint256 wethAmt) = p0 == address(WETH) ? (amount1, amount0) : (amount0, amount1);
        uint256 p = _spotPrice1e18();
        uint256 assetAsWeth = p != 0 ? Math.mulDiv(assetAmt, 1e18, p) : 0;
        uint256 totalValue = wethAmt + assetAsWeth;
        if (totalValue == 0 || liquidity == 0) return 0;
        uint256 proportion = Math.mulDiv(amount, 1e18, totalValue);
        uint256 targetTokenAmt = Math.mulDiv(assetAmt, proportion, 1e18);
        uint256 targetWethAmt = Math.mulDiv(wethAmt,  proportion, 1e18);
        (uint256 bal0, uint256 bal1) = p0 == address(WETH) ? (targetWethAmt, targetTokenAmt) : (targetTokenAmt, targetWethAmt);
        uint128 liqNeeded = LiquidityLibrary.getLiquidityForAmounts(sqrtP, sqrtLowerX96, sqrtUpperX96, bal0, bal1);
        if (liqNeeded > liquidity) return liquidity;
        return liqNeeded;
    }
    function setGiveAllowances() external onlyAuthorized {
        _giveAllowances();
    }
    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyAuthorized {
        harvestOnDeposit = _harvestOnDeposit;
    }
    function getPositionId() external view override returns (uint256) {
        return liqPos.positionId;
    }
    function pause() external onlyAuthorized {
        _pause();
        _removeAllowances();
    }
    function unpause() external onlyAuthorized {
        _unpause();
        _giveAllowances();
        _deposit();
    }
    function _giveAllowances() internal {
        if (address(ASSET) != address(0)) {
            ASSET.approve(address(nonfungiblePositionManager), type(uint256).max);
            ASSET.approve(address(swapRouter), type(uint256).max);
        }
        WETH.approve(address(nonfungiblePositionManager), type(uint256).max);
        WETH.approve(address(swapRouter), type(uint256).max);
    }
    function _removeAllowances() internal {
        if (address(ASSET) != address(0)) ASSET.approve(address(nonfungiblePositionManager), 0);
        WETH.approve(address(nonfungiblePositionManager), 0);
    }
    function changeAsset(address _newAssetAddr, address _newPoolV3Addr) external override onlyAuthorized {
        if (_newAssetAddr == address(0)) revert ZeroAddress();
        consecutiveOffensiveCount = 0;
        _decreaseAllLiquidity();
        (uint256 assetBal, uint256 wethBal) = _getTokenBalances();
        if (assetBal > 0) _swap(ASSET, WETH, assetBal);
        assetAddr = _newAssetAddr;
        ASSET = IERC20(_newAssetAddr);
        assetPoolV3 = _newPoolV3Addr;
        pool = IUniswapV3PoolMinimal(_newPoolV3Addr);
        _giveAllowances();
        (assetBal, wethBal) = _getTokenBalances();
        if (wethBal == 0 && assetBal == 0) return;
        _balanceTokens(assetBal, wethBal);
        _mintNewPosition(startM);
        mode = Mode.NORMAL;
        inRangeSince = 0;
        baselineTick = 0;
        emit StrategyEvent(10, liqPos.positionId, 0, 0);
    }
}