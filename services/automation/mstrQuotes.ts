import {
  encodePacked,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";

export const MAX_SLIPPAGE_BPS = 2_000n;
const BPS = 10_000n;

export interface MstrRouteConfig {
  weth: Address;
  usdg: Address;
  mstr: Address;
  v4Quoter: Address;
  v3Quoter: Address;
}

export interface RouteQuote {
  route: "V4_WETH_USDG_MSTR" | "V3_WETH_MSTR";
  amountOut: bigint;
  minimumOut: bigint;
  gasEstimate: bigint;
}

const v4QuoterAbi = parseAbi([
  "function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const v3QuoterAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);

export function minimumAfterSlippage(amountOut: bigint, slippageBps = MAX_SLIPPAGE_BPS): bigint {
  if (amountOut <= 0n) throw new Error("EMPTY_QUOTE");
  if (slippageBps < 0n || slippageBps >= BPS) throw new Error("INVALID_SLIPPAGE");
  return amountOut * (BPS - slippageBps) / BPS;
}

export function bestQuote(quotes: readonly RouteQuote[]): RouteQuote {
  if (quotes.length === 0) throw new Error("NO_ROUTES");
  return quotes.reduce((best, quote) => quote.amountOut > best.amountOut ? quote : best);
}

export async function quoteMstrRoutes(
  client: PublicClient,
  config: MstrRouteConfig,
  ethAmount: bigint
): Promise<RouteQuote[]> {
  if (ethAmount <= 0n || ethAmount > 10n * 10n ** 18n) throw new Error("INVALID_ETH_AMOUNT");
  if (ethAmount > (1n << 128n) - 1n) throw new Error("AMOUNT_TOO_LARGE");

  const [v4, v3] = await Promise.all([
    client.simulateContract({
      address: config.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInput",
      args: [{
        exactCurrency: config.weth,
        path: [
          { intermediateCurrency: config.usdg, fee: 200, tickSpacing: 4, hooks: "0x0000000000000000000000000000000000000000", hookData: "0x" },
          { intermediateCurrency: config.mstr, fee: 2500, tickSpacing: 25, hooks: "0x0000000000000000000000000000000000000000", hookData: "0x" },
        ],
        exactAmount: ethAmount,
      }],
    }),
    client.simulateContract({
      address: config.v3Quoter,
      abi: v3QuoterAbi,
      functionName: "quoteExactInput",
      args: [encodePacked(["address", "uint24", "address"], [config.weth, 10_000, config.mstr]), ethAmount],
    }),
  ]);

  return [
    {
      route: "V4_WETH_USDG_MSTR",
      amountOut: v4.result[0],
      minimumOut: minimumAfterSlippage(v4.result[0]),
      gasEstimate: v4.result[1],
    },
    {
      route: "V3_WETH_MSTR",
      amountOut: v3.result[0],
      minimumOut: minimumAfterSlippage(v3.result[0]),
      gasEstimate: v3.result[3],
    },
  ];
}
