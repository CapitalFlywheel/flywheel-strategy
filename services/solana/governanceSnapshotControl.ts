import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { readVerifiedGovernancePublicationDirectory } from "../../scripts/verify-governance-publication";
import { validateSnapshotPublicationIntent, type SnapshotPublicationIntent } from "./controlAuth";
import { governanceWindowStart } from "./governancePolicy";
import { prepareAndPublishSolanaGovernanceSnapshot } from "./governanceSnapshotPublisher";
import { validateGovernancePreviewRpcPair } from "./governanceProposalPreview";
import { verifyGovernanceReserveRoute } from "./governanceVaultRoute";
import { finalizedConsensus } from "./rpcConsensus";
import { readJsonIfExists } from "./durableJson";

export interface SnapshotControlEnvironment {
  rpcUrls: readonly [string, string];
  governanceProgram: string;
  expectedProgramCodeSha256: string;
  capitalMint: string;
  reserveMint: string;
  reserveAuthority: string;
  admin: string;
  stateRoot: string;
  publicDataRoot: string;
  excluded: readonly string[];
}

export async function assertProposalNotCreated(environment: SnapshotControlEnvironment, proposalId: string) {
  const ledger = await readJsonIfExists<{ state?: string; authorization?: { proposalCreation?: { proposalId?: string } } }>(
    resolve(environment.stateRoot, "governance-proposal-control.json"));
  if (ledger && (typeof ledger !== "object" || !["prepared", "pending", "unresolved", "finalized"].includes(ledger.state ?? "")
    || typeof ledger.authorization?.proposalCreation?.proposalId !== "string")) {
    throw new Error("GOVERNANCE_SNAPSHOT_LEDGER_UNVERIFIED");
  }
  if (ledger?.authorization?.proposalCreation?.proposalId === proposalId) {
    throw new Error("GOVERNANCE_SNAPSHOT_CREATE_IN_FLIGHT");
  }
  const program = new PublicKey(environment.governanceProgram);
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(BigInt(proposalId));
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program)[0];
  const consensus = await finalizedConsensus(environment.rpcUrls);
  await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url);
    for (const commitment of ["finalized", "confirmed"] as const) {
      const read = await connection.getAccountInfoAndContext(proposal, {
        commitment, minContextSlot: consensus.slot,
      });
      if (read.context.slot < consensus.slot) throw new Error("GOVERNANCE_SNAPSHOT_PROPOSAL_VIEW_STALE");
      if (read.value) throw new Error("GOVERNANCE_SNAPSHOT_PROPOSAL_ALREADY_CREATED");
    }
  }));
}

/** No signing key or Solana transaction is used. The private state directory
 * is never mounted into web; the publisher intentionally emits an audited
 * cache copy as public source.json so holders can recompute their weights. */
export async function publishOwnerGovernanceSnapshot(
  environment: SnapshotControlEnvironment, intent: SnapshotPublicationIntent, nowMs = Date.now(),
) {
  validateSnapshotPublicationIntent(intent, nowMs);
  validateGovernancePreviewRpcPair(environment.rpcUrls);
  if (intent.governanceProgram !== environment.governanceProgram
    || intent.programCodeSha256 !== environment.expectedProgramCodeSha256
    || intent.capitalMint !== environment.capitalMint
    || intent.reserveMint !== environment.reserveMint) {
    throw new Error("GOVERNANCE_SNAPSHOT_INTENT_CHANGED");
  }
  const verified = await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority,
    capitalMint: environment.capitalMint,
    reserveMint: environment.reserveMint,
    admin: environment.admin,
  });
  if (verified.lastProposalId + 1n !== BigInt(intent.proposalId)
    || verified.boundMint !== environment.capitalMint) {
    throw new Error("GOVERNANCE_SNAPSHOT_PROPOSAL_CHANGED");
  }
  await assertProposalNotCreated(environment, intent.proposalId);
  // These values are merely inputs to the publisher. It reopens and verifies
  // the entire V3 journal and its finalized blocks/movements on both RPCs.
  const cache = JSON.parse(await readFile(resolve(environment.stateRoot, "capital-transfers.json"), "utf8")) as {
    mint?: string; launchTime?: number; indexedThroughTime?: number;
  };
  if (cache.mint !== environment.capitalMint) throw new Error("GOVERNANCE_SNAPSHOT_CACHE_MINT_MISMATCH");
  const windowStart = governanceWindowStart(cache.indexedThroughTime!, cache.launchTime!);
  const result = await prepareAndPublishSolanaGovernanceSnapshot({
    governanceProgram: environment.governanceProgram,
    proposalId: BigInt(intent.proposalId), windowStart,
    excluded: environment.excluded, rpcUrls: environment.rpcUrls,
    stateRoot: environment.stateRoot, publicDataRoot: environment.publicDataRoot, nowMs,
    assertUncommittedRefresh: () => assertProposalNotCreated(environment, intent.proposalId),
  });
  const { manifest, snapshot } = await readVerifiedGovernancePublicationDirectory(result.publishedPath);
  if (JSON.stringify(manifest) !== JSON.stringify(result.manifest)
    || manifest.proposalId !== intent.proposalId
    || snapshot.governanceProgram !== intent.governanceProgram
    || snapshot.capitalMint !== intent.capitalMint
    || snapshot.merkleRoot !== manifest.merkleRoot
    || nowMs - manifest.publishedAtUnix * 1_000 > 25 * 60_000) {
    throw new Error("GOVERNANCE_SNAPSHOT_PUBLICATION_UNVERIFIED");
  }
  return { proposalId: manifest.proposalId, merkleRoot: manifest.merkleRoot,
    totalAvailableWeight: manifest.totalAvailableWeight,
    sourceSha256: manifest.sourceSha256, snapshotSha256: manifest.snapshotSha256,
    publishedAtUnix: manifest.publishedAtUnix, reused: result.reused, updatedAt: nowMs };
}
