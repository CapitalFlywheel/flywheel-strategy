import { createPublicClient, encodeFunctionData, formatUnits, http, type Address, type Hex } from "viem";
import { robinhoodChain } from "./network";
import { ensureRobinhoodChain, getActiveWalletProvider } from "./wallets";

export { robinhoodChain } from "./network";

const erc20Abi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;
const mstrDisplayAbi = [
  ...erc20Abi,
  {
    type: "function", name: "uiMultiplier", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
] as const;
const rewardVaultAbi = [
  {
    type: "function", name: "claimed", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "claim", stateMutability: "nonpayable",
    inputs: [
      { name: "cumulativeAmount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ], outputs: [],
  },
] as const;
const governanceAbi = [
  { type: "function", name: "activeProposalId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "proposals", stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      { name: "startsAt", type: "uint64" }, { name: "endsAt", type: "uint64" },
      { name: "executableAt", type: "uint64" }, { name: "weightRoot", type: "bytes32" },
      { name: "totalAvailableWeight", type: "uint128" }, { name: "totalCastWeight", type: "uint128" },
      { name: "optionCount", type: "uint8" }, { name: "executed", type: "bool" },
      { name: "passed", type: "bool" }, { name: "winningOption", type: "uint8" },
    ],
  },
  {
    type: "function", name: "getOption", stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }, { name: "optionIndex", type: "uint8" }],
    outputs: [{
      name: "", type: "tuple", components: [
        { name: "action", type: "uint8" }, { name: "reserveBps", type: "uint16" },
        { name: "reserveAmount", type: "uint128" }, { name: "lockDuration", type: "uint32" },
        { name: "recipient", type: "address" },
      ],
    }],
  },
  {
    type: "function", name: "optionVotes", stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }, { name: "optionIndex", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "vote", stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" }, { name: "optionIndex", type: "uint8" },
      { name: "weight", type: "uint256" }, { name: "proof", type: "bytes32[]" },
    ], outputs: [],
  },
] as const;

export interface GovernanceOption {
  action: number;
  reserveBps: number;
  reserveAmount: bigint;
  lockDuration: number;
  recipient: Address;
  votes: bigint;
}

export interface ActiveProposal {
  id: bigint;
  startsAt: number;
  endsAt: number;
  executableAt: number;
  totalAvailableWeight: bigint;
  totalCastWeight: bigint;
  executed: boolean;
  passed: boolean;
  winningOption: number;
  options: GovernanceOption[];
}

export const publicClient = createPublicClient({ transport: http(robinhoodChain.rpcUrl) });

export async function readMstrBalance(token: Address, vault?: Address): Promise<string> {
  if (!vault) return "—";
  const [balance, multiplier] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    readMstrMultiplier(token),
  ]);
  return Number(formatUnits(balance * multiplier / 10n ** 18n, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export async function readMstrMultiplier(token: Address): Promise<bigint> {
  try {
    return await publicClient.readContract({ address: token, abi: mstrDisplayAbi, functionName: "uiMultiplier" });
  } catch {
    return 10n ** 18n;
  }
}

export async function readClaimed(vault: Address, account: Address): Promise<bigint> {
  return publicClient.readContract({ address: vault, abi: rewardVaultAbi, functionName: "claimed", args: [account] });
}

export async function claimMstr(
  vault: Address,
  account: Address,
  cumulativeAmount: bigint,
  proof: Hex[]
): Promise<Hex> {
  const provider = getActiveWalletProvider();
  await ensureRobinhoodChain(provider);
  const data = encodeFunctionData({
    abi: rewardVaultAbi,
    functionName: "claim",
    args: [cumulativeAmount, proof],
  });
  return provider.request({
    method: "eth_sendTransaction",
    params: [{ from: account, to: vault, data }],
  }) as Promise<Hex>;
}

export async function waitForClaimReceipt(hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Claim transaction failed");
}

export async function readActiveProposal(governance: Address): Promise<ActiveProposal | null> {
  const id = await publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "activeProposalId" });
  if (id === 0n) return null;
  return readProposal(governance, id);
}

export async function readProposal(governance: Address, id: bigint): Promise<ActiveProposal | null> {
  if (id === 0n) return null;
  const proposal = await publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "proposals", args: [id] });
  const optionCount = Number(proposal[6]);
  if (Number(proposal[0]) === 0 || optionCount === 0) return null;
  const options = await Promise.all(Array.from({ length: optionCount }, async (_, index) => {
    const [option, votes] = await Promise.all([
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "getOption", args: [id, index] }),
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "optionVotes", args: [id, index] }),
    ]);
    return {
      action: option.action,
      reserveBps: option.reserveBps,
      reserveAmount: option.reserveAmount,
      lockDuration: option.lockDuration,
      recipient: option.recipient,
      votes,
    };
  }));
  return {
    id,
    startsAt: Number(proposal[0]),
    endsAt: Number(proposal[1]),
    executableAt: Number(proposal[2]),
    totalAvailableWeight: proposal[4],
    totalCastWeight: proposal[5],
    executed: proposal[7],
    passed: proposal[8],
    winningOption: Number(proposal[9]),
    options,
  };
}

export async function voteOnProposal(
  governance: Address,
  account: Address,
  proposalId: bigint,
  optionIndex: number,
  weight: bigint,
  proof: Hex[]
): Promise<Hex> {
  const provider = getActiveWalletProvider();
  await ensureRobinhoodChain(provider);
  const data = encodeFunctionData({ abi: governanceAbi, functionName: "vote", args: [proposalId, optionIndex, weight, proof] });
  return provider.request({ method: "eth_sendTransaction", params: [{ from: account, to: governance, data }] }) as Promise<Hex>;
}
