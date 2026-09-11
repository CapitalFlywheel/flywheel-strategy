// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMstrSwapAdapter} from "./interfaces/IMstrSwapAdapter.sol";

/// @notice Uses the cheaper V4 route first, then automatically retries through V3 if V4 fails.
contract FallbackMstrSwapAdapter is IMstrSwapAdapter, ReentrancyGuard {
    IMstrSwapAdapter public immutable primary;
    IMstrSwapAdapter public immutable fallbackAdapter;

    event PrimaryRouteFailed(bytes reason);
    event RouteUsed(bool indexed primaryRoute, uint256 ethIn, uint256 mstrOut);

    error ZeroAddress();

    constructor(address primary_, address fallback_) {
        if (primary_ == address(0) || fallback_ == address(0)) revert ZeroAddress();
        primary = IMstrSwapAdapter(primary_);
        fallbackAdapter = IMstrSwapAdapter(fallback_);
    }

    function swapExactEthForMstr(address recipient, uint256 minMstrOut)
        external
        payable
        nonReentrant
        returns (uint256 mstrOut)
    {
        try primary.swapExactEthForMstr{value: msg.value}(recipient, minMstrOut) returns (uint256 output) {
            emit RouteUsed(true, msg.value, output);
            return output;
        } catch (bytes memory reason) {
            emit PrimaryRouteFailed(reason);
            mstrOut = fallbackAdapter.swapExactEthForMstr{value: msg.value}(recipient, minMstrOut);
            emit RouteUsed(false, msg.value, mstrOut);
        }
    }
}
