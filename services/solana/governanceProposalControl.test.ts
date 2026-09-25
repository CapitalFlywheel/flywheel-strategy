import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import { SOLANA_CONTROL_NETWORK, solanaControlMessage, verifySignedSolanaControlAction,
  type ProposalControlIntent } from "./controlAuth";
import { createProposalControl, reconcileProposalControl, type ProposalControlEnvironment } from "./governanceProposalControl";
import { governanceProposalPreviewHash } from "./governanceProposalPreview";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";

const admin = Keypair.generate();
const program = Keypair.generate().publicKey.toBase58();
const reserveMint = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const capitalMint = Keypair.generate().publicKey.toBase58();
const marketing = Keypair.generate().publicKey.toBase58();
const route = deriveGovernanceReserveRoute(program, reserveMint);
const codeHash = "a".repeat(64);
const folders: string[] = [];

function environment(stateRoot: string): ProposalControlEnvironment {
  return { rpcUrls: ["https://one.invalid", "https://two.invalid"], stateRoot, publicDataRoot: "unused",
    governanceProgram: program, expectedProgramCodeSha256: codeHash,
    reserveMint, capitalMint, admin: admin.publicKey.toBase58(), adminKeypairPath: "unused" };
}

function exactInstructionAndIntent() {
  const idSeed = Buffer.alloc(8); idSeed.writeBigUInt64LE(1n);
  const proposalPda = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idSeed], route.program)[0];
  const root = "b".repeat(64);
  const data = Buffer.alloc(180 + 45 * 2);
  createHash("sha256").update("global:create_proposal").digest().subarray(0, 8).copy(data, 0);
  data.writeBigUInt64LE(1n, 8);
  data.writeBigInt64LE(3600n, 16);
  Buffer.from(root, "hex").copy(data, 112);
  data.writeBigUInt64LE(100n, 168);
  data.writeUInt32LE(2, 176);
  data.writeUInt8(0, 180);
  data.writeUInt8(4, 225);
  data.writeUInt32LE(30 * 86_400, 226);
  const ix = new TransactionInstruction({ programId: route.program, data, keys: [
    { pubkey: route.authority, isSigner: false, isWritable: true },
    { pubkey: route.ata, isSigner: false, isWritable: false },
    { pubkey: proposalPda, isSigner: false, isWritable: true },
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },
    { pubkey: route.program, isSigner: false, isWritable: false },
    { pubkey: route.programDataAddress, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ] });
  const now = Math.floor(Date.now() / 1000);
  const publication = { version: 2 as const, network: "solana-mainnet-beta" as const,
    proposalId: "1", publishedAtUnix: now - 60, merkleRoot: root, totalAvailableWeight: "500",
    sourceSha256: "c".repeat(64), snapshotSha256: "d".repeat(64),
    source: "governance/proposals/1/source.json", snapshot: "governance/proposals/1/snapshot.json" };
  const previewHash = governanceProposalPreviewHash({ mode: "initial", program,
    proposal: proposalPda.toBase58(), previousProposal: undefined, data: data.toString("hex"),
    keys: ix.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    programCodeSha256: codeHash, publication });
  const intent: ProposalControlIntent = { request: { mode: "initial", votingDurationSeconds: 3600,
    options: [{ action: "ACCUMULATE" }, { action: "LOCK_MSTRX", lockDurationSeconds: 30 * 86_400 }] },
    previewHash, auditedAtUnix: now, governanceProgram: program, programCodeSha256: codeHash,
    reserveMint, capitalMint, config: route.authority.toBase58(), reserveVault: route.ata.toBase58(),
    proposalId: "1", proposal: proposalPda.toBase58(), frozenReserveRawMstrx: "100",
    fixedMarketingRecipient: marketing, publication };
  return { ix, intent };
}

function authorization(intent: ProposalControlIntent, nonce: string) {
  const issuedAt = Date.now();
  const body = { network: SOLANA_CONTROL_NETWORK,
    action: intent.request.mode === "initial" ? "create_proposal" : "create_revote",
    signer: admin.publicKey.toBase58(), issuedAt, expiresAt: issuedAt + 300_000,
    nonce, proposalCreation: intent };
  return { ...body, signature: bs58.encode(nacl.sign.detached(
    new TextEncoder().encode(solanaControlMessage(body)), admin.secretKey,
  )) };
}

