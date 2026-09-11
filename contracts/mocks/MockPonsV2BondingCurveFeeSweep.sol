// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMockPonsV2FeeEscrowCredit {
    function credit(address recipient) external payable;
}

contract MockPonsV2BondingCurveFeeSweep {
    IMockPonsV2FeeEscrowCredit public immutable feeEscrow;
    address public deployer;
    bool public graduated;
    bool public buybackEnabled;

    constructor(address feeEscrow_, address deployer_) {
        feeEscrow = IMockPonsV2FeeEscrowCredit(feeEscrow_);
        deployer = deployer_;
    }

    receive() external payable {}

    function setDeployer(address value) external {
        deployer = value;
    }

    function setGraduated(bool value) external {
        graduated = value;
    }

    function setBuybackEnabled(bool value) external {
        buybackEnabled = value;
    }

    function sweepFees(uint256) external {
        require(msg.sender == deployer, "NOT_CREATOR");
        uint256 amount = address(this).balance;
        if (amount != 0) feeEscrow.credit{value: amount}(deployer);
    }
}
