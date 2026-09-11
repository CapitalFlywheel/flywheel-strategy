// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IPonsV2FeeEscrow} from "./interfaces/IPonsV2FeeEscrow.sol";

interface IPonsV2BondingCurveFeeSweep {
    function deployer() external view returns (address);
    function graduated() external view returns (bool);
    function buybackEnabled() external view returns (bool);
    function sweepFees(uint256 minBuybackTokensOut) external;
}

/// @notice Creator-fee recipient for a native-ETH PONS V2 launch.
/// @dev Anyone can move accrued creator fees from the PONS escrow into FeeRouter.
contract PonsFeeCollector is ReentrancyGuard {
    using Address for address payable;

    IPonsV2FeeEscrow public immutable feeEscrow;
    address payable public immutable feeRouter;

    event FeesCollected(uint256 amount);
    event CurveFeesSwept(address indexed curve);
    event ForcedEthForwarded(uint256 amount);

    error ZeroAddress();
    error OnlyFeeEscrow();
    error NothingToCollect();
    error ClaimAmountMismatch();
    error UnexpectedCurve();
    error CurveAlreadyGraduated();
    error PonsBuybackMustBeDisabled();

    constructor(address feeEscrow_, address payable feeRouter_) {
        if (feeEscrow_ == address(0) || feeRouter_ == address(0)) revert ZeroAddress();
        feeEscrow = IPonsV2FeeEscrow(feeEscrow_);
        feeRouter = feeRouter_;
    }

    receive() external payable {
        if (msg.sender != address(feeEscrow)) revert OnlyFeeEscrow();
    }

    function collect() external nonReentrant returns (uint256 amount) {
        return _collect();
    }

    /// @notice Moves pre-graduation PONS fees into escrow, claims them and forwards them to FeeRouter.
    /// @dev Permissionless, but accepts only a curve whose creator recipient is this contract.
    function sweepCurveAndCollect(address curve) external nonReentrant returns (uint256 amount) {
        if (curve == address(0)) revert ZeroAddress();
        IPonsV2BondingCurveFeeSweep ponsCurve = IPonsV2BondingCurveFeeSweep(curve);
        if (ponsCurve.deployer() != address(this)) revert UnexpectedCurve();
        if (ponsCurve.graduated()) revert CurveAlreadyGraduated();
        if (ponsCurve.buybackEnabled()) revert PonsBuybackMustBeDisabled();
        ponsCurve.sweepFees(0);
        emit CurveFeesSwept(curve);
        return _collect();
    }

    function _collect() private returns (uint256 amount) {
        uint256 beforeBalance = address(this).balance;
        amount = feeEscrow.claim();
        uint256 received = address(this).balance - beforeBalance;
        if (amount == 0) revert NothingToCollect();
        if (received != amount) revert ClaimAmountMismatch();
        feeRouter.sendValue(amount);
        emit FeesCollected(amount);
    }

    /// @notice Forwards ETH forced into this contract outside the normal escrow claim.
    function forwardForcedEth() external nonReentrant returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToCollect();
        feeRouter.sendValue(amount);
        emit ForcedEthForwarded(amount);
    }
}
