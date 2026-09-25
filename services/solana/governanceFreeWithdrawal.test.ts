import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { afterEach, describe, expect, it } from "vitest";
import { mstrxAta } from "./mstrxTransfers";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";
import { buildWithdrawFreeInstruction, reconcileFreeWithdrawal, withdrawFreeReserve, type FreeWithdrawalEnvironment } from "./governanceFreeWithdrawal";

const mint = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const program = Keypair.generate().publicKey.toBase58();
const adminKeypair = Keypair.generate();
const admin = adminKeypair.publicKey.toBase58();
const capital = Keypair.generate().publicKey.toBase58();
const route = deriveGovernanceReserveRoute(program, mint);
const codeHash = "a".repeat(64);
const temporary: string[] = [];

function environment(stateRoot: string): FreeWithdrawalEnvironment {
  return { rpcUrls: ["https://example.org/a", "https://example.org/b"], stateRoot,
    governanceProgram: program, expectedProgramCodeSha256: codeHash,
    reserveAuthority: route.authority.toBase58(), reserveMint: mint,
    capitalMint: capital, admin, adminKeypairPath: "unused-in-mock" };
}

function intent(amountRaw: string) {
  return { amountRaw, governanceProgram: program, programCodeSha256: codeHash,
    reserveMint: mint, reserveVault: route.ata.toBase58(), capitalMint: capital,
    adminAta: mstrxAta(new PublicKey(admin), route.mint).toBase58(),
    verifiedAt: Date.now() };
}

