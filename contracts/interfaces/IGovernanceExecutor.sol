// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGovernanceExecutor {
    enum ActionType {
        ACCUMULATE,
        BUYBACK_HOLD,
        BUYBACK_BURN,
        BUYBACK_LOCK,
        LOCK_MSTR,
        MARKETING_SALE
    }

    function previewReserveAmount(uint16 reserveBps) external view returns (uint256);
    function marketingWallet() external view returns (address);

    function executeOption(
        uint256 proposalId,
        ActionType action,
        uint16 reserveBps,
        uint256 reserveAmount,
        uint32 lockDuration,
        address recipient
    ) external;
}
