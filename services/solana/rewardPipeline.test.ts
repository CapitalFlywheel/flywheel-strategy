import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, unpackAccount, type Mint } from "@solana/spl-token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRewardEpochPlan, owedEscrowSeed, type FinalizedHolderJournal } from "./epochPlanner";
import { OWED_ESCROW_RELEASED, assertHolderJournalReady, assertOwedEscrowAccountUsable, assertOwedEscrowReleased, assertRewardLaunchBinding, assertRewardMintCanPush, classifyRewardSimulations, finalizeRewardEpoch, loadCurrentRewardPlan, owedRetryTime, requiredOperatorPayoutLamports, retryOwedRewardPayments, rewardEpochConservation, rewardMintSafetySnapshot, submittedBatchRetryDecision, type RewardPipelineEnvironment } from "./rewardPipeline";
import { mstrxAta } from "./mstrxTransfers";
import { readAgreedFinalizedTransaction } from "./finalizedTransfers";
import { finalizedConsensus } from "./rpcConsensus";

vi.mock("./finalizedTransfers", async (importOriginal) => ({
  ...await importOriginal<typeof import("./finalizedTransfers")>(),
  readAgreedFinalizedTransaction: vi.fn(),
}));

vi.mock("@solana/spl-token", async (importOriginal) => ({
  ...await importOriginal<typeof import("@solana/spl-token")>(),
  unpackAccount: vi.fn(),
}));

vi.mock("./rpcConsensus", async (importOriginal) => ({
  ...await importOriginal<typeof import("./rpcConsensus")>(),
  finalizedConsensus: vi.fn(),
}));

const journal: FinalizedHolderJournal = {
  version: 3,
  epochId: "2",
  capitalMint: "test-mint",
  launchSignature: "launch-tx",
  windowStart: 1_000,
  windowEnd: 4_600,
  finalizedThroughSlot: 100,
  finalizedBlockhash: "test-blockhash",
  coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 2, throughSlot: 100, throughBlockhash: "test-blockhash" },
  transfers: [],
};
const heartbeat = { service: "solana-holder-indexer", ok: true, updatedAt: 5_000_000 };
const previous = { epochId: "1", windowEnd: 1_000, finalized: true };

function ready(overrides: Partial<Parameters<typeof assertHolderJournalReady>[0]> = {}) {
  return () => assertHolderJournalReady({
    journal, previous, heartbeat, latestFinalizedTime: 5_200, nowMs: 5_050_000,
    ...overrides,
  });
}

describe("holder journal payout gate", () => {
  it("accepts a fresh indexed epoch after a finalized predecessor", () => {
    expect(ready()).not.toThrow();
  });

  it("rejects an old or unhealthy indexer heartbeat", () => {
    expect(ready({ heartbeat: { ...heartbeat, ok: false } })).toThrow("HOLDER_INDEXER_UNHEALTHY");
    expect(ready({ heartbeat: { ...heartbeat, updatedAt: 4_000_000 } })).toThrow("HOLDER_INDEXER_UNHEALTHY");
    expect(ready({ heartbeat: { ...heartbeat, updatedAt: 6_000_000 } })).toThrow("HOLDER_INDEXER_UNHEALTHY");
  });

  it("rejects a stale or future-dated holder window", () => {
    expect(ready({ latestFinalizedTime: 6_401 })).toThrow("HOLDER_JOURNAL_STALE");
    expect(ready({ latestFinalizedTime: 4_599 })).toThrow("HOLDER_JOURNAL_STALE");
  });

  it("rejects replay of a paid epoch and a gap in epoch windows", () => {
    expect(ready({ journal: { ...journal, epochId: "1" } })).toThrow("HOLDER_JOURNAL_EPOCH_NOT_ADVANCED");
    expect(ready({ journal: { ...journal, windowStart: 1_001 } })).toThrow("HOLDER_JOURNAL_EPOCH_NOT_ADVANCED");
    expect(ready({ previous: { ...previous, finalized: false } })).toThrow("HOLDER_JOURNAL_EPOCH_NOT_ADVANCED");
  });

  it("rejects vendor-only v1/v2 journals and incomplete full-block provenance", () => {
    for (const version of [1, 2]) {
      expect(ready({ journal: { ...journal, version } as unknown as FinalizedHolderJournal }))
        .toThrow("HOLDER_JOURNAL_VERSION_UNSUPPORTED");
    }
    expect(ready({ journal: { ...journal, coverage: { ...journal.coverage, throughSlot: 99 } } }))
      .toThrow("HOLDER_FULL_BLOCK_COVERAGE_INVALID");
  });

  it("binds the full-block scan to the independently published launch identity", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const subject = { capitalMint: mint, launchSignature: "launch-tx", coverage: journal.coverage };
    const config = { network: "solana-mainnet-beta", projectMint: mint, launchedAtSlot: 2, launchedAtSignature: "launch-tx" };
    expect(assertRewardLaunchBinding(subject, config)).toBe(true);
    expect(() => assertRewardLaunchBinding(subject, { ...config, launchedAtSlot: 3 })).toThrow("REWARD_LAUNCH_BINDING_MISMATCH");
    expect(() => assertRewardLaunchBinding(subject, { ...config, launchedAtSignature: "other" })).toThrow("REWARD_LAUNCH_BINDING_MISMATCH");
    expect(() => assertRewardLaunchBinding(subject, { ...config, projectMint: Keypair.generate().publicKey.toBase58() })).toThrow("REWARD_LAUNCH_BINDING_MISMATCH");
  });
});

