import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { assertVerifiedHolderCache, holderMovements, type CachedJournal } from "./holderJournal";
import { buildSolanaGovernanceSnapshot } from "./governanceSnapshot";
import { governanceWindowStart } from "./governancePolicy";
import { readAgreedFinalizedTransaction } from "./finalizedTransfers";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { readFinalizedBlockSignatures } from "./rpcTransactionVersion";
import { readVerifiedGovernancePublicationDirectory } from "../../scripts/verify-governance-publication";

export type GovernanceTransferCache = CachedJournal;
type CachedTransaction = CachedJournal["transactions"][number];

interface ActivatedLaunch {
  network: string;
  projectMint: string;
  launchedAtSlot: number;
  launchedAtSignature: string;
}

interface IndexerHeartbeat {
  service: string;
  ok: boolean;
  updatedAt: number;
  detail: string;
}

const MAX_HEARTBEAT_AGE_MS = 12 * 60_000;
const MAX_CACHE_AGE_SECONDS = 25 * 60;
const RPC_BATCH_SIZE = 8;
const TRANSACTION_BATCH_SIZE = 4;

/** Operator-declared publication time; onchain proposal creation supplies the independently dated commitment. */
export interface GovernanceSnapshotManifest {
  version: 2;
  network: "solana-mainnet-beta";
  proposalId: string;
  publishedAtUnix: number;
  merkleRoot: string;
  totalAvailableWeight: string;
  sourceSha256: string;
  snapshotSha256: string;
  source: string;
  snapshot: string;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value, null, 2) + "\n").digest("hex");
}

function exactPublicKey(value: string) {
  try { return typeof value === "string" && new PublicKey(value).toBase58() === value; }
  catch { return false; }
}

function checkedCache(input: unknown, launch: ActivatedLaunch, heartbeat: IndexerHeartbeat, nowMs: number) {
  // The indexer rejects every pre-digest V3 cache and rebuilds from launch.
  // Voting must use that same integrity gate before a marker can be trusted.
  assertVerifiedHolderCache(input);
  const cache = input;
  if (!exactPublicKey(cache.mint)
    || cache.mint !== launch.projectMint || cache.launchSlot !== launch.launchedAtSlot
    || cache.launchSignature !== launch.launchedAtSignature
    || !Number.isSafeInteger(cache.launchTime) || cache.launchTime <= 0
    || !Number.isSafeInteger(cache.indexedThroughSlot) || cache.indexedThroughSlot < cache.launchSlot
    || !Number.isSafeInteger(cache.indexedThroughTime) || cache.indexedThroughTime <= cache.launchTime
    || cache.coverage?.kind !== "two-rpc-finalized-full-blocks"
    || cache.coverage.fromSlot !== cache.launchSlot || cache.coverage.throughSlot !== cache.indexedThroughSlot
    || !exactPublicKey(cache.coverage.throughBlockhash)
    || !Array.isArray(cache.transactions) || cache.transactions.length === 0) {
    throw new Error("GOVERNANCE_TRANSFER_CACHE_IDENTITY_INVALID");
  }
  const progress = /^finalized-slot=(\d+):transactions=(\d+):journal=(?:\d+|waiting)$/.exec(heartbeat.detail ?? "");
  if (heartbeat.service !== "solana-holder-indexer" || heartbeat.ok !== true
    || !Number.isSafeInteger(heartbeat.updatedAt) || heartbeat.updatedAt > nowMs + 30_000
    || nowMs - heartbeat.updatedAt > MAX_HEARTBEAT_AGE_MS
    || !progress || Number(progress[1]) !== cache.indexedThroughSlot
    || Number(progress[2]) !== cache.transactions.length) {
    throw new Error("GOVERNANCE_INDEXER_COVERAGE_UNVERIFIED");
  }
  if (Math.floor(nowMs / 1_000) - cache.indexedThroughTime > MAX_CACHE_AGE_SECONDS
    || cache.indexedThroughTime > Math.floor(nowMs / 1_000) + 30) {
    throw new Error("GOVERNANCE_TRANSFER_CACHE_STALE");
  }
  const first = cache.transactions[0];
  if (first.signature !== cache.launchSignature || first.slot !== cache.launchSlot
    || first.blockTime !== cache.launchTime) throw new Error("GOVERNANCE_LAUNCH_COVERAGE_MISSING");
  const signatures = new Set<string>();
  let previousSlot = 0;
  let previousIndex = -1;
  let previousTime = cache.launchTime;
  for (const row of cache.transactions) {
    if (typeof row.signature !== "string" || !row.signature || signatures.has(row.signature)
      || !Number.isSafeInteger(row.slot) || row.slot < cache.launchSlot || row.slot > cache.indexedThroughSlot
      || !Number.isSafeInteger(row.transactionIndex) || row.transactionIndex < 0
      || !Number.isSafeInteger(row.blockTime) || row.blockTime < cache.launchTime
      || row.blockTime > cache.indexedThroughTime || row.blockTime < previousTime || !exactPublicKey(row.blockhash)
      || !Array.isArray(row.transfers)
      || row.slot < previousSlot || row.slot === previousSlot && row.transactionIndex <= previousIndex) {
      throw new Error("GOVERNANCE_TRANSFER_CACHE_INVALID");
    }
    for (const movement of row.transfers) {
      if (movement.signature !== row.signature || movement.slot !== row.slot
        || movement.transactionIndex !== row.transactionIndex || movement.timestamp !== row.blockTime) {
        throw new Error("GOVERNANCE_TRANSFER_CACHE_MOVEMENT_MISMATCH");
      }
    }
    signatures.add(row.signature);
    previousSlot = row.slot;
    previousIndex = row.transactionIndex;
    previousTime = row.blockTime;
  }
  return cache;
}

