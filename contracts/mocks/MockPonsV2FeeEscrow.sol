// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockPonsV2FeeEscrow {
    mapping(address => uint256) public balanceOf;

    function credit(address recipient) external payable {
        balanceOf[recipient] += msg.value;
    }

    function claim() external returns (uint256 amount) {
        amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        require(success);
    }
}
