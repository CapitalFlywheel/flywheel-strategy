import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
]);
const curveAbi = parseAbi([
  "function quoteReserve() view returns (uint256)",
  "function tokenReserve() view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32 value)"]);

const POOLS_SLOT = 6n;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

export interface MarketCapConfig {
  factory: Address;
  poolManager: Address;
  memeHook: Address;
  usdg: Address;
  wethUsdgPoolId: Hex;
  projectToken: Address;
}

export interface MarketCapReading {
  timestamp: number;
  phase: "bonding-curve" | "uniswap-v4";
  marketCapUsd: number;
  ethUsd: number;
  tokenPerEth: number;
  curve: Address;
}

function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }],
    [poolId, POOLS_SLOT]
  ));
}

export function tickFromSlot0(slot0: Hex): number {
  const packed = BigInt(slot0);
  const unsigned = Number((packed >> 160n) & 0xff_ffffn);
  return unsigned >= 0x80_0000 ? unsigned - 0x100_0000 : unsigned;
}

export function humanToken1PerToken0(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

export function v4PoolId(
  currency0: Address,
  currency1: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [currency0, currency1, fee, tickSpacing, hooks]
  ));
}

async function readTick(client: PublicClient, poolManager: Address, poolId: Hex): Promise<number> {
  const slot0 = await client.readContract({
    address: poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [poolStateSlot(poolId)],
  });
  return tickFromSlot0(slot0);
}

export async function readMarketCapUsd(
  client: PublicClient,
  config: MarketCapConfig
): Promise<MarketCapReading> {
  const launch = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [config.projectToken],
  });
  if (!launch.exists) throw new Error("TOKEN_NOT_LAUNCHED_BY_PONS_V2");
  if (getAddress(launch.pairToken) !== NATIVE) throw new Error("PROJECT_IS_NOT_NATIVE_ETH_PAIRED");

  const [supplyRaw, projectDecimals, usdgDecimals, ethUsdTick, latestBlock] = await Promise.all([
    client.readContract({ address: config.projectToken, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: config.projectToken, abi: erc20Abi, functionName: "decimals" }),
    // USDG is token1 in the configured WETH/USDG pool.
    client.readContract({
      address: config.usdg,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    readTick(client, config.poolManager, config.wethUsdgPoolId),
    client.getBlock(),
  ]);
  const ethUsd = humanToken1PerToken0(ethUsdTick, 18, usdgDecimals);
  const supply = Number(supplyRaw) / Math.pow(10, projectDecimals);
  let tokenPerEth: number;
  let phase: MarketCapReading["phase"];

  if (launch.phase === 0) {
    const [quoteReserveRaw, tokenReserveRaw] = await Promise.all([
      client.readContract({ address: launch.curve, abi: curveAbi, functionName: "quoteReserve" }),
      client.readContract({ address: launch.curve, abi: curveAbi, functionName: "tokenReserve" }),
    ]);
    const quoteReserve = Number(quoteReserveRaw) / 1e18;
    const tokenReserve = Number(tokenReserveRaw) / Math.pow(10, projectDecimals);
    if (quoteReserve <= 0 || tokenReserve <= 0) throw new Error("EMPTY_CURVE_RESERVES");
    tokenPerEth = tokenReserve / quoteReserve;
    phase = "bonding-curve";
  } else if (launch.phase === 2) {
    const poolId = v4PoolId(NATIVE, config.projectToken, launch.poolFee, launch.tickSpacing, config.memeHook);
    const projectTick = await readTick(client, config.poolManager, poolId);
    tokenPerEth = humanToken1PerToken0(projectTick, 18, projectDecimals);
    phase = "uniswap-v4";
  } else {
    throw new Error("PONS_GRADUATION_IN_PROGRESS");
  }

  if (!Number.isFinite(tokenPerEth) || tokenPerEth <= 0 || !Number.isFinite(ethUsd) || ethUsd <= 0) {
    throw new Error("INVALID_MARKET_PRICE");
  }
  return {
    timestamp: Number(latestBlock.timestamp),
    phase,
    marketCapUsd: supply / tokenPerEth * ethUsd,
    ethUsd,
    tokenPerEth,
    curve: launch.curve,
  };
}
