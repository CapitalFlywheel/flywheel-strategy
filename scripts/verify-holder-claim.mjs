import "dotenv/config";

import { readFile } from "node:fs/promises";
import { createPublicClient, formatUnits, getAddress, http, parseAbi } from "viem";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const rpcUrl = required("ROBINHOOD_RPC_URL");
const deployment = JSON.parse(await readFile("deployments/mainnet-4663.json", "utf8"));
const holder = getAddress((process.argv[2] ?? required("TEST_HOLDER_3_ADDRESS")).toLowerCase());
const mstr = getAddress(deployment.mstr);
const rewardVault = getAddress(deployment.rewardVault);
const client = createPublicClient({ transport: http(rpcUrl) });

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)"
]);
const rewardVaultAbi = parseAbi([
  "function latestEpoch() view returns (uint64)",
  "function claimed(address account) view returns (uint256)",
  "function totalClaimed() view returns (uint256)"
]);

async function outgoingRewardTransfers() {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{
        fromBlock: "0x0",
        toBlock: "latest",
        fromAddress: rewardVault,
        toAddress: holder,
        contractAddresses: [mstr],
        category: ["erc20"],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: "0x3e8"
      }]
    })
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error("Transfer-history request failed");
  return payload.result?.transfers ?? [];
}

const [
  decimals,
  latestEpoch,
  holderClaimed,
  totalClaimed,
  holderMstrBalance,
  rewardVaultMstrBalance,
  transfers,
  blockNumber
] = await Promise.all([
  client.readContract({ address: mstr, abi: erc20Abi, functionName: "decimals" }),
  client.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "latestEpoch" }),
  client.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "claimed", args: [holder] }),
  client.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "totalClaimed" }),
  client.readContract({ address: mstr, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
  client.readContract({ address: mstr, abi: erc20Abi, functionName: "balanceOf", args: [rewardVault] }),
  outgoingRewardTransfers(),
  client.getBlockNumber()
]);

const latestTransfer = transfers.at(-1);
console.log(JSON.stringify({
  ok: holderClaimed > 0n && transfers.length > 0,
  checkedAtBlock: blockNumber.toString(),
  rewardEpoch: Number(latestEpoch),
  holder,
  holderClaimedMstr: formatUnits(holderClaimed, decimals),
  totalClaimedMstr: formatUnits(totalClaimed, decimals),
  holderMstrBalance: formatUnits(holderMstrBalance, decimals),
  rewardVaultMstrBalance: formatUnits(rewardVaultMstrBalance, decimals),
  rewardTransfersFound: transfers.length,
  latestClaimTransaction: latestTransfer?.hash ?? null,
  latestClaimBlock: latestTransfer?.blockNum ? BigInt(latestTransfer.blockNum).toString() : null,
  latestClaimTimestamp: latestTransfer?.metadata?.blockTimestamp ?? null,
  latestTransferredMstr: latestTransfer?.value?.toString() ?? null
}, null, 2));
