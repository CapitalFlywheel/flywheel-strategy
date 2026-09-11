// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Holds the governed MSTR reserve separately from holder rewards.
contract StrategicReserveVault is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    struct LockTranche {
        uint128 amount;
        uint64 unlockAt;
    }

    IERC20 public immutable mstr;
    LockTranche[] public locks;

    event MstrLocked(uint256 amount, uint64 unlockAt);
    event MstrReleased(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error InvalidLockDuration();
    error InsufficientAvailableBalance();
    error AmountTooLarge();

    constructor(address admin, address executor, address mstr_) {
        if (admin == address(0) || executor == address(0) || mstr_ == address(0)) revert ZeroAddress();
        mstr = IERC20(mstr_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, executor);
    }

    function lockMstr(uint256 amount, uint32 duration) external onlyRole(EXECUTOR_ROLE) {
        if (!_allowedDuration(duration)) revert InvalidLockDuration();
        if (amount > availableBalance()) revert InsufficientAvailableBalance();
        if (amount > type(uint128).max) revert AmountTooLarge();
        uint64 unlockAt = duration == type(uint32).max
            ? type(uint64).max
            : uint64(block.timestamp + duration);
        locks.push(LockTranche({amount: uint128(amount), unlockAt: unlockAt}));
        emit MstrLocked(amount, unlockAt);
    }

    function releaseMstr(address recipient, uint256 amount) external onlyRole(EXECUTOR_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount > availableBalance()) revert InsufficientAvailableBalance();
        mstr.safeTransfer(recipient, amount);
        emit MstrReleased(recipient, amount);
    }

    function lockedBalance() public view returns (uint256 total) {
        uint256 length = locks.length;
        for (uint256 i; i < length; ++i) {
            if (locks[i].unlockAt > block.timestamp) total += locks[i].amount;
        }
    }

    function availableBalance() public view returns (uint256) {
        return mstr.balanceOf(address(this)) - lockedBalance();
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
