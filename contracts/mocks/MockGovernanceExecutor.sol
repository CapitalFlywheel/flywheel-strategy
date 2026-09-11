// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGovernanceExecutor} from "../interfaces/IGovernanceExecutor.sol";

contract MockGovernanceExecutor is IGovernanceExecutor {
    uint256 public lastProposalId;
    ActionType public lastAction;
    uint16 public lastReserveBps;
    uint256 public lastReserveAmount;
    uint32 public lastLockDuration;
    address public lastRecipient;
    uint256 public executions;
    uint256 public previewBase = 1_000;
    address public marketingWallet = address(1);

    function setMarketingWallet(address wallet) external {
        marketingWallet = wallet;
    }

    function previewReserveAmount(uint16 reserveBps) external view returns (uint256) {
        return previewBase * reserveBps / 10_000;
    }

    function executeOption(
        uint256 proposalId,
        ActionType action,
        uint16 reserveBps,
        uint256 reserveAmount,
        uint32 lockDuration,
        address recipient
    ) external {
        lastProposalId = proposalId;
        lastAction = action;
        lastReserveBps = reserveBps;
        lastReserveAmount = reserveAmount;
        lastLockDuration = lockDuration;
        lastRecipient = recipient;
        ++executions;
    }
}
