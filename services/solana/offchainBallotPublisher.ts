import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { mstrxAta } from "./mstrxTransfers";
import { governanceWindowStart } from "./governancePolicy";
import { prepareAndPublishSolanaGovernanceSnapshot } from "./governanceSnapshotPublisher";
import { readVerifiedGovernancePublicationDirectory } from "../../scripts/verify-governance-publication";
import { OFFCHAIN_ACTIONS, OFFCHAIN_VOTE_DOMAIN, validateOffchainBallot,
  type OffchainBallot, type OffchainAction } from "./offchainGovernance";

export interface OffchainBallotIntent {
  id: string;
  capitalMint: string;
  reserveWallet: string;
  reserveRawMstrx: string;
  durationHours: number;
  options: OffchainAction[];
  verifiedAt: number;
}

export function validateOffchainBallotIntent(input: unknown, issuedAt = Date.now()): OffchainBallotIntent {
  const intent = input as OffchainBallotIntent;
  if (!intent || typeof intent !== "object" || !/^[1-9]\d{0,19}$/.test(intent.id)
    || !/^[1-9]\d{0,29}$/.test(intent.reserveRawMstrx)
    || !Number.isSafeInteger(intent.durationHours) || intent.durationHours < 1 || intent.durationHours > 12
    || !Number.isSafeInteger(intent.verifiedAt) || intent.verifiedAt > issuedAt + 30_000
    || issuedAt - intent.verifiedAt > 90_000
    || !Array.isArray(intent.options) || intent.options.length < 2 || intent.options.length > 6
    || new Set(intent.options).size !== intent.options.length
    || intent.options.some((option) => !OFFCHAIN_ACTIONS.includes(option))) {
    throw new Error("OFFCHAIN_BALLOT_INTENT_INVALID");
  }
  try {
    if (new PublicKey(intent.capitalMint).toBase58() !== intent.capitalMint
      || new PublicKey(intent.reserveWallet).toBase58() !== intent.reserveWallet) throw new Error();
  } catch { throw new Error("OFFCHAIN_BALLOT_INTENT_INVALID"); }
  return intent;
}

export async function publishOffchainBallot(args: {
  intent: OffchainBallotIntent;
  publicDataRoot: string;
  stateRoot: string;
  rpcUrls: readonly [string, string];
  reserveMint: string;
  excluded: readonly string[];
  authorizedAt: number;
  nowMs?: number;
}): Promise<OffchainBallot> {
  const nowMs = args.nowMs ?? Date.now();
  const intent = validateOffchainBallotIntent(args.intent, args.authorizedAt);
  const publicRoot = resolve(args.publicDataRoot);
  const ballotRoot = resolve(publicRoot, "governance", "offchain");
  const activePath = resolve(ballotRoot, "active.json");
  try {
    const previous = validateOffchainBallot(JSON.parse(await readFile(activePath, "utf8")));
    if (previous.endsAt * 1_000 > nowMs) throw new Error("OFFCHAIN_BALLOT_ALREADY_ACTIVE");
    if (BigInt(intent.id) <= BigInt(previous.id)) throw new Error("OFFCHAIN_BALLOT_ID_NOT_INCREASING");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const launch = JSON.parse(await readFile(resolve(publicRoot, "config.json"), "utf8")) as {
    network?: string; projectMint?: string; reserveWallet?: string;
  };
  if (launch.network !== "solana-mainnet-beta" || launch.projectMint !== intent.capitalMint
    || launch.reserveWallet !== intent.reserveWallet) throw new Error("OFFCHAIN_LAUNCH_IDENTITY_CHANGED");
  const reserveAta = mstrxAta(new PublicKey(intent.reserveWallet), new PublicKey(args.reserveMint));
  const balances = await Promise.all(args.rpcUrls.map(async (url) =>
    (await new Connection(url, "finalized").getTokenAccountBalance(reserveAta, "finalized")).value.amount));
  if (balances[0] !== balances[1] || balances[0] !== intent.reserveRawMstrx) {
    throw new Error("OFFCHAIN_RESERVE_BALANCE_CHANGED");
  }
  const cache = JSON.parse(await readFile(resolve(args.stateRoot, "capital-transfers.json"), "utf8")) as {
    indexedThroughTime: number; launchTime: number;
  };
  const publication = await prepareAndPublishSolanaGovernanceSnapshot({
    governanceProgram: OFFCHAIN_VOTE_DOMAIN,
    proposalId: BigInt(intent.id),
    windowStart: governanceWindowStart(cache.indexedThroughTime, cache.launchTime),
    excluded: args.excluded,
    rpcUrls: args.rpcUrls,
    stateRoot: args.stateRoot,
    publicDataRoot: publicRoot,
    nowMs,
  });
  const verified = await readVerifiedGovernancePublicationDirectory(publication.publishedPath);
  if (verified.snapshot.governanceProgram !== OFFCHAIN_VOTE_DOMAIN
    || verified.snapshot.capitalMint !== intent.capitalMint
    || verified.manifest.proposalId !== intent.id) throw new Error("OFFCHAIN_SNAPSHOT_MISMATCH");
  const startsAt = Math.floor(Date.now() / 1_000) + 60;
  const ballot = validateOffchainBallot({
    version: 1, network: "solana-mainnet-beta", id: intent.id,
    capitalMint: intent.capitalMint, reserveWallet: intent.reserveWallet,
    reserveRawMstrx: intent.reserveRawMstrx,
    startsAt, endsAt: startsAt + intent.durationHours * 3_600,
    snapshotSha256: verified.manifest.snapshotSha256,
    merkleRoot: verified.snapshot.merkleRoot,
    totalAvailableWeight: verified.snapshot.totalAvailableWeight,
    options: intent.options, advisory: true,
  });
  await mkdir(ballotRoot, { recursive: true });
  await writeFile(resolve(ballotRoot, `${intent.id}.json`), `${JSON.stringify(ballot, null, 2)}\n`, {
    encoding: "utf8", mode: 0o644, flag: "wx", flush: true,
  });
  const temporary = resolve(ballotRoot, `.active-${intent.id}.json`);
  await writeFile(temporary, `${JSON.stringify(ballot, null, 2)}\n`, {
    encoding: "utf8", mode: 0o644, flag: "wx", flush: true,
  });
  await rename(temporary, activePath);
  return ballot;
}
