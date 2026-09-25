import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { assertSolanaGovernanceSnapshot, type SolanaGovernanceSnapshot } from "./governanceSnapshot";

export const OFFCHAIN_VOTE_DOMAIN = new PublicKey(createHash("sha256")
  .update("flywheel-strategy-offchain-ballot-v1", "utf8").digest()).toBase58();
export const OFFCHAIN_ACTIONS = [
  "ACCUMULATE", "BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "LOCK_MSTRX", "MARKETING_SALE",
] as const;
export type OffchainAction = typeof OFFCHAIN_ACTIONS[number];

export interface OffchainBallot {
  version: 1;
  network: "solana-mainnet-beta";
  id: string;
  capitalMint: string;
  reserveWallet: string;
  reserveRawMstrx: string;
  startsAt: number;
  endsAt: number;
  snapshotSha256: string;
  merkleRoot: string;
  totalAvailableWeight: string;
  options: OffchainAction[];
  advisory: true;
}

export interface SignedOffchainVote {
  proposalId: string;
  wallet: string;
  option: OffchainAction;
  signature: string;
}

export interface OffchainVoteReceipt extends SignedOffchainVote {
  weight: string;
  acceptedAt: number;
}

function exactPublicKey(value: unknown): value is string {
  try { return typeof value === "string" && new PublicKey(value).toBase58() === value; }
  catch { return false; }
}

export function validateOffchainBallot(input: unknown): OffchainBallot {
  const ballot = input as OffchainBallot;
  if (!ballot || typeof ballot !== "object" || ballot.version !== 1
    || ballot.network !== "solana-mainnet-beta" || ballot.advisory !== true
    || !/^[1-9]\d{0,19}$/.test(ballot.id) || !exactPublicKey(ballot.capitalMint)
    || !exactPublicKey(ballot.reserveWallet) || !/^(0|[1-9]\d{0,29})$/.test(ballot.reserveRawMstrx)
    || !Number.isSafeInteger(ballot.startsAt) || !Number.isSafeInteger(ballot.endsAt)
    || ballot.endsAt <= ballot.startsAt || ballot.endsAt - ballot.startsAt < 3_600
    || ballot.endsAt - ballot.startsAt > 43_200
    || !/^[a-f0-9]{64}$/.test(ballot.snapshotSha256)
    || !/^[a-f0-9]{64}$/.test(ballot.merkleRoot)
    || !/^[1-9]\d*$/.test(ballot.totalAvailableWeight)
    || !Array.isArray(ballot.options) || ballot.options.length < 2 || ballot.options.length > 6
    || new Set(ballot.options).size !== ballot.options.length
    || ballot.options.some((option) => !OFFCHAIN_ACTIONS.includes(option))) {
    throw new Error("OFFCHAIN_BALLOT_INVALID");
  }
  return ballot;
}

export function offchainVoteMessage(ballot: OffchainBallot, wallet: string, option: OffchainAction) {
  validateOffchainBallot(ballot);
  if (!exactPublicKey(wallet) || !ballot.options.includes(option)) throw new Error("OFFCHAIN_VOTE_INVALID");
  return [
    "FLYWHEEL STRATEGY OFFCHAIN VOTE V1",
    "Site: https://flywheelstrategy.xyz",
    "Network: Solana Mainnet Beta",
    `CAPITAL mint: ${ballot.capitalMint}`,
    `Proposal: ${ballot.id}`,
    `Snapshot SHA-256: ${ballot.snapshotSha256}`,
    `Wallet: ${wallet}`,
    `Choice: ${option}`,
    `Voting closes: ${new Date(ballot.endsAt * 1_000).toISOString()}`,
    "This is a signature, not a transaction or token approval",
  ].join("\n");
}

export function verifyOffchainVote(ballot: OffchainBallot, vote: SignedOffchainVote) {
  if (!vote || typeof vote !== "object" || vote.proposalId !== ballot.id
    || !exactPublicKey(vote.wallet) || !ballot.options.includes(vote.option)) {
    throw new Error("OFFCHAIN_VOTE_INVALID");
  }
  let signature: Uint8Array;
  try { signature = bs58.decode(vote.signature); } catch { throw new Error("OFFCHAIN_SIGNATURE_INVALID"); }
  if (signature.length !== 64 || !nacl.sign.detached.verify(
    new TextEncoder().encode(offchainVoteMessage(ballot, vote.wallet, vote.option)),
    signature, new PublicKey(vote.wallet).toBytes(),
  )) throw new Error("OFFCHAIN_SIGNATURE_INVALID");
}

