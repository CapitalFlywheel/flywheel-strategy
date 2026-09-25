import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { buildSolanaGovernanceSnapshot } from "./governanceSnapshot";
import { OFFCHAIN_ACTIONS, OFFCHAIN_VOTE_DOMAIN, offchainTally, offchainVoteMessage,
  recordOffchainVote, verifiedOffchainSnapshot, type OffchainBallot, type OffchainAction } from "./offchainGovernance";

const holder = Keypair.fromSeed(new Uint8Array(32).fill(11));
const outsider = Keypair.fromSeed(new Uint8Array(32).fill(12));
const mint = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey.toBase58();
const reserve = Keypair.fromSeed(new Uint8Array(32).fill(14)).publicKey.toBase58();
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(15)).publicKey.toBase58();
const snapshot = buildSolanaGovernanceSnapshot({
  governanceProgram: OFFCHAIN_VOTE_DOMAIN, proposalId: 12345n, windowStart: 1_000, excluded: [],
  journal: { version: 3, capitalMint: mint,
    windowEnd: 2_000, finalizedThroughSlot: 20, finalizedBlockhash: blockhash,
    coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 1, throughSlot: 20, throughBlockhash: blockhash },
    transfers: [{ signature: "mint-holder", slot: 1, transactionIndex: 0, instructionIndex: 0,
      timestamp: 1_000, to: holder.publicKey.toBase58(), rawAmount: "100" }],
  },
});
const raw = JSON.stringify(snapshot, null, 2) + "\n";
const ballot: OffchainBallot = { version: 1, network: "solana-mainnet-beta", advisory: true,
  id: "12345", capitalMint: mint, reserveWallet: reserve, reserveRawMstrx: "100000000",
  startsAt: 3_000, endsAt: 6_600,
  snapshotSha256: createHash("sha256").update(raw).digest("hex"),
  merkleRoot: snapshot.merkleRoot, totalAvailableWeight: snapshot.totalAvailableWeight,
  options: [...OFFCHAIN_ACTIONS],
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function signedVote(option: OffchainAction, signer = holder) {
  const wallet = signer.publicKey.toBase58();
  return { proposalId: ballot.id, wallet, option,
    signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(offchainVoteMessage(ballot, wallet, option)), signer.secretKey)) };
}

describe("signed offchain holder vote", () => {
  it("checks the published snapshot digest, holder eligibility and exact message signature", () => {
    expect(verifiedOffchainSnapshot(ballot, raw)).toEqual(snapshot);
    expect(() => verifiedOffchainSnapshot(ballot, raw.replace("100", "101"))).toThrow("OFFCHAIN_SNAPSHOT_MISMATCH");
  });

  it("records one vote per eligible wallet without a transaction and tallies the frozen weight", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-vote-"));
    directories.push(root);
    const vote = signedVote("BUYBACK_BURN");
    const first = await recordOffchainVote({ controlDataRoot: root, ballot, snapshot, vote, now: 3_100_000 });
    expect(first.weight).toBe(snapshot.entries[0].weight);
    expect(await recordOffchainVote({ controlDataRoot: root, ballot, snapshot, vote, now: 3_200_000 })).toEqual(first);
    await expect(recordOffchainVote({ controlDataRoot: root, ballot, snapshot,
      vote: signedVote("ACCUMULATE"), now: 3_200_000 })).rejects.toThrow("OFFCHAIN_ALREADY_VOTED");
    await expect(recordOffchainVote({ controlDataRoot: root, ballot, snapshot,
      vote: signedVote("BUYBACK_BURN", outsider), now: 3_200_000 })).rejects.toThrow("OFFCHAIN_WALLET_INELIGIBLE");
    const tally = await offchainTally(root, ballot, snapshot);
    expect(tally.count).toBe(1);
    expect(tally.totals.BUYBACK_BURN).toBe(first.weight);
    expect(tally.totals.ACCUMULATE).toBe("0");
  });

  it("rejects tampered choices, foreign signatures and closed voting windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-vote-"));
    directories.push(root);
    await expect(recordOffchainVote({ controlDataRoot: root, ballot, snapshot,
      vote: { ...signedVote("ACCUMULATE"), option: "BUYBACK_HOLD" }, now: 3_100_000 }))
      .rejects.toThrow("OFFCHAIN_SIGNATURE_INVALID");
    await expect(recordOffchainVote({ controlDataRoot: root, ballot, snapshot,
      vote: { ...signedVote("ACCUMULATE"), wallet: outsider.publicKey.toBase58() }, now: 3_100_000 }))
      .rejects.toThrow("OFFCHAIN_SIGNATURE_INVALID");
    await expect(recordOffchainVote({ controlDataRoot: root, ballot, snapshot,
      vote: signedVote("ACCUMULATE"), now: 6_600_000 })).rejects.toThrow("OFFCHAIN_VOTE_CLOSED");
  });
});
