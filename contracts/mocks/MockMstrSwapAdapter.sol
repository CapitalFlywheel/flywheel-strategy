// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMstrSwapAdapter} from "../interfaces/IMstrSwapAdapter.sol";
import {MockERC20} from "./MockERC20.sol";

contract MockMstrSwapAdapter is IMstrSwapAdapter {
    MockERC20 public immutable mstr;
    uint256 public rate;

    constructor(address mstr_, uint256 rate_) {
        mstr = MockERC20(mstr_);
        rate = rate_;
    }

    function setRate(uint256 newRate) external {
        rate = newRate;
    }

    function swapExactEthForMstr(address recipient, uint256 minAmountOut)
        external
        payable
        returns (uint256 amountOut)
    {
        amountOut = msg.value * rate / 1 ether;
        require(amountOut >= minAmountOut, "SLIPPAGE");
        mstr.mint(recipient, amountOut);
    }
}

