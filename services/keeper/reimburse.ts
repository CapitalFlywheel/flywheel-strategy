import { parseAbi, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

const keeperVaultAbi = parseAbi([
  "function maxReimbursementWei() view returns (uint256)",
  "function jobReimbursed(bytes32 jobId) view returns (bool)",
  "function reimburse(bytes32 jobId,address recipient,uint256 amount)",
]);

/** Reimburses the original automation transaction. The reimbursement call itself is not reimbursed. */
export async function reimburseGas(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Account,
  keeperVault: Address | undefined,
  originalHash: Hex
): Promise<Hex | undefined> {
  if (!keeperVault) return;
  const [receipt, cap, alreadyPaid, vaultBalance] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: originalHash }),
    publicClient.readContract({ address: keeperVault, abi: keeperVaultAbi, functionName: "maxReimbursementWei" }),
    publicClient.readContract({ address: keeperVault, abi: keeperVaultAbi, functionName: "jobReimbursed", args: [originalHash] }),
    publicClient.getBalance({ address: keeperVault }),
  ]);
  if (alreadyPaid) return;
  const actualCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const amount = actualCost < cap ? actualCost : cap;
  const payableAmount = amount < vaultBalance ? amount : vaultBalance;
  if (payableAmount === 0n) return;
  const { request } = await publicClient.simulateContract({
    account,
    address: keeperVault,
    abi: keeperVaultAbi,
    functionName: "reimburse",
    args: [originalHash, account.address, payableAmount],
  });
  const hash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
