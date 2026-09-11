// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStrategicReserveVault {
    function availableBalance() external view returns (uint256);
    function lockMstr(uint256 amount, uint32 duration) external;
    function releaseMstr(address recipient, uint256 amount) external;
}
