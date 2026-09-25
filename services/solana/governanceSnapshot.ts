import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { assertFinalizedFullBlockCoverage, type FinalizedHolderJournal } from "./epochPlanner";
import { SolanaHoldingEngine, type SolanaTransfer } from "./holderAccounting";

// These bytes are part of the proof format. A future on-chain verifier must use
// the same domains, little-endian integers, sorted pairs and odd-node carry.
const LEAF_DOMAIN = Buffer.from("flywheel-solana-governance-leaf-v1\0", "utf8");
const NODE_DOMAIN = Buffer.from("flywheel-solana-governance-node-v1\0", "utf8");
const ROOT_DOMAIN = Buffer.from("flywheel-solana-governance-root-v1\0", "utf8");
const EXCLUSIONS_DOMAIN = Buffer.from("flywheel-solana-governance-exclusions-v1\0", "utf8");
const NETWORK_DOMAIN = Buffer.from("solana-mainnet-beta\0", "utf8");
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export type GovernanceTransferWindow = Pick<FinalizedHolderJournal,
  "version" | "capitalMint" | "windowEnd" | "finalizedThroughSlot" | "finalizedBlockhash" | "coverage" | "transfers">;

export interface SolanaGovernanceSnapshotEntry {
  account: string;
  weight: string;
  proof: string[];
}

export interface SolanaGovernanceSnapshot {
  version: 1;
  network: "solana-mainnet-beta";
  governanceProgram: string;
  proposalId: string;
  capitalMint: string;
  windowStart: number;
  windowEnd: number;
  finalizedThroughSlot: number;
  finalizedBlockhash: string;
  excludedAccounts: string[];
  exclusionsHash: string;
  leafCount: number;
  merkleRoot: string;
  totalAvailableWeight: string;
  entries: SolanaGovernanceSnapshotEntry[];
}

function sha256(...pieces: Uint8Array[]) {
  const hash = createHash("sha256");
  for (const piece of pieces) hash.update(piece);
  return hash.digest();
}

function u64(value: bigint) {
  if (value < 0n || value > U64_MAX) throw new Error("GOVERNANCE_U64_OUT_OF_RANGE");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function u128(value: bigint) {
  if (value < 0n || value > U128_MAX) throw new Error("GOVERNANCE_U128_OUT_OF_RANGE");
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64LE(value & U64_MAX);
  bytes.writeBigUInt64LE(value >> 64n, 8);
  return bytes;
}

function publicKey(value: string) {
  return new PublicKey(value).toBase58();
}

function compareAddresses(left: string, right: string) {
  return Buffer.compare(new PublicKey(left).toBuffer(), new PublicKey(right).toBuffer());
}

function nodeHash(left: Buffer, right: Buffer) {
  return Buffer.compare(left, right) <= 0
    ? sha256(NODE_DOMAIN, left, right)
    : sha256(NODE_DOMAIN, right, left);
}

function exclusionHash(accounts: readonly string[]) {
  return sha256(EXCLUSIONS_DOMAIN, ...accounts.map((account) => new PublicKey(account).toBuffer()));
}

function leafHash(snapshot: Pick<SolanaGovernanceSnapshot,
  "governanceProgram" | "proposalId" | "capitalMint" |
  "windowStart" | "windowEnd" | "finalizedThroughSlot" | "finalizedBlockhash" | "exclusionsHash">,
account: string, weight: bigint) {
  return sha256(
    LEAF_DOMAIN, NETWORK_DOMAIN,
    new PublicKey(snapshot.governanceProgram).toBuffer(),
    new PublicKey(snapshot.capitalMint).toBuffer(),
    u64(BigInt(snapshot.proposalId)),
    u64(BigInt(snapshot.windowStart)), u64(BigInt(snapshot.windowEnd)),
    u64(BigInt(snapshot.finalizedThroughSlot)), new PublicKey(snapshot.finalizedBlockhash).toBuffer(),
    Buffer.from(snapshot.exclusionsHash, "hex"), new PublicKey(account).toBuffer(), u128(weight),
  );
}

function merkleLevels(leaves: readonly Buffer[]) {
  const levels: Buffer[][] = [[...leaves]];
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!;
    const next: Buffer[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(index + 1 < current.length ? nodeHash(current[index], current[index + 1]) : current[index]);
    }
    levels.push(next);
  }
  return levels;
}

