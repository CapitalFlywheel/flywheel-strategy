import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";
import {
  buildLockReleaseInstruction, lockReleaseMessage, reconcileLockRelease,
  releaseMatureMstrxLock, validateLockReleaseIntent, verifySignedLockRelease,
  type LockReleaseEnvironment, type LockReleaseIntent, type SignedLockRelease,
} from "./governanceLockReleaseControl";

const program = Keypair.generate().publicKey;
const admin = Keypair.generate();
const reserveMint = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const capitalMint = Keypair.generate().publicKey.toBase58();
const folders: string[] = [];

function environment(stateRoot = "unused"): LockReleaseEnvironment {
  return {
    rpcUrls: ["https://provider-one.invalid", "https://provider-two.invalid"], stateRoot,
    governanceProgram: program.toBase58(), expectedProgramCodeSha256: "a".repeat(64),
    reserveAuthority: deriveGovernanceReserveRoute(program.toBase58(), reserveMint).authority.toBase58(),
    reserveMint, capitalMint, admin: admin.publicKey.toBase58(), adminKeypairPath: "unused-in-mock",
  };
}

function intent(now = Date.now()): LockReleaseIntent {
  const derived = deriveGovernanceReserveRoute(program.toBase58(), reserveMint);
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(7n);
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program)[0];
  const record = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], program)[0];
  const escrow = PublicKey.findProgramAddressSync([
    record.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), derived.mint.toBuffer(),
  ], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
  return {
    governanceProgram: program.toBase58(), programCodeSha256: "a".repeat(64),
    reserveMint, reserveVault: derived.ata.toBase58(), capitalMint,
    config: derived.authority.toBase58(), proposalId: "7", proposal: proposal.toBase58(),
    lockRecord: record.toBase58(), lockVault: escrow.toBase58(),
    proposalStateSha256: "b".repeat(64), lockRecordStateSha256: "c".repeat(64),
    recordCommittedRawMstrx: "1000", observedEscrowRawMstrx: "1005",
    releaseAt: 1_700_000_000, verifiedAt: now,
  };
}

function signed(exact = intent(), nonce = "a".repeat(40)): SignedLockRelease {
  const issuedAt = Date.now();
  const payload = {
    network: "solana-mainnet-beta" as const, action: "release_lock_mstrx" as const,
    signer: admin.publicKey.toBase58(), issuedAt, expiresAt: issuedAt + 300_000,
    nonce, lockRelease: exact,
  };
  return { ...payload, signature: bs58.encode(nacl.sign.detached(
    new TextEncoder().encode(lockReleaseMessage(payload)), admin.secretKey,
  )) };
}