async function verifyCachedBlocks(cache: GovernanceTransferCache, rpcUrls: readonly [string, string]) {
  const consensus = await finalizedConsensus(rpcUrls);
  if (cache.indexedThroughSlot > consensus.slot) throw new Error("GOVERNANCE_CACHE_AHEAD_OF_FINALITY");
  const connections = rpcUrls.map((url) => new Connection(url, "finalized"));
  const rowsBySlot = new Map<number, CachedTransaction[]>();
  for (const row of cache.transactions) rowsBySlot.set(row.slot, [...(rowsBySlot.get(row.slot) ?? []), row]);
  const slots = [...new Set([...rowsBySlot.keys(), cache.indexedThroughSlot])].sort((a, b) => a - b);
  let tip: { blockhash: string; blockTime: number } | undefined;
  for (let index = 0; index < slots.length; index += RPC_BATCH_SIZE) {
    await Promise.all(slots.slice(index, index + RPC_BATCH_SIZE).map(async (slot) => {
      const blocks = await Promise.all(connections.map((connection) => readFinalizedBlockSignatures(connection, slot)));
      const block = requireMatchingValues(blocks.map((value) => ({
        blockhash: value.blockhash, blockTime: value.blockTime!, signatures: value.signatures,
      })), "GOVERNANCE_BLOCK_RPC_DISAGREEMENT");
      for (const row of rowsBySlot.get(slot) ?? []) {
        if (row.blockhash !== block.blockhash || row.blockTime !== block.blockTime
          || block.signatures[row.transactionIndex] !== row.signature) throw new Error("GOVERNANCE_CACHED_TRANSFER_REORGED");
      }
      if (slot === cache.indexedThroughSlot) tip = { blockhash: block.blockhash, blockTime: block.blockTime };
    }));
  }
  if (!tip || tip.blockTime !== cache.indexedThroughTime
    || tip.blockhash !== cache.coverage.throughBlockhash
    || cache.indexedThroughSlot === consensus.slot && tip.blockhash !== consensus.blockhash) {
    throw new Error("GOVERNANCE_CACHE_TIP_MISMATCH");
  }
  return { slot: cache.indexedThroughSlot, blockhash: tip.blockhash, blockTime: tip.blockTime, verifiedSlots: slots.length };
}

async function verifyCachedMovements(cache: GovernanceTransferCache, rpcUrls: readonly [string, string]) {
  // The JSON cache is not an authenticated source of token movements. Rebuild
  // every row from two agreeing finalized RPC responses before committing it
  // to the Merkle root. A single unavailable response must fail closed.
  for (let index = 0; index < cache.transactions.length; index += TRANSACTION_BATCH_SIZE) {
    await Promise.all(cache.transactions.slice(index, index + TRANSACTION_BATCH_SIZE).map(async (row) => {
      const transaction = await readAgreedFinalizedTransaction(rpcUrls, row.signature, cache.mint, { includeOrderedMovements: true });
      if (!transaction || transaction.slot !== row.slot || transaction.blockTime !== row.blockTime
        || transaction.blockhash !== row.blockhash) throw new Error("GOVERNANCE_CACHED_TRANSACTION_UNVERIFIED");
      const canonical = holderMovements(transaction, row.transactionIndex);
      if (canonical.length !== row.transfers.length) throw new Error("GOVERNANCE_CACHED_MOVEMENT_MISMATCH");
      for (let movementIndex = 0; movementIndex < canonical.length; movementIndex += 1) {
        const actual = row.transfers[movementIndex];
        const expected = canonical[movementIndex];
        if (actual.signature !== expected.signature || actual.slot !== expected.slot
          || actual.transactionIndex !== expected.transactionIndex
          || actual.instructionIndex !== expected.instructionIndex
          || actual.timestamp !== expected.timestamp || actual.from !== expected.from
          || actual.to !== expected.to || actual.rawAmount !== expected.rawAmount.toString()) {
          throw new Error("GOVERNANCE_CACHED_MOVEMENT_MISMATCH");
        }
      }
    }));
  }
}

