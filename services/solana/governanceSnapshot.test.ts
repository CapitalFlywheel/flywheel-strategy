import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { FinalizedHolderJournal } from "./epochPlanner";
import {
  assertSolanaGovernanceSnapshot, buildSolanaGovernanceSnapshot, verifySolanaGovernanceProof,
} from "./governanceSnapshot";

const address = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
const program = address(1);
const mint = address(2);
const blockhash = address(3);
const a = address(4);
const b = address(5);
const c = address(6);
const outsider = address(7);

function journal(): FinalizedHolderJournal {
  return {
    version: 3, epochId: "1", capitalMint: mint, launchSignature: "launch-tx", windowStart: 1_000, windowEnd: 2_000,
    finalizedThroughSlot: 20, finalizedBlockhash: blockhash,
    coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 1, throughSlot: 20, throughBlockhash: blockhash },
    transfers: [
      { signature: "mint-a", slot: 1, transactionIndex: 0, instructionIndex: 0, timestamp: 1_000, to: a, rawAmount: "100" },
      { signature: "send-ab", slot: 5, transactionIndex: 0, instructionIndex: 0, timestamp: 1_100, from: a, to: b, rawAmount: "40" },
      { signature: "mint-b", slot: 7, transactionIndex: 0, instructionIndex: 0, timestamp: 1_300, to: b, rawAmount: "30" },
      { signature: "mint-c", slot: 9, transactionIndex: 0, instructionIndex: 0, timestamp: 1_400, to: c, rawAmount: "5" },
    ],
  };
}

function build(overrides: Partial<Parameters<typeof buildSolanaGovernanceSnapshot>[0]> = {}) {
  return buildSolanaGovernanceSnapshot({ governanceProgram: program, proposalId: 1n, journal: journal(), windowStart: 1_000, excluded: [], ...overrides });
}

describe("Solana governance snapshot", () => {
  it("conserves token-time through transfers and proves all eligible leaves, including an odd leaf", () => {
    const snapshot = build();
    // Before the first loyalty-hour boundary: 100*1000 + 30*700 + 5*600.
    expect(snapshot.totalAvailableWeight).toBe("124000");
    expect(snapshot.leafCount).toBe(3);
    expect(snapshot.entries.reduce((sum, row) => sum + BigInt(row.weight), 0n)).toBe(124_000n);
    expect(snapshot.entries.map((row) => row.account)).toEqual([a, b, c].sort((x, y) =>
      Buffer.compare(new PublicKey(x).toBuffer(), new PublicKey(y).toBuffer())));
    expect(snapshot.entries.every((entry) => verifySolanaGovernanceProof(snapshot, entry))).toBe(true);
    expect(assertSolanaGovernanceSnapshot(snapshot)).toBe(true);
  });

  it("rejects vendor-only history and a full-block marker that does not reach the snapshot slot", () => {
    expect(() => build({ journal: { ...journal(), version: 2 } as unknown as FinalizedHolderJournal }))
      .toThrow("GOVERNANCE_JOURNAL_INVALID");
    const source = journal();
    expect(() => build({ journal: { ...source, coverage: { ...source.coverage, throughSlot: source.finalizedThroughSlot - 1 } } }))
      .toThrow("HOLDER_FULL_BLOCK_COVERAGE_INVALID");
  });

  it("is independent of source event order and exclusion input order", () => {
    const source = journal();
    const reversed = { ...source, transfers: [...source.transfers].reverse() };
    const first = build({ journal: source, excluded: [outsider, c] });
    const second = build({ journal: reversed, excluded: [c, outsider, c] });
    expect(second).toEqual(first);
    expect(first.entries.map((entry) => entry.account)).not.toContain(c);
  });

  it("binds a proof to its exact weight, mint, proposal, program, block and exclusion policy", () => {
    const snapshot = build();
    const entry = snapshot.entries[0];
    expect(verifySolanaGovernanceProof(snapshot, { ...entry, weight: (BigInt(entry.weight) + 1n).toString() })).toBe(false);
    expect(verifySolanaGovernanceProof(snapshot, { ...entry, account: outsider })).toBe(false);
    expect(build({ proposalId: 2n }).merkleRoot).not.toBe(snapshot.merkleRoot);
    expect(build({ governanceProgram: address(8) }).merkleRoot).not.toBe(snapshot.merkleRoot);
    expect(build({ journal: { ...journal(), capitalMint: address(9) } }).merkleRoot).not.toBe(snapshot.merkleRoot);
    expect(build({ journal: { ...journal(), finalizedBlockhash: address(10),
      coverage: { ...journal().coverage, throughBlockhash: address(10) } } }).merkleRoot).not.toBe(snapshot.merkleRoot);
    expect(build({ excluded: [outsider] }).merkleRoot).not.toBe(snapshot.merkleRoot);
    expect(build({ windowStart: 1_100 }).merkleRoot).not.toBe(snapshot.merkleRoot);
    expect(assertSolanaGovernanceSnapshot({ ...snapshot, totalAvailableWeight: "1" })).toBe(false);
    expect(assertSolanaGovernanceSnapshot({ ...snapshot, entries: snapshot.entries.slice(1) })).toBe(false);
  });

  it("fails closed on empty eligibility, duplicate movements and transfers beyond finality", () => {
    expect(() => build({ journal: { ...journal(), transfers: [] } })).toThrow("GOVERNANCE_NO_ELIGIBLE_HOLDERS");
    expect(() => build({ excluded: [a, b, c] })).toThrow("GOVERNANCE_NO_ELIGIBLE_HOLDERS");
    const source = journal();
    expect(() => build({ journal: { ...source, transfers: [...source.transfers, source.transfers[0]] } }))
      .toThrow("GOVERNANCE_DUPLICATE_TRANSFER");
    expect(() => build({ journal: { ...source, transfers: [...source.transfers, {
      signature: "late", slot: 21, transactionIndex: 0, instructionIndex: 0, timestamp: 1_500, to: a, rawAmount: "1",
    }] } })).toThrow("GOVERNANCE_TRANSFER_INVALID");
    expect(() => build({ journal: { ...source, transfers: [...source.transfers, {
      signature: "backdated", slot: 11, transactionIndex: 0, instructionIndex: 0, timestamp: 1_200, to: a, rawAmount: "1",
    }] } })).toThrow("GOVERNANCE_TRANSFER_TIME_REGRESSION");
  });
});
