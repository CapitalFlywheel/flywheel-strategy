import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildGovernanceVoteInstruction, canCastGovernanceVote, formatMstrxExact, formatRawTokenExact, governanceAddresses,
  governanceExecutionReceiptAddresses, governanceLockAddresses, inspectGovernanceExecutionReceipt,
  inspectGovernanceLock, inspectGovernanceVault,
  governanceProposalIdFromUrl, loadVerifiedGovernance, parseGovernanceConfig, parseGovernanceLockRecord, parseGovernanceProposal,
  verifyGovernanceProof, verifyGovernanceSourceArtifact, type GovernanceWalletProof, type VerifiedGovernance,
} from "./governanceClient";

const programId = new PublicKey("3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh");
const mint = "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu";
const blockhash = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse";
const voter = new PublicKey("EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1");
const exclusionsHash = "c5cf2cd13ec8c0b7e94bbb54bb86bf0869de021e6d563aeb93c23ed39363440f";
const root = "e302ca53ea641cdd4d34ee86682eaccbf489b72360fede22ced0d41741e1e08d";
const mstrxMint = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const upgradeableLoader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();

function u8(value: number) { return Buffer.from([value]); }
function u32(value: number) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function u64(value: bigint) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
function i64(value: bigint) { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(value); return bytes; }
function u128(value: bigint) { return Buffer.concat([u64(value & ((1n << 64n) - 1n)), u64(value >> 64n)]); }
function publicKey(value: string) { return new PublicKey(value).toBuffer(); }
function digest(value: string) { return createHash("sha256").update(value).digest().subarray(0, 8); }
function account(data: Buffer) { return { data, owner: programId, executable: false, lamports: 0, rentEpoch: 0 }; }

function fixture(): VerifiedGovernance {
  const addresses = governanceAddresses(programId, 1n, voter);
  const reserveVault = getAssociatedTokenAddressSync(new PublicKey(mstrxMint), addresses.config, true, TOKEN_2022_PROGRAM_ID).toBase58();
  return {
    programId, configAddress: addresses.config, proposalAddress: addresses.proposal,
    config: { schemaVersion: 3, admin: key(1), capitalMint: mint, capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      reserveMint: mstrxMint, reserveVault, marketingWallet: key(3), launchedAt: 500,
      launchSlot: 1n, launchSignatureHex: "ab".repeat(64), lastProposalId: 1n, activeProposalId: 1n,
      committedReserveRawMstrx: 100n, bump: 1 },
    proposal: { schemaVersion: 3, address: addresses.proposal.toBase58(), config: addresses.config.toBase58(),
      capitalMint: mint, reserveVault,
      id: 1n, startsAt: 2001, endsAt: 5601, executableAt: 5901, windowStart: 1000, windowEnd: 2000,
      finalizedThroughSlot: 20n, finalizedBlockhash: blockhash, exclusionsHash, merkleRoot: root,
      leafCount: 1n, totalAvailableWeight: 100_000n, frozenReserveRawMstrx: 100n,
      options: [
        { action: "ACCUMULATE", lockDurationSeconds: 0, recipient: SystemProgram.programId.toBase58(), reserveRawMstrx: 0n, minOutputRaw: 0n },
        { action: "BUYBACK_BURN", lockDurationSeconds: 0, recipient: SystemProgram.programId.toBase58(), reserveRawMstrx: 100n, minOutputRaw: 25n },
      ], optionWeights: [0n, 0n], totalCast: 0n, status: 0, winningOption: 255, bump: 1 },
    manifest: { version: 2, network: "solana-mainnet-beta", proposalId: "1", publishedAtUnix: 1_000, merkleRoot: root,
      totalAvailableWeight: "100000", sourceSha256: "a".repeat(64), snapshotSha256: "b".repeat(64),
      source: "governance/proposals/1/source.json", snapshot: "governance/proposals/1/snapshot.json" },
    upgradeAuthority: "IMMUTABLE", programCodeSha256: "a".repeat(64),
    vaultBalanceRawMstrx: 125n, committedReserveRawMstrx: 100n,
    freeReserveRawMstrx: 25n, capitalDecimals: 6, custodyVerifiedForProposal: true, accountSnapshotSlot: 21, chainTime: 2500,
  };
}

const proof: GovernanceWalletProof = { version: 1, proposalId: "1", account: voter.toBase58(),
  weight: "100000", proof: [], merkleRoot: root };

