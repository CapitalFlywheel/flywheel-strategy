// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMstrSwapAdapter} from "./interfaces/IMstrSwapAdapter.sol";
import {IUniversalRouter} from "./interfaces/IUniversalRouter.sol";

/// @notice Fixed fallback route: native ETH -> WETH -> official MSTR on Uniswap V3.
contract UniswapV3MstrSwapAdapter is IMstrSwapAdapter, ReentrancyGuard {
    bytes1 private constant WRAP_ETH = 0x0b;
    bytes1 private constant V3_SWAP_EXACT_IN = 0x00;
    address private constant ROUTER_BALANCE = address(2);

    uint24 public constant POOL_FEE = 10_000;
    uint256 public constant MAX_CHUNK = 10 ether;
    uint256 public constant DEADLINE_WINDOW = 2 minutes;

    IUniversalRouter public immutable universalRouter;
    address public immutable weth;
    IERC20 public immutable mstr;

    error ZeroAddress();
    error ZeroAmount();
    error ChunkTooLarge();
    error ZeroMinimumOutput();
    error InsufficientOutput();

    constructor(address universalRouter_, address weth_, address mstr_) {
        if (universalRouter_ == address(0) || weth_ == address(0) || mstr_ == address(0)) {
            revert ZeroAddress();
        }
        universalRouter = IUniversalRouter(universalRouter_);
        weth = weth_;
        mstr = IERC20(mstr_);
    }

    function swapExactEthForMstr(address recipient, uint256 minMstrOut)
        external
        payable
        nonReentrant
        returns (uint256 mstrOut)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value > MAX_CHUNK) revert ChunkTooLarge();
        if (minMstrOut == 0) revert ZeroMinimumOutput();

        uint256 beforeBalance = mstr.balanceOf(recipient);
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(ROUTER_BALANCE, msg.value);
        inputs[1] = abi.encode(
            recipient,
            msg.value,
            minMstrOut,
            encodedPath(),
            false,
            new uint256[](0)
        );
        universalRouter.execute{value: msg.value}(
            abi.encodePacked(WRAP_ETH, V3_SWAP_EXACT_IN), inputs, block.timestamp + DEADLINE_WINDOW
        );

        mstrOut = mstr.balanceOf(recipient) - beforeBalance;
        if (mstrOut < minMstrOut) revert InsufficientOutput();
    }

    function encodedPath() public view returns (bytes memory) {
        return abi.encodePacked(weth, POOL_FEE, address(mstr));
    }
}
