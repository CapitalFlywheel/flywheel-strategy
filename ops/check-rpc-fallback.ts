import { createPublicClient } from "viem";
import { rpcTransport } from "../services/shared/rpc";

const primary = process.env.ROBINHOOD_RPC_URL;
const secondary = process.env.ROBINHOOD_RPC_FALLBACK_URL;

if (!primary || !secondary) {
  throw new Error("Both primary and backup RPC endpoints are required");
}

async function main() {
  const client = createPublicClient({ transport: rpcTransport(primary, secondary) });
  const chainId = await client.getChainId();
  const blockNumber = await client.getBlockNumber();

  if (chainId !== 4663) {
    throw new Error(`Unexpected chain ID: ${chainId}`);
  }

  console.log(`RPC_FALLBACK_OK chain=${chainId} block=${blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
