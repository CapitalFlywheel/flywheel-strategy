// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReserveActionAdapter} from "./interfaces/IReserveActionAdapter.sol";
import {IUniversalRouter} from "./interfaces/IUniversalRouter.sol";

interface IPermit2Allowance {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IWeth is IERC20 {
    function withdraw(uint256 amount) external;
}

interface IV3QuoteExactInput {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

interface IV4QuoteExactInput {
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct QuoteExactInputParams {
        address exactCurrency;
        PathKey[] path;
        uint128 exactAmount;
    }

    function quoteExactInput(QuoteExactInputParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

interface IPonsV2FactoryView {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function graduate(address token) external;
    function createGraduatedPool(address token) external returns (uint256 positionId);
}

interface IPonsV2BondingCurveBuy {
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function sellableTokens() external view returns (uint256);
    function feeBps() external view returns (uint256);
    function creatorTaxBps() external view returns (uint256);
    function currentSnipeTaxBps(address account) external view returns (uint256);
    function readyToGraduate() external view returns (bool);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
}

/// @notice The production governance route for Robinhood Chain.
/// Resolves the live PONS phase on every call: bonding curve before graduation,
/// permissionless graduation while swept, and the V4 pool after graduation.
contract RobinhoodReserveActionAdapter is IReserveActionAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    bytes1 private constant V3_SWAP_EXACT_IN = 0x00;
    bytes1 private constant V4_SWAP = 0x10;
    bytes1 private constant SWAP_EXACT_IN = 0x07;
    bytes1 private constant SETTLE = 0x0b;
    bytes1 private constant TAKE = 0x0e;
    uint256 private constant OPEN_DELTA = 0;
    uint256 private constant BPS = 10_000;
    uint256 private constant DEADLINE_WINDOW = 2 minutes;
    uint24 private constant MSTR_WETH_V3_FEE = 10_000;

    address public executor;
    address public immutable initializer;
    IERC20 public immutable mstr;
    IERC20 public immutable projectToken;
    IWeth public immutable weth;
    IUniversalRouter public immutable universalRouter;
    IPonsV2FactoryView public immutable ponsFactory;
    address public immutable memeHook;
    IV3QuoteExactInput public immutable v3Quoter;
    IV4QuoteExactInput public immutable v4Quoter;

    event ExecutorInitialized(address indexed executor);
    event ReserveSwap(uint256 indexed proposalId, bool indexed marketing, uint256 mstrIn, uint256 amountOut);
    event PonsRouteUsed(uint256 indexed proposalId, uint8 indexed phase, uint256 ethIn, uint256 tokenOut);

    error ZeroAddress();
    error OnlyExecutor();
    error ExecutorAlreadyInitialized();
    error InvalidAmount();
    error InvalidSlippage();
    error MigrationInProgress();
    error InvalidPonsLaunch();
    error AmountTooLarge();
    error EthTransferFailed();
    error InsufficientOutput();
    error OnlyWeth();

    constructor(
        address initializer_,
        address mstr_,
        address projectToken_,
        address weth_,
        address universalRouter_,
        address permit2_,
        address ponsFactory_,
        address memeHook_,
        address v3Quoter_,
        address v4Quoter_
    ) {
        if (
            initializer_ == address(0) || mstr_ == address(0) || projectToken_ == address(0)
                || weth_ == address(0) || universalRouter_ == address(0) || permit2_ == address(0)
                || ponsFactory_ == address(0) || memeHook_ == address(0) || v3Quoter_ == address(0)
                || v4Quoter_ == address(0)
        ) revert ZeroAddress();
        initializer = initializer_;
        mstr = IERC20(mstr_);
        projectToken = IERC20(projectToken_);
        weth = IWeth(weth_);
        universalRouter = IUniversalRouter(universalRouter_);
        ponsFactory = IPonsV2FactoryView(ponsFactory_);
        memeHook = memeHook_;
        v3Quoter = IV3QuoteExactInput(v3Quoter_);
        v4Quoter = IV4QuoteExactInput(v4Quoter_);

        IERC20(mstr_).forceApprove(permit2_, type(uint256).max);
        IPermit2Allowance(permit2_).approve(mstr_, universalRouter_, type(uint160).max, type(uint48).max);
    }

    receive() external payable {
        if (msg.sender == address(weth)) return;
        IPonsV2FactoryView.LaunchedToken memory launch = ponsFactory.getLaunchedToken(address(projectToken));
        if (msg.sender != launch.curve) revert OnlyWeth();
    }

    function initializeExecutor(address executor_) external {
        if (msg.sender != initializer) revert OnlyExecutor();
        if (executor != address(0)) revert ExecutorAlreadyInitialized();
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
        emit ExecutorInitialized(executor_);
    }

    function buyProjectToken(
        uint256 proposalId,
        uint256 mstrAmount,
        BuybackMode,
        address recipient,
        uint16 maxSlippageBps
    ) external nonReentrant returns (uint256 projectTokenOut) {
        _validate(msg.sender, mstrAmount, recipient, maxSlippageBps);
        IPonsV2FactoryView.LaunchedToken memory launch = _loadLaunch();

        // A threshold-crossing public buy may leave PONS in either phase 0
        // (auto-graduation failed) or phase 1 (reserves swept). Both PONS
        // operations are permissionless and retryable, so finish them before
        // converting any reserve MSTR.
        if (launch.phase == 1 || (launch.phase == 0 && IPonsV2BondingCurveBuy(launch.curve).readyToGraduate())) {
            launch = _finishGraduation(launch);
        }

        uint256 recipientBalanceBefore = projectToken.balanceOf(recipient);
        uint256 ethAmount = _mstrToEth(mstrAmount, maxSlippageBps);
        uint256 untouchedEth = address(this).balance - ethAmount;

        if (launch.phase == 0) {
            _buyOnCurve(proposalId, launch.curve, ethAmount, recipient, maxSlippageBps);

            // The last curve buy can be partially filled and refunded while
            // atomically sweeping the launch. Complete phase 2 and spend that
            // refund in the new V4 pool in the same governance transaction.
            launch = _loadLaunch();
            if (launch.phase == 1 || (launch.phase == 0 && IPonsV2BondingCurveBuy(launch.curve).readyToGraduate())) {
                launch = _finishGraduation(launch);
            }
            uint256 refundedEth = address(this).balance - untouchedEth;
            if (refundedEth != 0) {
                if (launch.phase != 2) revert MigrationInProgress();
                _buyOnV4(proposalId, launch, refundedEth, recipient, maxSlippageBps);
            }
        } else if (launch.phase == 2) {
            _buyOnV4(proposalId, launch, ethAmount, recipient, maxSlippageBps);
        } else {
            revert InvalidPonsLaunch();
        }

        projectTokenOut = projectToken.balanceOf(recipient) - recipientBalanceBefore;
        if (projectTokenOut == 0) revert InsufficientOutput();
        emit ReserveSwap(proposalId, false, mstrAmount, projectTokenOut);
    }

    function _buyOnCurve(
        uint256 proposalId,
        address curveAddress,
        uint256 ethAmount,
        address recipient,
        uint16 maxSlippageBps
    ) private returns (uint256 tokenOut) {
        IPonsV2BondingCurveBuy curve = IPonsV2BondingCurveBuy(curveAddress);
        (uint256 quoteReserve, uint256 tokenReserve) = curve.getReserves();
        uint256 sellable = curve.sellableTokens();
        uint256 feeBps_ = curve.feeBps();
        uint256 creatorTaxBps_ = curve.creatorTaxBps();
        uint256 snipeTaxBps_ = curve.currentSnipeTaxBps(address(this));
        uint256 totalTaxBps = feeBps_ + creatorTaxBps_ + snipeTaxBps_;
        if (totalTaxBps >= BPS || sellable == 0 || quoteReserve == 0 || tokenReserve == 0) {
            revert InsufficientOutput();
        }

        // Mirrors the PONS constant-product quote. Governance cannot execute
        // until at least one hour after proposal creation, so the launch-second
        // snipe tax is normally zero; it is still included for completeness.
        uint256 netInput = ethAmount * (BPS - totalTaxBps) / BPS;
        uint256 quoted = netInput * tokenReserve / (quoteReserve + netInput);
        if (quoted > sellable) quoted = sellable;
        uint256 minimum = quoted * (BPS - maxSlippageBps) / BPS;
        if (minimum == 0) revert InsufficientOutput();

        tokenOut = curve.buy{value: ethAmount}(ethAmount, minimum, recipient);
        if (tokenOut == 0) revert InsufficientOutput();
        emit PonsRouteUsed(proposalId, 0, ethAmount, tokenOut);
    }

    function _buyOnV4(
        uint256 proposalId,
        IPonsV2FactoryView.LaunchedToken memory launch,
        uint256 ethAmount,
        address recipient,
        uint16 maxSlippageBps
    ) private returns (uint256 tokenOut) {
        if (ethAmount > type(uint128).max) revert AmountTooLarge();

        IV4QuoteExactInput.PathKey[] memory quotePath = new IV4QuoteExactInput.PathKey[](1);
        quotePath[0] = IV4QuoteExactInput.PathKey({
            intermediateCurrency: address(projectToken),
            fee: launch.poolFee,
            tickSpacing: launch.tickSpacing,
            hooks: memeHook,
            hookData: bytes("")
        });
        (uint256 quoted,) = v4Quoter.quoteExactInput(
            IV4QuoteExactInput.QuoteExactInputParams({
                exactCurrency: address(0), path: quotePath, exactAmount: uint128(ethAmount)
            })
        );
        uint256 minimum = quoted * (BPS - maxSlippageBps) / BPS;
        if (minimum == 0 || minimum > type(uint128).max) revert InsufficientOutput();

        PathKey[] memory path = new PathKey[](1);
        path[0] = PathKey({
            intermediateCurrency: address(projectToken),
            fee: launch.poolFee,
            tickSpacing: launch.tickSpacing,
            hooks: memeHook,
            hookData: bytes("")
        });
        ExactInputParams memory swapParams = ExactInputParams({
            currencyIn: address(0),
            path: path,
            minHopPriceX36: new uint256[](0),
            amountIn: uint128(ethAmount),
            amountOutMinimum: uint128(minimum)
        });
        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swapParams);
        actionParams[1] = abi.encode(address(0), OPEN_DELTA, false);
        actionParams[2] = abi.encode(address(projectToken), recipient, OPEN_DELTA);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN, SETTLE, TAKE), actionParams);

