import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildSolanaGovernanceSnapshot, assertSolanaGovernanceSnapshot, type SolanaGovernanceSnapshot } from "../services/solana/governanceSnapshot";
import { assertVerifiedHolderCache, type CachedJournal } from "../services/solana/holderJournal";
import type { GovernanceSnapshotManifest } from "../services/solana/governanceSnapshotPublisher";

function sha256(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }

function checkedJson<T>(bytes: Buffer): T {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T; }
  catch { throw new Error("GOVERNANCE_PUBLICATION_JSON_INVALID"); }
}

async function regularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("GOVERNANCE_PUBLICATION_FILE_INVALID");
  return readFile(path);
}

/** Recompute the public artifact and each served proof. This does not independently rescan Solana RPC history. */
export async function readVerifiedGovernancePublicationDirectory(directory: string) {
  const base = resolve(directory);
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error("GOVERNANCE_PUBLICATION_DIRECTORY_INVALID");
  const [manifestBytes, sourceBytes, snapshotBytes] = await Promise.all([
    regularFile(resolve(base, "manifest.json")), regularFile(resolve(base, "source.json")),
    regularFile(resolve(base, "snapshot.json")),
  ]);
  const manifest = checkedJson<GovernanceSnapshotManifest>(manifestBytes);
  const source = checkedJson<{ version: number; network: string; cache: CachedJournal;
    coverage: { launchSlot: number; indexedThroughSlot: number; indexedThroughBlockhash: string; basis: string } }>(sourceBytes);
  const snapshot = checkedJson<SolanaGovernanceSnapshot>(snapshotBytes);
  if (manifest.version !== 2 || manifest.network !== "solana-mainnet-beta"
    || !Number.isSafeInteger(manifest.publishedAtUnix) || manifest.publishedAtUnix <= 0
    || manifest.sourceSha256 !== sha256(sourceBytes) || manifest.snapshotSha256 !== sha256(snapshotBytes)
    || source.version !== 1 || source.network !== "solana-mainnet-beta"
    || source.coverage?.basis !== "two-rpc-finalized-full-blocks"
    || !assertSolanaGovernanceSnapshot(snapshot)) throw new Error("GOVERNANCE_PUBLICATION_INVALID");
  assertVerifiedHolderCache(source.cache);
  if (source.cache.launchSlot !== source.coverage.launchSlot
    || source.cache.indexedThroughSlot !== source.coverage.indexedThroughSlot
    || source.cache.coverage.throughBlockhash !== source.coverage.indexedThroughBlockhash
    || source.cache.mint !== snapshot.capitalMint
    || source.cache.indexedThroughTime !== snapshot.windowEnd
    || source.cache.indexedThroughSlot !== snapshot.finalizedThroughSlot
    || source.cache.coverage.throughBlockhash !== snapshot.finalizedBlockhash
    || snapshot.proposalId !== manifest.proposalId || snapshot.merkleRoot !== manifest.merkleRoot
    || snapshot.totalAvailableWeight !== manifest.totalAvailableWeight
    || manifest.publishedAtUnix < snapshot.windowEnd) throw new Error("GOVERNANCE_PUBLICATION_IDENTITY_MISMATCH");
  const rebuilt = buildSolanaGovernanceSnapshot({
    governanceProgram: snapshot.governanceProgram, proposalId: BigInt(snapshot.proposalId),
    windowStart: snapshot.windowStart, excluded: snapshot.excludedAccounts,
    journal: {
      version: 3, capitalMint: source.cache.mint, windowEnd: source.cache.indexedThroughTime,
      finalizedThroughSlot: source.cache.indexedThroughSlot,
      finalizedBlockhash: source.cache.coverage.throughBlockhash,
      coverage: source.cache.coverage,
      transfers: source.cache.transactions.flatMap((transaction) => transaction.transfers),
    },
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(snapshot)) throw new Error("GOVERNANCE_PUBLICATION_RECOMPUTE_MISMATCH");
  if (manifest.source !== `governance/proposals/${snapshot.proposalId}/source.json`
    || manifest.snapshot !== `governance/proposals/${snapshot.proposalId}/snapshot.json`) {
    throw new Error("GOVERNANCE_PUBLICATION_PATH_INVALID");
  }
  const proofDirectory = resolve(base, "proofs");
  const proofInfo = await lstat(proofDirectory);
  if (!proofInfo.isDirectory() || proofInfo.isSymbolicLink()) throw new Error("GOVERNANCE_PUBLICATION_PROOFS_INVALID");
  const expectedNames = snapshot.entries.map((entry) => `${entry.account}.json`).sort();
  const actualNames = (await readdir(proofDirectory)).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) throw new Error("GOVERNANCE_PUBLICATION_PROOFS_INVALID");
  for (let offset = 0; offset < snapshot.entries.length; offset += 64) {
    await Promise.all(snapshot.entries.slice(offset, offset + 64).map(async (entry) => {
      const proof = checkedJson<unknown>(await regularFile(resolve(proofDirectory, `${entry.account}.json`)));
      const expected = { version: 1, proposalId: snapshot.proposalId, account: entry.account,
        weight: entry.weight, proof: entry.proof, merkleRoot: snapshot.merkleRoot };
      if (JSON.stringify(proof) !== JSON.stringify(expected)) throw new Error("GOVERNANCE_PUBLICATION_PROOFS_INVALID");
    }));
  }
  return { manifest, snapshot };
}

export async function verifyGovernancePublicationDirectory(directory: string) {
  const { manifest, snapshot } = await readVerifiedGovernancePublicationDirectory(directory);
  return { proposalId: snapshot.proposalId, merkleRoot: snapshot.merkleRoot,
    totalAvailableWeight: snapshot.totalAvailableWeight, sourceSha256: manifest.sourceSha256,
    snapshotSha256: manifest.snapshotSha256, publishedAtUnix: manifest.publishedAtUnix };
}

if (process.argv[1]?.endsWith("verify-governance-publication.ts")) {
  if (process.argv.length !== 3) throw new Error("USAGE: tsx scripts/verify-governance-publication.ts <proposal-directory>");
  verifyGovernancePublicationDirectory(process.argv[2]).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
