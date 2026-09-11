// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Enforces voted project-token locks, then moves matured tokens to permanent HOLD custody.
contract ProjectTokenTimeLockVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LockTranche {
        uint128 amount;
        uint64 unlockAt;
        bool released;
    }

    address public immutable initializer;
    IERC20 public immutable projectToken;
    address public immutable holdVault;
    address public executor;
    uint256 public accountedBalance;
    LockTranche[] public locks;

    event ExecutorInitialized(address indexed executor);
    event TokensLocked(uint256 indexed proposalId, uint256 indexed lockId, uint256 amount, uint64 unlockAt);
    event TokensReleased(uint256 indexed lockId, uint256 amount);

    error ZeroAddress();
    error OnlyExecutor();
    error ExecutorAlreadyInitialized();
    error InvalidAmount();
    error InvalidDuration();
    error TokensNotReceived();
    error LockNotMature();
    error AlreadyReleased();
    error AmountTooLarge();

    constructor(address initializer_, address projectToken_, address holdVault_) {
        if (initializer_ == address(0) || projectToken_ == address(0) || holdVault_ == address(0)) revert ZeroAddress();
        initializer = initializer_;
        projectToken = IERC20(projectToken_);
        holdVault = holdVault_;
    }

    function initializeExecutor(address executor_) external {
        if (msg.sender != initializer) revert OnlyExecutor();
        if (executor != address(0)) revert ExecutorAlreadyInitialized();
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
        emit ExecutorInitialized(executor_);
    }

    function registerLock(uint256 proposalId, uint256 amount, uint32 duration) external returns (uint256 lockId) {
        if (msg.sender != executor) revert OnlyExecutor();
        if (amount == 0) revert InvalidAmount();
        if (!_allowedDuration(duration)) revert InvalidDuration();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (projectToken.balanceOf(address(this)) < accountedBalance + amount) revert TokensNotReceived();
        uint64 unlockAt = duration == type(uint32).max ? type(uint64).max : uint64(block.timestamp + duration);
        accountedBalance += amount;
        lockId = locks.length;
        locks.push(LockTranche({amount: uint128(amount), unlockAt: unlockAt, released: false}));
        emit TokensLocked(proposalId, lockId, amount, unlockAt);
    }

    function release(uint256 lockId) external nonReentrant {
        LockTranche storage tranche = locks[lockId];
        if (tranche.released) revert AlreadyReleased();
        if (block.timestamp < tranche.unlockAt) revert LockNotMature();
        tranche.released = true;
        accountedBalance -= tranche.amount;
        projectToken.safeTransfer(holdVault, tranche.amount);
        emit TokensReleased(lockId, tranche.amount);
    }

    function lockCount() external view returns (uint256) {
        return locks.length;
    }

    function _allowedDuration(uint32 duration) private pure returns (bool) {
        return duration == 30 days || duration == 90 days || duration == 180 days || duration == 365 days
            || duration == 730 days || duration == 1095 days || duration == 1825 days
            || duration == type(uint32).max;
    }
}