        uint256 beforeBalance = projectToken.balanceOf(recipient);
        universalRouter.execute{value: ethAmount}(abi.encodePacked(V4_SWAP), inputs, block.timestamp + DEADLINE_WINDOW);
        tokenOut = projectToken.balanceOf(recipient) - beforeBalance;
        if (tokenOut < minimum) revert InsufficientOutput();
        emit PonsRouteUsed(proposalId, 2, ethAmount, tokenOut);
    }

    function sellMstrForEth(
        uint256 proposalId,
        uint256 mstrAmount,
        address recipient,
        uint16 maxSlippageBps
    ) external nonReentrant returns (uint256 ethOut) {
        _validate(msg.sender, mstrAmount, recipient, maxSlippageBps);
        ethOut = _mstrToEth(mstrAmount, maxSlippageBps);
        (bool sent,) = payable(recipient).call{value: ethOut}("");
        if (!sent) revert EthTransferFailed();
        emit ReserveSwap(proposalId, true, mstrAmount, ethOut);
    }

    function _mstrToEth(uint256 amount, uint16 slippageBps) private returns (uint256 ethOut) {
        bytes memory path = abi.encodePacked(address(mstr), MSTR_WETH_V3_FEE, address(weth));
        (uint256 quoted,,,) = v3Quoter.quoteExactInput(path, amount);
        uint256 minimum = quoted * (BPS - slippageBps) / BPS;
        if (minimum == 0) revert InsufficientOutput();

        bytes[] memory inputs = new bytes[](1);
        // Robinhood's deployed Universal Router adds the per-hop price-limit
        // array as the sixth V3 input field.
        inputs[0] = abi.encode(address(this), amount, minimum, path, true, new uint256[](0));
        uint256 beforeBalance = weth.balanceOf(address(this));
        universalRouter.execute(abi.encodePacked(V3_SWAP_EXACT_IN), inputs, block.timestamp + DEADLINE_WINDOW);
        uint256 wethOut = weth.balanceOf(address(this)) - beforeBalance;
        if (wethOut < minimum) revert InsufficientOutput();
        weth.withdraw(wethOut);
        return wethOut;
    }

