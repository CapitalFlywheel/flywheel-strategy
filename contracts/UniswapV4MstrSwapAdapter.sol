// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMstrSwapAdapter} from "./interfaces/IMstrSwapAdapter.sol";
import {IUniversalRouter} from "./interfaces/IUniversalRouter.sol";

/// @notice Fixed primary route: native ETH -> WETH -> USDG -> official MSTR on Uniswap V4.
contract UniswapV4MstrSwapAdapter is IMstrSwapAdapter, ReentrancyGuard {
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    bytes1 private constant WRAP_ETH = 0x0b;
    bytes1 private constant V4_SWAP = 0x10;
    bytes1 private constant SWAP_EXACT_IN = 0x07;
    bytes1 private constant SETTLE = 0x0b;
    bytes1 private constant TAKE = 0x0e;
    address private constant ROUTER_BALANCE = address(2);
    uint256 private constant OPEN_DELTA = 0;

    uint24 public constant WETH_USDG_FEE = 200;
    int24 public constant WETH_USDG_TICK_SPACING = 4;
    uint24 public constant USDG_MSTR_FEE = 2_500;
    int24 public constant USDG_MSTR_TICK_SPACING = 25;
    uint256 public constant MAX_CHUNK = 10 ether;
    uint256 public constant DEADLINE_WINDOW = 2 minutes;

    IUniversalRouter public immutable universalRouter;
    address public immutable weth;
    address public immutable usdg;
    IERC20 public immutable mstr;

    error ZeroAddress();
    error ZeroAmount();
    error ChunkTooLarge();
    error ZeroMinimumOutput();
    error AmountTooLarge();
    error InsufficientOutput();

    constructor(address universalRouter_, address weth_, address usdg_, address mstr_) {
        if (
            universalRouter_ == address(0) || weth_ == address(0) || usdg_ == address(0)
                || mstr_ == address(0)
        ) revert ZeroAddress();
        universalRouter = IUniversalRouter(universalRouter_);
        weth = weth_;
        usdg = usdg_;
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
        if (msg.value > type(uint128).max || minMstrOut > type(uint128).max) revert AmountTooLarge();

        PathKey[] memory path = new PathKey[](2);
        path[0] = PathKey({
            intermediateCurrency: usdg,
            fee: WETH_USDG_FEE,
            tickSpacing: WETH_USDG_TICK_SPACING,
            hooks: address(0),
            hookData: bytes("")
        });
        path[1] = PathKey({
            intermediateCurrency: address(mstr),
            fee: USDG_MSTR_FEE,
            tickSpacing: USDG_MSTR_TICK_SPACING,
            hooks: address(0),
            hookData: bytes("")
        });
        ExactInputParams memory swapParams = ExactInputParams({
            currencyIn: weth,
            path: path,
            minHopPriceX36: new uint256[](0),
            amountIn: uint128(msg.value),
            amountOutMinimum: uint128(minMstrOut)
        });

        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swapParams);
        actionParams[1] = abi.encode(weth, OPEN_DELTA, false);
        actionParams[2] = abi.encode(address(mstr), recipient, OPEN_DELTA);

        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(ROUTER_BALANCE, msg.value);
        inputs[1] = abi.encode(abi.encodePacked(SWAP_EXACT_IN, SETTLE, TAKE), actionParams);

        uint256 beforeBalance = mstr.balanceOf(recipient);
        universalRouter.execute{value: msg.value}(
            abi.encodePacked(WRAP_ETH, V4_SWAP), inputs, block.timestamp + DEADLINE_WINDOW
        );
        mstrOut = mstr.balanceOf(recipient) - beforeBalance;
        if (mstrOut < minMstrOut) revert InsufficientOutput();
    }
}