function merkleProof(levels: readonly Buffer[][], leafIndex: number) {
  const proof: string[] = [];
  let index = leafIndex;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    if (sibling < levels[level].length) proof.push(levels[level][sibling].toString("hex"));
    index = Math.floor(index / 2);
  }
  return proof;
}

function validatedTransfers(journal: GovernanceTransferWindow) {
  if (!Array.isArray(journal.transfers)) throw new Error("GOVERNANCE_JOURNAL_INVALID");
  const seen = new Set<string>();
  const transfers: SolanaTransfer[] = journal.transfers.map((row) => {
    if (typeof row.signature !== "string" || !row.signature || !Number.isSafeInteger(row.slot) || row.slot <= 0
      || row.slot > journal.finalizedThroughSlot || !Number.isSafeInteger(row.instructionIndex) || row.instructionIndex < 0
      || row.transactionIndex !== undefined && (!Number.isSafeInteger(row.transactionIndex) || row.transactionIndex < 0)
      || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > journal.windowEnd
      || typeof row.rawAmount !== "string" || !/^[1-9]\d*$/.test(row.rawAmount)
      || !row.from && !row.to) throw new Error("GOVERNANCE_TRANSFER_INVALID");
    const eventId = JSON.stringify([row.signature, row.slot, row.instructionIndex]);
    if (seen.has(eventId)) throw new Error("GOVERNANCE_DUPLICATE_TRANSFER");
    seen.add(eventId);
    return {
      ...row, from: row.from ? publicKey(row.from) : undefined,
      to: row.to ? publicKey(row.to) : undefined,
      rawAmount: BigInt(row.rawAmount),
    };
  });
  transfers.sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0)
    || a.instructionIndex - b.instructionIndex || a.signature.localeCompare(b.signature));
  for (let index = 1; index < transfers.length; index += 1) {
    if (transfers[index].timestamp < transfers[index - 1].timestamp) throw new Error("GOVERNANCE_TRANSFER_TIME_REGRESSION");
  }
  return transfers;
}

/**
 * Builds a deterministic vote-weight commitment from an already verified,
 * finalized, complete mint-wide holder journal. This pure function does not
 * verify RPC finality, transfer-source completeness or reserve custody.
 * The explicit windowStart is a governance-policy input, not silently copied
 * from a reward epoch's potentially different window.
 */
export function buildSolanaGovernanceSnapshot(args: {
  governanceProgram: string;
  proposalId: bigint;
  journal: GovernanceTransferWindow;
  windowStart: number;
  excluded: Iterable<string>;
}): SolanaGovernanceSnapshot {
  const { journal } = args;
  if (journal.version !== 3 || !Number.isSafeInteger(journal.windowEnd) || journal.windowEnd <= 0
    || !Number.isSafeInteger(args.windowStart) || args.windowStart < 0 || args.windowStart >= journal.windowEnd
    || !Number.isSafeInteger(journal.finalizedThroughSlot) || journal.finalizedThroughSlot <= 0) {
    throw new Error("GOVERNANCE_JOURNAL_INVALID");
  }
  assertFinalizedFullBlockCoverage(journal.coverage, journal.finalizedThroughSlot, journal.finalizedBlockhash);
  if (args.proposalId <= 0n) throw new Error("GOVERNANCE_PROPOSAL_ID_INVALID");
  u64(args.proposalId);
  const governanceProgram = publicKey(args.governanceProgram);
  const capitalMint = publicKey(journal.capitalMint);
  const finalizedBlockhash = publicKey(journal.finalizedBlockhash);
  const excludedAccounts = [...new Set([...args.excluded].map(publicKey))].sort(compareAddresses);
  const exclusionsHash = exclusionHash(excludedAccounts).toString("hex");
  const engine = new SolanaHoldingEngine(args.windowStart, journal.windowEnd, excludedAccounts);
  for (const transfer of validatedTransfers(journal)) engine.apply(transfer);
  const weighted = [...engine.finalize()].sort(([left], [right]) => compareAddresses(left, right));
  if (weighted.length === 0) throw new Error("GOVERNANCE_NO_ELIGIBLE_HOLDERS");
  const totalAvailableWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0n);
  u128(totalAvailableWeight);
  const metadata = {
    governanceProgram, proposalId: args.proposalId.toString(), capitalMint,
    windowStart: args.windowStart,
    windowEnd: journal.windowEnd, finalizedThroughSlot: journal.finalizedThroughSlot,
    finalizedBlockhash, exclusionsHash,
  };
  const levels = merkleLevels(weighted.map(([account, weight]) => leafHash(metadata, account, weight)));
  const merkleRoot = sha256(ROOT_DOMAIN, u64(BigInt(weighted.length)), u128(totalAvailableWeight), levels.at(-1)![0]);
  const snapshot: SolanaGovernanceSnapshot = {
    version: 1, network: "solana-mainnet-beta", ...metadata, excludedAccounts,
    leafCount: weighted.length, merkleRoot: merkleRoot.toString("hex"), totalAvailableWeight: totalAvailableWeight.toString(),
    entries: weighted.map(([account, weight], index) => ({
      account, weight: weight.toString(), proof: merkleProof(levels, index),
    })),
  };
  if (!assertSolanaGovernanceSnapshot(snapshot)) throw new Error("GOVERNANCE_SNAPSHOT_NOT_CONSERVED");
  return snapshot;
}

