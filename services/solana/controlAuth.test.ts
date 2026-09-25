import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  SOLANA_CONTROL_CHALLENGE_MS, SOLANA_CONTROL_NETWORK,
  solanaControlMessage, verifySignedSolanaControlAction,
  type SignedSolanaControlAction,
} from "./controlAuth";
import { MARKETING_SALE_POOL } from "./marketingSaleRoute";

const owner = Keypair.generate();
const now = Date.now();

function signedAction(overrides: Partial<Omit<SignedSolanaControlAction, "signature">> = {}) {
  const unsigned = {
    network: SOLANA_CONTROL_NETWORK,
    action: "disarm_launch_detection",
    signer: owner.publicKey.toBase58(),
    issuedAt: now,
    expiresAt: now + SOLANA_CONTROL_CHALLENGE_MS,
    nonce: "a".repeat(40),
    ...overrides,
  };
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(solanaControlMessage(unsigned)), owner.secretKey));
  return { ...unsigned, signature };
}

describe("signed Solana control requests", () => {
  it("accepts only the owner's exact action and five-minute challenge", () => {
    const signed = signedAction();
    expect(verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now)).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed, action: "pause_conversions" }, owner.publicKey.toBase58(), now)).toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed, signer: Keypair.generate().publicKey.toBase58() }, owner.publicKey.toBase58(), now)).toThrow("SIGNER_NOT_OWNER");
    expect(() => verifySignedSolanaControlAction({ ...signed, signature: "forged" }, owner.publicKey.toBase58(), now)).toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now + SOLANA_CONTROL_CHALLENGE_MS + 1)).toThrow("CONTROL_CHALLENGE_EXPIRED");
  });

  it("binds a free-reserve withdrawal to exact amount and fixed onchain identities", () => {
    const pubkey = () => Keypair.generate().publicKey.toBase58();
    const withdrawal = { amountRaw: "42", governanceProgram: pubkey(), programCodeSha256: "f".repeat(64),
      reserveMint: pubkey(), reserveVault: pubkey(), capitalMint: pubkey(), adminAta: pubkey(), verifiedAt: now };
    const signed = signedAction({ action: "withdraw_free_reserve", withdrawal });
    expect(verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now)).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed, withdrawal: { ...withdrawal, amountRaw: "43" } }, owner.publicKey.toBase58(), now))
      .toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed, withdrawal: { ...withdrawal, reserveVault: pubkey() } }, owner.publicKey.toBase58(), now))
      .toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed, withdrawal: { ...withdrawal, programCodeSha256: "e".repeat(64) } }, owner.publicKey.toBase58(), now))
      .toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed, withdrawal: { ...withdrawal, verifiedAt: now - 91_000 } }, owner.publicKey.toBase58(), now))
      .toThrow("RESERVE_WITHDRAWAL_QUOTE_STALE");
    expect(() => verifySignedSolanaControlAction({ ...signed, action: "pause_conversions" }, owner.publicKey.toBase58(), now))
      .toThrow("RESERVE_WITHDRAWAL_ACTION_INVALID");
  });

  it("binds snapshot publication to the exact next proposal and reviewed mint/program", () => {
    const pubkey = () => Keypair.generate().publicKey.toBase58();
    const snapshotPublication = { governanceProgram: pubkey(), programCodeSha256: "a".repeat(64),
      capitalMint: pubkey(), reserveMint: pubkey(), proposalId: "8", verifiedAt: now };
    const signed = signedAction({ action: "publish_snapshot", snapshotPublication });
    expect(verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now)).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed,
      snapshotPublication: { ...snapshotPublication, proposalId: "9" } }, owner.publicKey.toBase58(), now))
      .toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed,
      snapshotPublication: { ...snapshotPublication, verifiedAt: now - 91_000 } }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_SNAPSHOT_QUOTE_STALE");
    expect(() => verifySignedSolanaControlAction({ ...signed, action: "pause_conversions" }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_SNAPSHOT_ACTION_INVALID");
  });

  it("binds lock execution to the exact frozen proposal, term and escrow", () => {
    const program = Keypair.generate().publicKey;
    const reserveMint = Keypair.generate().publicKey;
    const capitalMint = Keypair.generate().publicKey;
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
    const id = Buffer.alloc(8); id.writeBigUInt64LE(4n);
    const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), id], program)[0];
    const lockRecord = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], program)[0];
    const lockExecution = {
      governanceProgram: program.toBase58(), programCodeSha256: "a".repeat(64),
      reserveMint: reserveMint.toBase58(),
      reserveVault: getAssociatedTokenAddressSync(reserveMint, config, true, TOKEN_2022_PROGRAM_ID).toBase58(),
      capitalMint: capitalMint.toBase58(), capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      config: config.toBase58(), proposalId: "4", proposal: proposal.toBase58(),
      lockRecord: lockRecord.toBase58(),
      lockVault: getAssociatedTokenAddressSync(reserveMint, lockRecord, true, TOKEN_2022_PROGRAM_ID).toBase58(),
      proposalStateSha256: "b".repeat(64), frozenReserveRawMstrx: "500", lockDurationSeconds: 30 * 86_400,
      executableAt: Math.floor(now / 1_000) - 60, verifiedAt: now,
    };
    const signed = signedAction({ action: "execute_lock_mstrx", lockExecution });
    expect(verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now)).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed,
      lockExecution: { ...lockExecution, frozenReserveRawMstrx: "501" } }, owner.publicKey.toBase58(), now))
      .toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed,
      lockExecution: { ...lockExecution, lockDurationSeconds: 90 * 86_400 } }, owner.publicKey.toBase58(), now))
      .toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed,
      lockExecution: { ...lockExecution, lockVault: Keypair.generate().publicKey.toBase58() } }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_LOCK_PDA_MISMATCH");
    expect(() => verifySignedSolanaControlAction({ ...signed, action: "pause_conversions" }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_LOCK_ACTION_INVALID");
  });

  it("binds marketing sale to the fixed pool, recipient and voted SOL floor", () => {
    const program = Keypair.generate().publicKey;
    const mint = new PublicKey(MARKETING_SALE_POOL.mstrxMint);
    const capitalMint = Keypair.generate().publicKey;
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
    const id = Buffer.alloc(8); id.writeBigUInt64LE(5n);
    const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), id], program)[0];
    const receipt = PublicKey.findProgramAddressSync([Buffer.from("marketing-sale-receipt"), proposal.toBuffer()], program)[0];
    const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], program)[0];
    const bitmap = PublicKey.findProgramAddressSync([Buffer.from("pool_tick_array_bitmap_extension"),
      new PublicKey(MARKETING_SALE_POOL.pool).toBuffer()], new PublicKey(MARKETING_SALE_POOL.program))[0];
    const marketingExecution = {
      governanceProgram: program.toBase58(), programCodeSha256: "a".repeat(64),
      reserveMint: mint.toBase58(),
      reserveVault: getAssociatedTokenAddressSync(mint, config, true, TOKEN_2022_PROGRAM_ID).toBase58(),
      capitalMint: capitalMint.toBase58(), capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      config: config.toBase58(), proposalId: "5", proposal: proposal.toBase58(),
      receipt: receipt.toBase58(), trader: trader.toBase58(), recipient: Keypair.generate().publicKey.toBase58(),
      proposalStateSha256: "b".repeat(64), frozenReserveRawMstrx: "500",
      votedMinSolLamports: "20", executionMinSolLamports: "20",
      pool: MARKETING_SALE_POOL.pool, bitmap: bitmap.toBase58(),
      tickArrayAddresses: [Keypair.generate().publicKey.toBase58()],
      executableAt: Math.floor(now / 1_000) - 60, verifiedAt: now,
    };
    const signed = signedAction({ action: "execute_marketing_sale", marketingExecution });
    expect(verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now)).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed,
      marketingExecution: { ...marketingExecution, votedMinSolLamports: "21" } }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_MARKETING_AMOUNT_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed,
      marketingExecution: { ...marketingExecution, recipient: Keypair.generate().publicKey.toBase58() } }, owner.publicKey.toBase58(), now))
      .toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed,
      marketingExecution: { ...marketingExecution, pool: Keypair.generate().publicKey.toBase58() } }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_MARKETING_IDENTITY_INVALID");
  });

  it("binds a matured lock release to its exact record, escrow balance and canonical reserve", () => {
    const governanceProgram = Keypair.generate().publicKey;
    const reserveMint = new PublicKey("XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ");
    const capitalMint = Keypair.generate().publicKey;
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], governanceProgram)[0];
    const proposalId = Buffer.alloc(8); proposalId.writeBigUInt64LE(7n);
    const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), proposalId], governanceProgram)[0];
    const lockRecord = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], governanceProgram)[0];
    const lockRelease = {
      governanceProgram: governanceProgram.toBase58(), programCodeSha256: "a".repeat(64),
      reserveMint: reserveMint.toBase58(),
      reserveVault: getAssociatedTokenAddressSync(reserveMint, config, true, TOKEN_2022_PROGRAM_ID).toBase58(),
      capitalMint: capitalMint.toBase58(), config: config.toBase58(), proposalId: "7", proposal: proposal.toBase58(),
      lockRecord: lockRecord.toBase58(),
      lockVault: getAssociatedTokenAddressSync(reserveMint, lockRecord, true, TOKEN_2022_PROGRAM_ID).toBase58(),
      proposalStateSha256: "b".repeat(64), lockRecordStateSha256: "c".repeat(64),
      recordCommittedRawMstrx: "100", observedEscrowRawMstrx: "110",
      releaseAt: Math.floor(now / 1_000) - 60, verifiedAt: now,
    };
    const signed = signedAction({ action: "release_lock_mstrx", lockRelease });
    const message = solanaControlMessage(signed);
    expect(message).toContain("Observed escrow raw MSTRx: 110");
    expect(message).toContain(`Canonical reserve vault: ${lockRelease.reserveVault}`);
    expect(verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now)).toBe(true);
    for (const modified of [
      { observedEscrowRawMstrx: "111" },
      { recordCommittedRawMstrx: "99" },
      { proposalStateSha256: "d".repeat(64) },
      { lockRecordStateSha256: "d".repeat(64) },
      { releaseAt: lockRelease.releaseAt - 60 },
      { programCodeSha256: "d".repeat(64) },
    ]) {
      expect(() => verifySignedSolanaControlAction({ ...signed,
        lockRelease: { ...lockRelease, ...modified } }, owner.publicKey.toBase58(), now))
        .toThrow("SIGNATURE_INVALID");
    }
    expect(() => verifySignedSolanaControlAction({ ...signed,
      lockRelease: { ...lockRelease, observedEscrowRawMstrx: "99" } }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_LOCK_RELEASE_INTENT_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed,
      lockRelease: { ...lockRelease, lockVault: Keypair.generate().publicKey.toBase58() } }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_LOCK_RELEASE_PDA_MISMATCH");
    expect(() => verifySignedSolanaControlAction({ ...signed,
      lockRelease: { ...lockRelease, reserveVault: Keypair.generate().publicKey.toBase58() } }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_LOCK_RELEASE_PDA_MISMATCH");
    expect(() => verifySignedSolanaControlAction({ ...signed, action: "pause_conversions" }, owner.publicKey.toBase58(), now))
      .toThrow("GOVERNANCE_LOCK_RELEASE_ACTION_INVALID");
    expect(() => solanaControlMessage({ ...signed, withdrawal: {
      amountRaw: "1", governanceProgram: lockRelease.governanceProgram,
      programCodeSha256: lockRelease.programCodeSha256, reserveMint: lockRelease.reserveMint,
      reserveVault: lockRelease.reserveVault, capitalMint: lockRelease.capitalMint,
      adminAta: owner.publicKey.toBase58(), verifiedAt: now,
    } })).toThrow("GOVERNANCE_LOCK_RELEASE_ACTION_INVALID");
  });

  describe("runner nonce ledger", () => {
    let temporary: string;
    let dispatch: typeof import("./controlRunner").dispatch;
    const prior = {
      owner: process.env.SOLANA_ADMIN_OWNER,
      state: process.env.SOLANA_STATE_ROOT,
      control: process.env.CONTROL_DATA_ROOT,
    };

    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), "flywheel-control-auth-"));
      process.env.SOLANA_ADMIN_OWNER = owner.publicKey.toBase58();
      process.env.SOLANA_STATE_ROOT = join(temporary, "solana");
      process.env.CONTROL_DATA_ROOT = join(temporary, "control");
      ({ dispatch } = await import("./controlRunner"));
    });

    afterAll(async () => {
      if (prior.owner === undefined) delete process.env.SOLANA_ADMIN_OWNER; else process.env.SOLANA_ADMIN_OWNER = prior.owner;
      if (prior.state === undefined) delete process.env.SOLANA_STATE_ROOT; else process.env.SOLANA_STATE_ROOT = prior.state;
      if (prior.control === undefined) delete process.env.CONTROL_DATA_ROOT; else process.env.CONTROL_DATA_ROOT = prior.control;
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });

    it("rejects forged queue files and consumes a valid nonce only once", async () => {
      const status = {
        network: SOLANA_CONTROL_NETWORK,
        automationState: "stopped" as const,
        launch: { configured: false, armed: false, activated: false },
        services: {}, balances: {}, conversionsPaused: false, updatedAt: 0,
      };
      const authorization = signedAction({ nonce: "b".repeat(40) });
      const request = { ...authorization, id: "test-request", requestedAt: now };
      await expect(dispatch({ ...request, signature: "not-a-signature" }, status)).rejects.toThrow("SIGNATURE_INVALID");
      await expect(dispatch(request, status)).resolves.toBeUndefined();
      await expect(dispatch(request, status)).rejects.toThrow("CONTROL_NONCE_REPLAY");
      const marker = JSON.parse(await readFile(join(temporary, "solana", "control-nonces", `${request.nonce}.json`), "utf8")) as { action: string };
      expect(marker.action).toBe("disarm_launch_detection");
    });

    it("keeps real reserve withdrawal disabled before reviewed governance release without consuming authorization", async () => {
      const pubkey = () => Keypair.generate().publicKey.toBase58();
      const withdrawal = { amountRaw: "12", governanceProgram: pubkey(), programCodeSha256: "a".repeat(64),
        reserveMint: pubkey(), reserveVault: pubkey(), capitalMint: pubkey(), adminAta: pubkey(), verifiedAt: now };
      const signed = signedAction({ action: "withdraw_free_reserve", nonce: "c".repeat(40), withdrawal });
      const status = { network: SOLANA_CONTROL_NETWORK, automationState: "stopped" as const,
        launch: { configured: false, armed: false, activated: false },
        services: {}, balances: {}, conversionsPaused: false, updatedAt: 0 };
      await expect(dispatch({ ...signed, id: "3-cccccccccccccccc", requestedAt: now }, status))
        .rejects.toThrow("RESERVE_WITHDRAWAL_NOT_RELEASED");
      await expect(readFile(join(temporary, "solana", "control-nonces", `${signed.nonce}.json`), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
