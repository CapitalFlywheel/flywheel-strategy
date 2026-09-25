import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import { solanaControlMessage, type MarketingExecutionIntent } from "./controlAuth";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";
import { MARKETING_SALE_POOL } from "./marketingSaleRoute";
import { buildMarketingExecutionInstruction, executeMarketingDecision, reconcileMarketingExecution,
  requireFallbackMarketingSimulation, verifySignedMarketingExecution, type MarketingExecutionEnvironment,
  type SignedMarketingExecution } from "./governanceMarketingExecutionControl";

const program = Keypair.generate().publicKey;
const admin = Keypair.generate();
const reserveMint = MARKETING_SALE_POOL.mstrxMint;
const capitalMint = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const folders: string[] = [];

function environment(stateRoot = "unused"): MarketingExecutionEnvironment {
  return {
    rpcUrls: ["https://provider-one.invalid", "https://provider-two.invalid"], stateRoot,
    governanceProgram: program.toBase58(), expectedProgramCodeSha256: "a".repeat(64),
    reserveAuthority: deriveGovernanceReserveRoute(program.toBase58(), reserveMint).authority.toBase58(),
    reserveMint, capitalMint, admin: admin.publicKey.toBase58(), adminKeypairPath: "unused-in-mock",
  };
}

function intent(now = Date.now()): MarketingExecutionIntent {
  const route = deriveGovernanceReserveRoute(program.toBase58(), reserveMint);
  const seed = Buffer.alloc(8); seed.writeBigUInt64LE(7n);
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program)[0];
  const receipt = PublicKey.findProgramAddressSync([
    Buffer.from("marketing-sale-receipt"), proposal.toBuffer(),
  ], program)[0];
  const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], program)[0];
  const pool = new PublicKey(MARKETING_SALE_POOL.pool);
  const venue = new PublicKey(MARKETING_SALE_POOL.program);
  const bitmap = PublicKey.findProgramAddressSync([
    Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer(),
  ], venue)[0];
  const tickSeed = Buffer.alloc(4); tickSeed.writeInt32BE(0);
  const tick = PublicKey.findProgramAddressSync([
    Buffer.from("tick_array"), pool.toBuffer(), tickSeed,
  ], venue)[0];
  return {
    governanceProgram: program.toBase58(), programCodeSha256: "a".repeat(64),
    reserveMint, reserveVault: route.ata.toBase58(), capitalMint,
    capitalTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), config: route.authority.toBase58(),
    proposalId: "7", proposal: proposal.toBase58(), receipt: receipt.toBase58(),
    trader: trader.toBase58(), recipient, proposalStateSha256: "b".repeat(64),
    frozenReserveRawMstrx: "1000", votedMinSolLamports: "40", executionMinSolLamports: "50",
    pool: MARKETING_SALE_POOL.pool, bitmap: bitmap.toBase58(), tickArrayAddresses: [tick.toBase58()],
    executableAt: 1_700_000_000, verifiedAt: now,
  };
}

function signed(exact = intent(), nonce = "a".repeat(40)): SignedMarketingExecution {
  const issuedAt = Date.now();
  const payload = { network: "solana-mainnet-beta" as const, action: "execute_marketing_sale" as const,
    signer: admin.publicKey.toBase58(), issuedAt, expiresAt: issuedAt + 300_000,
    nonce, marketingExecution: exact };
  return { ...payload, signature: bs58.encode(nacl.sign.detached(
    new TextEncoder().encode(solanaControlMessage(payload)), admin.secretKey,
  )) };
}