describe("durable Solana payout reconciliation", () => {
  it("isolates a simulation rejection only when two independent providers agree on the same instruction failure", () => {
    expect(classifyRewardSimulations([null, null])).toBe("accepted");
    expect(classifyRewardSimulations([
      { InstructionError: [1, { Custom: 42 }] }, { InstructionError: [1, { Custom: 42 }] },
    ])).toBe("rejected");
    expect(() => classifyRewardSimulations([null, { InstructionError: [1, { Custom: 42 }] }]))
      .toThrow("REWARD_SIMULATION_UNCERTAIN");
    expect(() => classifyRewardSimulations([{ InstructionError: [1, { Custom: 42 }] }, { InstructionError: [1, { Custom: 43 }] }]))
      .toThrow("REWARD_SIMULATION_UNCERTAIN");
    expect(() => classifyRewardSimulations(["BlockhashNotFound", "BlockhashNotFound"]))
      .toThrow("REWARD_SIMULATION_UNCERTAIN");
  });

  it("rebroadcasts only the exact persisted signed transaction while both providers are within validity", () => {
    expect(submittedBatchRetryDecision({ statuses: [null, null], finalizedHeights: [100, 100], lastValidBlockHeight: 101 }))
      .toBe("rebroadcast-same-transaction");
    expect(submittedBatchRetryDecision({ statuses: [null, null], finalizedHeights: [100, 102], lastValidBlockHeight: 101 }))
      .toBe("wait-for-finality");
  });

  it("does not treat two missing post-expiry RPC statuses as proof of non-execution", () => {
    expect(() => submittedBatchRetryDecision({ statuses: [null, null], finalizedHeights: [134, 134], lastValidBlockHeight: 101 }))
      .toThrow("REWARD_BATCH_OUTCOME_UNPROVEN");
    expect(() => submittedBatchRetryDecision({ statuses: [{ err: null }, null], finalizedHeights: [134, 134], lastValidBlockHeight: 101 }))
      .toThrow("REWARD_BATCH_OUTCOME_UNPROVEN");
  });

  it("fails closed on an observed onchain error or malformed independent evidence", () => {
    expect(() => submittedBatchRetryDecision({ statuses: [{ err: { InstructionError: [0, "Custom"] } }, null], finalizedHeights: [100, 100], lastValidBlockHeight: 101 }))
      .toThrow("REWARD_BATCH_ONCHAIN_FAILURE");
    expect(() => submittedBatchRetryDecision({ statuses: [null], finalizedHeights: [100, 100], lastValidBlockHeight: 101 }))
      .toThrow("REWARD_BATCH_RPC_EVIDENCE_INVALID");
  });
});

