import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import { solanaControlMessage, type LockExecutionIntent } from "./controlAuth";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";
import {
  buildLockExecutionInstruction, executeLockDecision, reconcileLockExecution,
  verifySignedLockExecution, type LockExecutionEnvironment,
  type SignedLockExecution,
} from "./governanceLockExecutionControl";

const program = Keypair.generate().publicKey;
const admin = Keypair.generate();
const reserveMint = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const capitalMint = Keypair.generate().publicKey.toBase58();
const folders: string[] = [];

function environment(stateRoot = "unused"): LockExecutionEnvironment {
  return {
    rpcUrls: ["https://provider-one.invalid", "https://provider-two.invalid"], stateRoot,
    governanceProgram: program.toBase58(), expectedProgramCodeSha256: "a".repeat(64),
    reserveAuthority: deriveGovernanceReserveRoute(program.toBase58(), reserveMint).authority.toBase58(),
    reserveMint, capitalMint, admin: admin.publicKey.toBase58(), adminKeypairPath: "unused-in-mock",
  };
}

function intent(now = Date.now()): LockExecutionIntent {
  const derived = deriveGovernanceReserveRoute(program.toBase58(), reserveMint);
  const seed = Buffer.alloc(8); seed.writeBigUInt64LE(7n);
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program)[0];
  const lockRecord = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], program)[0];
  const lockVault = PublicKey.findProgramAddressSync([
    lockRecord.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), derived.mint.toBuffer(),
  ], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
  return {
    governanceProgram: program.toBase58(), programCodeSha256: "a".repeat(64),
    reserveMint, reserveVault: derived.ata.toBase58(), capitalMint,
    capitalTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), config: derived.authority.toBase58(),
    proposalId: "7", proposal: proposal.toBase58(), lockRecord: lockRecord.toBase58(),
    lockVault: lockVault.toBase58(), proposalStateSha256: "b".repeat(64),
    frozenReserveRawMstrx: "1000", lockDurationSeconds: 30 * 86_400,
    executableAt: 1_700_000_000, verifiedAt: now,
  };
}

function signed(exact = intent(), nonce = "a".repeat(40)): SignedLockExecution {
  const issuedAt = Date.now();
  const payload = { network: "solana-mainnet-beta" as const, action: "execute_lock_mstrx" as const,
    signer: admin.publicKey.toBase58(), issuedAt, expiresAt: issuedAt + 300_000, nonce, lockExecution: exact };
  return { ...payload, signature: bs58.encode(nacl.sign.detached(
    new TextEncoder().encode(solanaControlMessage(payload)), admin.secretKey,
  )) };
}

