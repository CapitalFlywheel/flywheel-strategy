import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { governanceAddresses, governanceExecutionReceiptAddresses } from "../../apps/web/src/governanceClient";
import { BUYBACK_QUOTE_MINT, PUMP_BUYBACK_PROGRAM,
  PUMPSWAP_BUYBACK_PROGRAM, type BuybackVenueState } from "./pumpBuybackInstructionManifest";
import { governanceBuybackAddresses } from "./governanceBuybackVenue";
import { buildBuybackExecutionInstruction, assertExactSignedBuybackTransaction,
  executeBuybackDecision, reconcileBuybackExecution, type BuybackExecutionEffects,
  type BuybackExecutionEnvironment, type SignedBuybackExecution } from "./governanceBuybackExecutionControl";
import { validateBuybackExecutionIntent, type BuybackExecutionIntent } from "./governanceBuybackIntent";

const program = new PublicKey(new Uint8Array(32).fill(34));
const capital = new PublicKey(new Uint8Array(32).fill(35));
const creator = new PublicKey(new Uint8Array(32).fill(36));
const fee = new PublicKey(new Uint8Array(32).fill(37));
const signer = Keypair.generate();
const reserveMint = BUYBACK_QUOTE_MINT;
const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], program)[0];
const vault = getAssociatedTokenAddressSync(reserveMint, config, true, TOKEN_2022_PROGRAM_ID);
const route = governanceBuybackAddresses(capital, TOKEN_PROGRAM_ID);
const tempRoots: string[] = [];

function environment(stateRoot = "C:/unused"): BuybackExecutionEnvironment {
  return { rpcUrls: ["https://one.example", "https://two.example"], stateRoot,
    governanceProgram: program.toBase58(), expectedProgramCodeSha256: "a".repeat(64),
    reserveAuthority: config.toBase58(), reserveMint: reserveMint.toBase58(),
    capitalMint: capital.toBase58(), admin: signer.publicKey.toBase58(),
    adminKeypairPath: "C:/nonexistent-key.json" };
}

function venueState(phase: "curve" | "pumpSwap"): BuybackVenueState {
  return phase === "curve" ? {
    phase, bondingCurveAddress: route.curve.toBase58(),
    bondingCurveOwner: PUMP_BUYBACK_PROGRAM.toBase58(), complete: false,
    curveBaseMint: capital.toBase58(), curveQuoteMint: reserveMint.toBase58(),
    creator: creator.toBase58(), feeRecipient: fee.toBase58(),
    buybackFeeRecipient: fee.toBase58(),
  } : {
    phase, bondingCurveComplete: true, poolAddress: route.pool.toBase58(),
    poolOwner: PUMPSWAP_BUYBACK_PROGRAM.toBase58(), poolIndex: 0,
    poolCreator: route.poolAuthority.toBase58(), poolBaseMint: capital.toBase58(),
    poolQuoteMint: reserveMint.toBase58(), coinCreator: creator.toBase58(),
    protocolFeeRecipient: fee.toBase58(),
  };
}

function intent(phase: "curve" | "pumpSwap" = "curve",
  action: BuybackExecutionIntent["action"] = "BUYBACK_BURN"): BuybackExecutionIntent {
  const proposal = governanceAddresses(program, 1n).proposal;
  const receipt = governanceExecutionReceiptAddresses(program, proposal).buyback;
  return { governanceProgram: program.toBase58(), programCodeSha256: "a".repeat(64),
    reserveMint: reserveMint.toBase58(), reserveVault: vault.toBase58(),
    capitalMint: capital.toBase58(), capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    config: config.toBase58(), proposalId: "1", proposal: proposal.toBase58(),
    receipt: receipt.toBase58(), trader: trader.toBase58(), action,
    proposalStateSha256: "b".repeat(64), frozenReserveRawMstrx: "100000000",
    votedMinOutputRawCapital: "900000", lockDurationSeconds: action === "BUYBACK_LOCK" ? 30 * 86_400 : 0,
    executableAt: 1_780_000_000, venueState: venueState(phase), verifiedAt: Date.now() };
}

function signedTransaction(env: BuybackExecutionEnvironment, decision: BuybackExecutionIntent,
  extra: TransactionInstruction[] = []) {
  const instruction = buildBuybackExecutionInstruction(env, decision);
  const blockhash = new PublicKey(new Uint8Array(32).fill(91)).toBase58();
  const message = new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash,
    instructions: [instruction, ...extra] }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  return { signature: bs58.encode(tx.signatures[0]),
    transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
    blockhash, lastValidBlockHeight: 1000 };
}

function authorization(decision: BuybackExecutionIntent, nonce = "c".repeat(40)): SignedBuybackExecution {
  const issuedAt = Date.now();
  return { network: "solana-mainnet-beta", action: "execute_buyback",
    signer: signer.publicKey.toBase58(), issuedAt, expiresAt: issuedAt + 300_000,
    nonce, signature: "injected-test-verifier", buybackExecution: decision };
}