function prepared(ix: TransactionInstruction) {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ix],
  }).compileToV0Message());
  tx.sign([admin]);
  return { signature: bs58.encode(tx.signatures[0]),
    transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
    blockhash: tx.message.recentBlockhash, lastValidBlockHeight: 100 };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("exact governance proposal owner control", () => {
  it("round-trips the complete published preview digest through the signed transaction", async () => {
    const { ix, intent } = exactInstructionAndIntent();
    const expected = createHash("sha256").update(JSON.stringify({
      mode: "initial", program, proposal: intent.proposal, previousProposal: undefined,
      data: Buffer.from(ix.data).toString("hex"),
      keys: ix.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
      programCodeSha256: codeHash, publication: intent.publication,
    })).digest("hex");
    expect(intent.previewHash).toBe(expected);
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-preview-roundtrip-")); folders.push(stateRoot);
    const tx = prepared(ix);
    const result = await createProposalControl(environment(stateRoot), {
      requestId: "9-9999999999999999", authorization: authorization(intent, "9".repeat(40)),
    }, { verify: async () => ix, prepare: async () => tx,
      broadcast: async () => undefined, transactionState: async () => "pending" });
    expect(result.transaction.signature).toBe(tx.signature);
    expect(result.state).toBe("pending");
  });

  it("keeps the production signer and send path source-gated", async () => {
    const { intent } = exactInstructionAndIntent();
    await expect(createProposalControl(environment("unused"), { requestId: "1-aaaaaaaaaaaaaaaa",
      authorization: authorization(intent, "a".repeat(40)) }))
      .rejects.toThrow("GOVERNANCE_PROPOSAL_NOT_RELEASED");
  });

  it("binds the signed request to preview, publication and fixed ballot options", () => {
    const { intent } = exactInstructionAndIntent();
    const signed = authorization(intent, "a".repeat(40));
    expect(verifySignedSolanaControlAction(signed, admin.publicKey.toBase58())).toBe(true);
    for (const altered of [
      { ...intent, previewHash: "e".repeat(64) },
      { ...intent, frozenReserveRawMstrx: "99" },
      { ...intent, publication: { ...intent.publication, snapshotSha256: "e".repeat(64) } },
      { ...intent, request: { ...intent.request, options: [
        { action: "ACCUMULATE" as const }, { action: "LOCK_MSTRX" as const, lockDurationSeconds: 90 * 86_400 }] } },
    ]) expect(() => verifySignedSolanaControlAction({ ...signed, proposalCreation: altered },
      admin.publicKey.toBase58())).toThrow("SIGNATURE_INVALID");
    expect(() => authorization({ ...intent, auditedAtUnix: intent.auditedAtUnix - 120 }, "b".repeat(40)))
      .toThrow("GOVERNANCE_PROPOSAL_PREVIEW_STALE");
  });

  it("requires the exact previous proposal PDA for an immediate re-vote authorization", () => {
    const { intent } = exactInstructionAndIntent();
    const seed = Buffer.alloc(8); seed.writeBigUInt64LE(2n);
    const revote: ProposalControlIntent = { ...intent,
      request: { ...intent.request, mode: "revote" },
      proposalId: "2",
      proposal: PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], route.program)[0].toBase58(),
      previousProposal: intent.proposal,
      publication: { ...intent.publication, proposalId: "2",
        source: "governance/proposals/2/source.json", snapshot: "governance/proposals/2/snapshot.json" } };
    const signed = authorization(revote, "f".repeat(40));
    expect(verifySignedSolanaControlAction(signed, admin.publicKey.toBase58())).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed, proposalCreation: { ...revote,
      previousProposal: Keypair.generate().publicKey.toBase58() } }, admin.publicKey.toBase58()))
      .toThrow("GOVERNANCE_PROPOSAL_PDA_MISMATCH");
  });

  it("durably persists exact signed bytes before send, rebroadcasts only those bytes and blocks a second pending request", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-proposal-control-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const { ix, intent } = exactInstructionAndIntent();
    const tx = prepared(ix);
    let prepares = 0;
    let sends = 0;
    let chainState: "pending" | "finalized" = "pending";
    const effects = { verify: async () => ix,
      prepare: async () => { prepares++; return tx; },
      broadcast: async (actual: typeof tx) => {
        sends++;
        const ledger = JSON.parse(await readFile(join(stateRoot, "governance-proposal-control.json"), "utf8")) as {
          state: string; transaction: typeof tx;
        };
        expect(ledger.state).toMatch(/^(prepared|pending)$/);
        expect(ledger.transaction).toEqual(actual);
      },
      transactionState: async () => chainState };
    const first = await createProposalControl(env, { requestId: "1-aaaaaaaaaaaaaaaa",
      authorization: authorization(intent, "a".repeat(40)) }, effects);
    expect(first.state).toBe("pending");
    await reconcileProposalControl(env, effects);
    expect(prepares).toBe(1);
    expect(sends).toBe(2);
    await expect(createProposalControl(env, { requestId: "2-bbbbbbbbbbbbbbbb",
      authorization: authorization(intent, "b".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_PROPOSAL_PENDING_RECONCILIATION");
    chainState = "finalized";
    expect((await reconcileProposalControl(env, effects))?.state).toBe("finalized");
  });

  it("rejects tampered persisted intent and holds an unresolved expiry without a replacement signature", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-proposal-control-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const { ix, intent } = exactInstructionAndIntent();
    const tx = prepared(ix);
    let chainState: "pending" | "unresolved" = "pending";
    const effects = { verify: async () => ix, prepare: async () => tx,
      broadcast: async () => undefined, transactionState: async () => chainState };
    await createProposalControl(env, { requestId: "3-cccccccccccccccc",
      authorization: authorization(intent, "c".repeat(40)) }, effects);
    chainState = "unresolved";
    expect((await reconcileProposalControl(env, effects))?.state).toBe("unresolved");
    await expect(createProposalControl(env, { requestId: "4-dddddddddddddddd",
      authorization: authorization(intent, "d".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_PROPOSAL_UNRESOLVED_REVIEW_REQUIRED");
    const path = join(stateRoot, "governance-proposal-control.json");
    const ledger = JSON.parse(await readFile(path, "utf8")) as { authorization: { proposalCreation: ProposalControlIntent } };
    ledger.authorization.proposalCreation.previewHash = "f".repeat(64);
    await writeFile(path, JSON.stringify(ledger), "utf8");
    await expect(reconcileProposalControl(env, effects)).rejects.toThrow("SIGNATURE_INVALID");
  });
});