function preparedTransaction(env: FreeWithdrawalEnvironment, exact: ReturnType<typeof intent>) {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: adminKeypair.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(adminKeypair.publicKey, new PublicKey(exact.adminAta),
        adminKeypair.publicKey, route.mint, TOKEN_2022_PROGRAM_ID),
      buildWithdrawFreeInstruction(env, exact, []),
    ],
  }).compileToV0Message());
  transaction.sign([adminKeypair]);
  return { signature: bs58.encode(transaction.signatures[0]),
    transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    blockhash: transaction.message.recentBlockhash, lastValidBlockHeight: 100 };
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("governance free reserve withdrawal", () => {
  it("encodes an exact raw amount and fixed admin token-account destination", () => {
    const env = environment("unused");
    const exact = intent("700");
    const ix = buildWithdrawFreeInstruction(env, exact, []);
    expect(ix.programId.toBase58()).toBe(program);
    expect(ix.data.subarray(0, 8)).toEqual(createHash("sha256").update("global:withdraw_free").digest().subarray(0, 8));
    expect(ix.data.readBigUInt64LE(8)).toBe(700n);
    expect(ix.keys[2].pubkey.toBase58()).toBe(route.ata.toBase58());
    expect(ix.keys[3].pubkey.toBase58()).toBe(exact.adminAta);
    expect(() => buildWithdrawFreeInstruction(env, { ...exact, adminAta: Keypair.generate().publicKey.toBase58() }, [])).toThrow("RESERVE_WITHDRAWAL_ROUTE_MISMATCH");
  });

  it("never prepares an amount beyond independently verified free inventory", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-free-withdraw-")); temporary.push(stateRoot);
    let prepared = false;
    const effects = {
      verifiedFree: async () => 5n,
      prepare: async () => { prepared = true; throw new Error("SHOULD_NOT_PREPARE"); },
      broadcast: async () => undefined,
      transactionState: async () => "pending" as const,
    };
    await expect(withdrawFreeReserve(environment(stateRoot), { requestId: "1-aaaaaaaaaaaaaaaa", nonce: "a".repeat(40), intent: intent("6") }, effects))
      .rejects.toThrow("RESERVE_WITHDRAWAL_EXCEEDS_FREE");
    expect(prepared).toBe(false);
  });

  it("durably persists one signed transaction before send and only rebroadcasts identical bytes after a crash", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-free-withdraw-")); temporary.push(stateRoot);
    const env = environment(stateRoot);
    const prepared = preparedTransaction(env, intent("7"));
    let prepareCount = 0;
    let broadcastCount = 0;
    let chainState: "pending" | "finalized" = "pending";
    const effects = {
      verifiedFree: async () => 10n,
      prepare: async (exact: ReturnType<typeof intent>) => { prepareCount++; return prepareCount === 1 ? prepared : preparedTransaction(env, exact); },
      broadcast: async (transaction: typeof prepared) => {
        broadcastCount++;
        if (prepareCount === 1) expect(transaction.signature).toBe(prepared.signature);
        const persisted = JSON.parse(await readFile(join(stateRoot, "governance-free-withdrawal.json"), "utf8")) as { state: string; transaction: typeof prepared };
        expect(["prepared", "pending"]).toContain(persisted.state);
        expect(persisted.transaction).toEqual(transaction);
      },
      transactionState: async () => chainState,
    };
    const first = await withdrawFreeReserve(env, { requestId: "1-aaaaaaaaaaaaaaaa", nonce: "a".repeat(40), intent: intent("7") }, effects);
    expect(first.state).toBe("pending");
    expect(prepareCount).toBe(1);
    await reconcileFreeWithdrawal(env, effects);
    expect(broadcastCount).toBe(2);
    await expect(withdrawFreeReserve(env, { requestId: "2-bbbbbbbbbbbbbbbb", nonce: "b".repeat(40), intent: intent("2") }, effects))
      .rejects.toThrow("RESERVE_WITHDRAWAL_PENDING_RECONCILIATION");
    expect(prepareCount).toBe(1);
    chainState = "finalized";
    expect((await reconcileFreeWithdrawal(env, effects))?.state).toBe("finalized");
    await withdrawFreeReserve(env, { requestId: "2-bbbbbbbbbbbbbbbb", nonce: "b".repeat(40), intent: intent("2") }, effects);
    expect(prepareCount).toBe(2);
    const archived = JSON.parse(await readFile(join(stateRoot, "governance-free-withdrawal-history", `${"a".repeat(40)}.json`), "utf8")) as { state: string };
    expect(archived.state).toBe("finalized");
  });

  it("recovers a crash during first broadcast without signing a replacement", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-free-withdraw-")); temporary.push(stateRoot);
    const env = environment(stateRoot);
    const prepared = preparedTransaction(env, intent("3"));
    let preparedCount = 0;
    let sent = 0;
    const effects = {
      verifiedFree: async () => 10n,
      prepare: async () => { preparedCount++; return prepared; },
      broadcast: async () => { sent++; if (sent === 1) throw new Error("NETWORK_DISCONNECT_AFTER_SEND"); },
      transactionState: async () => "pending" as const,
    };
    await expect(withdrawFreeReserve(env, { requestId: "3-cccccccccccccccc", nonce: "c".repeat(40), intent: intent("3") }, effects))
      .rejects.toThrow("NETWORK_DISCONNECT_AFTER_SEND");
    const persisted = JSON.parse(await readFile(join(stateRoot, "governance-free-withdrawal.json"), "utf8")) as { state: string; transaction: typeof prepared };
    expect(persisted.state).toBe("prepared");
    expect(persisted.transaction).toEqual(prepared);
    expect((await reconcileFreeWithdrawal(env, effects))?.state).toBe("pending");
    expect(preparedCount).toBe(1);
    expect(sent).toBe(2);
  });

  it("rejects a persisted ledger whose intent no longer matches the actual admin-signed instruction", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-free-withdraw-")); temporary.push(stateRoot);
    const env = environment(stateRoot);
    const effects = {
      verifiedFree: async () => 10n,
      prepare: async (exact: ReturnType<typeof intent>) => preparedTransaction(env, exact),
      broadcast: async () => undefined,
      transactionState: async () => "pending" as const,
    };
    await withdrawFreeReserve(env, { requestId: "4-dddddddddddddddd", nonce: "d".repeat(40), intent: intent("3") }, effects);
    const path = join(stateRoot, "governance-free-withdrawal.json");
    const ledger = JSON.parse(await readFile(path, "utf8")) as { intent: { amountRaw: string }; transaction: { blockhash: string } };
    ledger.intent.amountRaw = "4";
    await writeFile(path, JSON.stringify(ledger), "utf8");
    await expect(reconcileFreeWithdrawal(env, effects)).rejects.toThrow("RESERVE_WITHDRAWAL_LEDGER_TRANSACTION_INVALID");
    ledger.intent.amountRaw = "3";
    ledger.transaction.blockhash = Keypair.generate().publicKey.toBase58();
    await writeFile(path, JSON.stringify(ledger), "utf8");
    await expect(reconcileFreeWithdrawal(env, effects)).rejects.toThrow("RESERVE_WITHDRAWAL_LEDGER_TRANSACTION_INVALID");
  });

  it("holds an inconclusive expired signature without signing another withdrawal", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-free-withdraw-")); temporary.push(stateRoot);
    const env = environment(stateRoot);
    let state: "pending" | "unresolved" | "finalized" = "pending";
    let preparedCount = 0;
    const effects = {
      verifiedFree: async () => 10n,
      prepare: async (exact: ReturnType<typeof intent>) => { preparedCount++; return preparedTransaction(env, exact); },
      broadcast: async () => undefined,
      transactionState: async () => state,
    };
    await withdrawFreeReserve(env, { requestId: "5-eeeeeeeeeeeeeeee", nonce: "e".repeat(40), intent: intent("4") }, effects);
    state = "unresolved";
    expect((await reconcileFreeWithdrawal(env, effects))?.state).toBe("unresolved");
    await expect(withdrawFreeReserve(env, { requestId: "6-ffffffffffffffff", nonce: "f".repeat(40), intent: intent("4") }, effects))
      .rejects.toThrow("RESERVE_WITHDRAWAL_UNRESOLVED_REVIEW_REQUIRED");
    expect(preparedCount).toBe(1);
    state = "finalized";
    expect((await reconcileFreeWithdrawal(env, effects))?.state).toBe("finalized");
  });
});