afterEach(async () => {
  for (const path of tempRoots.splice(0)) await rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("buyback execution: pinned vote, exact transaction, durable replay", () => {
  it("builds each winning action for either canonical phase using the voted floor only", () => {
    for (const phase of ["curve", "pumpSwap"] as const) {
      for (const action of ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK"] as const) {
        const decision = intent(phase, action);
        expect(() => validateBuybackExecutionIntent(decision, decision.verifiedAt)).not.toThrow();
        const ix = buildBuybackExecutionInstruction(environment(), decision);
        expect(ix.programId.toBase58()).toBe(program.toBase58());
        expect(ix.keys.find((meta) => meta.pubkey.equals(trader))).toBeTruthy();
        expect(ix.data.length).toBe(8); // No operator-supplied quote or mutable min.
        expect(ix.keys.length).toBe(18 + (phase === "curve" ? 27 : 23));
      }
    }
  });

  it("rejects zero or changed floor, forged phase, wrong PDA and extra fields", () => {
    const base = intent();
    expect(() => validateBuybackExecutionIntent({ ...base, votedMinOutputRawCapital: "0" }, base.verifiedAt))
      .toThrow("GOVERNANCE_BUYBACK_AMOUNT_INVALID");
    expect(() => validateBuybackExecutionIntent({ ...base, receipt: fee.toBase58() }, base.verifiedAt))
      .toThrow("GOVERNANCE_BUYBACK_PDA_MISMATCH");
    expect(() => validateBuybackExecutionIntent({ ...base,
      venueState: { ...base.venueState, phase: "pumpSwap" } as BuybackExecutionIntent["venueState"],
    }, base.verifiedAt)).toThrow();
    expect(() => validateBuybackExecutionIntent({ ...base, arbitrary: "x" } as BuybackExecutionIntent,
      base.verifiedAt)).toThrow("GOVERNANCE_BUYBACK_INTENT_FIELDS_INVALID");
  });

  it("accepts only the one exact owner-signed v0 instruction and account ordering", () => {
    const env = environment(); const decision = intent("pumpSwap", "BUYBACK_HOLD");
    const exact = signedTransaction(env, decision);
    expect(() => assertExactSignedBuybackTransaction(env, decision, exact)).not.toThrow();
    expect(() => assertExactSignedBuybackTransaction(env,
      { ...decision, venueState: { ...decision.venueState,
        protocolFeeRecipient: creator.toBase58() } as BuybackExecutionIntent["venueState"] }, exact))
      .toThrow("GOVERNANCE_BUYBACK_TRANSACTION_INVALID");
    const extra = new TransactionInstruction({ programId: SystemProgram.programId,
      keys: [], data: Buffer.alloc(0) });
    expect(() => assertExactSignedBuybackTransaction(env, decision,
      signedTransaction(env, decision, [extra]))).toThrow("GOVERNANCE_BUYBACK_TRANSACTION_INVALID");
  });

  it("persists signed bytes before broadcast and never prepares a second pending transaction", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-buyback-test-")); tempRoots.push(stateRoot);
    const env = environment(stateRoot); const decision = intent();
    const prepare = vi.fn(async () => signedTransaction(env, decision));
    const broadcast = vi.fn(async () => undefined);
    const effects: BuybackExecutionEffects = { audit: async () => decision,
      verifyAuthorization: (auth) => validateBuybackExecutionIntent(auth.buybackExecution, auth.issuedAt),
      prepare, broadcast, transactionState: async () => "pending" };
    const auth = authorization(decision);
    const first = await executeBuybackDecision(env,
      { requestId: "1-0123456789abcdef", authorization: auth }, effects);
    expect(first.state).toBe("pending");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await expect(executeBuybackDecision(env,
      { requestId: "2-0123456789abcdef", authorization: auth }, effects))
      .rejects.toThrow("GOVERNANCE_BUYBACK_PENDING_RECONCILIATION");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(2); // Same stored bytes only.
    const persisted = await reconcileBuybackExecution(env, effects);
    expect(persisted?.transaction.signature).toBe(first.transaction.signature);
  });

  it("keeps a terminal failed ledger readable after historical RPC signatures disappear", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-buyback-terminal-")); tempRoots.push(stateRoot);
    const env = environment(stateRoot); const decision = intent();
    const transactionState = vi.fn<BuybackExecutionEffects["transactionState"]>()
      .mockResolvedValueOnce("failed")
      .mockRejectedValue(new Error("HISTORICAL_SIGNATURE_PRUNED"));
    const effects: BuybackExecutionEffects = {
      audit: async () => decision,
      verifyAuthorization: (auth) => validateBuybackExecutionIntent(auth.buybackExecution, auth.issuedAt),
      prepare: async () => signedTransaction(env, decision), broadcast: async () => undefined,
      transactionState,
    };
    await executeBuybackDecision(env,
      { requestId: "1-0123456789abcdef", authorization: authorization(decision) }, effects);
    expect((await reconcileBuybackExecution(env, effects))?.state).toBe("failed");
    expect((await reconcileBuybackExecution(env, effects))?.state).toBe("failed");
    expect(transactionState).toHaveBeenCalledTimes(1);
  });

  it("fails production entry while the global execution release gate is false", async () => {
    await expect(executeBuybackDecision(environment(), {
      requestId: "1-0123456789abcdef", authorization: authorization(intent()),
    })).rejects.toThrow("GOVERNANCE_EXECUTION_NOT_RELEASED");
  });
});