function prepared(environment: LockReleaseEnvironment, exact: LockReleaseIntent) {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [buildLockReleaseInstruction(environment, exact)],
  }).compileToV0Message());
  transaction.sign([admin]);
  return { signature: bs58.encode(transaction.signatures[0]),
    transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    blockhash: transaction.message.recentBlockhash, lastValidBlockHeight: 100 };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("mature MSTRx lock release to canonical reserve", () => {
  it("pins the Anchor discriminator and exact account vector without a selectable recipient", () => {
    const env = environment();
    const exact = intent();
    const ix = buildLockReleaseInstruction(env, exact);
    expect(ix.data).toEqual(createHash("sha256").update("global:release_lock_mstrx").digest().subarray(0, 8));
    expect(ix.keys.map((key) => [key.pubkey.toBase58(), key.isWritable, key.isSigner])).toEqual([
      [exact.config, false, false], [exact.lockRecord, true, false],
      [reserveMint, false, false], [exact.reserveVault, true, false],
      [exact.lockVault, true, false], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
    ]);
    expect(() => buildLockReleaseInstruction(env, { ...exact,
      reserveVault: Keypair.generate().publicKey.toBase58() })).toThrow("GOVERNANCE_LOCK_RELEASE_PDA_MISMATCH");
    expect(() => validateLockReleaseIntent({ ...exact,
      observedEscrowRawMstrx: "999" }, exact.verifiedAt)).toThrow("GOVERNANCE_LOCK_RELEASE_INTENT_INVALID");
  });

  it("binds owner approval to the historical lock, record hash and observed escrow", () => {
    const authorization = signed();
    expect(verifySignedLockRelease(authorization, admin.publicKey.toBase58())).toBe(true);
    for (const changed of [
      { ...authorization.lockRelease, lockRecordStateSha256: "d".repeat(64) },
      { ...authorization.lockRelease, observedEscrowRawMstrx: "1010" },
      { ...authorization.lockRelease, proposalId: "8" },
    ]) {
      expect(() => verifySignedLockRelease({ ...authorization, lockRelease: changed },
        admin.publicKey.toBase58())).toThrow();
    }
    expect(() => verifySignedLockRelease({ ...authorization, signer: Keypair.generate().publicKey.toBase58() },
      admin.publicKey.toBase58())).toThrow("GOVERNANCE_LOCK_RELEASE_AUTH_INVALID");
    expect(authorization.signature.length).toBeGreaterThan(0);
  });

  it("persists an exact signed tx before broadcast, reconciles it and blocks a duplicate release", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-release-"));
    folders.push(stateRoot);
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
        const persisted = JSON.parse(await readFile(join(stateRoot, "governance-lock-release.json"), "utf8")) as {
          transaction: typeof tx; state: string;
        };
        expect(persisted.transaction).toEqual(value);
        expect(persisted.state).toMatch(/^(prepared|pending)$/);
      },
      transactionState: async () => chainState,
    };
    const first = await releaseMatureMstrxLock(env, { requestId: "1-aaaaaaaaaaaaaaaa", authorization }, effects);
    expect(first.state).toBe("pending");
    await reconcileLockRelease(env, effects);
    expect(broadcasts).toBe(2);
    await expect(releaseMatureMstrxLock(env, {
      requestId: "2-bbbbbbbbbbbbbbbb", authorization: signed(exact, "b".repeat(40)),
    }, effects)).rejects.toThrow("GOVERNANCE_LOCK_RELEASE_PENDING_RECONCILIATION");
    expect(prepares).toBe(1);
    chainState = "finalized";
    expect((await reconcileLockRelease(env, effects))?.state).toBe("finalized");
    // Old RPC signature history can disappear after finalization.
    effects.transactionState = async () => { throw new Error("HISTORICAL_SIGNATURE_UNAVAILABLE"); };
    expect((await reconcileLockRelease(env, effects))?.state).toBe("finalized");
    await expect(releaseMatureMstrxLock(env, {
      requestId: "3-cccccccccccccccc", authorization: signed(exact, "c".repeat(40)),
    }, effects)).rejects.toThrow("GOVERNANCE_LOCK_RELEASE_REPLAY");
  });

  it("fails closed when a fresh escrow observation changed and when expiry is unresolved", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-release-"));
    folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const tx = prepared(env, exact);
    let chainState: "pending" | "unresolved" = "pending";
    const effects = {
      audit: async () => ({ ...exact, observedEscrowRawMstrx: "1006", verifiedAt: Date.now() }),
      prepare: async () => tx, broadcast: async () => undefined,
      transactionState: async () => chainState,
    };
    await expect(releaseMatureMstrxLock(env, {
      requestId: "4-dddddddddddddddd", authorization: signed(exact, "d".repeat(40)),
    }, effects)).rejects.toThrow("GOVERNANCE_LOCK_RELEASE_PREVIEW_CHANGED");
    effects.audit = async () => ({ ...exact, verifiedAt: Date.now() });
    await releaseMatureMstrxLock(env, {
      requestId: "5-eeeeeeeeeeeeeeee", authorization: signed(exact, "e".repeat(40)),
    }, effects);
    chainState = "unresolved";
    expect((await reconcileLockRelease(env, effects))?.state).toBe("unresolved");
    await expect(releaseMatureMstrxLock(env, {
      requestId: "6-ffffffffffffffff", authorization: signed(exact, "f".repeat(40)),
    }, effects)).rejects.toThrow("GOVERNANCE_LOCK_RELEASE_UNRESOLVED_REVIEW_REQUIRED");
  });

  it("rejects tampered durable bytes even if the hash is recomputed", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-release-"));
    folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const effects = {
      audit: async () => ({ ...exact, verifiedAt: Date.now() }),
      prepare: async () => prepared(env, exact), broadcast: async () => undefined,
      transactionState: async () => "pending" as const,
    };
    await releaseMatureMstrxLock(env, {
      requestId: "8-aaaaaaaaaaaaaaaa", authorization: signed(exact),
    }, effects);
    const path = join(stateRoot, "governance-lock-release.json");
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
    await expect(reconcileLockRelease(env, effects)).rejects.toThrow("GOVERNANCE_LOCK_RELEASE_TRANSACTION_INVALID");
  });

  it("keeps the production path gated without RPC or key reads", async () => {
    await expect(releaseMatureMstrxLock(environment(), {
      requestId: "7-aaaaaaaaaaaaaaaa", authorization: signed(),
    })).rejects.toThrow("GOVERNANCE_EXECUTION_NOT_RELEASED");
  });
});
