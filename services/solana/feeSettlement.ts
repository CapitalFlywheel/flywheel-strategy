import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { buildCustomQuoteCreatorFeeSweepPlan, readCustomQuoteCreatorFeeBalances } from "./pumpFees";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { readAgreedFinalizedTransaction, tokenAccountDelta } from "./finalizedTransfers";
import { createMstrxTransfer, mstrxAta, splitMstrx60_40 } from "./mstrxTransfers";
import { requireMatchingValues } from "./rpcConsensus";
import { broadcastPreparedTransaction, loadKeypair, prepareSignedTransaction } from "./transactions";

type Phase = "curve" | "pumpswap";
type SignedTransaction = Awaited<ReturnType<typeof prepareSignedTransaction>>;

export interface FeeReceiptState {
  phase: Phase;
  state: "collecting" | "expired" | "collected" | "routing" | "routed" | "recovered";
  collection: SignedTransaction;
  collectedRaw?: string;
  collectionSlot?: number;
  collectionBlockhash?: string;
  route?: SignedTransaction;
  holderRaw?: string;
  reserveRaw?: string;
  recoverySignature?: string;
}

export interface FeeSettlementState {
  version: 1;
  projectMint: string;
  mint: string;
  creator: string;
  receipts: FeeReceiptState[];
  recovery?: { state: "submitted" | "confirmed"; transaction: SignedTransaction; amount: string; receiptSignatures: string[] };
}

export interface FeeSettlementEnvironment {
  rpcUrls: readonly [string, string];
  stateRoot: string;
  projectMint: string;
  mint: string;
  creator: string;
  holder: string;
  reserve: string;
  recovery: string;
  creatorKeypairPath: string;
  operatorKeypairPath: string;
  minimumSweepRaw?: bigint;
}

function statePath(environment: FeeSettlementEnvironment) {
  return resolve(environment.stateRoot, "fee-settlement.json");
}

export async function loadFeeSettlement(environment: FeeSettlementEnvironment): Promise<FeeSettlementState> {
  const state = await readJsonIfExists<FeeSettlementState>(statePath(environment)) ?? {
    version: 1 as const, projectMint: environment.projectMint, mint: environment.mint, creator: environment.creator, receipts: [],
  };
  if (state.version !== 1 || state.projectMint !== environment.projectMint || state.mint !== environment.mint || state.creator !== environment.creator || !Array.isArray(state.receipts)) {
    throw new Error("FEE_LEDGER_IDENTITY_MISMATCH");
  }
  const signatures = state.receipts.map((row) => row.collection.signature);
  if (new Set(signatures).size !== signatures.length) throw new Error("FEE_LEDGER_DUPLICATE_RECEIPT");
  return state;
}

async function save(environment: FeeSettlementEnvironment, state: FeeSettlementState) {
  await writeDurableJson(statePath(environment), state);
}

async function balance(environment: FeeSettlementEnvironment, owner: string) {
  const ata = mstrxAta(new PublicKey(owner), new PublicKey(environment.mint));
  const values = await Promise.all(environment.rpcUrls.map(async (url) => {
    try {
      const account = await getAccount(new Connection(url, "finalized"), ata, "finalized", TOKEN_2022_PROGRAM_ID);
      return account.amount.toString();
    } catch (error) {
      if (error instanceof Error && /account not found/i.test(error.message)) return "0";
      throw error;
    }
  }));
  return BigInt(requireMatchingValues(values, "FEE_BALANCE_RPC_DISAGREEMENT"));
}

async function rebroadcast(environment: FeeSettlementEnvironment, prepared: SignedTransaction) {
  return broadcastPreparedTransaction({ connection: new Connection(environment.rpcUrls[0], "confirmed"), ...prepared });
}

async function pendingTransaction(environment: FeeSettlementEnvironment, prepared: SignedTransaction) {
  const snapshots = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [status, height] = await Promise.all([
      connection.getSignatureStatuses([prepared.signature], { searchTransactionHistory: true }),
      connection.getBlockHeight("finalized"),
    ]);
    return { status: status.value[0], height };
  }));
  if (snapshots.some((snapshot) => snapshot.status?.err)) throw new Error("FEE_TRANSACTION_ONCHAIN_FAILURE");
  if (snapshots.every((snapshot) => snapshot.status === null && snapshot.height > prepared.lastValidBlockHeight + 32)) return "expired";
  if (snapshots.every((snapshot) => snapshot.height <= prepared.lastValidBlockHeight)) {
    try { await rebroadcast(environment, prepared); } catch {
      // The exact signed bytes remain in durable state and will be checked again
    }
  }
  return "waiting";
}

