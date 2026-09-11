// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The production adapter will contain only the approved Robinhood Chain routes.
interface IReserveActionAdapter {
    enum BuybackMode {
        HOLD,
        BURN,
        LOCK
    }

    function buyProjectToken(
        uint256 proposalId,
        uint256 mstrAmount,
        BuybackMode mode,
        address recipient,
        uint16 maxSlippageBps
    ) external returns (uint256 projectTokenOut);

    function sellMstrForEth(
        uint256 proposalId,
        uint256 mstrAmount,
        address recipient,
        uint16 maxSlippageBps
    ) external returns (uint256 ethOut);
}