describe("owed escrow conservation", () => {
  it("keeps new isolated payouts disabled until the Token-2022 release gate is explicitly reviewed", () => {
    expect(OWED_ESCROW_RELEASED).toBe(false);
    expect(() => assertOwedEscrowReleased()).toThrow("REWARD_OWED_ESCROW_UNRELEASED");
  });

  it("counts an allocation as owed only after its exact escrow transfer is marked finalized", () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const capitalMint = Keypair.generate().publicKey.toBase58();
    const source: FinalizedHolderJournal = {
      version: 3, epochId: "1", capitalMint, launchSignature: "launch", windowStart: 1_000, windowEnd: 2_000,
      finalizedThroughSlot: 9, finalizedBlockhash: "hash",
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 2, throughSlot: 9, throughBlockhash: "hash" },
      transfers: [{ signature: "mint", slot: 2, transactionIndex: 0, instructionIndex: 0, timestamp: 1_000,
        to: recipient, rawAmount: "10" }],
    };
    const plan = buildRewardEpochPlan({
      epochId: 1n, journal: source, fundedRawMstrx: 17n, excluded: [],
      mstrxMint: Keypair.generate().publicKey.toBase58(),
      owedEscrowOwner: Keypair.generate().publicKey.toBase58(),
      owedEscrowAddress: Keypair.generate().publicKey.toBase58(),
    });
    const batch = plan.batches[0];
    batch.ataState = "isolating";
    batch.state = "confirmed";
    batch.originalFailure = { kind: "ata", evidence: "simulation" };
    batch.allocations[0].delivery = {
      state: "owed", ata: { state: "rejected" }, transfer: { state: "pending" }, escrow: { state: "submitted", signature: "escrow" },
      rejection: { stage: "ata", evidence: "simulation" },
    };
    expect(() => rewardEpochConservation(plan)).toThrow("REWARD_OWED_RECEIPT_INVALID");
    batch.allocations[0].delivery.escrow.state = "confirmed";
    expect(rewardEpochConservation(plan)).toMatchObject({ paidRaw: 0n, owedRaw: 17n });
    plan.owedEscrow.address = Keypair.generate().publicKey.toBase58();
    expect(() => rewardEpochConservation(plan)).toThrow("REWARD_PLAN_HASH_MISMATCH");
  });

  it("conserves a mixed batch when one wallet is paid and the other remains escrowed", () => {
    const capitalMint = Keypair.generate().publicKey.toBase58();
    const recipients = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    const source: FinalizedHolderJournal = {
      version: 3, epochId: "1", capitalMint, launchSignature: "launch", windowStart: 1_000, windowEnd: 2_000,
      finalizedThroughSlot: 9, finalizedBlockhash: "hash",
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 2, throughSlot: 9, throughBlockhash: "hash" },
      transfers: recipients.map((recipient, index) => ({ signature: `mint-${index}`, slot: 2,
        transactionIndex: index, instructionIndex: 0, timestamp: 1_000, to: recipient, rawAmount: "10" })),
    };
    const plan = buildRewardEpochPlan({ epochId: 1n, journal: source, fundedRawMstrx: 17n, excluded: [],
      mstrxMint: Keypair.generate().publicKey.toBase58(), owedEscrowOwner: Keypair.generate().publicKey.toBase58(),
      owedEscrowAddress: Keypair.generate().publicKey.toBase58(), batchSize: 2 });
    expect(plan.batches).toHaveLength(1);
    const batch = plan.batches[0];
    expect(batch.allocations).toHaveLength(2);
    batch.ataState = "isolating";
    batch.state = "confirmed";
    batch.originalFailure = { kind: "transfer", evidence: "simulation" };
    const [paid, owed] = batch.allocations;
    paid.delivery = { state: "paid", ata: { state: "confirmed" },
      transfer: { state: "confirmed", signature: "paid-finalized" }, escrow: { state: "pending" } };
    owed.delivery = { state: "owed", ata: { state: "rejected" }, transfer: { state: "pending" },
      escrow: { state: "confirmed", signature: "escrow-finalized" },
      rejection: { stage: "ata", evidence: "simulation" } };
    const result = rewardEpochConservation(plan);
    expect(result.paidRaw + result.owedRaw).toBe(17n);
    expect(result.owed).toMatchObject([{ recipient: owed.recipient, rawMstrx: owed.rawMstrx,
      escrowSignature: "escrow-finalized", state: "owed" }]);
  });

  it("rejects mint changes that alter Token-2022 push semantics or rent sizing", () => {
    const safe = {
      initialized: true, decimals: 8, hookProgram: PublicKey.default.toBase58(),
      hasTransferFee: false, paused: false, defaultAccountState: 1,
      extensionHash: "hash", escrowAccountLength: 170, ataAccountLength: 175,
    };
    expect(() => assertRewardMintCanPush(safe)).not.toThrow();
    expect(() => assertRewardMintCanPush({ ...safe, hookProgram: Keypair.generate().publicKey.toBase58() }))
      .toThrow("REWARD_MSTRX_TRANSFER_SEMANTICS_UNSUPPORTED");
    expect(() => assertRewardMintCanPush({ ...safe, hasTransferFee: true }))
      .toThrow("REWARD_MSTRX_TRANSFER_SEMANTICS_UNSUPPORTED");
    expect(() => assertRewardMintCanPush({ ...safe, paused: true }))
      .toThrow("REWARD_MSTRX_TRANSFER_SEMANTICS_UNSUPPORTED");
    expect(() => assertRewardMintCanPush({ ...safe, defaultAccountState: 2 }))
      .toThrow("REWARD_MSTRX_TRANSFER_SEMANTICS_UNSUPPORTED");
    expect(() => assertRewardMintCanPush({ ...safe, decimals: 6 })).toThrow("REWARD_MSTRX_MINT_INVALID");
    expect(() => assertRewardMintCanPush({ ...safe, escrowAccountLength: 0 }))
      .toThrow("REWARD_MSTRX_ACCOUNT_LENGTH_INVALID");
  });

  it("derives escrow and ATA rent sizes from actual Token-2022 extension bytes", () => {
    const extension = (kind: ExtensionType, bytes: Buffer) => {
      const header = Buffer.alloc(4);
      header.writeUInt16LE(kind, 0);
      header.writeUInt16LE(bytes.length, 2);
      return Buffer.concat([header, bytes]);
    };
    const tlvData = Buffer.concat([
      extension(ExtensionType.TransferHook, Buffer.alloc(64)),
      extension(ExtensionType.DefaultAccountState, Buffer.from([1])),
    ]);
    const mint = { isInitialized: true, decimals: 8, tlvData } as Mint;
    const snapshot = rewardMintSafetySnapshot(mint);
    expect(snapshot.hookProgram).toBe(PublicKey.default.toBase58());
    expect(snapshot.defaultAccountState).toBe(1);
    expect(snapshot.ataAccountLength).toBeGreaterThan(snapshot.escrowAccountLength);
    expect(() => assertRewardMintCanPush(snapshot)).not.toThrow();
  });

  it("requires an initialized, unfrozen, undelegated owed token account", () => {
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const safe = {
      mint, owner, isInitialized: true, isFrozen: false, delegate: null,
      delegatedAmount: 0n, closeAuthority: null,
    };
    expect(() => assertOwedEscrowAccountUsable(safe, mint.toBase58(), owner.toBase58())).not.toThrow();
    for (const unsafe of [
      { ...safe, isFrozen: true },
      { ...safe, isInitialized: false },
      { ...safe, delegate: Keypair.generate().publicKey, delegatedAmount: 1n },
      { ...safe, closeAuthority: Keypair.generate().publicKey },
    ]) {
      expect(() => assertOwedEscrowAccountUsable(unsafe, mint.toBase58(), owner.toBase58()))
        .toThrow("REWARD_OWED_ESCROW_ACCOUNT_UNSAFE");
    }
  });

  it("keeps retrying transient owed failures after the eighth attempt with a bounded interval", () => {
    expect(owedRetryTime(1, 1000)).toBe(901000);
    expect(owedRetryTime(8, 1000)).toBe(21_601_000);
    expect(owedRetryTime(9, 1000)).toBe(21_601_000);
    expect(owedRetryTime(1000, 1000)).toBe(21_601_000);
    expect(() => owedRetryTime(0, 1000)).toThrow("REWARD_OWED_RETRY_TIME_INVALID");
  });
});