function prepared(env: MarketingExecutionEnvironment, exact: MarketingExecutionIntent) {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [buildMarketingExecutionInstruction(env, exact)],
  }).compileToV0Message());
  tx.sign([admin]);
  return { signature: bs58.encode(tx.signatures[0]),
    transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
    blockhash: tx.message.recentBlockhash, lastValidBlockHeight: 100 };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("exact owner-controlled MSTRx marketing sale", () => {
  it("simulates the exact primary-signed bytes on fallback and aborts on fallback failure", async () => {
    const tx = prepared(environment(), intent());
    let called = 0;
    const fallback = {
      simulateTransaction: async (received: VersionedTransaction, options: {
        commitment: string; sigVerify: boolean;
      }) => {
        called++;
        expect(Buffer.from(received.serialize()).toString("base64")).toBe(tx.transactionBase64);
        expect(options).toEqual({ commitment: "confirmed", sigVerify: true });
        return { value: { err: null } };
      },
    } as unknown as Pick<Connection, "simulateTransaction">;
    await requireFallbackMarketingSimulation(fallback, tx);
    expect(called).toBe(1);
    const rejected = { simulateTransaction: async () => ({ value: { err: { InstructionError: [0, "Custom"] } } }),
    } as unknown as Pick<Connection, "simulateTransaction">;
    await expect(requireFallbackMarketingSimulation(rejected, tx))
      .rejects.toThrow("GOVERNANCE_MARKETING_FALLBACK_SIMULATION_FAILED");
    await expect(requireFallbackMarketingSimulation(fallback, { ...tx, signature: "wrong" }))
      .rejects.toThrow("GOVERNANCE_MARKETING_FALLBACK_TRANSACTION_INVALID");
    expect(called).toBe(1);
  });

  it("pins the outer ABI, fixed recipient, bitmap, ordered ticks and owner signer", () => {
    const env = environment();
    const exact = intent();
    const ix = buildMarketingExecutionInstruction(env, exact);
    expect(ix.data.subarray(0, 8)).toEqual(createHash("sha256")
      .update("global:execute_marketing_sale").digest().subarray(0, 8));
    expect(ix.data.readBigUInt64LE(8)).toBe(50n);
    expect(ix.keys.length).toBe(24);
    expect(ix.keys[0].pubkey.toBase58()).toBe(exact.config);
    expect(ix.keys[2].pubkey.toBase58()).toBe(exact.receipt);
    expect(ix.keys[8].pubkey.toBase58()).toBe(recipient);
    expect(ix.keys[16].pubkey.toBase58()).toBe(exact.bitmap);
    expect(ix.keys[18].pubkey.toBase58()).toBe(env.admin);
    expect(ix.keys[18].isSigner).toBe(true);
    expect(ix.keys[23].pubkey.toBase58()).toBe(exact.tickArrayAddresses[0]);
    expect(ix.keys.filter((account) => account.isSigner).length).toBe(1);
    expect(() => buildMarketingExecutionInstruction(env,
      { ...exact, executionMinSolLamports: "39" })).toThrow("GOVERNANCE_MARKETING_AMOUNT_INVALID");
    expect(() => buildMarketingExecutionInstruction(env,
      { ...exact, bitmap: Keypair.generate().publicKey.toBase58() })).toThrow("GOVERNANCE_MARKETING_PDA_MISMATCH");
  });

  it("requires an owner signature binding amounts, recipient, proposal hash and venue", () => {
    const authorization = signed();
    expect(verifySignedMarketingExecution(authorization, admin.publicKey.toBase58())).toBe(true);
    for (const changed of [
      { ...authorization.marketingExecution, frozenReserveRawMstrx: "1001" },
      { ...authorization.marketingExecution, executionMinSolLamports: "60" },
      { ...authorization.marketingExecution, recipient: Keypair.generate().publicKey.toBase58() },
      { ...authorization.marketingExecution, proposalStateSha256: "c".repeat(64) },
    ]) {
      expect(() => verifySignedMarketingExecution({ ...authorization, marketingExecution: changed },
        admin.publicKey.toBase58())).toThrow("SIGNATURE_INVALID");
    }
  });

  it("durably persists the exact signed transaction before first broadcast and blocks pending replay", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-marketing-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const auth = signed(exact);
    const tx = prepared(env, exact);
    let broadcasts = 0;
    let prepares = 0;
    let state: "pending" | "finalized" = "pending";
    const effects = {
      audit: async () => ({ ...exact, verifiedAt: Date.now() }),
      prepare: async () => { prepares++; return tx; },
      broadcast: async (value: typeof tx) => {
        broadcasts++;
        const saved = JSON.parse(await readFile(join(stateRoot, "governance-marketing-execution.json"), "utf8"));
        expect(saved.transaction).toEqual(value);
        expect(saved.state).toMatch(/^(prepared|pending)$/);
      },
      transactionState: async () => state,
    };
    const first = await executeMarketingDecision(env, { requestId: "1-aaaaaaaaaaaaaaaa", authorization: auth }, effects);
    expect(first.state).toBe("pending");
    await reconcileMarketingExecution(env, effects);
    expect(broadcasts).toBe(2);
    await expect(executeMarketingDecision(env, { requestId: "2-bbbbbbbbbbbbbbbb",
      authorization: signed(exact, "b".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_MARKETING_PENDING_RECONCILIATION");
    expect(prepares).toBe(1);
    state = "finalized";
    expect((await reconcileMarketingExecution(env, effects))?.state).toBe("finalized");
    await expect(executeMarketingDecision(env, { requestId: "3-cccccccccccccccc",
      authorization: signed(exact, "c".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_MARKETING_REPLAY");
  });

  it("fails on changed proposal, unresolved expiry and tampered durable intent", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-marketing-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const tx = prepared(env, exact);
    let state: "pending" | "unresolved" = "pending";
    const effects = {
      audit: async () => ({ ...exact, votedMinSolLamports: "41", verifiedAt: Date.now() }),
      prepare: async () => tx,
      broadcast: async () => undefined,
      transactionState: async () => state,
    };
    await expect(executeMarketingDecision(env, { requestId: "4-dddddddddddddddd",
      authorization: signed(exact, "d".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_MARKETING_PREVIEW_CHANGED");
    effects.audit = async () => ({ ...exact, verifiedAt: Date.now() });
    await executeMarketingDecision(env, { requestId: "5-eeeeeeeeeeeeeeee",
      authorization: signed(exact, "e".repeat(40)) }, effects);
    state = "unresolved";
    expect((await reconcileMarketingExecution(env, effects))?.state).toBe("unresolved");
    await expect(executeMarketingDecision(env, { requestId: "6-ffffffffffffffff",
      authorization: signed(exact, "f".repeat(40)) }, effects))
      .rejects.toThrow("GOVERNANCE_MARKETING_UNRESOLVED_REVIEW_REQUIRED");
    const path = join(stateRoot, "governance-marketing-execution.json");
    const ledger = JSON.parse(await readFile(path, "utf8"));
    ledger.authorization.marketingExecution.frozenReserveRawMstrx = "9999";
    await writeFile(path, JSON.stringify(ledger), "utf8");
    await expect(reconcileMarketingExecution(env, effects)).rejects.toThrow("SIGNATURE_INVALID");
  });

  it("rejects a substitute owner-signed transaction even if a ledger hash is recomputed", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-marketing-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    const effects = {
      audit: async () => ({ ...exact, verifiedAt: Date.now() }),
      prepare: async () => prepared(env, exact), broadcast: async () => undefined,
      transactionState: async () => "pending" as const,
    };
    await executeMarketingDecision(env, { requestId: "8-aaaaaaaaaaaaaaaa", authorization: signed(exact) }, effects);
    const path = join(stateRoot, "governance-marketing-execution.json");
    const ledger = JSON.parse(await readFile(path, "utf8"));
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
    await expect(reconcileMarketingExecution(env, effects)).rejects.toThrow("GOVERNANCE_MARKETING_TRANSACTION_INVALID");
  });

  it("permits retry only after finalized failure and keeps production source-gated", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-marketing-")); folders.push(stateRoot);
    const env = environment(stateRoot);
    const exact = intent();
    let state: "pending" | "failed" = "pending";
    const effects = {
      audit: async () => ({ ...exact, verifiedAt: Date.now() }),
      prepare: async () => prepared(env, exact), broadcast: async () => undefined,
      transactionState: async () => state,
    };
    await executeMarketingDecision(env, { requestId: "9-aaaaaaaaaaaaaaaa", authorization: signed(exact) }, effects);
    state = "failed";
    expect((await reconcileMarketingExecution(env, effects))?.state).toBe("failed");
    effects.transactionState = async () => { throw new Error("HISTORICAL_SIGNATURE_UNAVAILABLE"); };
    const retry = await executeMarketingDecision(env, { requestId: "10-bbbbbbbbbbbbbbbb",
      authorization: signed(exact, "b".repeat(40)) }, effects);
    expect(retry.state).toBe("pending");
    await expect(executeMarketingDecision(environment(), { requestId: "11-cccccccccccccccc",
      authorization: signed() })).rejects.toThrow("GOVERNANCE_EXECUTION_NOT_RELEASED");
  });
});