describe("Solana public governance safety", () => {
  it("checks a cross-language proof against the onchain commitment before building a vote", async () => {
    const state = fixture();
    expect(await verifyGovernanceProof(state, voter, proof)).toBe(true);
    expect(await verifyGovernanceProof(state, voter, { ...proof, weight: "100001" })).toBe(false);
    expect(await verifyGovernanceProof(state, voter, { ...proof, merkleRoot: "f".repeat(64) })).toBe(false);
    expect(await verifyGovernanceProof(state, new PublicKey(key(8)), proof)).toBe(false);
    const instruction = await buildGovernanceVoteInstruction(state, voter, 1, proof);
    expect(instruction.programId.toBase58()).toBe(programId.toBase58());
    expect(instruction.keys.map((entry) => entry.pubkey.toBase58())).toEqual([
      state.proposalAddress.toBase58(), governanceAddresses(programId, 1n, voter).voteRecord!.toBase58(),
      voter.toBase58(), voter.toBase58(), SystemProgram.programId.toBase58(),
    ]);
    expect(instruction.data.subarray(0, 8)).toEqual(new Uint8Array(digest("global:cast_vote")));
    const bytes = new DataView(instruction.data.buffer, instruction.data.byteOffset, instruction.data.byteLength);
    expect(bytes.getUint8(8)).toBe(1);
    expect(bytes.getBigUint64(9, true)).toBe(100_000n);
    expect(bytes.getUint32(25, true)).toBe(0);
    expect(new Transaction({ feePayer: voter, recentBlockhash: blockhash }).add(instruction).serializeMessage().length).toBeGreaterThan(0);
    await expect(buildGovernanceVoteInstruction(state, voter, 2, proof)).rejects.toThrow("GOVERNANCE_VOTE_NOT_VERIFIED");
  });

  it("rejects an unreleased, late, already-used or ineligible vote", () => {
    const state = fixture();
    expect(canCastGovernanceVote(state, proof, false, false)).toBe(false);
    // Even a released UI flag cannot offer a ballot with unreviewed executors.
    expect(canCastGovernanceVote(state, proof, false, true)).toBe(false);
    expect(canCastGovernanceVote(state, proof, true, true)).toBe(false);
    expect(canCastGovernanceVote(state, undefined, false, true)).toBe(false);
    expect(canCastGovernanceVote({ ...state, chainTime: state.proposal.endsAt }, proof, false, true)).toBe(false);
    expect(canCastGovernanceVote({ ...state, config: { ...state.config, activeProposalId: 0n } }, proof, false, true)).toBe(false);
  });

  it("parses exact Anchor config and proposal account layouts", async () => {
    const state = fixture();
    const config = Buffer.concat([digest("account:Config"), u8(3), publicKey(state.config.admin), publicKey(mint),
      publicKey(TOKEN_PROGRAM_ID.toBase58()), publicKey(mstrxMint), publicKey(state.config.reserveVault),
      publicKey(state.config.marketingWallet), i64(500n), u64(1n), Buffer.from(state.config.launchSignatureHex, "hex"),
      u64(1n), u64(1n), u64(100n), u8(1)]);
    expect(await parseGovernanceConfig(account(config))).toMatchObject({ schemaVersion: 3, capitalMint: mint,
      reserveVault: state.config.reserveVault, committedReserveRawMstrx: 100n, activeProposalId: 1n });
    const options = [
      Buffer.concat([u8(0), u32(0), publicKey(SystemProgram.programId.toBase58()), u64(0n), u64(0n)]),
      Buffer.concat([u8(2), u32(0), publicKey(SystemProgram.programId.toBase58()), u64(100n), u64(25n)]),
    ];
    const proposal = Buffer.concat([digest("account:Proposal"), u8(3), publicKey(state.configAddress.toBase58()),
      publicKey(mint), publicKey(state.config.reserveVault),
      u64(1n), i64(2001n), i64(5601n), i64(5901n), i64(1000n), i64(2000n), u64(20n),
      publicKey(blockhash), Buffer.from(exclusionsHash, "hex"), Buffer.from(root, "hex"),
      u64(1n), u128(100_000n), u64(100n), u32(2), ...options,
      ...Array.from({ length: 6 }, () => u128(0n)), u128(0n), u8(0), u8(255), u8(1),
    ]);
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(proposal))).toMatchObject({
      schemaVersion: 3, reserveVault: state.config.reserveVault, merkleRoot: root, totalAvailableWeight: 100_000n,
      options: [{ action: "ACCUMULATE", minOutputRaw: 0n }, { action: "BUYBACK_BURN", minOutputRaw: 25n }],
    });
    const tampered = Buffer.from(proposal);
    tampered[tampered.length - 19] = 1; // Change a tally without changing totalCast
    await expect(parseGovernanceProposal(state.proposalAddress.toBase58(), account(tampered))).rejects.toThrow();
    const nonLockExecuted = Buffer.from(proposal);
    nonLockExecuted.writeBigUInt64LE(8_000n, nonLockExecuted.length - 99);
    nonLockExecuted.writeBigUInt64LE(8_000n, nonLockExecuted.length - 19);
    nonLockExecuted[nonLockExecuted.length - 3] = 4;
    nonLockExecuted[nonLockExecuted.length - 2] = 1;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(nonLockExecuted)))
      .toMatchObject({ status: 4, winningOption: 1, options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN" }] });
    const accumulated = Buffer.from(proposal);
    accumulated.writeBigUInt64LE(8_000n, accumulated.length - 115); // ACCUMULATE tally
    accumulated.writeBigUInt64LE(8_000n, accumulated.length - 19);
    accumulated[accumulated.length - 3] = 4;
    accumulated[accumulated.length - 2] = 0;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(accumulated)))
      .toMatchObject({ status: 4, winningOption: 0, totalCast: 8_000n,
        options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN" }] });
    const executed = Buffer.from(nonLockExecuted);
    const secondOption = proposal.indexOf(options[1]);
    expect(secondOption).toBeGreaterThan(0);
    executed[secondOption] = 4; // The only implemented executor is LOCK_MSTRX
    executed.writeUInt32LE(30 * 86_400, secondOption + 1);
    executed.writeBigUInt64LE(0n, secondOption + 45);
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(executed))).toMatchObject({
      status: 4, winningOption: 1, totalCast: 8_000n, options: [{ action: "ACCUMULATE" }, { action: "LOCK_MSTRX" }],
    });
    const marketing = Buffer.from(proposal);
    marketing[secondOption] = 5;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(marketing))).toMatchObject({
      options: [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE" }],
    });
    const noFloor = Buffer.from(proposal);
    noFloor.writeBigUInt64LE(0n, secondOption + 45);
    await expect(parseGovernanceProposal(state.proposalAddress.toBase58(), account(noFloor)))
      .rejects.toThrow("GOVERNANCE_OPTION_POLICY_MISMATCH");
    const superseded = Buffer.from(nonLockExecuted);
    superseded[superseded.length - 3] = 5;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(superseded)))
      .toMatchObject({ status: 5, winningOption: 1, totalCast: 8_000n });
    const activeRevote = Buffer.from(proposal);
    activeRevote[activeRevote.length - 3] = 6;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(activeRevote)))
      .toMatchObject({ status: 6, winningOption: 255 });
    const noQuorum = Buffer.from(proposal);
    noQuorum[noQuorum.length - 3] = 7;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(noQuorum)))
      .toMatchObject({ status: 7, winningOption: 255 });
    const tied = Buffer.from(proposal);
    tied.writeBigUInt64LE(4_000n, tied.length - 115);
    tied.writeBigUInt64LE(4_000n, tied.length - 99);
    tied.writeBigUInt64LE(8_000n, tied.length - 19);
    tied[tied.length - 3] = 8;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(tied)))
      .toMatchObject({ status: 8, winningOption: 255, totalCast: 8_000n });
    const supersededNoQuorum = Buffer.from(noQuorum);
    supersededNoQuorum[supersededNoQuorum.length - 3] = 5;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(supersededNoQuorum)))
      .toMatchObject({ status: 5, winningOption: 255, totalCast: 0n });
    const supersededTie = Buffer.from(tied);
    supersededTie[supersededTie.length - 3] = 5;
    expect(await parseGovernanceProposal(state.proposalAddress.toBase58(), account(supersededTie)))
      .toMatchObject({ status: 5, winningOption: 255, totalCast: 8_000n });
    const invalidSupersededNoWinner = Buffer.from(superseded);
    invalidSupersededNoWinner[invalidSupersededNoWinner.length - 2] = 255;
    await expect(parseGovernanceProposal(state.proposalAddress.toBase58(), account(invalidSupersededNoWinner)))
      .rejects.toThrow("GOVERNANCE_RESULT_MISMATCH");
  });

  it("accepts stable positive proposal links and rejects malformed IDs", () => {
    expect(governanceProposalIdFromUrl("?proposal=17")).toBe(17n);
    expect(governanceProposalIdFromUrl("")).toBeUndefined();
    expect(() => governanceProposalIdFromUrl("?proposal=../17")).toThrow();
    expect(() => governanceProposalIdFromUrl("?proposal=0")).toThrow();
  });

  it("streams the same-origin source checksum and rejects missing or oversized source files", async () => {
    const source = new TextEncoder().encode('{"transfers":[]}\n');
    const expected = createHash("sha256").update(source).digest("hex");
    const path = "/governance/proposals/1/source.json";
    const sourceResponse = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source.subarray(0, 5));
        controller.enqueue(source.subarray(5));
        controller.close();
      },
    }));
    const fetchMock = vi.fn(async () => sourceResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      await verifyGovernanceSourceArtifact(path, expected);
      expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ cache: "no-store", redirect: "error" }));
      await expect(verifyGovernanceSourceArtifact(path, "0".repeat(64)))
        .rejects.toThrow("GOVERNANCE_SOURCE_CHECKSUM_MISMATCH");
      await expect(verifyGovernanceSourceArtifact("https://example.com/source.json", expected))
        .rejects.toThrow("GOVERNANCE_SOURCE_PATH_INVALID");
      fetchMock.mockImplementationOnce(async () => new Response("missing", { status: 404 }));
      await expect(verifyGovernanceSourceArtifact(path, expected))
        .rejects.toThrow("GOVERNANCE_PUBLISHED_SOURCE_MISSING");
      fetchMock.mockImplementationOnce(async () => new Response("too large", {
        headers: { "content-length": String(64 * 1024 * 1024 + 1) },
      }));
      await expect(verifyGovernanceSourceArtifact(path, expected))
        .rejects.toThrow("GOVERNANCE_SOURCE_TOO_LARGE");
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects old or unknown account schema before any RPC query", async () => {
    await expect(loadVerifiedGovernance({} as Connection, {
      network: "solana-mainnet-beta", projectMint: mint, mstrxMint,
      governanceProgram: key(9), governanceAccountSchemaVersion: 1,
    })).rejects.toThrow("GOVERNANCE_WEB_SCHEMA_UNSUPPORTED");
    await expect(loadVerifiedGovernance({} as Connection, {
      network: "solana-mainnet-beta", projectMint: mint, mstrxMint,
      governanceProgram: key(9), governanceAccountSchemaVersion: 2,
    })).rejects.toThrow("GOVERNANCE_WEB_SCHEMA_UNSUPPORTED");
    await expect(loadVerifiedGovernance({} as Connection, {
      network: "solana-mainnet-beta", projectMint: mint, mstrxMint,
      governanceProgram: key(9), governanceAccountSchemaVersion: 3,
    })).rejects.toThrow("GOVERNANCE_REVIEWED_PROGRAM_HASH_MISSING");
  });

  it("reads config, proposal and reserve evidence from one finalized account snapshot", async () => {
    const deployedProgram = new PublicKey(key(9));
    const addresses = governanceAddresses(deployedProgram, 1n);
    const reserveVault = getAssociatedTokenAddressSync(new PublicKey(mstrxMint), addresses.config, true, TOKEN_2022_PROGRAM_ID);
    const admin = key(1);
    const programDataAddress = new PublicKey(key(10));
    const configData = Buffer.concat([digest("account:Config"), u8(3), publicKey(admin), publicKey(mint),
      publicKey(TOKEN_PROGRAM_ID.toBase58()), publicKey(mstrxMint), reserveVault.toBuffer(),
      publicKey(key(3)), i64(500n), u64(1n), Buffer.from("ab".repeat(64), "hex"),
      u64(1n), u64(1n), u64(100n), u8(1)]);
    const empty = publicKey(SystemProgram.programId.toBase58());
    const options = [Buffer.concat([u8(0), u32(0), empty, u64(0n), u64(0n)]),
      Buffer.concat([u8(4), u32(30 * 86_400), empty, u64(100n), u64(0n)])];
    const proposalData = Buffer.concat([digest("account:Proposal"), u8(3), addresses.config.toBuffer(),
      publicKey(mint), reserveVault.toBuffer(), u64(1n), i64(90_000n), i64(93_600n), i64(93_900n),
      i64(500n), i64(2000n), u64(20n), publicKey(blockhash), Buffer.from(exclusionsHash, "hex"),
      Buffer.from(root, "hex"), u64(1n), u128(100_000n), u64(100n), u32(2), ...options,
      ...Array.from({ length: 6 }, () => u128(0n)), u128(0n), u8(0), u8(255), u8(1)]);
    const mintData = Buffer.alloc(82);
    mintData[44] = 8;
    mintData[45] = 1;
    const capitalMintData = Buffer.from(mintData);
    capitalMintData[44] = 6;
    const vaultData = Buffer.alloc(ACCOUNT_SIZE);
    publicKey(mstrxMint).copy(vaultData, 0);
    addresses.config.toBuffer().copy(vaultData, 32);
    vaultData.writeBigUInt64LE(125n, 64);
    vaultData[108] = 1;
    const programData = Buffer.concat([u32(2), programDataAddress.toBuffer()]);
    const reviewedCode = Buffer.from("reviewed-governance-program");
    const reviewedHash = createHash("sha256").update(reviewedCode).digest("hex");
    let programDataBytes = Buffer.concat([u32(3), u64(1n), u8(0), Buffer.alloc(32), reviewedCode]);
    const snapshotValue = [
      { ...account(programData), owner: upgradeableLoader, executable: true },
      { ...account(configData), owner: deployedProgram },
      { ...account(mintData), owner: TOKEN_2022_PROGRAM_ID },
      { ...account(capitalMintData), owner: TOKEN_PROGRAM_ID },
      { ...account(vaultData), owner: TOKEN_2022_PROGRAM_ID },
      { ...account(proposalData), owner: deployedProgram }, null, null, null, null,
    ];
    const getMultipleAccountsInfoAndContext = vi.fn(async (_addresses: PublicKey[], _commitment: string) => (
      { context: { slot: 21 }, value: snapshotValue }));
    const getAccountInfo = vi.fn(async (address: PublicKey) => address.equals(addresses.config)
      ? { ...account(configData), owner: deployedProgram }
      : address.equals(programDataAddress)
        ? { ...account(programDataBytes), owner: upgradeableLoader }
        : null);
    const connection = { getAccountInfo, getMultipleAccountsInfoAndContext,
      getBlockTime: vi.fn(async () => 3_000),
      getBlock: vi.fn(async () => ({ blockhash })) } as unknown as Connection;
    let publishedSource = '{"transfers":[]}\n';
    let publishedSnapshot = `${JSON.stringify({
      version: 1, network: "solana-mainnet-beta", governanceProgram: deployedProgram.toBase58(),
      proposalId: "1", capitalMint: mint, windowStart: 500, windowEnd: 2000,
      finalizedThroughSlot: 20, finalizedBlockhash: blockhash, exclusionsHash,
      merkleRoot: root, totalAvailableWeight: "100000", leafCount: 1,
      entries: [{ account: voter.toBase58(), weight: "100000", proof: [] }],
    }, null, 2)}\n`;
    const manifest = {
      version: 2, network: "solana-mainnet-beta", proposalId: "1", publishedAtUnix: 2_000,
      merkleRoot: root, totalAvailableWeight: "100000",
      sourceSha256: createHash("sha256").update(publishedSource).digest("hex"),
      snapshotSha256: createHash("sha256").update(publishedSnapshot).digest("hex"),
      source: "governance/proposals/1/source.json", snapshot: "governance/proposals/1/snapshot.json",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/manifest.json")
      ? new Response(JSON.stringify(manifest))
      : url.endsWith("/source.json") ? new Response(publishedSource) : new Response(publishedSnapshot)));
    const publicConfig = { network: "solana-mainnet-beta" as const, projectMint: mint, mstrxMint,
      governanceProgram: deployedProgram.toBase58(), governanceProgramCodeSha256: reviewedHash,
      governanceAccountSchemaVersion: 3 };
    try {
      const result = await loadVerifiedGovernance(connection, publicConfig);
      expect(result).toMatchObject({ accountSnapshotSlot: 21, custodyVerifiedForProposal: true,
        committedReserveRawMstrx: 100n, vaultBalanceRawMstrx: 125n, capitalDecimals: 6,
        upgradeAuthority: "IMMUTABLE", programCodeSha256: reviewedHash });
      expect(getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
      const immediateRevote = Buffer.from(proposalData);
      immediateRevote.writeBigInt64LE(3_000n, 113);
      immediateRevote.writeBigInt64LE(6_600n, 121);
      immediateRevote.writeBigInt64LE(6_900n, 129);
      immediateRevote[immediateRevote.length - 3] = 6;
      snapshotValue[5] = { ...account(immediateRevote), owner: deployedProgram };
      manifest.publishedAtUnix = 2_999;
      expect((await loadVerifiedGovernance(connection, publicConfig))?.proposal)
        .toMatchObject({ startsAt: 3_000, endsAt: 6_600, executableAt: 6_900, status: 6 });
      manifest.publishedAtUnix = 3_001;
      await expect(loadVerifiedGovernance(connection, publicConfig))
        .rejects.toThrow("GOVERNANCE_PUBLISHED_SNAPSHOT_MISMATCH");
      snapshotValue[5] = { ...account(proposalData), owner: deployedProgram };
      manifest.publishedAtUnix = 2_000;
      manifest.snapshotSha256 = "f".repeat(64);
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_SNAPSHOT_CHECKSUM_MISMATCH");
      manifest.snapshotSha256 = createHash("sha256").update(publishedSnapshot).digest("hex");
      manifest.publishedAtUnix = 3_601;
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_PUBLISHED_SNAPSHOT_MISMATCH");
      manifest.publishedAtUnix = 2_000;
      manifest.merkleRoot = "f".repeat(64);
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_PUBLISHED_SNAPSHOT_MISMATCH");
      manifest.merkleRoot = root;
      publishedSource = '{"transfers":["tampered"]}\n';
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_SOURCE_CHECKSUM_MISMATCH");
      publishedSource = '{"transfers":[]}\n';
      const originalSnapshot = publishedSnapshot;
      publishedSnapshot = publishedSnapshot.replace('"totalAvailableWeight": "100000"', '"totalAvailableWeight": "99999"');
      manifest.snapshotSha256 = createHash("sha256").update(publishedSnapshot).digest("hex");
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_SNAPSHOT_CONTENT_MISMATCH");
      publishedSnapshot = originalSnapshot;
      manifest.snapshotSha256 = createHash("sha256").update(publishedSnapshot).digest("hex");
      expect(getMultipleAccountsInfoAndContext.mock.calls[0][0].map((entry: PublicKey) => entry.toBase58()))
        .toEqual([deployedProgram, addresses.config, new PublicKey(mstrxMint), new PublicKey(mint),
          reserveVault, addresses.proposal,
          governanceLockAddresses(deployedProgram, addresses.proposal, new PublicKey(mstrxMint)).record,
          governanceLockAddresses(deployedProgram, addresses.proposal, new PublicKey(mstrxMint)).escrow,
          governanceExecutionReceiptAddresses(deployedProgram, addresses.proposal).buyback,
          governanceExecutionReceiptAddresses(deployedProgram, addresses.proposal).marketing]
          .map((entry) => entry.toBase58()));
      programDataBytes = Buffer.from(programDataBytes);
      programDataBytes[45] ^= 1; // Tampered immutable code after the ProgramData header
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_PROGRAM_CODE_HASH_MISMATCH");
      programDataBytes[45] ^= 1;
      programDataBytes[12] = 1; // Restored upgrade authority means commitments are no longer binding
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_PROGRAM_NOT_IMMUTABLE");
      programDataBytes[12] = 0;
      const staleConfig = Buffer.from(configData);
      staleConfig.writeBigUInt64LE(2n, 289); // Finalized bank advanced to a new active proposal
      snapshotValue[1] = { ...account(staleConfig), owner: deployedProgram };
      await expect(loadVerifiedGovernance(connection, publicConfig)).rejects.toThrow("GOVERNANCE_STATE_CHANGED_RELOAD");
    } finally { vi.unstubAllGlobals(); }
  });

  it("checks canonical Token-2022 vault owner, mint and committed solvency", () => {
    const state = fixture();
    const data = Buffer.alloc(ACCOUNT_SIZE);
    publicKey(mstrxMint).copy(data, 0);
    state.configAddress.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(125n, 64);
    data[108] = 1;
    const vaultInfo = { ...account(data), owner: TOKEN_2022_PROGRAM_ID };
    expect(inspectGovernanceVault(state.configAddress, state.config, new PublicKey(mstrxMint), vaultInfo)).toMatchObject({
      balance: 125n, free: 25n,
    });
    data.writeBigUInt64LE(99n, 64);
    expect(() => inspectGovernanceVault(state.configAddress, state.config, new PublicKey(mstrxMint), vaultInfo)).toThrow("GOVERNANCE_RESERVE_VAULT_INVALID");
    data.writeBigUInt64LE(125n, 64);
    expect(() => inspectGovernanceVault(state.configAddress, { ...state.config, reserveVault: key(7) }, new PublicKey(mstrxMint), vaultInfo)).toThrow("GOVERNANCE_RESERVE_VAULT_ADDRESS_MISMATCH");
    expect(() => inspectGovernanceVault(state.configAddress, state.config, new PublicKey(mstrxMint), { ...vaultInfo, owner: TOKEN_PROGRAM_ID })).toThrow();
    data[108] = 2;
    expect(() => inspectGovernanceVault(state.configAddress, state.config, new PublicKey(mstrxMint), vaultInfo)).toThrow("GOVERNANCE_RESERVE_VAULT_INVALID");
  });

  it("verifies an executed LOCK_MSTRX against its exact PDA, escrow and term, including timed release", async () => {
    const base = fixture();
    const duration = 30 * 86_400;
    const lockedAt = 6_000;
    const releaseAt = lockedAt + duration;
    const proposal = { ...base.proposal, status: 4 as const, winningOption: 1,
      options: [base.proposal.options[0], { ...base.proposal.options[1], action: "LOCK_MSTRX" as const,
        lockDurationSeconds: duration, minOutputRaw: 0n }] };
    const addresses = governanceLockAddresses(programId, base.proposalAddress, new PublicKey(mstrxMint));
    const recordData = Buffer.concat([digest("account:LockRecord"), publicKey(base.proposalAddress.toBase58()),
      publicKey(base.configAddress.toBase58()), publicKey(base.config.reserveVault), publicKey(addresses.escrow.toBase58()),
      u64(100n), i64(BigInt(lockedAt)), i64(BigInt(releaseAt)), u32(duration), u8(0), u8(addresses.bump)]);
    const escrowData = Buffer.alloc(ACCOUNT_SIZE);
    publicKey(mstrxMint).copy(escrowData, 0);
    addresses.record.toBuffer().copy(escrowData, 32);
    escrowData.writeBigUInt64LE(125n, 64); // Third-party donations cannot reduce the committed lock
    escrowData[108] = 1;
    const escrowInfo = { ...account(escrowData), owner: TOKEN_2022_PROGRAM_ID };
    const inspect = (time: number, record = recordData, escrow = escrowInfo) => inspectGovernanceLock(
      programId, base.configAddress, base.config, base.proposalAddress, proposal,
      new PublicKey(mstrxMint), account(record), escrow, time);

    expect(await parseGovernanceLockRecord(account(recordData))).toMatchObject({
      amount: 100n, releaseAt, durationSeconds: duration, status: 0,
    });
    expect(await inspect(7_000)).toMatchObject({ state: "ACTIVE", escrowBalanceRawMstrx: 125n });
    expect(await inspect(releaseAt + 1)).toMatchObject({ state: "MATURED_AWAITING_RELEASE" });
    await expect(inspect(7_000, Buffer.from(recordData), null as never)).rejects.toThrow("GOVERNANCE_ONCHAIN_ACCOUNT_MISSING");

    const wrongProposal = Buffer.from(recordData);
    publicKey(key(7)).copy(wrongProposal, 8);
    await expect(inspect(7_000, wrongProposal)).rejects.toThrow("GOVERNANCE_LOCK_RECORD_MISMATCH");
    escrowData.writeBigUInt64LE(99n, 64);
    await expect(inspect(7_000)).rejects.toThrow("GOVERNANCE_LOCK_ESCROW_INVALID");
    escrowData.writeBigUInt64LE(125n, 64);
    const wrongTerm = Buffer.from(recordData);
    wrongTerm.writeBigInt64LE(BigInt(releaseAt + 1), 8 + 32 * 4 + 8 + 8);
    await expect(inspect(7_000, wrongTerm)).rejects.toThrow("GOVERNANCE_LOCK_RECORD_MISMATCH");

    const releasedRecord = Buffer.from(recordData);
    releasedRecord[releasedRecord.length - 2] = 1;
    escrowData.writeBigUInt64LE(0n, 64);
    await expect(inspect(releaseAt - 1, releasedRecord)).rejects.toThrow("GOVERNANCE_LOCK_RECORD_MISMATCH");
    expect(await inspect(releaseAt + 1, releasedRecord)).toMatchObject({
      state: "RELEASED", escrowBalanceRawMstrx: 0n,
    });
    escrowData.writeBigUInt64LE(1n, 64);
    await expect(inspect(releaseAt + 1, releasedRecord)).rejects.toThrow("GOVERNANCE_LOCK_ESCROW_INVALID");
  });

  it("formats exact MSTRx units without floating-point loss", () => {
    expect(formatMstrxExact(123_456_789n)).toBe("1.23456789");
    expect(formatMstrxExact(100_000_000n)).toBe("1");
    expect(formatMstrxExact(1n)).toBe("0.00000001");
    expect(formatRawTokenExact(123_456_789n, 6)).toBe("123.456789");
    expect(formatRawTokenExact(1_000_000_000n, 9)).toBe("1");
  });

  it("requires canonical finalized buyback receipts for every buyback outcome", async () => {
    const base = fixture();
    const addresses = governanceExecutionReceiptAddresses(programId, base.proposalAddress);
    const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], programId)[0];
    const hold = PublicKey.findProgramAddressSync([Buffer.from("capital-hold")], programId)[0];
    const pump = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], pump)[0];
    for (const [action, actionIndex] of [["BUYBACK_HOLD", 1], ["BUYBACK_BURN", 2], ["BUYBACK_LOCK", 3]] as const) {
      const duration = action === "BUYBACK_LOCK" ? 30 * 86_400 : 0;
      const proposal = { ...base.proposal, status: 4 as const, winningOption: 1,
        options: [base.proposal.options[0], { ...base.proposal.options[1], action, lockDurationSeconds: duration }] };
      const destination = action === "BUYBACK_BURN" ? SystemProgram.programId
        : getAssociatedTokenAddressSync(new PublicKey(mint), action === "BUYBACK_HOLD" ? hold : addresses.buyback,
          true, TOKEN_PROGRAM_ID);
      const bytes = Buffer.alloc(335);
      digest("account:BuybackExecutionReceipt").copy(bytes, 0);
      bytes[8] = 3;
      publicKey(base.proposalAddress.toBase58()).copy(bytes, 9);
      publicKey(base.configAddress.toBase58()).copy(bytes, 41);
      publicKey(mint).copy(bytes, 73);
      publicKey(base.config.reserveVault).copy(bytes, 105);
      trader.toBuffer().copy(bytes, 137);
      pump.toBuffer().copy(bytes, 169);
      curve.toBuffer().copy(bytes, 201);
      destination.toBuffer().copy(bytes, 233);
      bytes[265] = actionIndex;
      bytes.writeBigUInt64LE(100n, 266);
      bytes.writeBigUInt64LE(25n, 274);
      bytes.writeBigUInt64LE(40n, 282);
      bytes.writeBigUInt64LE(1_000n, 290);
      bytes.writeBigUInt64LE(action === "BUYBACK_BURN" ? 960n : 1_000n, 298);
      bytes.writeBigInt64LE(6_000n, 306);
      bytes.writeBigInt64LE(action === "BUYBACK_LOCK" ? BigInt(6_000 + duration) : 0n, 314);
      bytes.writeUInt32LE(duration, 330);
      bytes[334] = addresses.buybackBump;
      const inspect = (record: Buffer | null) => inspectGovernanceExecutionReceipt(programId, base.configAddress,
        base.config, base.proposalAddress, proposal, record ? account(record) : null, null, 6_100);
      expect(await inspect(bytes)).toMatchObject({ kind: "BUYBACK", action, inputRawMstrx: 100n,
        votedMinOutputRaw: 25n, actualOutputRaw: 40n, destination: destination.toBase58() });
      await expect(inspect(null)).rejects.toThrow("GOVERNANCE_EXECUTION_RECEIPT_STATE_MISMATCH");
      const lessThanVote = Buffer.from(bytes);
      lessThanVote.writeBigUInt64LE(24n, 282);
      await expect(inspect(lessThanVote)).rejects.toThrow("GOVERNANCE_BUYBACK_RECEIPT_MISMATCH");
      const wrongInput = Buffer.from(bytes);
      wrongInput.writeBigUInt64LE(99n, 266);
      await expect(inspect(wrongInput)).rejects.toThrow("GOVERNANCE_BUYBACK_RECEIPT_MISMATCH");
      const wrongBump = Buffer.from(bytes);
      wrongBump[334] ^= 1;
      await expect(inspect(wrongBump)).rejects.toThrow("GOVERNANCE_BUYBACK_RECEIPT_MISMATCH");
      const wrongDestination = Buffer.from(bytes);
      publicKey(key(9)).copy(wrongDestination, 233);
      await expect(inspect(wrongDestination)).rejects.toThrow("GOVERNANCE_BUYBACK_RECEIPT_MISMATCH");
      const wrongOwner = { ...account(bytes), owner: SystemProgram.programId };
      await expect(inspectGovernanceExecutionReceipt(programId, base.configAddress, base.config,
        base.proposalAddress, proposal, wrongOwner, null, 6_100)).rejects.toThrow("GOVERNANCE_ONCHAIN_ACCOUNT_MISSING");
    }
  });

  it("requires a canonical marketing receipt, fixed recipient and voted SOL floor", async () => {
    const base = fixture();
    const addresses = governanceExecutionReceiptAddresses(programId, base.proposalAddress);
    const proposal = { ...base.proposal, status: 4 as const, winningOption: 1,
      options: [base.proposal.options[0], { ...base.proposal.options[1], action: "MARKETING_SALE" as const,
        recipient: base.config.marketingWallet, minOutputRaw: 25n }] };
    const bytes = Buffer.alloc(251);
    digest("account:MarketingSaleReceipt").copy(bytes, 0);
    bytes[8] = 3; bytes[9] = 5;
    publicKey(base.proposalAddress.toBase58()).copy(bytes, 10);
    publicKey(base.configAddress.toBase58()).copy(bytes, 42);
    publicKey(mstrxMint).copy(bytes, 74);
    publicKey(base.config.reserveVault).copy(bytes, 106);
    publicKey(base.config.marketingWallet).copy(bytes, 138);
    publicKey("2ngTuP7xA581dqX9uJkGRqxmKuehY3k4SDfPebeoRG2J").copy(bytes, 170);
    bytes.writeBigUInt64LE(100n, 202);
    bytes.writeBigUInt64LE(25n, 210);
    bytes.writeBigUInt64LE(30n, 218);
    bytes.writeBigUInt64LE(40n, 226);
    bytes.writeBigUInt64LE(2_000_000n, 234);
    bytes.writeBigInt64LE(6_000n, 242);
    bytes[250] = addresses.marketingBump;
    const inspect = (record: Buffer) => inspectGovernanceExecutionReceipt(programId, base.configAddress,
      base.config, base.proposalAddress, proposal, null, account(record), 6_100);
    expect(await inspect(bytes)).toMatchObject({ kind: "MARKETING_SALE", action: "MARKETING_SALE",
      inputRawMstrx: 100n, votedMinOutputRaw: 25n, actualOutputRaw: 40n,
      destination: base.config.marketingWallet });
    const wrongRecipient = Buffer.from(bytes);
    publicKey(key(9)).copy(wrongRecipient, 138);
    await expect(inspect(wrongRecipient)).rejects.toThrow("GOVERNANCE_MARKETING_RECEIPT_MISMATCH");
    const wrongFloor = Buffer.from(bytes);
    wrongFloor.writeBigUInt64LE(24n, 210);
    await expect(inspect(wrongFloor)).rejects.toThrow("GOVERNANCE_MARKETING_RECEIPT_MISMATCH");
    const weakExecution = Buffer.from(bytes);
    weakExecution.writeBigUInt64LE(29n, 226);
    await expect(inspect(weakExecution)).rejects.toThrow("GOVERNANCE_MARKETING_RECEIPT_MISMATCH");
    const wrongPool = Buffer.from(bytes);
    publicKey(key(8)).copy(wrongPool, 170);
    await expect(inspect(wrongPool)).rejects.toThrow("GOVERNANCE_MARKETING_RECEIPT_MISMATCH");
    await expect(inspectGovernanceExecutionReceipt(programId, base.configAddress, base.config,
      base.proposalAddress, proposal, null, null, 6_100)).rejects.toThrow("GOVERNANCE_EXECUTION_RECEIPT_STATE_MISMATCH");
  });
});