async function reconcileReceipt(environment: FeeSettlementEnvironment, state: FeeSettlementState, receipt: FeeReceiptState, allowRouting = true) {
  const creatorAta = mstrxAta(new PublicKey(environment.creator), new PublicKey(environment.mint)).toBase58();
  const holderAta = mstrxAta(new PublicKey(environment.holder), new PublicKey(environment.mint)).toBase58();
  const reserveAta = mstrxAta(new PublicKey(environment.reserve), new PublicKey(environment.mint)).toBase58();
  if (receipt.state === "collecting") {
    const transaction = await readAgreedFinalizedTransaction(environment.rpcUrls, receipt.collection.signature, environment.mint);
    if (!transaction) {
      if (await pendingTransaction(environment, receipt.collection) === "expired") {
        receipt.state = "expired";
        await save(environment, state);
      }
      return false;
    }
    const amount = tokenAccountDelta(transaction, creatorAta);
    if (amount <= 0n) throw new Error("FEE_COLLECTION_DELTA_INVALID");
    receipt.collectedRaw = amount.toString();
    receipt.collectionSlot = transaction.slot;
    receipt.collectionBlockhash = transaction.blockhash;
    receipt.state = "collected";
    await save(environment, state);
  }
  if (receipt.state === "collected") {
    if (!allowRouting) return false;
    const amount = BigInt(receipt.collectedRaw ?? "0");
    if (amount <= 0n || amount > await balance(environment, environment.creator)) throw new Error("FEE_COLLECTED_BALANCE_UNAVAILABLE");
    const split = splitMstrx60_40(amount);
    const connection = new Connection(environment.rpcUrls[0], "confirmed");
    const operator = await loadKeypair(environment.operatorKeypairPath);
    const creator = await loadKeypair(environment.creatorKeypairPath);
    if (creator.publicKey.toBase58() !== environment.creator) throw new Error("CREATOR_KEYPAIR_MISMATCH");
    const instructions = [];
    if (split.holderRaw > 0n) instructions.push(await createMstrxTransfer({ connection, sourceOwner: creator.publicKey, destinationOwner: new PublicKey(environment.holder), mint: new PublicKey(environment.mint), rawAmount: split.holderRaw }));
    if (split.reserveRaw > 0n) instructions.push(await createMstrxTransfer({ connection, sourceOwner: creator.publicKey, destinationOwner: new PublicKey(environment.reserve), mint: new PublicKey(environment.mint), rawAmount: split.reserveRaw }));
    receipt.route = await prepareSignedTransaction({ connection, payer: operator, additionalSigners: [creator], instructions });
    receipt.holderRaw = split.holderRaw.toString();
    receipt.reserveRaw = split.reserveRaw.toString();
    receipt.state = "routing";
    await save(environment, state);
    await rebroadcast(environment, receipt.route);
    return false;
  }
  if (receipt.state === "routing") {
    if (!receipt.route || !receipt.collectedRaw || !receipt.holderRaw || !receipt.reserveRaw) throw new Error("FEE_ROUTE_STATE_INVALID");
    const transaction = await readAgreedFinalizedTransaction(environment.rpcUrls, receipt.route.signature, environment.mint);
    if (!transaction) {
      if (await pendingTransaction(environment, receipt.route) === "expired") {
        receipt.route = undefined;
        receipt.state = "collected";
        await save(environment, state);
      }
      return false;
    }
    if (tokenAccountDelta(transaction, creatorAta) !== -BigInt(receipt.collectedRaw)
      || tokenAccountDelta(transaction, holderAta) !== BigInt(receipt.holderRaw)
      || tokenAccountDelta(transaction, reserveAta) !== BigInt(receipt.reserveRaw)) {
      throw new Error("FEE_ROUTE_DELTA_MISMATCH");
    }
    receipt.state = "routed";
    await save(environment, state);
  }
  return receipt.state === "routed" || receipt.state === "recovered";
}

export async function reconcilePendingFeeReceipt(environment: FeeSettlementEnvironment) {
  const state = await loadFeeSettlement(environment);
  const pending = state.receipts.find((row) => row.state === "collecting" || row.state === "routing");
  if (!pending) return { pending: false };
  await reconcileReceipt(environment, state, pending, false);
  return { pending: pending.state === "collecting" || pending.state === "routing", signature: pending.collection.signature, state: pending.state };
}

