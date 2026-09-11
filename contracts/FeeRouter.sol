// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IMstrSwapAdapter} from "./interfaces/IMstrSwapAdapter.sol";

/// @notice Receives creator fees in ETH and separates reward, reserve and automation funds.
contract FeeRouter is AccessControl, Pausable, ReentrancyGuard {
    using Address for address payable;

    bytes32 public constant AUTOMATION_ROLE = keccak256("AUTOMATION_ROLE");

    uint16 public constant BPS = 10_000;
    uint16 public constant REWARD_BPS = 5_000;
    uint16 public constant RESERVE_BPS = 4_000;
    uint16 public constant KEEPER_BPS = 1_000;

    address public immutable rewardVault;
    address public immutable reserveVault;
    address payable public immutable keeperVault;

    IMstrSwapAdapter public swapAdapter;
    mapping(address adapter => bool allowed) public allowedSwapAdapters;
    uint256 public unallocatedEth;
    uint256 public pendingRewardEth;
    uint256 public pendingReserveEth;

    event FeesReceived(address indexed sender, uint256 amount);
    event FeesAllocated(uint256 rewardEth, uint256 reserveEth, uint256 keeperEth);
    event RewardMstrPurchased(uint256 ethIn, uint256 mstrOut);
    event ReserveMstrPurchased(uint256 ethIn, uint256 mstrOut);
    event SwapAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);
    event SwapAdapterPermissionUpdated(address indexed adapter, bool allowed);

    error ZeroAddress();
    error ZeroAmount();
    error AmountExceedsPending();
    error AdapterNotAllowed();

    constructor(
        address admin,
        address automation,
        address rewardVault_,
        address reserveVault_,
        address payable keeperVault_,
        address swapAdapter_
    ) {
        if (
            admin == address(0) || automation == address(0) || rewardVault_ == address(0)
                || reserveVault_ == address(0) || keeperVault_ == address(0) || swapAdapter_ == address(0)
        ) revert ZeroAddress();

        rewardVault = rewardVault_;
        reserveVault = reserveVault_;
        keeperVault = keeperVault_;
        swapAdapter = IMstrSwapAdapter(swapAdapter_);
        allowedSwapAdapters[swapAdapter_] = true;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AUTOMATION_ROLE, automation);
    }

    receive() external payable {
        unallocatedEth += msg.value;
        emit FeesReceived(msg.sender, msg.value);
    }

    /// @notice Splits every newly received wei. Anyone may keep allocation moving.
    function allocate() external nonReentrant whenNotPaused {
        uint256 amount = unallocatedEth;
        if (amount == 0) revert ZeroAmount();
        unallocatedEth = 0;

        uint256 rewardAmount = amount * REWARD_BPS / BPS;
        uint256 reserveAmount = amount * RESERVE_BPS / BPS;
        uint256 keeperAmount = amount - rewardAmount - reserveAmount;

        pendingRewardEth += rewardAmount;
        pendingReserveEth += reserveAmount;
        keeperVault.sendValue(keeperAmount);

        emit FeesAllocated(rewardAmount, reserveAmount, keeperAmount);
    }

    function buyRewardMstr(uint256 ethAmount, uint256 minMstrOut)
        external
        onlyRole(AUTOMATION_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 mstrOut)
    {
        return _buyRewardMstr(swapAdapter, ethAmount, minMstrOut);
    }

    function buyRewardMstrWithAdapter(address adapter, uint256 ethAmount, uint256 minMstrOut)
        external
        onlyRole(AUTOMATION_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 mstrOut)
    {
        if (!allowedSwapAdapters[adapter]) revert AdapterNotAllowed();
        return _buyRewardMstr(IMstrSwapAdapter(adapter), ethAmount, minMstrOut);
    }

    function buyReserveMstr(uint256 ethAmount, uint256 minMstrOut)
        external
        onlyRole(AUTOMATION_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 mstrOut)
    {
        return _buyReserveMstr(swapAdapter, ethAmount, minMstrOut);
    }

    function buyReserveMstrWithAdapter(address adapter, uint256 ethAmount, uint256 minMstrOut)
        external
        onlyRole(AUTOMATION_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 mstrOut)
    {
        if (!allowedSwapAdapters[adapter]) revert AdapterNotAllowed();
        return _buyReserveMstr(IMstrSwapAdapter(adapter), ethAmount, minMstrOut);
    }

    function setSwapAdapter(address newAdapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAdapter == address(0)) revert ZeroAddress();
        address previous = address(swapAdapter);
        swapAdapter = IMstrSwapAdapter(newAdapter);
        allowedSwapAdapters[newAdapter] = true;
        emit SwapAdapterUpdated(previous, newAdapter);
        emit SwapAdapterPermissionUpdated(newAdapter, true);
    }

    function setSwapAdapterAllowed(address adapter, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (adapter == address(0)) revert ZeroAddress();
        if (!allowed && adapter == address(swapAdapter)) revert AdapterNotAllowed();
        allowedSwapAdapters[adapter] = allowed;
        emit SwapAdapterPermissionUpdated(adapter, allowed);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _buyRewardMstr(IMstrSwapAdapter adapter, uint256 ethAmount, uint256 minMstrOut)
        private
        returns (uint256 mstrOut)
    {
        if (ethAmount == 0) revert ZeroAmount();
        if (ethAmount > pendingRewardEth) revert AmountExceedsPending();
        pendingRewardEth -= ethAmount;
        mstrOut = adapter.swapExactEthForMstr{value: ethAmount}(rewardVault, minMstrOut);
        emit RewardMstrPurchased(ethAmount, mstrOut);
    }

    function _buyReserveMstr(IMstrSwapAdapter adapter, uint256 ethAmount, uint256 minMstrOut)
        private
        returns (uint256 mstrOut)
    {
        if (ethAmount == 0) revert ZeroAmount();
        if (ethAmount > pendingReserveEth) revert AmountExceedsPending();
        pendingReserveEth -= ethAmount;
        mstrOut = adapter.swapExactEthForMstr{value: ethAmount}(reserveVault, minMstrOut);
        emit ReserveMstrPurchased(ethAmount, mstrOut);
    }
}
