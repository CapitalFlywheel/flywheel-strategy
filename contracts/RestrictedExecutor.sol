// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGovernanceExecutor} from "./interfaces/IGovernanceExecutor.sol";
import {IReserveActionAdapter} from "./interfaces/IReserveActionAdapter.sol";
import {IStrategicReserveVault} from "./interfaces/IStrategicReserveVault.sol";

interface IProjectTokenTimeLockVault {
    function registerLock(uint256 proposalId, uint256 amount, uint32 duration) external returns (uint256 lockId);
}

/// @notice Executes only the six governance actions and cannot invent a seventh action.
contract RestrictedExecutor is IGovernanceExecutor {
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public governance;
    address public immutable initializer;
    IStrategicReserveVault public immutable reserveVault;
    IReserveActionAdapter public immutable actionAdapter;
    address public immutable projectHoldVault;
    address public immutable projectTokenLockVault;
    address public immutable marketingWallet;

    mapping(uint256 proposalId => bool executed) public proposalExecuted;

    event OptionExecuted(
        uint256 indexed proposalId,
        ActionType indexed action,
        uint16 reserveBps,
        uint256 reserveAmount,
        uint32 lockDuration,
        address recipient,
        uint256 outputAmount
    );

    error ZeroAddress();
    error OnlyGovernance();
    error ProposalAlreadyExecuted();
    error InvalidParameters();
    error ReserveBalanceChanged();
    error GovernanceAlreadyInitialized();

    constructor(
        address initializer_,
        address reserveVault_,
        address actionAdapter_,
        address projectHoldVault_,
        address projectTokenLockVault_,
        address marketingWallet_
    ) {
        if (
            initializer_ == address(0) || reserveVault_ == address(0) || actionAdapter_ == address(0)
                || projectHoldVault_ == address(0) || projectTokenLockVault_ == address(0)
                || marketingWallet_ == address(0)
        ) revert ZeroAddress();
        initializer = initializer_;
        reserveVault = IStrategicReserveVault(reserveVault_);
        actionAdapter = IReserveActionAdapter(actionAdapter_);
        projectHoldVault = projectHoldVault_;
        projectTokenLockVault = projectTokenLockVault_;
        marketingWallet = marketingWallet_;
    }

    /// @notice One-time binding removes the circular deployment dependency with GovernanceController.
    function initializeGovernance(address governance_) external {
        if (msg.sender != initializer) revert OnlyGovernance();
        if (governance != address(0)) revert GovernanceAlreadyInitialized();
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
    }

    function previewReserveAmount(uint16 reserveBps) external view returns (uint256) {
        if (reserveBps > BPS) revert InvalidParameters();
        return reserveVault.availableBalance() * reserveBps / BPS;
    }

    function executeOption(
        uint256 proposalId,
        ActionType action,
        uint16 reserveBps,
        uint256 reserveAmount,
        uint32 lockDuration,
        address recipient
    ) external {
        if (msg.sender != governance) revert OnlyGovernance();
        if (proposalExecuted[proposalId]) revert ProposalAlreadyExecuted();
        proposalExecuted[proposalId] = true;

        if (action == ActionType.ACCUMULATE) {
            if (reserveBps != 0 || reserveAmount != 0 || lockDuration != 0 || recipient != address(0)) {
                revert InvalidParameters();
            }
            emit OptionExecuted(proposalId, action, 0, 0, 0, address(0), 0);
            return;
        }

        if (reserveBps == 0 || reserveBps > BPS || reserveAmount == 0) revert InvalidParameters();
        if (reserveAmount > reserveVault.availableBalance()) revert ReserveBalanceChanged();

        uint256 outputAmount;
        if (action == ActionType.LOCK_MSTR) {
            if (lockDuration == 0 || recipient != address(0)) revert InvalidParameters();
            reserveVault.lockMstr(reserveAmount, lockDuration);
        } else {
            reserveVault.releaseMstr(address(actionAdapter), reserveAmount);

            if (action == ActionType.BUYBACK_HOLD) {
                if (lockDuration != 0 || recipient != address(0)) revert InvalidParameters();
                outputAmount = actionAdapter.buyProjectToken(
                    proposalId,
                    reserveAmount,
                    IReserveActionAdapter.BuybackMode.HOLD,
                    projectHoldVault,
                    MAX_SLIPPAGE_BPS
                );
            } else if (action == ActionType.BUYBACK_BURN) {
                if (lockDuration != 0 || recipient != address(0)) revert InvalidParameters();
                outputAmount = actionAdapter.buyProjectToken(
                    proposalId,
                    reserveAmount,
                    IReserveActionAdapter.BuybackMode.BURN,
                    BURN_ADDRESS,
                    MAX_SLIPPAGE_BPS
                );
            } else if (action == ActionType.BUYBACK_LOCK) {
                if (lockDuration == 0 || recipient != address(0)) revert InvalidParameters();
                outputAmount = actionAdapter.buyProjectToken(
                    proposalId,
                    reserveAmount,
                    IReserveActionAdapter.BuybackMode.LOCK,
                    projectTokenLockVault,
                    MAX_SLIPPAGE_BPS
                );
                IProjectTokenTimeLockVault(projectTokenLockVault).registerLock(
                    proposalId, outputAmount, lockDuration
                );
            } else if (action == ActionType.MARKETING_SALE) {
                if (lockDuration != 0 || recipient != marketingWallet) revert InvalidParameters();
                outputAmount = actionAdapter.sellMstrForEth(
                    proposalId, reserveAmount, recipient, MAX_SLIPPAGE_BPS
                );
            } else {
                revert InvalidParameters();
            }
        }

        emit OptionExecuted(
            proposalId, action, reserveBps, reserveAmount, lockDuration, recipient, outputAmount
        );
    }
}
