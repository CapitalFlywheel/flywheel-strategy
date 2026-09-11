// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

contract MockUniversalRouter {
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

    MockERC20 public immutable mstr;
    uint256 public immutable mstrPerEth;
    bytes public lastCommands;
    bytes public lastPath;

    constructor(address mstr_, uint256 mstrPerEth_) {
        mstr = MockERC20(mstr_);
        mstrPerEth = mstrPerEth_;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(deadline >= block.timestamp);
        require(commands.length == 2 && commands[0] == 0x0b);
        address recipient;
        uint256 amountIn;
        uint256 minOut;
        bytes memory path;
        if (commands[1] == 0x00) {
            (recipient, amountIn, minOut, path,,) =
                abi.decode(inputs[1], (address, uint256, uint256, bytes, bool, uint256[]));
        } else {
            require(commands[1] == 0x10);
            (bytes memory actions, bytes[] memory actionParams) = abi.decode(inputs[1], (bytes, bytes[]));
            require(keccak256(actions) == keccak256(hex"070b0e"));
            ExactInputParams memory params = abi.decode(actionParams[0], (ExactInputParams));
            (, recipient,) = abi.decode(actionParams[2], (address, address, uint256));
            amountIn = params.amountIn;
            minOut = params.amountOutMinimum;
            path = abi.encode(params.path);
        }
        require(amountIn == msg.value);
        uint256 output = msg.value * mstrPerEth / 1 ether;
        require(output >= minOut);
        lastCommands = commands;
        lastPath = path;
        mstr.mint(recipient, output);
    }
}
