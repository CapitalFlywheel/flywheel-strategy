import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import { buildSolanaGovernanceSnapshot } from "./governanceSnapshot";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";
import {
  auditCreateProposalDraft, auditCreateRevoteDraft,
  buildCreateProposalInstruction, buildCreateRevoteInstruction,
  type GovernanceAccountSet, type GovernanceProposalInstructionInput, type GovernanceRevoteInstructionInput,
} from "./governanceProposalInstruction";

const MSTRX = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const account = (owner: PublicKey, data: Buffer, executable = false): AccountInfo<Buffer> => ({
  owner, data, executable, lamports: 1_000_000, rentEpoch: 0,
});
const cloneAccounts = (accounts: GovernanceAccountSet): GovernanceAccountSet => Object.fromEntries(
  Object.entries(accounts).map(([name, value]) => [name, value && { ...value, data: Buffer.from(value.data) }]),
) as unknown as GovernanceAccountSet;

function fixture(): GovernanceProposalInstructionInput {
  const program = key(1);
  const capital = key(2);
  const admin = key(3);
  const marketing = key(4);
  const holder = key(5);
  const snapshotBlockhash = key(6);
  const custodyBlockhash = key(7);
  const derived = deriveGovernanceReserveRoute(program.toBase58(), MSTRX);
  const config = Buffer.alloc(306);
  createHash("sha256").update("account:Config").digest().copy(config, 0, 0, 8);
  config[8] = 3;
  admin.toBuffer().copy(config, 9);
  capital.toBuffer().copy(config, 41);
  TOKEN_PROGRAM_ID.toBuffer().copy(config, 73);
  new PublicKey(MSTRX).toBuffer().copy(config, 105);
  derived.ata.toBuffer().copy(config, 137);
  marketing.toBuffer().copy(config, 169);
  config.writeBigInt64LE(1_000n, 201);
  config.writeBigUInt64LE(10n, 209);
  config[217] = 1;
  config[305] = derived.bump;
  const capitalData = Buffer.alloc(82);
  capitalData[44] = 6;
  capitalData[45] = 1;
  const vaultData = Buffer.alloc(165);
  new PublicKey(MSTRX).toBuffer().copy(vaultData, 0);
  derived.authority.toBuffer().copy(vaultData, 32);
  vaultData.writeBigUInt64LE(700n, 64);
  vaultData[108] = 1;
  const programData = Buffer.alloc(53);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(9n, 4);
  programData[12] = 0; // no upgrade authority after reviewed deployment
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]).copy(programData, 45);
  const programAccount = Buffer.alloc(36);
  programAccount.writeUInt32LE(2, 0);
  derived.programDataAddress.toBuffer().copy(programAccount, 4);
  const accounts: GovernanceAccountSet = {
    program: account(LOADER, programAccount, true),
    programData: account(LOADER, programData),
    config: account(program, config),
    vault: account(TOKEN_2022_PROGRAM_ID, vaultData),
    capitalMint: account(TOKEN_PROGRAM_ID, capitalData),
  };
  const snapshot = buildSolanaGovernanceSnapshot({
    governanceProgram: program.toBase58(), proposalId: 1n, windowStart: 1_000,
    journal: {
      version: 3, capitalMint: capital.toBase58(), windowEnd: 2_000,
      finalizedThroughSlot: 20, finalizedBlockhash: snapshotBlockhash.toBase58(),
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 11, throughSlot: 20, throughBlockhash: snapshotBlockhash.toBase58() },
      transfers: [{ signature: "fund-holder", slot: 11, transactionIndex: 0, instructionIndex: 0,
        timestamp: 1_000, to: holder.toBase58(), rawAmount: "100" }],
    },
    excluded: [],
  });
  const publication = {
    version: 2 as const, network: "solana-mainnet-beta" as const,
    proposalId: "1", publishedAtUnix: 2_005,
    merkleRoot: snapshot.merkleRoot, totalAvailableWeight: snapshot.totalAvailableWeight,
    sourceSha256: "a".repeat(64),
    snapshotSha256: createHash("sha256").update(JSON.stringify(snapshot, null, 2) + "\n").digest("hex"),
    source: "governance/proposals/1/source.json", snapshot: "governance/proposals/1/snapshot.json",
  };
  return {
    route: {
      governanceProgram: program.toBase58(), reserveAuthority: derived.authority.toBase58(),
      reserveMint: MSTRX, capitalMint: capital.toBase58(), admin: admin.toBase58(),
      expectedProgramCodeSha256: createHash("sha256").update(programData.subarray(45)).digest("hex"),
    },
    finalizedAccounts: [
      { slot: 30, blockhash: custodyBlockhash.toBase58(), accounts },
      { slot: 30, blockhash: custodyBlockhash.toBase58(), accounts: cloneAccounts(accounts) },
    ],
    snapshotFinality: { slot: 20, blockhash: snapshotBlockhash.toBase58() },
    snapshot, publication, observedClockUnix: 2_010, votingDurationSeconds: 3_600,
    frozenReserveRawMstrx: 700n,
    options: [{ action: "ACCUMULATE" }, { action: "LOCK_MSTRX", lockDurationSeconds: 30 * 86_400 }],
  };
}

