import {
  getAddress,
  parseAbi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export const PONS_V2_FACTORY = getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");

export const ponsLifecycleAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function graduate(address token)",
  "function createGraduatedPool(address token) returns (uint256 positionId)",
]);

const curveLifecycleAbi = parseAbi([
  "function readyToGraduate() view returns (bool)",
]);

export interface PonsLifecycleStatus {
  phase: number;
  phaseName: "curve" | "migration" | "v4" | "rescued" | "unknown";
  readyToGraduate: boolean;
  transactions: Hex[];
}

function phaseName(phase: number): PonsLifecycleStatus["phaseName"] {
  if (phase === 0) return "curve";
  if (phase === 1) return "migration";
  if (phase === 2) return "v4";
  if (phase === 3) return "rescued";
  return "unknown";
}

async function readLaunch(publicClient: PublicClient, projectToken: Address) {
  return publicClient.readContract({
    address: PONS_V2_FACTORY,
    abi: ponsLifecycleAbi,
    functionName: "getLaunchedToken",
    args: [projectToken],
  });
}

async function sendLifecycleTransaction(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Account,
  functionName: "graduate" | "createGraduatedPool",
  projectToken: Address,
): Promise<Hex | undefined> {
  try {
    const { request } = await publicClient.simulateContract({
      account,
      address: PONS_V2_FACTORY,
      abi: ponsLifecycleAbi,
      functionName,
      args: [projectToken],
    });
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`PONS_${functionName.toUpperCase()}_REVERTED`);
    return hash;
  } catch (error) {
    // Another keeper or the crossing buyer may have advanced the exact same
    // phase between our read and write. Treat that race as success only when
    // the chain confirms that the requested phase is already behind us.
    const latest = await readLaunch(publicClient, projectToken);
    const expectedPhase = functionName === "graduate" ? 1 : 2;
    if (Number(latest.phase) >= expectedPhase && Number(latest.phase) !== 3) return;
    throw error;
  }
}

/**
 * Advances only permissionless PONS lifecycle steps. While the curve is still
 * open it performs no transaction. Once the last curve token is sold it keeps
 * retrying the sweep and pool creation until the V4 pool exists.
 */
export async function advancePonsLifecycle(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Account,
  projectToken: Address,
): Promise<PonsLifecycleStatus> {
  let launch = await readLaunch(publicClient, projectToken);
  if (!launch.exists) throw new Error("PONS_LAUNCH_NOT_FOUND");
  if (launch.pairToken !== "0x0000000000000000000000000000000000000000") {
    throw new Error("PONS_PROJECT_IS_NOT_ETH_PAIRED");
  }

  const transactions: Hex[] = [];
  let readyToGraduate = false;
  if (Number(launch.phase) === 0) {
    readyToGraduate = await publicClient.readContract({
      address: launch.curve,
      abi: curveLifecycleAbi,
      functionName: "readyToGraduate",
    });
    if (readyToGraduate) {
      const hash = await sendLifecycleTransaction(publicClient, walletClient, account, "graduate", projectToken);
      if (hash) transactions.push(hash);
      launch = await readLaunch(publicClient, projectToken);
    }
  }

  if (Number(launch.phase) === 1) {
    const hash = await sendLifecycleTransaction(publicClient, walletClient, account, "createGraduatedPool", projectToken);
    if (hash) transactions.push(hash);
    launch = await readLaunch(publicClient, projectToken);
  }

  const phase = Number(launch.phase);
  return { phase, phaseName: phaseName(phase), readyToGraduate, transactions };
}

