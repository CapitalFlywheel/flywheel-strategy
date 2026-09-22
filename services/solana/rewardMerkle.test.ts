import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { buildRewardMerkle, rewardLeaf, verifyRewardProof } from "./rewardMerkle";

const recipients = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58()).sort();

describe("reward Merkle tree", () => {
  it("creates proofs matching the on-chain sorted-pair verifier including an odd leaf", () => {
    const tree = buildRewardMerkle(17n, recipients.map((recipient, index) => ({ recipient, rawMstrx: BigInt(index + 1) })));
    expect(tree.root).toHaveLength(32);
    expect(tree.payments).toHaveLength(5);
    for (const payment of tree.payments) {
      expect(verifyRewardProof(tree.root, rewardLeaf(17n, payment.recipient, payment.rawAmount), payment.proof)).toBe(true);
    }
  });

  it("rejects duplicate recipients and zero amounts", () => {
    expect(() => buildRewardMerkle(1n, [
      { recipient: recipients[0], rawMstrx: 1n },
      { recipient: recipients[0], rawMstrx: 2n },
    ])).toThrow("DUPLICATE_RECIPIENT");
    expect(() => buildRewardMerkle(1n, [{ recipient: recipients[0], rawMstrx: 0n }])).toThrow("INVALID_PAYMENT_AMOUNT");
  });
});
