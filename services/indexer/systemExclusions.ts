import { getAddress, parseAbi, type Address, type PublicClient } from "viem";

const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
]);

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

export function exclusionSet(addresses: readonly (string | undefined)[]): Set<string> {
  const values = addresses.filter((address): address is string => Boolean(address?.trim()));
  return new Set(values.map((address) => getAddress(address.trim()).toLowerCase()));
}

export async function readPonsCurve(
  client: PublicClient,
  factory: Address,
  projectToken: Address
): Promise<Address> {
  const launch = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [projectToken],
  });
  if (!launch.exists) throw new Error("TOKEN_NOT_LAUNCHED_BY_PONS_V2");
  return launch.curve;
}