function revoteFixture(status = 1, observedClockUnix = 5_911): GovernanceRevoteInstructionInput {
  const input = fixture();
  const program = new PublicKey(input.route.governanceProgram);
  const capital = new PublicKey(input.route.capitalMint);
  const holder = key(5);
  const snapshotBlockhash = key(6);
  const [previousProposal] = PublicKey.findProgramAddressSync([
    Buffer.from("proposal"), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
  ], program);
  const prior = Buffer.alloc(726);
  createHash("sha256").update("account:Proposal").digest().copy(prior, 0, 0, 8);
  prior[8] = 3;
  new PublicKey(input.route.reserveAuthority).toBuffer().copy(prior, 9);
  capital.toBuffer().copy(prior, 41);
  deriveGovernanceReserveRoute(input.route.governanceProgram, MSTRX).ata.toBuffer().copy(prior, 73);
  prior.writeBigUInt64LE(1n, 105);
  prior.writeBigInt64LE(5_901n, 129);
  prior.writeBigUInt64LE(700n, 281);
  prior.writeUInt32LE(2, 289);
  prior[293] = 0; // ACCUMULATE
  prior[346] = 4; // LOCK_MSTRX spending winner
  prior.writeBigUInt64LE(700n, 383);
  prior[511] = status;
  prior[512] = status === 1 ? 1 : 255;
  for (const observed of input.finalizedAccounts) {
    observed.accounts.config!.data.writeBigUInt64LE(1n, 281);
    observed.accounts.config!.data.writeBigUInt64LE(1n, 289);
    observed.accounts.config!.data.writeBigUInt64LE(700n, 297);
    observed.accounts.vault!.data.writeBigUInt64LE(900n, 64);
    observed.accounts.previousProposal = account(program, Buffer.from(prior));
  }
  const windowEnd = observedClockUnix - 10;
  const snapshot = buildSolanaGovernanceSnapshot({
    governanceProgram: program.toBase58(), proposalId: 2n, windowStart: Math.max(1_000, windowEnd - 86_400),
    journal: {
      version: 3, capitalMint: capital.toBase58(), windowEnd,
      finalizedThroughSlot: 20, finalizedBlockhash: snapshotBlockhash.toBase58(),
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 11, throughSlot: 20,
        throughBlockhash: snapshotBlockhash.toBase58() },
      transfers: [{ signature: "fund-holder", slot: 11, transactionIndex: 0, instructionIndex: 0,
        timestamp: 1_000, to: holder.toBase58(), rawAmount: "100" }],
    },
    excluded: [],
  });
  input.snapshot = snapshot;
  input.publication = {
    version: 2, network: "solana-mainnet-beta", proposalId: "2", publishedAtUnix: windowEnd + 1,
    merkleRoot: snapshot.merkleRoot, totalAvailableWeight: snapshot.totalAvailableWeight,
    sourceSha256: "a".repeat(64),
    snapshotSha256: createHash("sha256").update(JSON.stringify(snapshot, null, 2) + "\n").digest("hex"),
    source: "governance/proposals/2/source.json", snapshot: "governance/proposals/2/snapshot.json",
  };
  input.observedClockUnix = observedClockUnix;
  return { ...input, previousProposalAddress: previousProposal.toBase58() };
}