async function readExistingManifest(path: string) {
  try {
    return JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertExistingPublication(path: string, manifest: GovernanceSnapshotManifest, snapshot: ReturnType<typeof buildSolanaGovernanceSnapshot>) {
  const [sourceBytes, snapshotBytes] = await Promise.all([
    readFile(join(path, "source.json"), "utf8"), readFile(join(path, "snapshot.json"), "utf8"),
  ]);
  const hashBytes = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  if (hashBytes(sourceBytes) !== manifest.sourceSha256 || hashBytes(snapshotBytes) !== manifest.snapshotSha256) {
    throw new Error("GOVERNANCE_PUBLISHED_FILES_MISMATCH");
  }
  for (const entry of snapshot.entries) {
    const expected = JSON.stringify({
      version: 1, proposalId: snapshot.proposalId, account: entry.account,
      weight: entry.weight, proof: entry.proof, merkleRoot: snapshot.merkleRoot,
    }, null, 2) + "\n";
    if (await readFile(join(path, "proofs", `${entry.account}.json`), "utf8") !== expected) {
      throw new Error("GOVERNANCE_PUBLISHED_PROOF_MISMATCH");
    }
  }
}

async function cleanupTemporaryPublication(root: string, temporary: string, proposalId: bigint) {
  const parent = resolve(root);
  const candidate = resolve(temporary);
  if (!candidate.startsWith(`${parent}${sep}`)
    || !basename(candidate).startsWith(`.publish-${proposalId}-`)) {
    throw new Error("GOVERNANCE_TEMPORARY_PATH_INVALID");
  }
  let file: Awaited<ReturnType<typeof lstat>>;
  try { file = await lstat(candidate); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!file.isDirectory() || file.isSymbolicLink()) throw new Error("GOVERNANCE_TEMPORARY_NOT_DIRECTORY");
  await rm(candidate, { recursive: true, force: false });
}

/** Read-only chain verification followed by atomic local publication; no transactions are sent. */
export async function prepareAndPublishSolanaGovernanceSnapshot(args: {
  governanceProgram: string;
  proposalId: bigint;
  windowStart: number;
  excluded: Iterable<string>;
  rpcUrls: readonly [string, string];
  stateRoot: string;
  publicDataRoot: string;
  nowMs?: number;
  /** Called before and immediately after staging a changed bundle. It must
   * prove that no proposal account or in-flight create transaction exists. */
  assertUncommittedRefresh?: () => Promise<void>;
}) {
  const nowMs = args.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("GOVERNANCE_TIME_INVALID");
  const [launch, heartbeat, rawCache] = await Promise.all([
    readFile(resolve(args.publicDataRoot, "config.json"), "utf8").then((raw) => JSON.parse(raw) as ActivatedLaunch),
    readFile(resolve(args.publicDataRoot, "status", "solana-holder-indexer.json"), "utf8").then((raw) => JSON.parse(raw) as IndexerHeartbeat),
    readFile(resolve(args.stateRoot, "capital-transfers.json"), "utf8").then((raw) => JSON.parse(raw) as unknown),
  ]);
  if (launch.network !== "solana-mainnet-beta" || !exactPublicKey(launch.projectMint)
    || !Number.isSafeInteger(launch.launchedAtSlot) || launch.launchedAtSlot <= 0
    || !launch.launchedAtSignature) throw new Error("GOVERNANCE_LAUNCH_NOT_VERIFIED");
  const cache = checkedCache(rawCache, launch, heartbeat, nowMs);
  // Bitquery Transfers is not a completeness oracle for mint/burn or same-tx
  // movement. The V3 indexer has already scanned every finalized block with
  // two independent RPCs; do not make vendor availability a voting dependency.
  const tip = await verifyCachedBlocks(cache, args.rpcUrls);
  const expectedWindowStart = governanceWindowStart(tip.blockTime, cache.launchTime);
  if (args.windowStart !== expectedWindowStart) throw new Error("GOVERNANCE_WINDOW_START_MISMATCH");
  await verifyCachedMovements(cache, args.rpcUrls);
  const sourceData = {
    version: 1, network: "solana-mainnet-beta", cache,
    coverage: { launchSlot: cache.launchSlot, launchSignature: cache.launchSignature,
      indexedThroughSlot: tip.slot, indexedThroughBlockhash: tip.blockhash,
      basis: "two-rpc-finalized-full-blocks",
      verifiedCanonicalSlots: tip.verifiedSlots },
  };
  const snapshot = buildSolanaGovernanceSnapshot({
    governanceProgram: args.governanceProgram, proposalId: args.proposalId,
    windowStart: args.windowStart, excluded: args.excluded,
    journal: { version: 3, capitalMint: cache.mint, windowEnd: tip.blockTime,
      finalizedThroughSlot: tip.slot, finalizedBlockhash: tip.blockhash,
      coverage: cache.coverage,
      transfers: cache.transactions.flatMap((row) => row.transfers) },
  });
  const root = resolve(args.publicDataRoot, "governance", "proposals");
  const target = join(root, args.proposalId.toString());
  const existing = await readExistingManifest(target);
  if (existing && typeof existing.publishedAtUnix !== "number") throw new Error("GOVERNANCE_PUBLICATION_TIME_INVALID");
  let publishedAtUnix = existing ? existing.publishedAtUnix as number : Math.floor(nowMs / 1_000);
  if (!Number.isSafeInteger(publishedAtUnix) || publishedAtUnix < cache.launchTime
    || !existing && publishedAtUnix < tip.blockTime || publishedAtUnix > Math.floor(nowMs / 1_000)) {
    throw new Error("GOVERNANCE_PUBLICATION_TIME_INVALID");
  }
  let manifest: GovernanceSnapshotManifest = {
    version: 2, network: "solana-mainnet-beta", proposalId: args.proposalId.toString(),
    publishedAtUnix,
    merkleRoot: snapshot.merkleRoot, totalAvailableWeight: snapshot.totalAvailableWeight,
    sourceSha256: digest(sourceData), snapshotSha256: digest(snapshot),
    source: `governance/proposals/${args.proposalId}/source.json`,
    snapshot: `governance/proposals/${args.proposalId}/snapshot.json`,
  };
  if (existing) {
    if (publishedAtUnix >= tip.blockTime && digest(existing) === digest(manifest)) {
      await assertExistingPublication(target, manifest, snapshot);
      return { snapshot, manifest, publishedPath: target, reused: true };
    }
    if (!args.assertUncommittedRefresh) throw new Error("GOVERNANCE_SNAPSHOT_ALREADY_PUBLISHED_DIFFERENTLY");
    const previous = await readVerifiedGovernancePublicationDirectory(target);
    if (JSON.stringify(previous.manifest) !== JSON.stringify(existing)) {
      throw new Error("GOVERNANCE_PUBLISHED_FILES_MISMATCH");
    }
    await args.assertUncommittedRefresh();
    publishedAtUnix = Math.floor(nowMs / 1_000);
    manifest = { ...manifest, publishedAtUnix };
  }
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, `.publish-${args.proposalId}-`));
  try {
    await mkdir(join(temporary, "proofs"));
    const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx", flush: true });
    await writeJson(join(temporary, "source.json"), sourceData);
    await writeJson(join(temporary, "snapshot.json"), snapshot);
    for (const entry of snapshot.entries) {
      await writeJson(join(temporary, "proofs", `${entry.account}.json`), {
        version: 1, proposalId: snapshot.proposalId, account: entry.account,
        weight: entry.weight, proof: entry.proof, merkleRoot: snapshot.merkleRoot,
      });
    }
    await writeJson(join(temporary, "manifest.json"), manifest);
    // A changed, uncommitted proposal ID may be refreshed; old versions are
    // never deleted. During the two renames the public path may briefly 404,
    // which makes preview/vote fail closed rather than serve mixed files.
    if (existing) {
      await readVerifiedGovernancePublicationDirectory(temporary);
      await args.assertUncommittedRefresh!();
      const archiveRoot = resolve(args.publicDataRoot, "governance", "archives", args.proposalId.toString());
      await mkdir(archiveRoot, { recursive: true });
      const archive = join(archiveRoot, `${existing.publishedAtUnix}-${randomBytes(6).toString("hex")}`);
      await rename(target, archive);
      try { await rename(temporary, target); }
      catch (error) {
        await rename(archive, target);
        throw error;
      }
      return { snapshot, manifest, publishedPath: target, reused: false };
    }
    await args.assertUncommittedRefresh?.();
    try {
      await rename(temporary, target);
    } catch (error) {
      const concurrent = await readExistingManifest(target);
      if (!concurrent || digest(concurrent) !== digest(manifest)) throw error;
      await assertExistingPublication(target, manifest, snapshot);
      return { snapshot, manifest, publishedPath: target, reused: true };
    }
    return { snapshot, manifest, publishedPath: target, reused: false };
  } finally {
    // The successful rename removes the temporary path. On every failure,
    // remove only the exact mkdtemp directory, never the immutable proposal.
    await cleanupTemporaryPublication(root, temporary, args.proposalId);
  }
}