export function verifiedOffchainSnapshot(ballot: OffchainBallot, raw: string): SolanaGovernanceSnapshot {
  const snapshot = JSON.parse(raw) as SolanaGovernanceSnapshot;
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== ballot.snapshotSha256 || !assertSolanaGovernanceSnapshot(snapshot)
    || snapshot.governanceProgram !== OFFCHAIN_VOTE_DOMAIN || snapshot.proposalId !== ballot.id
    || snapshot.capitalMint !== ballot.capitalMint || snapshot.merkleRoot !== ballot.merkleRoot
    || snapshot.totalAvailableWeight !== ballot.totalAvailableWeight) {
    throw new Error("OFFCHAIN_SNAPSHOT_MISMATCH");
  }
  return snapshot;
}

export function voteWeight(snapshot: SolanaGovernanceSnapshot, wallet: string) {
  const entry = snapshot.entries.find((candidate) => candidate.account === wallet);
  if (!entry || !/^[1-9]\d*$/.test(entry.weight)) throw new Error("OFFCHAIN_WALLET_INELIGIBLE");
  return entry.weight;
}

export function offchainVoteRoot(controlDataRoot: string, ballotId: string) {
  if (!/^[1-9]\d{0,19}$/.test(ballotId)) throw new Error("OFFCHAIN_BALLOT_ID_INVALID");
  return resolve(controlDataRoot, "solana-requests", "offchain-votes", ballotId);
}

export async function recordOffchainVote(args: {
  controlDataRoot: string; ballot: OffchainBallot; snapshot: SolanaGovernanceSnapshot;
  vote: SignedOffchainVote; now?: number;
}): Promise<OffchainVoteReceipt> {
  const now = args.now ?? Date.now();
  validateOffchainBallot(args.ballot);
  if (now < args.ballot.startsAt * 1_000 || now >= args.ballot.endsAt * 1_000) {
    throw new Error("OFFCHAIN_VOTE_CLOSED");
  }
  verifyOffchainVote(args.ballot, args.vote);
  const weight = voteWeight(args.snapshot, args.vote.wallet);
  const root = offchainVoteRoot(args.controlDataRoot, args.ballot.id);
  await mkdir(root, { recursive: true });
  const receipt = { ...args.vote, weight, acceptedAt: now };
  try {
    await writeFile(resolve(root, `${args.vote.wallet}.json`), `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8", mode: 0o600, flag: "wx", flush: true,
    });
    return receipt;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    const prior = JSON.parse(await readFile(resolve(root, `${args.vote.wallet}.json`), "utf8")) as OffchainVoteReceipt;
    if (prior.signature === receipt.signature && prior.option === receipt.option
      && prior.proposalId === receipt.proposalId && prior.weight === receipt.weight) return prior;
    throw new Error("OFFCHAIN_ALREADY_VOTED");
  }
}

export async function offchainTally(controlDataRoot: string, ballot: OffchainBallot,
  snapshot: SolanaGovernanceSnapshot) {
  const root = offchainVoteRoot(controlDataRoot, ballot.id);
  let names: string[];
  try { names = await readdir(root); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") names = [];
    else throw error;
  }
  if (names.some((name) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(name))) {
    throw new Error("OFFCHAIN_VOTE_STORE_INVALID");
  }
  const totals = Object.fromEntries(ballot.options.map((option) => [option, "0"])) as Record<OffchainAction, string>;
  const receipts: OffchainVoteReceipt[] = [];
  const eligibleWeights = new Map(snapshot.entries.map((entry) => [entry.account, entry.weight]));
  for (const name of names.sort()) {
    const receipt = JSON.parse(await readFile(resolve(root, name), "utf8")) as OffchainVoteReceipt;
    if (name !== `${receipt.wallet}.json` || !Number.isSafeInteger(receipt.acceptedAt)
      || receipt.acceptedAt < ballot.startsAt * 1_000 || receipt.acceptedAt >= ballot.endsAt * 1_000
      || receipt.weight !== eligibleWeights.get(receipt.wallet)) throw new Error("OFFCHAIN_VOTE_STORE_INVALID");
    verifyOffchainVote(ballot, receipt);
    totals[receipt.option] = (BigInt(totals[receipt.option]) + BigInt(receipt.weight)).toString();
    receipts.push(receipt);
  }
  return { totals, count: receipts.length, receipts };
}