export async function sweepCreatorFees(environment: FeeSettlementEnvironment, phase: Phase) {
  const state = await loadFeeSettlement(environment);
  if (state.recovery?.state === "submitted") throw new Error("FEE_RECOVERY_PENDING");
  const pending = state.receipts.find((row) => row.state !== "routed" && row.state !== "recovered" && row.state !== "expired");
  if (pending) {
    const settled = await reconcileReceipt(environment, state, pending);
    return { changed: settled, receipt: pending };
  }
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  const balances = await Promise.all(environment.rpcUrls.map(async (rpcUrl) => {
    const row = await readCustomQuoteCreatorFeeBalances({
      rpcUrl, creator: environment.creator, quoteMint: environment.mint,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    });
    return { curveRaw: row.curveRaw.toString(), pumpSwapRaw: row.pumpSwapRaw.toString() };
  }));
  const agreedBalances = requireMatchingValues(balances, "PUMP_FEE_VAULT_RPC_DISAGREEMENT");
  const pendingRaw = BigInt(phase === "curve" ? agreedBalances.curveRaw : agreedBalances.pumpSwapRaw);
  if (pendingRaw < (environment.minimumSweepRaw ?? 10_000n)) return { changed: false };
  const operator = await loadKeypair(environment.operatorKeypairPath);
  const plans = await Promise.all(environment.rpcUrls.map((rpcUrl) => buildCustomQuoteCreatorFeeSweepPlan({
    rpcUrl, creator: environment.creator, quoteMint: environment.mint,
    quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), feePayer: operator.publicKey.toBase58(),
  })));
  const instructionSets = plans.map((plan) => (phase === "curve" ? plan.curve : plan.pumpSwap).map((instruction) => ({
    programId: instruction.programId.toBase58(),
    keys: instruction.keys.map((key) => ({ key: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })),
    data: instruction.data.toString("base64"),
  })));
  requireMatchingValues(instructionSets, "PUMP_SWEEP_INSTRUCTIONS_RPC_DISAGREEMENT");
  const instructions = phase === "curve" ? plans[0].curve : plans[0].pumpSwap;
  if (!instructions.length) throw new Error("NO_SWEEP_INSTRUCTION_AVAILABLE");
  const collection = await prepareSignedTransaction({ connection, payer: operator, instructions });
  const receipt: FeeReceiptState = { phase, state: "collecting", collection };
  state.receipts.push(receipt);
  await save(environment, state);
  await rebroadcast(environment, collection);
  return { changed: true, receipt };
}

export function recoverableFeeAmount(state: FeeSettlementState) {
  if (state.receipts.some((row) => row.state === "collecting" || row.state === "routing")) throw new Error("FEE_TRANSACTION_UNRESOLVED");
  return state.receipts.filter((row) => row.state === "collected")
    .reduce((sum, row) => sum + BigInt(row.collectedRaw ?? "0"), 0n);
}

export async function recoverUncommittedCreatorFees(environment: FeeSettlementEnvironment) {
  const state = await loadFeeSettlement(environment);
  const creatorAta = mstrxAta(new PublicKey(environment.creator), new PublicKey(environment.mint)).toBase58();
  const recoveryAta = mstrxAta(new PublicKey(environment.recovery), new PublicKey(environment.mint)).toBase58();
  if (state.recovery?.state === "submitted") {
    const transaction = await readAgreedFinalizedTransaction(environment.rpcUrls, state.recovery.transaction.signature, environment.mint);
    if (!transaction) {
      if (await pendingTransaction(environment, state.recovery.transaction) === "expired") {
        const amount = state.recovery.amount;
        state.recovery = undefined;
        await save(environment, state);
        return { pending: false, amount, expired: true };
      }
      return { pending: true, amount: state.recovery.amount };
    }
    if (tokenAccountDelta(transaction, creatorAta) !== -BigInt(state.recovery.amount)
      || tokenAccountDelta(transaction, recoveryAta) !== BigInt(state.recovery.amount)) throw new Error("FEE_RECOVERY_DELTA_MISMATCH");
    for (const receipt of state.receipts) {
      if (state.recovery.receiptSignatures.includes(receipt.collection.signature)) {
        receipt.state = "recovered";
        receipt.recoverySignature = state.recovery.transaction.signature;
      }
    }
    state.recovery.state = "confirmed";
    await save(environment, state);
    return { pending: false, amount: state.recovery.amount, signature: state.recovery.transaction.signature };
  }
  const amount = recoverableFeeAmount(state);
  if (amount <= 0n) throw new Error("NO_UNCOMMITTED_FEES");
  if (amount > await balance(environment, environment.creator)) throw new Error("RECOVERABLE_FEE_BALANCE_UNAVAILABLE");
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  const operator = await loadKeypair(environment.operatorKeypairPath);
  const creator = await loadKeypair(environment.creatorKeypairPath);
  if (creator.publicKey.toBase58() !== environment.creator) throw new Error("CREATOR_KEYPAIR_MISMATCH");
  const instruction = await createMstrxTransfer({
    connection, sourceOwner: creator.publicKey, destinationOwner: new PublicKey(environment.recovery),
    mint: new PublicKey(environment.mint), rawAmount: amount,
  });
  const transaction = await prepareSignedTransaction({ connection, payer: operator, additionalSigners: [creator], instructions: [instruction] });
  state.recovery = {
    state: "submitted", transaction, amount: amount.toString(),
    receiptSignatures: state.receipts.filter((row) => row.state === "collected").map((row) => row.collection.signature),
  };
  await save(environment, state);
  await rebroadcast(environment, transaction);
  return { pending: true, amount: amount.toString(), signature: transaction.signature };
}
