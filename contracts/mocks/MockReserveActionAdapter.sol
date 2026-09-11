// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IReserveActionAdapter} from "../interfaces/IReserveActionAdapter.sol";
import {MockERC20} from "./MockERC20.sol";

contract MockReserveActionAdapter is IReserveActionAdapter {
    IERC20 public immutable mstr;
    MockERC20 public immutable projectToken;
    uint256 public immutable projectTokensPerMstr;

    uint256 public lastProposalId;
    uint256 public lastMstrAmount;
    BuybackMode public lastMode;
    address public lastRecipient;
    uint16 public lastMaxSlippageBps;

    constructor(address mstr_, address projectToken_, uint256 projectTokensPerMstr_) {
        mstr = IERC20(mstr_);
        projectToken = MockERC20(projectToken_);
        projectTokensPerMstr = projectTokensPerMstr_;
    }

    function buyProjectToken(
        uint256 proposalId,
        uint256 mstrAmount,
        BuybackMode mode,
        address recipient,
        uint16 maxSlippageBps
    ) external returns (uint256 projectTokenOut) {
        lastProposalId = proposalId;
        lastMstrAmount = mstrAmount;
        lastMode = mode;
        lastRecipient = recipient;
        lastMaxSlippageBps = maxSlippageBps;
        projectTokenOut = mstrAmount * projectTokensPerMstr;
        projectToken.mint(recipient, projectTokenOut);
    }

    function sellMstrForEth(
        uint256 proposalId,
        uint256 mstrAmount,
        address recipient,
        uint16 maxSlippageBps
    ) external returns (uint256 ethOut) {
        lastProposalId = proposalId;
        lastMstrAmount = mstrAmount;
        lastRecipient = recipient;
        lastMaxSlippageBps = maxSlippageBps;
        ethOut = 0;
    }
}
