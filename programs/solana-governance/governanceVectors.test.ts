import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { FinalizedHolderJournal } from "../../services/solana/epochPlanner";
import { buildSolanaGovernanceSnapshot } from "../../services/solana/governanceSnapshot";

const address = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();

describe("Anchor governance proof format fixture", () => {
  it("has exactly the same one-leaf root as the Rust unit vector", () => {
    const journal: FinalizedHolderJournal = {
      version: 3,
      epochId: "1",
      capitalMint: address(2),
      launchSignature: "launch-tx",
      windowStart: 1_000,
      windowEnd: 2_000,
      finalizedThroughSlot: 20,
      finalizedBlockhash: address(3),
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 1, throughSlot: 20, throughBlockhash: address(3) },
      transfers: [{
        signature: "mint-a", slot: 1, transactionIndex: 0, instructionIndex: 0,
        timestamp: 1_000, to: address(4), rawAmount: "100",
      }],
    };
    const snapshot = buildSolanaGovernanceSnapshot({
      governanceProgram: "3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh",
      proposalId: 1n,
      journal,
      windowStart: 1_000,
      excluded: [],
    });
    expect(snapshot.totalAvailableWeight).toBe("100000");
    expect(snapshot.leafCount).toBe(1);
    expect(snapshot.entries[0].account).toBe(address(4));
    expect(snapshot.entries[0].proof).toEqual([]);
    expect(snapshot.exclusionsHash).toBe("c5cf2cd13ec8c0b7e94bbb54bb86bf0869de021e6d563aeb93c23ed39363440f");
    expect(snapshot.merkleRoot).toBe("e302ca53ea641cdd4d34ee86682eaccbf489b72360fede22ced0d41741e1e08d");

    const twoHolders = buildSolanaGovernanceSnapshot({
      governanceProgram: "3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh",
      proposalId: 1n,
      journal: {
        ...journal,
        transfers: [...journal.transfers, {
          signature: "mint-b", slot: 2, transactionIndex: 0, instructionIndex: 0,
          timestamp: 1_000, to: address(5), rawAmount: "50",
        }],
      },
      windowStart: 1_000,
      excluded: [],
    });
    expect(twoHolders.totalAvailableWeight).toBe("150000");
    expect(twoHolders.merkleRoot).toBe("17eee2b4b19ad09e3435dd93fd437bf2694b8aee8dcfa159ebff2f20dbff3513");
  });
});
