import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi } from "viem";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const FACTORY = getAddress(process.env.PONS_V2_FACTORY_ADDRESS || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
const NATIVE = "0x0000000000000000000000000000000000000000";
const CONFIG_ID = 0n;
const factoryAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function canLaunch(address launcher) view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)",
]);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const client = createPublicClient({ transport: http(RPC) });
const launcher = getAddress(required("LAUNCHER_ADDRESS"));
const creatorFeeRecipient = getAddress(required("PONS_FEE_COLLECTOR_ADDRESS"));
const [launchFee, canLaunch, maxCreatorTaxBps, expectedEconomics] = await Promise.all([
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchFee" }),
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "canLaunch", args: [launcher] }),
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [CONFIG_ID, NATIVE] }),
]);
if (!canLaunch) throw new Error("PONS_V2_LAUNCHER_NOT_ALLOWED");
if (maxCreatorTaxBps < 200n) throw new Error("PONS_V2_CREATOR_TAX_CAP_BELOW_2_PERCENT");

const params = {
  name: required("TOKEN_NAME"),
  symbol: required("TOKEN_SYMBOL"),
  logo: process.env.TOKEN_LOGO || "",
  description: process.env.TOKEN_DESCRIPTION || "",
  socials: {
    twitter: process.env.TOKEN_TWITTER || "",
    telegram: process.env.TOKEN_TELEGRAM || "",
    discord: process.env.TOKEN_DISCORD || "",
    website: process.env.TOKEN_WEBSITE || "",
    farcaster: process.env.TOKEN_FARCASTER || "",
  },
  creatorFeeRecipient,
  creatorTaxBps: 200,
  buybackEnabled: false,
  expectedEconomics,
  salt: process.env.LAUNCH_SALT || `0x${randomBytes(32).toString("hex")}`,
};
const data = encodeFunctionData({
  abi: factoryAbi,
  functionName: "launchToken",
  args: [params, CONFIG_ID, NATIVE],
});

console.log(JSON.stringify({
  checkedAtBlock: (await client.getBlockNumber()).toString(),
  chainId: 4663,
  from: launcher,
  to: FACTORY,
  value: launchFee.toString(),
  data,
  decoded: { params, launchConfigId: Number(CONFIG_ID), pairToken: NATIVE },
  safety: "UNSIGNED_ONLY_RECHECK_WITH_VERIFY_LIVE_BEFORE_SIGNING",
}, null, 2));
