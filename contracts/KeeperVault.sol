// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @notice Publicly visible ETH budget used only to reimburse approved automation jobs.
contract KeeperVault is AccessControl, ReentrancyGuard {
    using Address for address payable;

    bytes32 public constant AUTOMATION_ROLE = keccak256("AUTOMATION_ROLE");
    uint256 public maxReimbursementWei;
    mapping(bytes32 jobId => bool reimbursed) public jobReimbursed;

    event Funded(address indexed sender, uint256 amount);
    event Reimbursed(bytes32 indexed jobId, address indexed recipient, uint256 amount);
    event MaxReimbursementUpdated(uint256 previousAmount, uint256 newAmount);

    error ZeroAddress();
    error InvalidAmount();
    error AmountAboveCap();
    error JobAlreadyReimbursed();

    constructor(address admin, address automation, uint256 maxReimbursementWei_) {
        if (admin == address(0) || automation == address(0)) revert ZeroAddress();
        if (maxReimbursementWei_ == 0) revert InvalidAmount();
        maxReimbursementWei = maxReimbursementWei_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AUTOMATION_ROLE, automation);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function reimburse(bytes32 jobId, address payable recipient, uint256 amount)
        external
        onlyRole(AUTOMATION_ROLE)
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (amount > maxReimbursementWei) revert AmountAboveCap();
        if (jobReimbursed[jobId]) revert JobAlreadyReimbursed();
        jobReimbursed[jobId] = true;
        recipient.sendValue(amount);
        emit Reimbursed(jobId, recipient, amount);
    }

    function setMaxReimbursementWei(uint256 newAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAmount == 0) revert InvalidAmount();
        uint256 previous = maxReimbursementWei;
        maxReimbursementWei = newAmount;
        emit MaxReimbursementUpdated(previous, newAmount);
    }
}
