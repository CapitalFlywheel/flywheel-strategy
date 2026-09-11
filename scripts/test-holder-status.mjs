import "dotenv/config";

import { createPublicClient, formatUnits, getAddress, http, parseAbi } from "viem";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const rpcUrl = required("ROBINHOOD_RPC_URL");
const client = createPublicClient({ transport: http(rpcUrl) });
const token = getAddress(required("PROJECT_TOKEN_ADDRESS"));
const curve = getAddress(required("PROJECT_CURVE_ADDRESS"));
const launchBlock = BigInt(required("PROJECT_LAUNCH_BLOCK"));
const holders = [
  ["holder1", getAddress(required("TEST_HOLDER_1_ADDRESS"))],
  ["holder2", getAddress(required("TEST_HOLDER_2_ADDRESS"))],
  ["holder3", getAddress(required("TEST_HOLDER_3_ADDRESS"))]
];
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)"
]);
const latestBlock = await client.getBlockNumber();
const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });

async function tokenTransfers(filter) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{
        fromBlock: `0x${launchBlock.toString(16)}`,
        toBlock: "latest",
        ...filter,
        contractAddresses: [token],
        category: ["erc20"],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: "0x3e8"
      }]
    })
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error("Alchemy transfer-history request failed");
  return payload.result?.transfers ?? [];
}

const results = [];
for (const [label, address] of holders) {
  const [balance, inboundTransfers, outboundTransfers] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    tokenTransfers({ toAddress: address }),
    tokenTransfers({ fromAddress: address })
  ]);
  const firstBuy = inboundTransfers[0];
  const lastSale = outboundTransfers.at(-1);
  results.push({
    label,
    address,
    tokenBalance: formatUnits(balance, decimals),
    inboundTransfers: inboundTransfers.length,
    firstTransferFrom: firstBuy?.from ?? null,
    firstBuyBlock: firstBuy?.blockNum ? BigInt(firstBuy.blockNum).toString() : null,
    firstBuyTimestamp: firstBuy?.metadata?.blockTimestamp ?? null,
    firstBuyTransaction: firstBuy?.hash ?? null,
    outboundTransfers: outboundTransfers.length,
    lastSaleBlock: lastSale?.blockNum ? BigInt(lastSale.blockNum).toString() : null,
    lastSaleTimestamp: lastSale?.metadata?.blockTimestamp ?? null,
    lastSaleTransaction: lastSale?.hash ?? null,
    lastSaleTokenAmount: lastSale?.value?.toString() ?? null
  });
}

console.log(JSON.stringify({
  ok: true,
  checkedAtBlock: latestBlock.toString(),
  token,
  holders: results
}, null, 2));
