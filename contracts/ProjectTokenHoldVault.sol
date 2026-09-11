// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Transparent permanent custody for project tokens bought back in HOLD mode.
/// There is intentionally no withdrawal or admin function.
contract ProjectTokenHoldVault {
    IERC20 public immutable projectToken;

    error ZeroAddress();

    constructor(address projectToken_) {
        if (projectToken_ == address(0)) revert ZeroAddress();
        projectToken = IERC20(projectToken_);
    }

    function balance() external view returns (uint256) {
        return projectToken.balanceOf(address(this));
    }
}