describe("payout operator SOL budget", () => {
  it("reserves worst-case ATA rent plus a transaction-fee margin before signing", () => {
    expect(requiredOperatorPayoutLamports(2_039_280n, 3)).toBe(7_117_840n);
    expect(requiredOperatorPayoutLamports(2_039_280n, 0)).toBe(1_000_000n);
    expect(() => requiredOperatorPayoutLamports(-1n, 1)).toThrow("REWARD_OPERATOR_BUDGET_INPUT_INVALID");
  });
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public Solana reward epoch history", () => {
  it("publishes a finalized epoch beneath the public snapshots route", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-solana-reward-"));
    temporaryRoots.push(root);
    const stateRoot = join(root, "state");
    const publicDataRoot = join(root, "public");
    const journal: FinalizedHolderJournal = {
      version: 3,
      epochId: "1",
      capitalMint: Keypair.generate().publicKey.toBase58(),
      launchSignature: "launch-tx",
      windowStart: 1_000,
      windowEnd: 2_000,
      finalizedThroughSlot: 99,
      finalizedBlockhash: "final-block",
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 2, throughSlot: 99, throughBlockhash: "final-block" },
      transfers: [{
        signature: "transfer",
        slot: 2,
        transactionIndex: 0,
        instructionIndex: 0,
        timestamp: 1_000,
        to: Keypair.generate().publicKey.toBase58(),
        rawAmount: "100",
      }],
    };
    const holder = Keypair.generate();
    const holderKeypairPath = join(root, "holder-keypair.json");
    await writeFile(holderKeypairPath, JSON.stringify([...holder.secretKey]));
    const escrowAddress = await PublicKey.createWithSeed(holder.publicKey, owedEscrowSeed(journal.capitalMint, 1n), TOKEN_2022_PROGRAM_ID);
    const mstrxMint = Keypair.generate().publicKey.toBase58();
    const plan = buildRewardEpochPlan({
      epochId: 1n, journal, fundedRawMstrx: 100n, excluded: [],
      mstrxMint,
      owedEscrowOwner: holder.publicKey.toBase58(), owedEscrowAddress: escrowAddress.toBase58(),
    });
    expect(plan.batches).toHaveLength(1);
    await mkdir(publicDataRoot, { recursive: true });
    await writeFile(join(publicDataRoot, "config.json"), JSON.stringify({
      network: "solana-mainnet-beta", projectMint: journal.capitalMint,
      launchedAtSlot: journal.coverage.fromSlot, launchedAtSignature: journal.launchSignature,
    }));
    await mkdir(join(stateRoot, "reward-epochs"), { recursive: true });
    await writeFile(join(stateRoot, "reward-epochs", "current.json"), JSON.stringify(plan));
    const environment = { stateRoot, publicDataRoot, holderKeypairPath, mstrxMint } as RewardPipelineEnvironment;
    await writeFile(join(publicDataRoot, "config.json"), JSON.stringify({
      network: "solana-mainnet-beta", projectMint: journal.capitalMint,
      launchedAtSlot: journal.coverage.fromSlot + 1, launchedAtSignature: journal.launchSignature,
    }));
    await expect(loadCurrentRewardPlan(environment)).rejects.toThrow("REWARD_LAUNCH_BINDING_MISMATCH");
    await writeFile(join(publicDataRoot, "config.json"), JSON.stringify({
      network: "solana-mainnet-beta", projectMint: journal.capitalMint,
      launchedAtSlot: journal.coverage.fromSlot, launchedAtSignature: journal.launchSignature,
    }));
    await expect(finalizeRewardEpoch(environment)).rejects.toThrow("REWARD_BATCHES_INCOMPLETE");
    expect((await readFile(join(stateRoot, "reward-epochs", "current.json"), "utf8"))).toContain('"finalized":false');
    plan.batches[0].ataState = "confirmed";
    plan.batches[0].state = "confirmed";
    plan.batches[0].signature = "payout-signature";
    await writeFile(join(stateRoot, "reward-epochs", "current.json"), JSON.stringify(plan));

    const sourceAta = mstrxAta(holder.publicKey, new PublicKey(environment.mstrxMint)).toBase58();
    const destinationAta = mstrxAta(new PublicKey(plan.batches[0].allocations[0].recipient), new PublicKey(environment.mstrxMint)).toBase58();
    vi.mocked(readAgreedFinalizedTransaction).mockResolvedValue({
      signature: "payout-signature", slot: 99, blockTime: 2_000, blockhash: "final-block",
      deltas: [
        { account: sourceAta, owner: holder.publicKey.toBase58(), rawAmount: "-100" },
        { account: destinationAta, owner: plan.batches[0].allocations[0].recipient, rawAmount: "100" },
      ],
    });
    expect(rewardEpochConservation(plan)).toMatchObject({ paidRaw: 100n, owedRaw: 0n });
    await finalizeRewardEpoch(environment);

    const detail = JSON.parse(await readFile(resolve(publicDataRoot, "snapshots", "solana-reward-epoch-1.json"), "utf8"));
    const history = JSON.parse(await readFile(resolve(publicDataRoot, "snapshots", "history.json"), "utf8"));
    expect(detail.epochId).toBe("1");
    expect(detail.fundedRawMstrx).toBe("100");
    expect(history).toMatchObject([{ epoch: 1, mstrxRewardRaw: "100", signature: "payout-signature" }]);
    expect((await readFile(join(stateRoot, "reward-epochs", "current.json"), "utf8"))).toContain('"finalized": true');
  });

  it("writes a durable owed ledger only after two-RPC escrow balance proof and omits signed bytes from public output", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-owed-"));
    temporaryRoots.push(root);
    const stateRoot = join(root, "state");
    const publicDataRoot = join(root, "public");
    const holder = Keypair.generate();
    const holderKeypairPath = join(root, "holder-keypair.json");
    await writeFile(holderKeypairPath, JSON.stringify([...holder.secretKey]));
    const capitalMint = Keypair.generate().publicKey.toBase58();
    const mstrxMint = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const escrowAddress = await PublicKey.createWithSeed(holder.publicKey, owedEscrowSeed(capitalMint, 1n), TOKEN_2022_PROGRAM_ID);
    const source: FinalizedHolderJournal = {
      version: 3, epochId: "1", capitalMint, launchSignature: "launch", windowStart: 100, windowEnd: 500,
      finalizedThroughSlot: 20, finalizedBlockhash: "block",
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 10, throughSlot: 20, throughBlockhash: "block" },
      transfers: [{ signature: "launch", slot: 10, transactionIndex: 0, instructionIndex: 0, timestamp: 100,
        to: recipient, rawAmount: "100" }],
    };
    const plan = buildRewardEpochPlan({ epochId: 1n, journal: source, fundedRawMstrx: 17n, excluded: [],
      mstrxMint, owedEscrowOwner: holder.publicKey.toBase58(), owedEscrowAddress: escrowAddress.toBase58() });
    plan.owedEscrow.state = "confirmed";
    plan.batches[0].ataState = "isolating";
    plan.batches[0].state = "confirmed";
    plan.batches[0].originalFailure = { kind: "ata", evidence: "simulation" };
    plan.batches[0].allocations[0].delivery = {
      state: "owed", ata: { state: "rejected" }, transfer: { state: "pending" },
      escrow: { state: "confirmed", signature: "escrow-finalized", transactionBase64: "PRIVATE_SIGNED_BYTES" },
      rejection: { stage: "ata", evidence: "simulation" },
    };
    await mkdir(resolve(stateRoot, "reward-epochs"), { recursive: true });
    await mkdir(publicDataRoot, { recursive: true });
    await writeFile(resolve(stateRoot, "reward-epochs", "current.json"), JSON.stringify(plan));
    await writeFile(resolve(publicDataRoot, "config.json"), JSON.stringify({
      network: "solana-mainnet-beta", projectMint: capitalMint, launchedAtSlot: 10, launchedAtSignature: "launch",
    }));
    const sourceAta = mstrxAta(holder.publicKey, new PublicKey(mstrxMint)).toBase58();
    vi.mocked(readAgreedFinalizedTransaction).mockResolvedValue({
      signature: "escrow-finalized", slot: 20, blockTime: 500, blockhash: "block",
      deltas: [
        { account: sourceAta, owner: holder.publicKey.toBase58(), rawAmount: "-17" },
        { account: escrowAddress.toBase58(), owner: holder.publicKey.toBase58(), rawAmount: "17" },
      ],
    });
    vi.mocked(finalizedConsensus).mockResolvedValue({ slot: 20, blockhash: "block", providers: 2 });
    vi.spyOn(Connection.prototype, "getAccountInfoAndContext").mockResolvedValue({
      context: { slot: 20 }, value: {} as never,
    });
    vi.mocked(unpackAccount).mockReturnValue({
      address: escrowAddress, mint: new PublicKey(mstrxMint), owner: holder.publicKey,
      amount: 17n, isInitialized: true, isFrozen: false, delegate: null,
      delegatedAmount: 0n, closeAuthority: null,
    } as ReturnType<typeof unpackAccount>);
    const environment: RewardPipelineEnvironment = {
      stateRoot, publicDataRoot, holderKeypairPath, mstrxMint,
      rpcUrls: ["https://one.invalid", "https://two.invalid"],
      journalPath: join(root, "journal.json"), capitalMint,
      operatorKeypairPath: holderKeypairPath, excluded: [],
    };
    await finalizeRewardEpoch(environment);
    const privateLedger = await readFile(resolve(stateRoot, "reward-epochs", "owed-epoch-1.json"), "utf8");
    const publicLedger = await readFile(resolve(publicDataRoot, "snapshots", "solana-owed-epoch-1.json"), "utf8");
    const publicEpoch = JSON.parse(await readFile(resolve(publicDataRoot, "snapshots", "solana-reward-epoch-1.json"), "utf8"));
    expect(publicEpoch.owedStatusPath).toBe("/snapshots/solana-owed-epoch-1.json");
    expect(JSON.parse(privateLedger).receipts).toMatchObject([{ recipient, rawMstrx: "17", state: "owed" }]);
    expect(JSON.parse(publicLedger)).toMatchObject({ outstandingRawMstrx: "17" });
    expect(publicLedger).not.toContain("PRIVATE_SIGNED_BYTES");
    expect(publicLedger).not.toContain("transactionBase64");

    const originalPublicEpoch = await readFile(resolve(publicDataRoot, "snapshots", "solana-reward-epoch-1.json"), "utf8");
    const originalPlanArchive = await readFile(resolve(stateRoot, "reward-epochs", "plan-epoch-1.json"), "utf8");
    const retryLedgerPath = resolve(stateRoot, "reward-epochs", "owed-epoch-1.json");
    const retryLedger = JSON.parse(privateLedger);
    retryLedger.receipts[0].transfer = {
      state: "submitted", signature: "retry-finalized", transactionBase64: "PRIVATE_RETRY_BYTES",
      blockhash: "retry-blockhash", lastValidBlockHeight: 40,
    };
    await writeFile(retryLedgerPath, JSON.stringify(retryLedger));
    vi.spyOn(Connection.prototype, "getParsedTransaction").mockResolvedValue(null);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_rpcUrls, signature) => ({
      signature, slot: signature === "retry-finalized" ? 25 : 20,
      blockTime: 500, blockhash: signature === "retry-finalized" ? "retry-final-block" : "block",
      deltas: signature === "retry-finalized" ? [
        { account: escrowAddress.toBase58(), owner: holder.publicKey.toBase58(), rawAmount: "-17" },
        { account: mstrxAta(new PublicKey(recipient), new PublicKey(mstrxMint)).toBase58(), owner: recipient, rawAmount: "17" },
      ] : [
        { account: sourceAta, owner: holder.publicKey.toBase58(), rawAmount: "-17" },
        { account: escrowAddress.toBase58(), owner: holder.publicKey.toBase58(), rawAmount: "17" },
      ],
    }));
    vi.mocked(finalizedConsensus).mockResolvedValue({ slot: 25, blockhash: "retry-final-block", providers: 2 });
    vi.spyOn(Connection.prototype, "getAccountInfoAndContext").mockResolvedValue({
      context: { slot: 25 }, value: {} as never,
    });
    await retryOwedRewardPayments(environment);
    const delivered = JSON.parse(await readFile(retryLedgerPath, "utf8"));
    const deliveredPublic = JSON.parse(await readFile(resolve(publicDataRoot, "snapshots", "solana-owed-epoch-1.json"), "utf8"));
    expect(delivered.receipts[0]).toMatchObject({ state: "paid", transfer: { signature: "retry-finalized", state: "confirmed" } });
    expect(deliveredPublic).toMatchObject({ outstandingRawMstrx: "0", receipts: [{ state: "paid", payoutSignature: "retry-finalized" }] });
    expect(deliveredPublic.deliveryEvents).toMatchObject([{ recipient, rawMstrx: "17", signature: "retry-finalized", finalizedSlot: 25 }]);
    expect(JSON.stringify(deliveredPublic)).not.toContain("PRIVATE_RETRY_BYTES");
    expect(await readFile(resolve(publicDataRoot, "snapshots", "solana-reward-epoch-1.json"), "utf8")).toBe(originalPublicEpoch);
    expect(await readFile(resolve(stateRoot, "reward-epochs", "plan-epoch-1.json"), "utf8")).toBe(originalPlanArchive);
    await writeFile(resolve(publicDataRoot, "snapshots", "solana-owed-epoch-1.json"), publicLedger);
    await retryOwedRewardPayments(environment);
    expect(JSON.parse(await readFile(retryLedgerPath, "utf8")).deliveryEvents).toHaveLength(1);
    expect(JSON.parse(await readFile(resolve(publicDataRoot, "snapshots", "solana-owed-epoch-1.json"), "utf8")))
      .toMatchObject({ outstandingRawMstrx: "0", deliveryEvents: [{ signature: "retry-finalized" }] });
  });
});
