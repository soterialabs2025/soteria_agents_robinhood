// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IV3SwapRouterMinimal.sol";
import "../interfaces/IQuoterV2.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/IContractManager.sol";
import "../interfaces/IUniswapV2Router02.sol";

interface IPausable {
    function paused() external view returns (bool);
}

/// @notice Minimal Permit2 interface (single-token permit+transfer use case).
/// @dev Replace with full official interface in production.
interface IPermit2 {
    struct PermitTransferFrom {
        IERC20 token;
        uint256 amount;
        uint256 expiration;
        uint256 nonce;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}
 

contract RouletteSwapRouter is ISwapRouter, Ownable, ReentrancyGuard {

    using SafeERC20 for IERC20;

    IV3SwapRouterMinimal public immutable v3Router;
    IUniswapV2Router02 public immutable v2Router;
    IQuoterV2 public immutable quoterV2;
    IPermit2 public immutable permit2;
    IERC20 private WETH;
    IContractManager public manager;
    IERC20 private TOKEN;
    address public strategy; // Strategy contract address
    uint24 public immutable defaultFee = 10_000; // e.g. 10_000 on Base
    uint16 public maxSlippageBps = 1_000;      // 10% cap for safety
    uint16 public defaultSlippageBps = 300;  // 3% default
    uint16 public fallbackSlippageBps = 900; // 9% if quoter fails

    bool public initialized;
    
    error Unauthorized();

    event SwapExecuted(
        address indexed caller,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event OwnerSet(address indexed newOwner);
    event SlippageParamsUpdated(uint16 defaultSlippageBps, uint16 fallbackSlippageBps);
    event ContractSetUp(address indexed caller);
    event StrategySet(address indexed strategy);

    //Sepolia addresses
    address private immutable baseV3RouterAddr = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address private immutable baseV2RouterAddr = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address private immutable quoterV2Addr = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address private immutable baseV3FactoryAddr = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address private immutable baseWETH = 0x4200000000000000000000000000000000000006;
    address private immutable nonfungiblePositionManagerAddr = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address private immutable permit2Addr = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address private constant UNIVERSAL_ROUTER_BASE = 0x198EF79F1F515F02dFE9e3115eD9fC07183f02fC;
    uint24 private constant FEE_500 = 500;
    uint24 private constant FEE_3000 = 3000;
    uint24 private constant FEE_10000 = 10000;
    address public universalRouterAddr;
    address public demeterAddr;

    constructor(address _managerAddr) Ownable(msg.sender) {
        require(_managerAddr != address(0), "Invalid manager address");
        manager = IContractManager(_managerAddr);
        v3Router = IV3SwapRouterMinimal(baseV3RouterAddr);
        v2Router = IUniswapV2Router02(baseV2RouterAddr);
        quoterV2 = IQuoterV2(quoterV2Addr);
        permit2 = IPermit2(permit2Addr);
        WETH = IERC20(baseWETH);
    }

    // -----------------------------
    // Admin / tuning
    // -----------------------------

    modifier onlyAuthorized() {
        address s = _msgSender();
        if (s != demeterAddr && s != address(manager) && s != owner()) revert Unauthorized();
        _;
    }
    function setUpContract() external onlyOwner {
        address _tokenAddr = manager.getAddress("ASSET");
        address _strategyAddr = manager.getAddress("RouletteStrategy");
        demeterAddr = manager.getAddress("Demeter");
        address _ur = manager.getAddress("UniversalRouter");
        universalRouterAddr = _ur != address(0) ? _ur : UNIVERSAL_ROUTER_BASE;
        require(_tokenAddr != address(0), "token=0");
        require(_strategyAddr != address(0), "strategy=0");
        TOKEN = IERC20(_tokenAddr);
        strategy = _strategyAddr;
        initialized = true;
        emit ContractSetUp(_msgSender());
        emit StrategySet(_strategyAddr);
    }

    function updateAsset() external onlyAuthorized {
        address _assetAddr = manager.getAddress("ASSET");
        require(_assetAddr != address(0), "asset=0");
        TOKEN = IERC20(_assetAddr);
    }

    function setSlippageParams(uint16 _defaultSlippageBps, uint16 _fallbackSlippageBps) external onlyOwner {
        require(_defaultSlippageBps <= maxSlippageBps, "default>max");
        require(_fallbackSlippageBps <= maxSlippageBps, "fallback>max");
        defaultSlippageBps = _defaultSlippageBps;
        fallbackSlippageBps = _fallbackSlippageBps;
        emit SlippageParamsUpdated(_defaultSlippageBps, _fallbackSlippageBps);
    }

    // -----------------------------
    // Public swap helpers
    // -----------------------------

    /// @notice Swap using Permit2 to pull tokens from caller.
    /// @dev Caller signs off-chain, your frontend builds `permit` and `sig`.
    function swapExactInputFromCallerWithPermit2(
        IPermit2.PermitTransferFrom calldata permit,
        IPermit2.SignatureTransferDetails calldata transferDetails,
        bytes calldata signature,
        address tokenOut,
        address recipient
    ) external returns (uint256 amountOut) {
        require(transferDetails.to == address(this), "to!=router");
        address owner_ = msg.sender;

        // 1) Pull tokens from owner using Permit2
        permit2.permitTransferFrom(
            permit,
            transferDetails,
            owner_,
            signature
        );

        IERC20 tokenIn = permit.token;
        uint256 amountIn = transferDetails.requestedAmount;
        require(amountIn > 0, "zero in");

        // 2) Perform swap, output to `recipient`
        amountOut = _swapExactInput(
            address(tokenIn),
            tokenOut,
            amountIn,
            defaultFee,
            recipient,
            defaultSlippageBps,
            fallbackSlippageBps
        );
    }

    /// @notice Swap using regular ERC20 allowance from caller to this router.
    function swapExactInputFromCaller(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient
    ) external returns (uint256 amountOut) {
        require(amountIn > 0, "zero in");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        amountOut = _swapExactInput(
            tokenIn,
            tokenOut,
            amountIn,
            defaultFee,
            recipient,
            defaultSlippageBps,
            fallbackSlippageBps
        );
    }

    /// @notice Swap using tokens already held by a strategy/vault.
    /// @dev Useful for so that V3 just calls this with its own balances.
    /// @dev When called by the Strategy, recipient must be the Strategy address and strategy must not be paused.
    function swapExactInputFromStrategy(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient
    ) external override returns (uint256 amountOut) {
        require(amountIn > 0, "zero in");
        if (msg.sender == strategy) {
            require(recipient == strategy, "recipient must be strategy");
            require(!IPausable(strategy).paused(), "strategy paused");
        }

        // Strategy needs to approve this router for tokenIn.
        // Pull tokens from strategy (msg.sender) to this router
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        amountOut = _swapExactInput(
            tokenIn,
            tokenOut,
            amountIn,
            defaultFee,
            recipient,
            defaultSlippageBps,
            fallbackSlippageBps
        );
    }

    /// @notice Two-hop swap: oldAsset -> WETH -> newAsset
    /// @dev Used by strategy when changing assets. Performs two V3 swaps through WETH.
    /// @param oldAssetAddr The current asset address to swap from
    /// @param newAssetAddr The new asset address to swap to
    /// @param amountIn The amount of oldAsset to swap
    /// @param recipient The address to receive the newAsset (should be strategy address)
    /// @return amountOut The amount of newAsset received
    function swapAssetToNewAsset(
        address oldAssetAddr,
        address newAssetAddr,
        uint256 amountIn,
        address recipient
    ) external override returns (uint256 amountOut) {
        require(amountIn > 0, "zero in");
        require(oldAssetAddr != address(0), "oldAsset=0");
        require(newAssetAddr != address(0), "newAsset=0");
        require(recipient != address(0), "recipient=0");
        
        if (msg.sender == strategy) {
            require(recipient == strategy, "recipient must be strategy");
            require(!IPausable(strategy).paused(), "strategy paused");
        }

        // Pull oldAsset from strategy (msg.sender) to this router
        IERC20 oldAsset = IERC20(oldAssetAddr);
        oldAsset.safeTransferFrom(msg.sender, address(this), amountIn);

        // First hop: oldAsset -> WETH
        uint256 wethReceived = _swapExactInput(
            oldAssetAddr,
            baseWETH,
            amountIn,
            defaultFee,
            address(this), // Intermediate recipient (this router)
            defaultSlippageBps,
            fallbackSlippageBps
        );

        // Second hop: WETH -> newAsset
        amountOut = _swapExactInput(
            baseWETH,
            newAssetAddr,
            wethReceived,
            defaultFee,
            recipient, // Final recipient (strategy)
            defaultSlippageBps,
            fallbackSlippageBps
        );

        emit SwapExecuted(msg.sender, recipient, oldAssetAddr, newAssetAddr, amountIn, amountOut);
    }

    /// @notice Swap token to WETH for vault deposits.
    /// @param isV3 If true routes through V3 (tries fee tiers 0.05%, 0.3%, 1%), if false routes through V2.
    function swapTokenToWethForVault(
        address tokenIn,
        uint256 amountIn,
        address recipient,
        bool isV3
    ) external override returns (uint256 amountOut) {
        require(amountIn > 0, "zero in");
        require(tokenIn != baseWETH, "token is WETH");
        require(recipient != address(0), "recipient=0");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        if (isV3) {
            amountOut = _swapTokenToWethMultiFee(tokenIn, amountIn, recipient);
        } else {
            amountOut = _swapTokenToWethV2(tokenIn, amountIn, recipient);
        }

        require(amountOut > 0, "swap returned zero");
        emit SwapExecuted(msg.sender, recipient, tokenIn, baseWETH, amountIn, amountOut);
    }

    function _swapTokenToWethMultiFee(address tokenIn, uint256, address recipient) internal returns (uint256 amountOut) {
        uint24[3] memory fees = [FEE_500, FEE_3000, FEE_10000];
        for (uint256 i = 0; i < fees.length; i++) {
            uint256 bal = IERC20(tokenIn).balanceOf(address(this));
            if (bal == 0) break;
            try this.swapTokenToWethSingleFee(tokenIn, bal, recipient, fees[i]) returns (uint256 out) {
                if (out > 0) return out;
            } catch {}
        }
        revert("no V3 pool");
    }

    function swapTokenToWethSingleFee(address tokenIn, uint256 amountIn, address recipient, uint24 fee) external returns (uint256 amountOut) {
        require(msg.sender == address(this), "only self");
        return _swapExactInput(tokenIn, baseWETH, amountIn, fee, recipient, defaultSlippageBps, fallbackSlippageBps);
    }

    function _swapTokenToWethV2(address tokenIn, uint256 amountIn, address recipient) internal returns (uint256 amountOut) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = baseWETH;
        uint256[] memory amounts = v2Router.getAmountsOut(amountIn, path);
        uint256 amountOutMin = Math.mulDiv(amounts[amounts.length - 1], 10_000 - defaultSlippageBps, 10_000);
        _ensureAllowance(IERC20(tokenIn), address(v2Router), amountIn);
        uint256 balBefore = IERC20(baseWETH).balanceOf(recipient);
        v2Router.swapExactTokensForTokens(amountIn, amountOutMin, path, recipient, block.timestamp + 300);
        return IERC20(baseWETH).balanceOf(recipient) - balBefore;
    }

    // -----------------------------
    // Internal core swap logic
    // -----------------------------

    function _swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        address recipient,
        uint16 slippageBps,
        uint16 fallbackSlippage
    ) internal returns (uint256 amountOut) {
        require(recipient != address(0), "recipient=0");
        require(slippageBps <= maxSlippageBps, "slippage>max");
        require(fallbackSlippage <= maxSlippageBps, "fallback>max");

        IERC20 inToken = IERC20(tokenIn);

        uint256 bal = inToken.balanceOf(address(this));
        if (amountIn > bal) amountIn = bal;
        require(amountIn > 0, "no balance");

        // 1) Compute minOut via quoter, fallback if needed
        uint256 minOut = _getMinimumOutputForSwap(
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            slippageBps,  
            fallbackSlippage
        );

        // 2) Approve router for this amount if needed
        _ensureAllowance(inToken, address(v3Router), amountIn);

        // 3) Build single-hop path: tokenIn -> tokenOut
        bytes memory path = abi.encodePacked(tokenIn, fee, tokenOut);

        amountOut = v3Router.exactInput(
            IV3SwapRouterMinimal.ExactInputParams({
                path: path,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minOut
            })
        );

        emit SwapExecuted(msg.sender, recipient, tokenIn, tokenOut, amountIn, amountOut);
    }

    function _getMinimumOutputForSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        uint16 slippageBps,
        uint16 fallbackSlippage
    ) internal returns (uint256 amountOutMinimum) {
        // Try quoter; if it reverts, use a dumb fallback bound.
        try quoterV2.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                fee: fee,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256 amountOut, uint160, uint32, uint256) {
            amountOutMinimum = Math.mulDiv(amountOut, (10_000 - slippageBps), 10_000);
        } catch {
            // Fallback: assume 1:1 with big slippage discount
            amountOutMinimum = Math.mulDiv(amountIn, fallbackSlippage, 10_000);
        }
    }

    function _ensureAllowance(IERC20 token, address spender, uint256 amount) internal {
        uint256 current = token.allowance(address(this), spender);
        if (current < amount) {
            token.approve(spender, 0);
            token.approve(spender, type(uint256).max);
        }
    }
}