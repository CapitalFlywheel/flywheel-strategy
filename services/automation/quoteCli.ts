import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, formatEther, parseEther, type Address } from "viem";
import { bestQuote, quoteMstrRoutes } from "./mstrQuotes";
import { rpcTransport } from "../shared/rpc";

async function main() {
  const config = JSON.parse(
    readFileSync("config/robinhood-mainnet.json", "utf8")
  );
  const ethAmount = parseEther(process.argv[2] ?? "0.01");
  const client = createPublicClient({
    transport: rpcTransport(process.env.ROBINHOOD_RPC_URL || config.rpcUrl, process.env.ROBINHOOD_RPC_FALLBACK_URL),
  });
  const quotes = await quoteMstrRoutes(client, {
    weth: config.assets.WETH as Address,
    usdg: config.assets.USDG as Address,
    mstr: config.assets.MSTR as Address,
    v4Quoter: config.uniswap.v4Quoter as Address,
    v3Quoter: config.uniswap.v3Quoter as Address,
  }, ethAmount);

  console.log(JSON.stringify({
    ethIn: formatEther(ethAmount),
    routes: quotes.map((quote) => ({
      ...quote,
      amountOutRaw: quote.amountOut.toString(),
      minimumOutRaw: quote.minimumOut.toString(),
      gasEstimate: quote.gasEstimate.toString(),
    })),
    selected: bestQuote(quotes).route,
  }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
