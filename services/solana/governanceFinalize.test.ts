import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import { SOLANA_CONTROL_NETWORK, solanaControlMessage, verifySignedSolanaControlAction,
  type FinalizeVoteIntent } from "./controlAuth";
import { buildFinalizeVoteInstruction, finalizeVote, reconcileFinalizeVote,
  type FinalizeVoteEnvironment } from "./governanceFinalize";

const program = Keypair.generate().publicKey;
const admin = Keypair.generate();
const reserveMint = Keypair.generate().publicKey.toBase58();
const capitalMint = Keypair.generate().publicKey.toBase58();
const reserveVault = Keypair.generate().publicKey.toBase58();
const codeHash = "b".repeat(64);
const folders: string[] = [];

function environment(stateRoot: string): FinalizeVoteEnvironment {
  return {
    rpcUrls: ["https://provider-one.invalid", "https://provider-two.invalid"], stateRoot,
    governanceProgram: program.toBase58(), expectedProgramCodeSha256: codeHash,
    reserveAuthority: Keypair.generate().publicKey.toBase58(), reserveMint, capitalMint,
    admin: admin.publicKey.toBase58(), adminKeypairPath: "unused-in-mock",
  };
}

function intent(): FinalizeVoteIntent {
  const id = 7n;
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(id);
  return {
    governanceProgram: program.toBase58(), programCodeSha256: codeHash,
    reserveMint, reserveVault, capitalMint,
    config: PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0].toBase58(), proposalId: id.toString(),
    proposal: PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program)[0].toBase58(), proposalStateSha256: "c".repeat(64),
    frozenReserveRawMstrx: "100", executableAt: 1_800_000_000,
    verifiedAt: Date.now(),
  };
}

function preparedTransaction(env: FinalizeVoteEnvironment, exact: FinalizeVoteIntent) {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [buildFinalizeVoteInstruction(env, exact)],
  }).compileToV0Message());
  tx.sign([admin]);
  return { signature: bs58.encode(tx.signatures[0]), transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
    blockhash: tx.message.recentBlockhash, lastValidBlockHeight: 100 };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("governance ballot finalization control", () => {
  it("builds only the exact Anchor finalize instruction and rejects a different PDA", () => {
    const env = environment("unused");
    const exact = intent();
    const ix = buildFinalizeVoteInstruction(env, exact);
    expect(ix.data).toEqual(createHash("sha256").update("global:finalize").digest().subarray(0, 8));
    expect(ix.keys.map(({ pubkey, isWritable, isSigner }) => [pubkey.toBase58(), isWritable, isSigner]))
      .toEqual([[exact.config, true, false], [exact.proposal, true, false]]);
    expect(() => buildFinalizeVoteInstruction(env, { ...exact, proposal: Keypair.generate().publicKey.toBase58() }))
      .toThrow("GOVERNANCE_FINALIZE_PDA_MISMATCH");
  });

  it("binds owner challenge to exact proposal bytes and rejects tampering", () => {
    const exact = intent();
    const now = Date.now();
    const payload = { network: SOLANA_CONTROL_NETWORK, action: "finalize_vote", signer: admin.publicKey.toBase58(),
      issuedAt: now, expiresAt: now + 300_000, nonce: "a".repeat(40), finalization: exact };
    const signed = { ...payload, signature: bs58.encode(nacl.sign.detached(
      new TextEncoder().encode(solanaControlMessage(payload)), admin.secretKey,
    )) };
    expect(verifySignedSolanaControlAction(signed, admin.publicKey.toBase58(), now)).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed, finalization: {
      ...exact, proposalStateSha256: "d".repeat(64),
    } }, admin.publicKey.toBase58(), now)).toThrow("SIGNATURE_INVALID");
  });

  it("persists exact signed bytes before broadcast and does not sign a second pending request", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-finalize-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const prepared = preparedTransaction(env, exact);
    let prepares = 0;
    let sends = 0;
    let chainState: "pending" | "finalized" = "pending";
    const effects = {
      verify: async () => undefined,
      prepare: async () => { prepares++; return prepared; },
      broadcast: async (tx: typeof prepared) => {
        sends++;
        const persisted = JSON.parse(await readFile(join(stateRoot, "governance-finalize-vote.json"), "utf8")) as {
          state: string; transaction: typeof prepared;
        };
        expect(persisted.state).toMatch(/^(prepared|pending)$/);
        expect(persisted.transaction).toEqual(tx);
      },
      transactionState: async () => chainState,
    };
    const first = await finalizeVote(env, { requestId: "1-aaaaaaaaaaaaaaaa", nonce: "a".repeat(40), intent: exact }, effects);
    expect(first.state).toBe("pending");
    await reconcileFinalizeVote(env, effects);
    expect(sends).toBe(2);
    await expect(finalizeVote(env, { requestId: "2-bbbbbbbbbbbbbbbb", nonce: "b".repeat(40), intent: exact }, effects))
      .rejects.toThrow("GOVERNANCE_FINALIZE_PENDING_RECONCILIATION");
    expect(prepares).toBe(1);
    chainState = "finalized";
    expect((await reconcileFinalizeVote(env, effects))?.state).toBe("finalized");
  });

  it("rejects tampered persisted transaction and holds an unresolved expiry", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-finalize-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const prepared = preparedTransaction(env, exact);
    let state: "pending" | "unresolved" = "pending";
    const effects = {
      verify: async () => undefined,
      prepare: async () => prepared,
      broadcast: async () => undefined,
      transactionState: async () => state,
    };
    await finalizeVote(env, { requestId: "3-cccccccccccccccc", nonce: "c".repeat(40), intent: exact }, effects);
    state = "unresolved";
    expect((await reconcileFinalizeVote(env, effects))?.state).toBe("unresolved");
    await expect(finalizeVote(env, { requestId: "4-dddddddddddddddd", nonce: "d".repeat(40), intent: exact }, effects))
      .rejects.toThrow("GOVERNANCE_FINALIZE_UNRESOLVED_REVIEW_REQUIRED");
    const path = join(stateRoot, "governance-finalize-vote.json");
    const ledger = JSON.parse(await readFile(path, "utf8")) as { intent: FinalizeVoteIntent };
    ledger.intent.proposalStateSha256 = "d".repeat(64);
    await writeFile(path, JSON.stringify(ledger), "utf8");
    // Proposal hash is part of the signed owner intent, but not transaction
    // bytes. A ledger integrity check also needs to bind the whole intent.
    await expect(reconcileFinalizeVote(env, effects)).rejects.toThrow("GOVERNANCE_FINALIZE_LEDGER_INVALID");
  });
});
