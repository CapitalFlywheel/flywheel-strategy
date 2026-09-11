// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMstrSwapAdapter {
    /// @notice Swaps native ETH for MSTR and sends MSTR directly to recipient.
    /// @dev The adapter must revert when amountOut is below minAmountOut.
    function swapExactEthForMstr(address recipient, uint256 minAmountOut)
        external
        payable
        returns (uint256 amountOut);
}

