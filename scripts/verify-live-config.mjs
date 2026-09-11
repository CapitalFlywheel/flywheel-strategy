import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi } from "viem";

const pons = JSON.parse(readFileSync(new URL("../config/pons-v2-mainnet.json", import.meta.url)));
const route = JSON.parse(readFileSync(new URL("../config/robinhood-mainnet.json", import.meta.url)));
const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || route.rpcUrl) });
const factoryAbi = parseAbi([
  "function launchEnabled() view returns (bool)",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function feeEscrow() view returns (address)",
  "function memeHook() view returns (address)",
  "function getLaunchConfig(uint256 id) view returns (uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
]);
const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)",
]);
const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
]);

const addressEq = (a, b) => a.toLowerCase() === b.toLowerCase();
const requireCheck = (condition, message) => {
  if (!condition) throw new Error(`LIVE_CONFIG_MISMATCH: ${message}`);
};

const [blockNumber, launchEnabled, launchFee, maxCreatorTaxBps, feeEscrow, memeHook, launchConfig, digest, mstrSymbol, mstrDecimals, uiMultiplier, routerCode, poolCode, poolToken0, poolToken1, poolFee, liquidity] =
  await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: pons.factory, abi: factoryAbi, functionName: "launchEnabled" }),
    client.readContract({ address: pons.factory, abi: factoryAbi, functionName: "launchFee" }),
    client.readContract({ address: pons.factory, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
    client.readContract({ address: pons.factory, abi: factoryAbi, functionName: "feeEscrow" }),
    client.readContract({ address: pons.factory, abi: factoryAbi, functionName: "memeHook" }),
    client.readContract({ address: pons.factory, abi: factoryAbi, functionName: "getLaunchConfig", args: [BigInt(pons.launch.configId)] }),
    client.readContract({ address: pons.factory, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [BigInt(pons.launch.configId), pons.launch.pairToken] }),
    client.readContract({ address: route.assets.MSTR, abi: tokenAbi, functionName: "symbol" }),
    client.readContract({ address: route.assets.MSTR, abi: tokenAbi, functionName: "decimals" }),
    client.readContract({ address: route.assets.MSTR, abi: tokenAbi, functionName: "uiMultiplier" }),
    client.getCode({ address: route.uniswap.universalRouter }),
    client.getCode({ address: route.uniswap.pools.MSTR_WETH_V3_100 }),
    client.readContract({ address: route.uniswap.pools.MSTR_WETH_V3_100, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: route.uniswap.pools.MSTR_WETH_V3_100, abi: poolAbi, functionName: "token1" }),
    client.readContract({ address: route.uniswap.pools.MSTR_WETH_V3_100, abi: poolAbi, functionName: "fee" }),
    client.readContract({ address: route.uniswap.pools.MSTR_WETH_V3_100, abi: poolAbi, functionName: "liquidity" }),
  ]);

requireCheck(launchEnabled, "PONS V2 launch is disabled");
requireCheck(launchFee === BigInt(pons.launch.launchFeeWei), "launch fee changed");
requireCheck(maxCreatorTaxBps >= BigInt(pons.launch.creatorTaxBps), "2% creator tax is no longer allowed");
requireCheck(addressEq(feeEscrow, pons.feeEscrow), "fee escrow changed");
requireCheck(addressEq(memeHook, pons.memeHook), "meme hook changed");
requireCheck(launchConfig[0] === BigInt(pons.launch.supplyRaw), "token supply changed");
requireCheck(launchConfig[1] === BigInt(pons.launch.baseTradeFeeBps), "base trading fee changed");
requireCheck(launchConfig[6], "launch config is disabled");
requireCheck(digest === pons.launch.nativeEconomicsDigest, "economics digest changed");
requireCheck(mstrSymbol === "MSTR" && mstrDecimals === 18, "official MSTR metadata changed");
requireCheck(routerCode && routerCode !== "0x", "Universal Router has no code");
requireCheck(poolCode && poolCode !== "0x", "fallback pool has no code");
requireCheck(addressEq(poolToken0, route.assets.WETH), "fallback token0 is not WETH");
requireCheck(addressEq(poolToken1, route.assets.MSTR), "fallback token1 is not MSTR");
requireCheck(poolFee === 10_000, "fallback pool fee changed");
requireCheck(liquidity > 0n, "fallback pool has no active liquidity");

console.log(JSON.stringify({
  ok: true,
  blockNumber: String(blockNumber),
  ponsFactory: pons.factory,
  feeEscrow,
  totalTradeFeeBps: Number(launchConfig[1]) + pons.launch.creatorTaxBps,
  economicsDigest: digest,
  mstr: route.assets.MSTR,
  mstrUiMultiplierRaw: String(uiMultiplier),
  fallbackPool: route.uniswap.pools.MSTR_WETH_V3_100,
  fallbackLiquidity: String(liquidity),
}, null, 2));
