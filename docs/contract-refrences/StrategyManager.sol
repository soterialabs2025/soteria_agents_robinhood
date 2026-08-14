// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract StrategyManager is Ownable, Pausable {
    constructor() Ownable(msg.sender) {}

    struct DeviationBands {
        uint256 lowerBps;
        uint256 upperBps;
        uint256 maxTokenCapBps;
    }
    
    uint256 public constant DIVISOR = 10000;
    uint256 public constant WITHDRAWAL_FEE_CAP = 100;
    uint16 public constant MAX_SLIPPAGE_BPS16 = 1500;
    uint24 public v3Fee = 10000;
    int24 public tickSpacing = 200;
    int8 public startM = 6;
    int24 public recoveryRange = 150;
    uint256 public protocolFeeBps = 0;
    uint256 public constant MAX_TOTAL_FEE_BPS = 1000;
    uint256 public withdrawalFeeBps = 0;
    uint16 public slippageBps = 300;
    uint16 public fallbackSlippageBps = 500;
    uint256 public minHarvestDelay = 4 hours;
    DeviationBands public deviationBands;
    uint256 public offensiveTargetAssetBps = 4000; // remint target: asset% (e.g. 4000 = 40% token / 60% WETH)

    event ParamUpdated(bytes32 indexed param, uint256 val1, uint256 val2);
    error SlippageTooHigh();
    function setProtocolFeeBps(uint256 _protocolFeeBps) external onlyOwner {
        require(_protocolFeeBps <= MAX_TOTAL_FEE_BPS, "H");
        protocolFeeBps = _protocolFeeBps;
        emit ParamUpdated(bytes32("pFBps"), _protocolFeeBps, 0);
    }
    function setWithdrawalFeeBps(uint256 _withdrawalFeeBps) external onlyOwner {
        require(_withdrawalFeeBps <= WITHDRAWAL_FEE_CAP, "H");
        withdrawalFeeBps = _withdrawalFeeBps;
        emit ParamUpdated(bytes32("wFBps"), _withdrawalFeeBps, 0);
    }
    function setV3Fee(uint24 _v3Fee) external onlyOwner {
        v3Fee = _v3Fee;
        emit ParamUpdated(bytes32("vF"), _v3Fee, 0);
    }
    function setTickSpacing(int24 _tickSpacing, int8 _startM, int24 _recoveryRange) external onlyOwner {
        require(_tickSpacing > 0, ">0");
        require(_startM > 0, ">0");
        require(_recoveryRange > 0, ">0");
        tickSpacing = _tickSpacing;
        startM = _startM;
        recoveryRange = _recoveryRange;
        emit ParamUpdated(bytes32("tSpg"), uint256(int256(_tickSpacing)), uint256(int256(_startM)));
    }
    function setSlippage(uint16 _slippageBps, uint16 _fallbackSlippageBps) external onlyOwner {
        if (_slippageBps > MAX_SLIPPAGE_BPS16) revert SlippageTooHigh();
        slippageBps = _slippageBps;
        fallbackSlippageBps = _fallbackSlippageBps;
        emit ParamUpdated(bytes32("slippage"), _slippageBps, _fallbackSlippageBps);
    }
    function setMinHarvestDelay(uint256 _delay) external onlyOwner { 
        minHarvestDelay = _delay;
        emit ParamUpdated(bytes32("mHD"), _delay, 0);
    }
    function setDeviationBands(uint256 _lowerBps, uint256 _upperBps, uint256 _maxTokenCapBps) external onlyOwner {
        deviationBands = DeviationBands({lowerBps: _lowerBps, upperBps: _upperBps, maxTokenCapBps: _maxTokenCapBps});
        emit ParamUpdated(bytes32("deviationBands"), _maxTokenCapBps, _lowerBps);
    }
    function setOffensiveTargetAssetBps(uint256 _offensiveTargetAssetBps) external onlyOwner {
        require(_offensiveTargetAssetBps <= DIVISOR, ">100%");
        offensiveTargetAssetBps = _offensiveTargetAssetBps;
        emit ParamUpdated(bytes32("offensiveTargetBps"), _offensiveTargetAssetBps, 0);
    }

}