describe("Solana create_proposal v3 audit-only builder", () => {
  it("encodes exact Anchor Borsh arguments and ordered account metas", () => {
    const input = fixture();
    const draft = auditCreateProposalDraft(input);
    const [proposal] = PublicKey.findProgramAddressSync([
      Buffer.from("proposal"), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
    ], new PublicKey(input.route.governanceProgram));
    expect(draft.proposal).toBe(proposal.toBase58());
    expect(draft.config).toBe(input.route.reserveAuthority);
    expect(draft.id).toBe(1n);
    expect(draft.frozenReserveRawMstrx).toBe(700n);
    expect([draft.estimatedStartsAt, draft.estimatedEndsAt, draft.estimatedExecutableAt])
      .toEqual([2_010 + 86_400, 2_010 + 86_400 + 3_600, 2_010 + 86_400 + 3_600 + 300]);
    expect(draft.keys.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable])).toEqual([
      [draft.config, false, true],
      [draft.reserveVault, false, false],
      [draft.proposal, false, true],
      [input.route.admin, true, true],
      [input.route.governanceProgram, false, false],
      [deriveGovernanceReserveRoute(input.route.governanceProgram, MSTRX).programDataAddress.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
    const data = draft.data;
    expect(data.length).toBe(180 + 2 * 45);
    expect(data.subarray(0, 8)).toEqual(createHash("sha256").update("global:create_proposal").digest().subarray(0, 8));
    expect(data.readBigUInt64LE(8)).toBe(1n);
    expect(data.readBigInt64LE(16)).toBe(3_600n);
    expect(data.readBigInt64LE(24)).toBe(1_000n);
    expect(data.readBigInt64LE(32)).toBe(2_000n);
    expect(data.readBigUInt64LE(40)).toBe(20n);
    expect(data.subarray(48, 80)).toEqual(new PublicKey(input.snapshot.finalizedBlockhash).toBuffer());
    expect(data.subarray(80, 112).toString("hex")).toBe(input.snapshot.exclusionsHash);
    expect(data.subarray(112, 144).toString("hex")).toBe(input.snapshot.merkleRoot);
    expect(data.readBigUInt64LE(144)).toBe(1n);
    expect(data.readBigUInt64LE(152)).toBe(BigInt(input.snapshot.totalAvailableWeight));
    expect(data.readBigUInt64LE(160)).toBe(0n);
    expect(data.readBigUInt64LE(168)).toBe(700n);
    expect(data.readUInt32LE(176)).toBe(2);
    expect(data[180]).toBe(0); // ACCUMULATE enum index
    expect(data.readUInt32LE(181)).toBe(0);
    expect(data.subarray(185, 217)).toEqual(Buffer.alloc(32));
    expect(data.readBigUInt64LE(217)).toBe(0n);
    expect(data[225]).toBe(4); // LOCK_MSTRX enum index
    expect(data.readUInt32LE(226)).toBe(30 * 86_400);
    expect(data.readBigUInt64LE(262)).toBe(0n);
    expect(draft.unreleasedExecutors).toEqual(["ACCUMULATE", "LOCK_MSTRX"]);
  });

  it("never produces a sendable instruction while Rust proposals and executors are unreleased", () => {
    expect(() => buildCreateProposalInstruction(fixture())).toThrow("GOVERNANCE_PROPOSALS_NOT_RELEASED");
  });

  it("requires exact full free reserve and no existing active commitment", () => {
    const wrong = fixture();
    wrong.frozenReserveRawMstrx = 699n;
    expect(() => auditCreateProposalDraft(wrong)).toThrow("GOVERNANCE_PROPOSAL_EXACT_FREE_AMOUNT_REQUIRED");
    const active = fixture();
    for (const observed of active.finalizedAccounts) {
      observed.accounts.config!.data.writeBigUInt64LE(1n, 289);
      observed.accounts.config!.data.writeBigUInt64LE(100n, 297);
    }
    expect(() => auditCreateProposalDraft(active)).toThrow("GOVERNANCE_PROPOSAL_COMMITMENT_ACTIVE");
  });

  it("uses the lower finalized free balance when an ordinary fee deposit lands between RPC views", () => {
    const input = fixture();
    input.finalizedAccounts[1].slot = 31;
    input.finalizedAccounts[1].blockhash = key(8).toBase58();
    input.finalizedAccounts[1].accounts.vault!.data.writeBigUInt64LE(701n, 64);
    const draft = auditCreateProposalDraft(input);
    expect(draft.frozenReserveRawMstrx).toBe(700n);
    expect(draft.data.readBigUInt64LE(168)).toBe(700n);
    // The higher, later balance is not a safe amount to draft from both views.
    input.frozenReserveRawMstrx = 701n;
    expect(() => auditCreateProposalDraft(input)).toThrow("GOVERNANCE_PROPOSAL_EXACT_FREE_AMOUNT_REQUIRED");
  });

  it("rejects mismatched immutable vault/config bytes and widely separated views", () => {
    const identity = fixture();
    identity.finalizedAccounts[1].slot = 31;
    identity.finalizedAccounts[1].blockhash = key(8).toBase58();
    key(9).toBuffer().copy(identity.finalizedAccounts[1].accounts.vault!.data, 32);
    expect(() => auditCreateProposalDraft(identity)).toThrow("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
    const commitment = fixture();
    commitment.finalizedAccounts[1].slot = 31;
    commitment.finalizedAccounts[1].blockhash = key(8).toBase58();
    commitment.finalizedAccounts[1].accounts.config!.data.writeBigUInt64LE(1n, 297);
    expect(() => auditCreateProposalDraft(commitment)).toThrow("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
    const stale = fixture();
    stale.finalizedAccounts[1].slot = 55;
    stale.finalizedAccounts[1].blockhash = key(8).toBase58();
    expect(() => auditCreateProposalDraft(stale)).toThrow("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
    const sameSlotDifferentBalance = fixture();
    sameSlotDifferentBalance.finalizedAccounts[1].accounts.vault!.data.writeBigUInt64LE(701n, 64);
    expect(() => auditCreateProposalDraft(sameSlotDifferentBalance)).toThrow("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
  });

  it("rejects RPC code/state disagreement, snapshot identity drift and unreviewed bytecode", () => {
    const drift = fixture();
    drift.finalizedAccounts[1].accounts.vault!.data.writeBigUInt64LE(701n, 64);
    expect(() => auditCreateProposalDraft(drift)).toThrow("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
    const wrongBlock = fixture();
    wrongBlock.snapshotFinality.blockhash = key(8).toBase58();
    expect(() => auditCreateProposalDraft(wrongBlock)).toThrow("GOVERNANCE_PROPOSAL_SNAPSHOT_IDENTITY_MISMATCH");
    const sameSlotFork = fixture();
    for (const observed of sameSlotFork.finalizedAccounts) observed.slot = sameSlotFork.snapshotFinality.slot;
    expect(() => auditCreateProposalDraft(sameSlotFork)).toThrow("GOVERNANCE_PROPOSAL_SNAPSHOT_IDENTITY_MISMATCH");
    const wrongRoot = fixture();
    wrongRoot.snapshot.merkleRoot = "ab".repeat(32);
    expect(() => auditCreateProposalDraft(wrongRoot)).toThrow("GOVERNANCE_PROPOSAL_SNAPSHOT_INVALID");
    const wrongProgram = fixture();
    wrongProgram.route.expectedProgramCodeSha256 = "01".repeat(32);
    expect(() => auditCreateProposalDraft(wrongProgram)).toThrow("GOVERNANCE_PROGRAM_CODE_HASH_MISMATCH");
  });

  it("requires sequential proposal IDs, exact lookback, policy options and fixed marketing recipient", () => {
    const outOfOrder = fixture();
    for (const observed of outOfOrder.finalizedAccounts) observed.accounts.config!.data.writeBigUInt64LE(2n, 281);
    expect(() => auditCreateProposalDraft(outOfOrder)).toThrow("GOVERNANCE_PROPOSAL_SNAPSHOT_IDENTITY_MISMATCH");
    const wrongWindow = fixture();
    wrongWindow.snapshot.windowStart = 999;
    expect(() => auditCreateProposalDraft(wrongWindow)).toThrow("GOVERNANCE_PROPOSAL_SNAPSHOT_INVALID");
    const badOption = fixture();
    badOption.options = [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", recipient: key(4).toBase58(), minOutputRaw: 1n }];
    expect(() => auditCreateProposalDraft(badOption)).toThrow("GOVERNANCE_RECIPIENT_UNEXPECTED");
    const fixedMarketing = fixture();
    fixedMarketing.options = [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE", recipient: key(4).toBase58(), minOutputRaw: 1_000_000_000n }];
    expect(auditCreateProposalDraft(fixedMarketing).data[225]).toBe(5);
    expect(auditCreateProposalDraft(fixedMarketing).data.readBigUInt64LE(262)).toBe(1_000_000_000n);
    fixedMarketing.options = [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE", recipient: key(9).toBase58(), minOutputRaw: 1_000_000_000n }];
    expect(() => auditCreateProposalDraft(fixedMarketing)).toThrow("GOVERNANCE_MARKETING_RECIPIENT_INVALID");
  });

  it("cannot draft a conversion without its immutable voted output floor", () => {
    const missing = fixture();
    missing.options = [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN" }];
    expect(() => auditCreateProposalDraft(missing)).toThrow("GOVERNANCE_MIN_OUTPUT_INVALID");
    missing.options = [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", minOutputRaw: 25n }];
    expect(auditCreateProposalDraft(missing).data.readBigUInt64LE(262)).toBe(25n);
  });

  it("requires a published checksum-bound snapshot before drafting a delayed ballot", () => {
    const unpublished = fixture();
    unpublished.publication.snapshotSha256 = "f".repeat(64);
    expect(() => auditCreateProposalDraft(unpublished)).toThrow("GOVERNANCE_PROPOSAL_PUBLICATION_INVALID");
    const future = fixture();
    future.publication.publishedAtUnix = future.observedClockUnix + 1;
    expect(() => auditCreateProposalDraft(future)).toThrow("GOVERNANCE_PROPOSAL_PUBLICATION_INVALID");
    const old = fixture();
    old.publication.version = 1 as 2;
    expect(() => auditCreateProposalDraft(old)).toThrow("GOVERNANCE_PROPOSAL_PUBLICATION_INVALID");
  });
});

describe("Solana create_revote audit-only builder", () => {
  it("serializes the same exact commitment with the previous PDA and new snapshot", () => {
    const input = revoteFixture();
    const draft = auditCreateRevoteDraft(input);
    expect(draft.id).toBe(2n);
    expect(draft.frozenReserveRawMstrx).toBe(700n);
    expect([draft.estimatedStartsAt, draft.estimatedEndsAt, draft.estimatedExecutableAt])
      .toEqual([input.observedClockUnix, input.observedClockUnix + 3_600,
        input.observedClockUnix + 3_600 + 300]);
    expect(draft.previousProposal).toBe(input.previousProposalAddress);
    expect(draft.data.subarray(0, 8)).toEqual(
      createHash("sha256").update("global:create_revote").digest().subarray(0, 8),
    );
    expect(draft.data.readBigUInt64LE(8)).toBe(2n);
    expect(draft.keys.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable])).toEqual([
      [draft.config, false, true], [draft.reserveVault, false, false],
      [input.previousProposalAddress, false, true], [draft.proposal, false, true],
      [input.route.admin, true, true], [input.route.governanceProgram, false, false],
      [deriveGovernanceReserveRoute(input.route.governanceProgram, MSTRX).programDataAddress.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
    expect(() => buildCreateRevoteInstruction(input)).toThrow("GOVERNANCE_PROPOSALS_NOT_RELEASED");
  });

  it("keeps new deposits outside the re-vote and rejects premature or closed state", () => {
    const input = revoteFixture();
    input.frozenReserveRawMstrx = 900n;
    expect(() => auditCreateRevoteDraft(input)).toThrow("GOVERNANCE_REVOTE_COMMITMENT_MISMATCH");
    const early = revoteFixture(1, 5_900);
    expect(() => auditCreateRevoteDraft(early)).toThrow("GOVERNANCE_REVOTE_TOO_EARLY");
    const wrongState = revoteFixture();
    for (const observed of wrongState.finalizedAccounts) observed.accounts.previousProposal!.data[511] = 4;
    expect(() => auditCreateRevoteDraft(wrongState)).toThrow("GOVERNANCE_REVOTE_PREVIOUS_NOT_PENDING");
    const noActionWinner = revoteFixture();
    for (const observed of noActionWinner.finalizedAccounts) observed.accounts.previousProposal!.data[512] = 0;
    expect(() => auditCreateRevoteDraft(noActionWinner)).toThrow("GOVERNANCE_REVOTE_PREVIOUS_INVALID");
    const wrongAddress = revoteFixture();
    wrongAddress.previousProposalAddress = key(8).toBase58();
    expect(() => auditCreateRevoteDraft(wrongAddress)).toThrow("GOVERNANCE_REVOTE_PREVIOUS_ADDRESS_MISMATCH");
  });

  it("ignores a later free-reserve deposit but keeps the exact prior commitment", () => {
    const input = revoteFixture();
    input.finalizedAccounts[1].slot = 31;
    input.finalizedAccounts[1].blockhash = key(8).toBase58();
    input.finalizedAccounts[1].accounts.vault!.data.writeBigUInt64LE(901n, 64);
    expect(auditCreateRevoteDraft(input).frozenReserveRawMstrx).toBe(700n);
    input.finalizedAccounts[1].accounts.config!.data.writeBigUInt64LE(701n, 297);
    expect(() => auditCreateRevoteDraft(input)).toThrow("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
  });

  it("permits retry after a prior re-vote missed quorum or tied without releasing funds", () => {
    for (const status of [7, 8]) {
      const input = revoteFixture(status, 5_901);
      expect(auditCreateRevoteDraft(input).frozenReserveRawMstrx).toBe(700n);
      expect(() => auditCreateRevoteDraft(revoteFixture(status, 5_900)))
        .toThrow("GOVERNANCE_REVOTE_TOO_EARLY");
    }
  });

  it("permits a new holder ballot at the unexecuted spending winner's execution time", () => {
    expect(auditCreateRevoteDraft(revoteFixture(1, 5_901)).frozenReserveRawMstrx).toBe(700n);
    expect(() => auditCreateRevoteDraft(revoteFixture(1, 5_900)))
      .toThrow("GOVERNANCE_REVOTE_TOO_EARLY");
  });
});
