// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IGovernanceExecutor} from "./interfaces/IGovernanceExecutor.sol";

/// @notice Team-curated, holder-decided governance with a fixed action allowlist.
contract GovernanceController is AccessControl, ReentrancyGuard {
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");

    uint32 public constant MIN_VOTING_DURATION = 1 hours;
    uint32 public constant MAX_VOTING_DURATION = 12 hours;
    uint32 public constant EXECUTION_DELAY = 5 minutes;
    uint16 public constant QUORUM_BPS = 700;
    uint16 private constant BPS = 10_000;

    struct Option {
        IGovernanceExecutor.ActionType action;
        uint16 reserveBps;
        uint128 reserveAmount;
        uint32 lockDuration;
        address recipient;
    }

    struct Proposal {
        uint64 startsAt;
        uint64 endsAt;
        uint64 executableAt;
        bytes32 weightRoot;
        uint128 totalAvailableWeight;
        uint128 totalCastWeight;
        uint8 optionCount;
        bool executed;
        bool passed;
        uint8 winningOption;
    }

    IGovernanceExecutor public immutable executor;
    uint256 public proposalCount;
    uint256 public activeProposalId;

    mapping(uint256 proposalId => Proposal proposal) public proposals;
    mapping(uint256 proposalId => mapping(uint8 optionIndex => Option option)) private _options;
    mapping(uint256 proposalId => mapping(uint8 optionIndex => uint256 votes)) public optionVotes;
    mapping(uint256 proposalId => mapping(address voter => bool voted)) public hasVoted;

    event ProposalCreated(
        uint256 indexed proposalId,
        uint64 startsAt,
        uint64 endsAt,
        uint64 executableAt,
        bytes32 weightRoot,
        uint256 totalAvailableWeight,
        uint8 optionCount
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 indexed optionIndex, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId, uint8 indexed winningOption, uint256 winningWeight);
    event ProposalRejected(uint256 indexed proposalId, string reason);

    error ZeroAddress();
    error InvalidDuration();
    error InvalidOptionCount();
    error InvalidOption();
    error DuplicateAction();
    error ProposalNotActive();
    error ProposalNotExecutable();
    error AlreadyVoted();
    error AlreadyExecuted();
    error InvalidProof();
    error WeightTooLarge();
    error ActiveProposalExists();
    error ReserveAmountTooLarge();

    constructor(address admin, address proposer, address executor_) {
        if (admin == address(0) || proposer == address(0) || executor_ == address(0)) revert ZeroAddress();
        executor = IGovernanceExecutor(executor_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PROPOSER_ROLE, proposer);
    }

    function createProposal(
        bytes32 weightRoot,
        uint128 totalAvailableWeight,
        uint32 votingDuration,
        Option[] calldata options
    ) external onlyRole(PROPOSER_ROLE) returns (uint256 proposalId) {
        if (activeProposalId != 0) revert ActiveProposalExists();
        if (votingDuration < MIN_VOTING_DURATION || votingDuration > MAX_VOTING_DURATION) {
            revert InvalidDuration();
        }
        if (options.length < 2 || options.length > 6 || totalAvailableWeight == 0 || weightRoot == bytes32(0)) {
            revert InvalidOptionCount();
        }

        uint256 seenActions;
        proposalId = ++proposalCount;
        activeProposalId = proposalId;
        uint64 startsAt = uint64(block.timestamp);
        uint64 endsAt = uint64(block.timestamp + votingDuration);

        proposals[proposalId] = Proposal({
            startsAt: startsAt,
            endsAt: endsAt,
            executableAt: uint64(endsAt + EXECUTION_DELAY),
            weightRoot: weightRoot,
            totalAvailableWeight: totalAvailableWeight,
            totalCastWeight: 0,
            optionCount: uint8(options.length),
            executed: false,
            passed: false,
            winningOption: 0
        });

        for (uint8 i; i < options.length; ++i) {
            Option calldata option = options[i];
            if (option.reserveBps > BPS) revert InvalidOption();
            uint256 actionBit = 1 << uint8(option.action);
            if (seenActions & actionBit != 0) revert DuplicateAction();
            seenActions |= actionBit;
            _validateOption(option);
            uint256 reserveAmount = executor.previewReserveAmount(option.reserveBps);
            if (reserveAmount > type(uint128).max) revert ReserveAmountTooLarge();
            _options[proposalId][i] = Option({
                action: option.action,
                reserveBps: option.reserveBps,
                reserveAmount: uint128(reserveAmount),
                lockDuration: option.lockDuration,
                recipient: option.recipient
            });
        }

        emit ProposalCreated(
            proposalId,
            startsAt,
            endsAt,
            uint64(endsAt + EXECUTION_DELAY),
            weightRoot,
            totalAvailableWeight,
            uint8(options.length)
        );
    }

    function vote(uint256 proposalId, uint8 optionIndex, uint256 weight, bytes32[] calldata proof) external {
        Proposal storage proposal = proposals[proposalId];
        if (block.timestamp < proposal.startsAt || block.timestamp >= proposal.endsAt || optionIndex >= proposal.optionCount) {
            revert ProposalNotActive();
        }
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        if (weight > type(uint128).max) revert WeightTooLarge();
        if (uint256(proposal.totalCastWeight) + weight > proposal.totalAvailableWeight) revert WeightTooLarge();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, weight))));
        if (!MerkleProof.verifyCalldata(proof, proposal.weightRoot, leaf)) revert InvalidProof();

        hasVoted[proposalId][msg.sender] = true;
        proposal.totalCastWeight += uint128(weight);
        optionVotes[proposalId][optionIndex] += weight;
        emit VoteCast(proposalId, msg.sender, optionIndex, weight);
    }

    /// @notice Called automatically by keeper bots after the five-minute delay.
    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.executed) revert AlreadyExecuted();
        if (block.timestamp < proposal.executableAt) revert ProposalNotExecutable();
        proposal.executed = true;
        activeProposalId = 0;

        if (uint256(proposal.totalCastWeight) * BPS < uint256(proposal.totalAvailableWeight) * QUORUM_BPS) {
            emit ProposalRejected(proposalId, "QUORUM_NOT_REACHED");
            return;
        }

        (uint8 winner, uint256 winningWeight, bool tied) = _winner(proposalId, proposal.optionCount);
        if (tied) {
            emit ProposalRejected(proposalId, "TIED_RESULT");
            return;
        }

        proposal.passed = true;
        proposal.winningOption = winner;
        Option memory option = _options[proposalId][winner];
        executor.executeOption(
            proposalId,
            option.action,
            option.reserveBps,
            option.reserveAmount,
            option.lockDuration,
            option.recipient
        );
        emit ProposalExecuted(proposalId, winner, winningWeight);
    }

    function getOption(uint256 proposalId, uint8 optionIndex) external view returns (Option memory) {
        return _options[proposalId][optionIndex];
    }

    function _winner(uint256 proposalId, uint8 optionCount)
        private
        view
        returns (uint8 winner, uint256 winningWeight, bool tied)
    {
        for (uint8 i; i < optionCount; ++i) {
            uint256 votes = optionVotes[proposalId][i];
            if (votes > winningWeight) {
                winner = i;
                winningWeight = votes;
                tied = false;
            } else if (votes == winningWeight) {
                tied = true;
            }
        }
    }

    function _validateOption(Option calldata option) private view {
        if (option.action == IGovernanceExecutor.ActionType.ACCUMULATE) {
            if (
                option.reserveBps != 0 || option.reserveAmount != 0 || option.lockDuration != 0
                    || option.recipient != address(0)
            ) {
                revert InvalidOption();
            }
            return;
        }

        if (option.reserveBps == 0 || option.reserveAmount != 0) revert InvalidOption();

        if (
            option.action == IGovernanceExecutor.ActionType.BUYBACK_LOCK
                || option.action == IGovernanceExecutor.ActionType.LOCK_MSTR
        ) {
            if (!_allowedLockDuration(option.lockDuration) || option.recipient != address(0)) revert InvalidOption();
        } else if (option.action == IGovernanceExecutor.ActionType.MARKETING_SALE) {
            if (option.recipient != executor.marketingWallet() || option.lockDuration != 0) revert InvalidOption();
        } else if (option.lockDuration != 0 || option.recipient != address(0)) {
            revert InvalidOption();
        }
    }

    function _allowedLockDuration(uint32 duration) private pure returns (bool) {
        return duration == 30 days || duration == 90 days || duration == 180 days || duration == 365 days
            || duration == 730 days || duration == 1095 days || duration == 1825 days
            || duration == type(uint32).max;
    }
}