    function _loadLaunch() private view returns (IPonsV2FactoryView.LaunchedToken memory launch) {
        launch = ponsFactory.getLaunchedToken(address(projectToken));
        if (!launch.exists || launch.pairToken != address(0) || launch.curve == address(0)) {
            revert InvalidPonsLaunch();
        }
    }

    function _finishGraduation(IPonsV2FactoryView.LaunchedToken memory launch)
        private
        returns (IPonsV2FactoryView.LaunchedToken memory)
    {
        if (launch.phase == 0) {
            if (!IPonsV2BondingCurveBuy(launch.curve).readyToGraduate()) revert MigrationInProgress();
            ponsFactory.graduate(address(projectToken));
            launch = _loadLaunch();
        }
        if (launch.phase == 1) {
            ponsFactory.createGraduatedPool(address(projectToken));
            launch = _loadLaunch();
        }
        if (launch.phase != 2) revert MigrationInProgress();
        return launch;
    }

    function _validate(address caller, uint256 amount, address recipient, uint16 slippageBps) private view {
        if (caller != executor) revert OnlyExecutor();
        if (amount == 0 || recipient == address(0)) revert InvalidAmount();
        if (slippageBps > 2_000) revert InvalidSlippage();
        if (mstr.balanceOf(address(this)) < amount) revert InvalidAmount();
    }
}