function prepared(environment: LockExecutionEnvironment, exact: LockExecutionIntent) {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [buildLockExecutionInstruction(environment, exact)],
  }).compileToV0Message());
  transaction.sign([admin]);
  return { signature: bs58.encode(transaction.signatures[0]),
    transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    blockhash: transaction.message.recentBlockhash, lastValidBlockHeight: 100 };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("exact owner-controlled MSTRx lock execution", () => {
  it("pins onchain ABI, lock PDA/ATA and exactly one payer signer", () => {
    const env = environment();
    const exact = intent();
    const ix = buildLockExecutionInstruction(env, exact);
    expect(ix.data).toEqual(createHash("sha256").update("global:execute_lock_mstrx").digest().subarray(0, 8));
    expect(ix.keys.map((key) => [key.pubkey.toBase58(), key.isWritable, key.isSigner])).toEqual([
      [exact.config, true, false], [exact.proposal, true, false], [reserveMint, false, false],
      [exact.reserveVault, true, false], [exact.lockRecord, true, false], [exact.lockVault, true, false],
      [env.admin, true, true], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
      ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", false, false],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
    expect(() => buildLockExecutionInstruction(env, { ...exact, lockRecord: Keypair.generate().publicKey.toBase58() }))
      .toThrow("GOVERNANCE_LOCK_PDA_MISMATCH");
    expect(() => buildLockExecutionInstruction(env, { ...exact, lockDurationSeconds: 0 }))
      .toThrow("GOVERNANCE_LOCK_PREVIEW_INVALID");
  });

  it("requires an owner signature over the exact frozen amount, duration and state hash", () => {
    const authorization = signed();
    expect(verifySignedLockExecution(authorization, admin.publicKey.toBase58())).toBe(true);
    for (const tampered of [
      { ...authorization.lockExecution, frozenReserveRawMstrx: "1001" },
      { ...authorization.lockExecution, lockDurationSeconds: 90 * 86_400 },
      { ...authorization.lockExecution, proposalStateSha256: "c".repeat(64) },
    ]) {
      expect(() => verifySignedLockExecution({ ...authorization, lockExecution: tampered }, admin.publicKey.toBase58()))
        .toThrow("SIGNATURE_INVALID");
    }
    expect(() => verifySignedLockExecution({ ...authorization, signer: Keypair.generate().publicKey.toBase58() },
      admin.publicKey.toBase58())).toThrow("SIGNER_NOT_OWNER");
  });

  it("persists exact signed transaction before send and prevents duplicate pending execution", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-lock-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const authorization = signed(exact);
    const tx = prepared(env, exact);
    let prepares = 0;
    let broadcasts = 0;
    let chainState: "pending" | "finalized" = "pending";
    const effects = {
      audit: async () => ({ ...exact, verifiedAt: Date.now() }),
      prepare: async () => { prepares++; return tx; },
      broadcast: async (value: typeof tx) => {
        broadcasts++;
        const persisted = JSON.parse(await readFile(join(stateRoot, "governance-lock-execution.json"), "utf8")) as {
          transaction: typeof tx; state: string;
        };
        expect(persisted.transaction).toEqual(value);
        expect(persisted.state).toMatch(/^(prepared|pending)$/);
      },
      transactionState: async () => chainState,
    };
    const first = await executeLockDecision(env, { requestId: "1-aaaaaaaaaaaaaaaa", authorization }, effects);
    expect(first.state).toBe("pending");
    await reconcileLockExecution(env, effects);
    expect(broadcasts).toBe(2);
    await expect(executeLockDecision(env, { requestId: "2-bbbbbbbbbbbbbbbb",
      authorization: signed(exact, "b".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_LOCK_PENDING_RECONCILIATION");
    expect(prepares).toBe(1);
    chainState = "finalized";
    expect((await reconcileLockExecution(env, effects))?.state).toBe("finalized");
    await expect(executeLockDecision(env, { requestId: "3-cccccccccccccccc",
      authorization: signed(exact, "c".repeat(40)) }, effects)).rejects.toThrow("GOVERNANCE_LOCK_REPLAY");
  });

  it("rejects changed proposal terms, tampered durable bytes and unresolved expiry", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-lock-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const tx = prepared(env, exact);
    let chainState: "pending" | "unresolved" = "pending";
    const effects = {
      audit: async () => ({ ...exact, frozenReserveRawMstrx: "1001", verifiedAt: Date.now() }),
      prepare: async () => tx, broadcast: async () => undefined,
      transactionState: async () => chainState,
    };
    await expect(executeLockDecision(env, { requestId: "4-dddddddddddddddd",
      authorization: signed(exact, "d".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_LOCK_PREVIEW_CHANGED");
    effects.audit = async () => ({ ...exact, verifiedAt: Date.now() });
    await executeLockDecision(env, { requestId: "5-eeeeeeeeeeeeeeee",
      authorization: signed(exact, "e".repeat(40)) }, effects);
    chainState = "unresolved";
    expect((await reconcileLockExecution(env, effects))?.state).toBe("unresolved");
    await expect(executeLockDecision(env, { requestId: "6-ffffffffffffffff",
      authorization: signed(exact, "f".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_LOCK_UNRESOLVED_REVIEW_REQUIRED");
    const path = join(stateRoot, "governance-lock-execution.json");
    const ledger = JSON.parse(await readFile(path, "utf8")) as { authorization: SignedLockExecution };
    ledger.authorization.lockExecution.frozenReserveRawMstrx = "9999";
    await writeFile(path, JSON.stringify(ledger), "utf8");
    await expect(reconcileLockExecution(env, effects)).rejects.toThrow("SIGNATURE_INVALID");
  });

  it("rejects a different validly owner-signed instruction even if a ledger hash is recomputed", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-lock-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const effects = {
      audit: async () => ({ ...exact, verifiedAt: Date.now() }),
      prepare: async () => prepared(env, exact), broadcast: async () => undefined,
      transactionState: async () => "pending" as const,
    };
    await executeLockDecision(env, { requestId: "8-aaaaaaaaaaaaaaaa", authorization: signed(exact) }, effects);
    const path = join(stateRoot, "governance-lock-execution.json");
    const ledger = JSON.parse(await readFile(path, "utf8")) as {
      transaction: ReturnType<typeof prepared>; transactionSha256: string;
    };
    const alternate = new VersionedTransaction(new TransactionMessage({
      payerKey: admin.publicKey, recentBlockhash: ledger.transaction.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: admin.publicKey,
        toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message());
    alternate.sign([admin]);
    const raw = Buffer.from(alternate.serialize());
    ledger.transaction.signature = bs58.encode(alternate.signatures[0]);
    ledger.transaction.transactionBase64 = raw.toString("base64");
    ledger.transactionSha256 = createHash("sha256").update(raw).digest("hex");
    await writeFile(path, JSON.stringify(ledger), "utf8");
    await expect(reconcileLockExecution(env, effects)).rejects.toThrow("GOVERNANCE_LOCK_TRANSACTION_INVALID");
  });

  it("allows a new signed attempt only after a finalized failed transaction", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-lock-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    let outcome: "pending" | "failed" = "pending";
    const effects = {
      audit: async () => ({ ...exact, verifiedAt: Date.now() }),
      prepare: async () => prepared(env, exact), broadcast: async () => undefined,
      transactionState: async () => outcome,
    };
    await executeLockDecision(env, { requestId: "9-aaaaaaaaaaaaaaaa", authorization: signed(exact) }, effects);
    outcome = "failed";
    expect((await reconcileLockExecution(env, effects))?.state).toBe("failed");
    // Finalized failure remains durable even after RPCs drop old signatures.
    effects.transactionState = async () => { throw new Error("HISTORICAL_SIGNATURE_UNAVAILABLE"); };
    const retry = await executeLockDecision(env, { requestId: "10-bbbbbbbbbbbbbbbb",
      authorization: signed(exact, "b".repeat(40)) }, effects);
    expect(retry.state).toBe("pending");
  });

  it("keeps the production path source-gated without touching RPC or key files", async () => {
    await expect(executeLockDecision(environment(), { requestId: "7-aaaaaaaaaaaaaaaa",
      authorization: signed() })).rejects.toThrow("GOVERNANCE_EXECUTION_NOT_RELEASED");
  });
});