export function verifySolanaGovernanceProof(snapshot: SolanaGovernanceSnapshot, entry: SolanaGovernanceSnapshotEntry) {
  try {
    if (snapshot.version !== 1 || snapshot.network !== "solana-mainnet-beta"
      || !/^[a-f0-9]{64}$/.test(snapshot.merkleRoot) || !/^[a-f0-9]{64}$/.test(snapshot.exclusionsHash)
      || !/^[1-9]\d*$/.test(entry.weight)) return false;
    let hash = leafHash(snapshot, entry.account, BigInt(entry.weight));
    for (const sibling of entry.proof) {
      if (!/^[a-f0-9]{64}$/.test(sibling)) return false;
      hash = nodeHash(hash, Buffer.from(sibling, "hex"));
    }
    return sha256(ROOT_DOMAIN, u64(BigInt(snapshot.leafCount)), u128(BigInt(snapshot.totalAvailableWeight)), hash)
      .toString("hex") === snapshot.merkleRoot;
  } catch {
    return false;
  }
}

export function assertSolanaGovernanceSnapshot(snapshot: SolanaGovernanceSnapshot) {
  try {
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length === 0
      || snapshot.entries.length !== snapshot.leafCount
      || !Array.isArray(snapshot.excludedAccounts)
      || exclusionHash(snapshot.excludedAccounts).toString("hex") !== snapshot.exclusionsHash) return false;
    if (snapshot.excludedAccounts.some((account, index) => publicKey(account) !== account
      || index > 0 && compareAddresses(snapshot.excludedAccounts[index - 1], account) >= 0)) return false;
    const seen = new Set<string>();
    let total = 0n;
    for (let index = 0; index < snapshot.entries.length; index += 1) {
      const entry = snapshot.entries[index];
      if (seen.has(entry.account) || snapshot.excludedAccounts.includes(entry.account)
        || publicKey(entry.account) !== entry.account
        || index > 0 && compareAddresses(snapshot.entries[index - 1].account, entry.account) >= 0
        || !verifySolanaGovernanceProof(snapshot, entry)) return false;
      seen.add(entry.account);
      total += BigInt(entry.weight);
    }
    if (total !== BigInt(snapshot.totalAvailableWeight) || total <= 0n || total > U128_MAX) return false;
    const leaves = snapshot.entries.map((entry) => leafHash(snapshot, entry.account, BigInt(entry.weight)));
    const rebuiltRoot = sha256(ROOT_DOMAIN, u64(BigInt(leaves.length)), u128(total), merkleLevels(leaves).at(-1)![0]);
    return rebuiltRoot.toString("hex") === snapshot.merkleRoot;
  } catch {
    return false;
  }
}
