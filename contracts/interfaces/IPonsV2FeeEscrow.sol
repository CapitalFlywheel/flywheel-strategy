// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPonsV2FeeEscrow {
    function claim() external returns (uint256 amount);
    function balanceOf(address recipient) external view returns (uint256);
}
