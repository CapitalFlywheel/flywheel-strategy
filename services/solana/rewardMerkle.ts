import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { PushAllocation } from "./holderAccounting";

const LEAF_DOMAIN = Buffer.from("flywheel-reward-leaf-v1", "utf8");
const U64_MAX = (1n << 64n) - 1n;

export interface RewardMerklePayment {
  recipient: string;
  rawAmount: bigint;
  proof: Buffer[];
}
function u64Le(value: bigint) {
  if (value < 0n || value > U64_MAX) throw new Error("U64_OUT_OF_RANGE");
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(value);
  return encoded;
}

function sha256(...values: Uint8Array[]) {
  const digest = createHash("sha256");
  for (const value of values) digest.update(value);
  return digest.digest();
}

function pairHash(left: Buffer, right: Buffer) {
  return Buffer.compare(left, right) <= 0 ? sha256(left, right) : sha256(right, left);
}

export function rewardLeaf(epochId: bigint, recipient: string, rawAmount: bigint) {
  return sha256(LEAF_DOMAIN, u64Le(epochId), new PublicKey(recipient).toBuffer(), u64Le(rawAmount));
}

export function verifyRewardProof(root: Buffer, leaf: Buffer, proof: readonly Buffer[]) {
  return proof.reduce((node, sibling) => pairHash(node, sibling), leaf).equals(root);
}

export function buildRewardMerkle(epochId: bigint, allocations: readonly PushAllocation[]) {
  if (epochId <= 0n) throw new Error("INVALID_EPOCH_ID");
  const normalized = allocations
    .map(({ recipient, rawMstrx }) => ({ recipient: new PublicKey(recipient).toBase58(), rawAmount: rawMstrx }))
    .sort((a, b) => a.recipient.localeCompare(b.recipient));
  if (!normalized.length) throw new Error("EMPTY_DISTRIBUTION");
  const recipients = new Set<string>();
  for (const payment of normalized) {
    if (payment.rawAmount <= 0n) throw new Error("INVALID_PAYMENT_AMOUNT");
    u64Le(payment.rawAmount);
    if (recipients.has(payment.recipient)) throw new Error("DUPLICATE_RECIPIENT");
    recipients.add(payment.recipient);
  }

  const levels: Buffer[][] = [normalized.map((payment) => rewardLeaf(epochId, payment.recipient, payment.rawAmount))];
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!;
    const next: Buffer[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(index + 1 < current.length ? pairHash(current[index], current[index + 1]) : current[index]);
    }
    levels.push(next);
  }

  const payments: RewardMerklePayment[] = normalized.map((payment, leafIndex) => {
    const proof: Buffer[] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level += 1) {
      const sibling = index % 2 === 0 ? index + 1 : index - 1;
      if (sibling < levels[level].length) proof.push(levels[level][sibling]);
      index = Math.floor(index / 2);
    }
    return { ...payment, proof };
  });
  const root = levels.at(-1)![0];
  if (!payments.every((payment) => verifyRewardProof(root, rewardLeaf(epochId, payment.recipient, payment.rawAmount), payment.proof))) {
    throw new Error("MERKLE_PROOF_BUILD_FAILED");
  }
  return { epochId, root, payments };
}
