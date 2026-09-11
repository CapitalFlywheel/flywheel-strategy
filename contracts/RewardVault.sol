// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Holds only MSTR allocated to passive holders and supports cumulative claims.
contract RewardVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ROOT_PUBLISHER_ROLE = keccak256("ROOT_PUBLISHER_ROLE");

    IERC20 public immutable mstr;
    bytes32 public merkleRoot;
    uint64 public latestEpoch;
    uint256 public cumulativeAllocated;
    uint256 public totalClaimed;

    mapping(address account => uint256 amount) public claimed;

    event DistributionPublished(uint64 indexed epoch, bytes32 indexed merkleRoot, uint256 cumulativeAllocated);
    event RewardClaimed(address indexed account, uint256 amount, uint256 cumulativeAmount);

    error ZeroAddress();
    error EpochNotIncreasing();
    error AllocationDecreased();
    error AllocationNotFunded();
    error InvalidProof();
    error NothingToClaim();
    error EmptyRoot();

    constructor(address admin, address rootPublisher, address mstr_) {
        if (admin == address(0) || rootPublisher == address(0) || mstr_ == address(0)) revert ZeroAddress();
        mstr = IERC20(mstr_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROOT_PUBLISHER_ROLE, rootPublisher);
    }

    function publishDistribution(uint64 epoch, bytes32 newRoot, uint256 newCumulativeAllocated)
        external
        onlyRole(ROOT_PUBLISHER_ROLE)
    {
        if (epoch <= latestEpoch) revert EpochNotIncreasing();
        if (newRoot == bytes32(0)) revert EmptyRoot();
        if (newCumulativeAllocated < cumulativeAllocated) revert AllocationDecreased();
        if (newCumulativeAllocated > mstr.balanceOf(address(this)) + totalClaimed) revert AllocationNotFunded();

        latestEpoch = epoch;
        merkleRoot = newRoot;
        cumulativeAllocated = newCumulativeAllocated;
        emit DistributionPublished(epoch, newRoot, newCumulativeAllocated);
    }

    function claim(uint256 cumulativeAmount, bytes32[] calldata proof) external nonReentrant whenNotPaused {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        uint256 previous = claimed[msg.sender];
        if (cumulativeAmount <= previous) revert NothingToClaim();
        uint256 amount = cumulativeAmount - previous;

        claimed[msg.sender] = cumulativeAmount;
        totalClaimed += amount;
        mstr.safeTransfer(msg.sender, amount);
        emit RewardClaimed(msg.sender, amount, cumulativeAmount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
