import "dotenv/config";

import { readFile } from "node:fs/promises";
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseAbi } from "viem";

const rpcUrl = process.env.ROBINHOOD_RPC_URL;
if (!rpcUrl) throw new Error("ROBINHOOD_RPC_URL is required");
const deployment = JSON.parse(await readFile("deployments/mainnet-4663.json", "utf8"));
const client = createPublicClient({ transport: http(rpcUrl) });

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)"
]);
const rewardVaultAbi = parseAbi([
  "function latestEpoch() view returns (uint64)",
  "function cumulativeAllocated() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function merkleRoot() view returns (bytes32)"
]);
const routerAbi = parseAbi([
  "function unallocatedEth() view returns (uint256)",
  "function pendingRewardEth() view returns (uint256)",
  "function pendingReserveEth() view returns (uint256)"
]);
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"
]);
const curveAbi = parseAbi([
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)"
]);

const mstr = getAddress(deployment.mstr);
const projectToken = getAddress(deployment.projectToken);
const rewardVault = getAddress(deployment.rewardVault);
const reserveVault = getAddress(deployment.reserveVault);
const feeRouter = getAddress(deployment.feeRouter);
const launch = await client.readContract({
  address: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  abi: factoryAbi,
  functionName: "getLaunchedToken",
  args: [projectToken]
});
if (!launch.exists) throw new Error("PONS launch not found");

const [
  decimals,
  rewardBalance,
  reserveBalance,
  latestEpoch,
  cumulativeAllocated,
  totalClaimed,
  merkleRoot,
  unallocatedEth,
  pendingRewardEth,
  pendingReserveEth,
  quoteFeeBalance,
  creatorTaxBalance,
  keeperVaultEth
] = await Promise.all([
  client.readContract({ address: mstr, abi: erc20Abi, functionName: "decimals" }),
  client.readContract({ address: mstr, abi: erc20Abi, functionName: "balanceOf", args: [rewardVault] }),
  client.readContract({ address: mstr, abi: erc20Abi, functionName: "balanceOf", args: [reserveVault] }),
  client.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "latestEpoch" }),
  client.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "cumulativeAllocated" }),
  client.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "totalClaimed" }),
  client.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "merkleRoot" }),
  client.readContract({ address: feeRouter, abi: routerAbi, functionName: "unallocatedEth" }),
  client.readContract({ address: feeRouter, abi: routerAbi, functionName: "pendingRewardEth" }),
  client.readContract({ address: feeRouter, abi: routerAbi, functionName: "pendingReserveEth" }),
  client.readContract({ address: launch.curve, abi: curveAbi, functionName: "quoteFeeBalance" }),
  client.readContract({ address: launch.curve, abi: curveAbi, functionName: "creatorTaxBalance" }),
  client.getBalance({ address: getAddress(deployment.keeperVault) })
]);

console.log(JSON.stringify({
  ok: true,
  blockNumber: (await client.getBlockNumber()).toString(),
  rewardEpoch: Number(latestEpoch),
  rewardVaultMstr: formatUnits(rewardBalance, decimals),
  reserveVaultMstr: formatUnits(reserveBalance, decimals),
  cumulativeAllocatedMstr: formatUnits(cumulativeAllocated, decimals),
  totalClaimedMstr: formatUnits(totalClaimed, decimals),
  unallocatedEth: formatEther(unallocatedEth),
  pendingRewardEth: formatEther(pendingRewardEth),
  pendingReserveEth: formatEther(pendingReserveEth),
  newCreatorTaxWaitingInCurveEth: formatEther(creatorTaxBalance),
  ponsBaseFeeWaitingInCurveEth: formatEther(quoteFeeBalance),
  keeperVaultEth: formatEther(keeperVaultEth),
  merkleRoot
}, null, 2));
