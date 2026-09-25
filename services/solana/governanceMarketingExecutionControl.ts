import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, TransactionInstruction,
  VersionedTransaction, type AccountInfo, type AccountMeta } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { governanceAddresses, governanceExecutionReceiptAddresses,
  inspectGovernanceExecutionReceipt, parseGovernanceConfig, parseGovernanceProposal,
} from "../../apps/web/src/governanceClient";
import { validateMarketingExecutionIntent, verifySignedSolanaControlAction,
  type MarketingExecutionIntent, type SignedSolanaControlAction } from "./controlAuth";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { buildExecuteMarketingSaleDraft } from "./governanceExecutionInstruction";
import { inspectPinnedMarketingSaleQuote } from "./governanceMarketingSaleQuote";
import { deriveGovernanceReserveRoute, verifyGovernanceReserveRoute } from "./governanceVaultRoute";
import { MARKETING_SALE_POOL } from "./marketingSaleRoute";
import { requireGovernanceExecutionReleased } from "./releaseGates";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type LedgerState = "prepared" | "pending" | "finalized" | "failed" | "unresolved";
const MAX_U64 = (1n << 64n) - 1n;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const pin = MARKETING_SALE_POOL;
const memo = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Independent of the global governance gate and Rust's own closed executor. */
export const MARKETING_EXECUTION_CONTROL_RELEASED = false;

export interface MarketingExecutionEnvironment {
  rpcUrls: readonly [string, string];
  stateRoot: string;
  governanceProgram: string;
  expectedProgramCodeSha256: string;
  reserveAuthority: string;
  reserveMint: string;
  capitalMint: string;
  admin: string;
  adminKeypairPath: string;
  /** At most four consecutive initialized arrays; larger trades can fail closed. */
  tickArrayCount?: 1 | 2 | 3 | 4;
}

export type MarketingExecutionReadEnvironment = Omit<MarketingExecutionEnvironment, "stateRoot" | "adminKeypairPath">;
export type SignedMarketingExecution = SignedSolanaControlAction & {
  action: "execute_marketing_sale";
  marketingExecution: MarketingExecutionIntent;
};
export interface MarketingExecutionLedger {
  version: 1;
  requestId: string;
  authorization: SignedSolanaControlAction;
  transaction: Prepared;
  transactionSha256: string;
  state: LedgerState;
  updatedAt: number;
}
export interface MarketingExecutionEffects {
  audit: (proposalId: string) => Promise<MarketingExecutionIntent>;
  prepare: (instruction: TransactionInstruction) => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared, intent: MarketingExecutionIntent) =>
    Promise<"pending" | "unresolved" | "failed" | "finalized">;
}

const ledgerPath = (environment: MarketingExecutionEnvironment) =>
  resolve(environment.stateRoot, "governance-marketing-execution.json");
const historyPath = (environment: MarketingExecutionEnvironment, nonce: string) =>
  resolve(environment.stateRoot, "governance-marketing-execution-history", `${nonce}.json`);

function positiveU64(value: string, code: string) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > MAX_U64) {
    throw new Error(code);
  }
  return BigInt(value);
}

function route(environment: MarketingExecutionReadEnvironment) {
  const derived = deriveGovernanceReserveRoute(environment.governanceProgram, environment.reserveMint);
  if (environment.reserveMint !== pin.mstrxMint
    || derived.authority.toBase58() !== environment.reserveAuthority
    || !/^[a-f0-9]{64}$/.test(environment.expectedProgramCodeSha256)
    || new PublicKey(environment.admin).toBase58() !== environment.admin
    || new PublicKey(environment.capitalMint).toBase58() !== environment.capitalMint) {
    throw new Error("GOVERNANCE_MARKETING_ROUTE_INVALID");
  }
  return derived;
}

function identities(environment: MarketingExecutionReadEnvironment, intent: MarketingExecutionIntent) {
  validateMarketingExecutionIntent(intent, intent.verifiedAt);
  const derived = route(environment);
  const id = positiveU64(intent.proposalId, "GOVERNANCE_MARKETING_ID_INVALID");
  const addresses = governanceAddresses(derived.program, id);
  const receipt = governanceExecutionReceiptAddresses(derived.program, addresses.proposal).marketing;
  const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], derived.program)[0];
  if (intent.governanceProgram !== environment.governanceProgram
    || intent.programCodeSha256 !== environment.expectedProgramCodeSha256
    || intent.reserveMint !== environment.reserveMint || intent.reserveVault !== derived.ata.toBase58()
    || intent.capitalMint !== environment.capitalMint || intent.config !== derived.authority.toBase58()
    || intent.proposal !== addresses.proposal.toBase58() || intent.receipt !== receipt.toBase58()
    || intent.trader !== trader.toBase58() || intent.pool !== pin.pool) {
    throw new Error("GOVERNANCE_MARKETING_ROUTE_MISMATCH");
  }
  return { derived, id, addresses, receipt, trader };
}

function marketingIntent(input: SignedSolanaControlAction) {
  if (input.action !== "execute_marketing_sale" || !input.marketingExecution) {
    throw new Error("GOVERNANCE_MARKETING_ACTION_INVALID");
  }
  return input.marketingExecution;
}

export function verifySignedMarketingExecution(input: SignedSolanaControlAction, owner: string, now = Date.now()) {
  marketingIntent(input);
  return verifySignedSolanaControlAction(input, owner, now);
}

function required(account: AccountInfo<Buffer> | null, owner: PublicKey, length?: number) {
  if (!account || account.executable || !account.owner.equals(owner)
    || length !== undefined && account.data.length !== length) {
    throw new Error("GOVERNANCE_MARKETING_ACCOUNT_INVALID");
  }
  return account;
}

function fingerprint(account: AccountInfo<Buffer> | null) {
  return account ? { owner: account.owner.toBase58(), executable: account.executable,
    data: sha256(account.data) } : null;
}

/** Fresh finalized governance and venue reads from both providers. The voted
 * minimum, not a fabricated CLMM quote, controls the atomic onchain sale. */
export async function auditMarketingExecution(environment: MarketingExecutionReadEnvironment, proposalId: string) {
  const derived = route(environment);
  const id = positiveU64(proposalId, "GOVERNANCE_MARKETING_ID_INVALID");
  const addresses = governanceAddresses(derived.program, id);
  const receipt = governanceExecutionReceiptAddresses(derived.program, addresses.proposal).marketing;
  const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], derived.program)[0];
  const checkedRoute = await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram, expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority, reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint, admin: environment.admin,
  });
  if (checkedRoute.activeProposalId !== id || checkedRoute.committedRaw <= 0n
    || checkedRoute.vaultBalanceRaw < checkedRoute.committedRaw) {
    throw new Error("GOVERNANCE_MARKETING_COMMITMENT_INVALID");
  }
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([
        derived.authority, addresses.proposal, receipt, trader, new PublicKey(environment.capitalMint),
      ], { commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) {
      throw new Error("GOVERNANCE_MARKETING_RPC_STALE");
    }
    const [configInfo, proposalInfo, receiptInfo, traderInfo, capitalInfo] = read.value;
    const config = await parseGovernanceConfig(required(configInfo, derived.program, 306));
    const proposal = await parseGovernanceProposal(addresses.proposal.toBase58(),
      required(proposalInfo, derived.program, 726));
    required(capitalInfo, new PublicKey(config.capitalTokenProgram));
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((program) => program.toBase58() === config.capitalTokenProgram)
      || !traderInfo || traderInfo.executable || !traderInfo.owner.equals(SystemProgram.programId)
      || traderInfo.data.length !== 0 || receiptInfo !== null
      || config.admin !== environment.admin || config.capitalMint !== environment.capitalMint
      || config.reserveMint !== environment.reserveMint || config.reserveVault !== derived.ata.toBase58()
      || config.activeProposalId !== id || config.committedReserveRawMstrx !== checkedRoute.committedRaw
      || config.bump !== derived.bump || proposal.id !== id
      || proposal.config !== derived.authority.toBase58()
      || proposal.capitalMint !== environment.capitalMint
      || proposal.reserveVault !== derived.ata.toBase58()
      || proposal.status !== 1 || proposal.frozenReserveRawMstrx !== checkedRoute.committedRaw
      || proposal.executableAt !== proposal.endsAt + 300 || chainTime! < proposal.executableAt) {
      throw new Error("GOVERNANCE_MARKETING_DECISION_INVALID");
    }
    const winning = proposal.options[proposal.winningOption];
    if (!winning || winning.action !== "MARKETING_SALE"
      || winning.reserveRawMstrx !== checkedRoute.committedRaw
      || winning.minOutputRaw <= 0n || winning.recipient !== config.marketingWallet
      || winning.recipient === SystemProgram.programId.toBase58()
      || winning.lockDurationSeconds !== 0) {
      throw new Error("GOVERNANCE_MARKETING_OPTION_INVALID");
    }
    return {
      config: fingerprint(configInfo), proposal: fingerprint(proposalInfo), receipt: fingerprint(receiptInfo),
      trader: fingerprint(traderInfo), capital: fingerprint(capitalInfo), chainTime,
      capitalTokenProgram: config.capitalTokenProgram, recipient: winning.recipient,
      proposalStateSha256: sha256(proposalInfo!.data), frozenRaw: proposal.frozenReserveRawMstrx.toString(),
      votedMinSolLamports: winning.minOutputRaw.toString(), executableAt: proposal.executableAt,
      startsAt: proposal.startsAt, endsAt: proposal.endsAt,
    };
  }));
  const observation = requireMatchingValues(observations, "GOVERNANCE_MARKETING_RPC_DISAGREEMENT");
  // The recipient must be a normal System account as required by Rust, not an
  // executable program or a token account that could trap forwarded SOL.
  await Promise.all(environment.rpcUrls.map(async (url) => {
    const account = await new Connection(url, "finalized").getAccountInfo(
      new PublicKey(observation.recipient), { commitment: "finalized", minContextSlot: agreed.slot });
    if (!account || account.executable || !account.owner.equals(SystemProgram.programId)
      || account.data.length !== 0) throw new Error("GOVERNANCE_MARKETING_RECIPIENT_INVALID");
  }));
  const floor = BigInt(observation.votedMinSolLamports);
  const quote = await inspectPinnedMarketingSaleQuote({
    rpcUrls: environment.rpcUrls, trader: trader.toBase58(),
    exactInputMstrxRaw: checkedRoute.committedRaw,
    governanceMinSolLamports: floor, requestedMinSolLamports: floor,
    tickArrayCount: environment.tickArrayCount ?? 1,
  });
  const intent: MarketingExecutionIntent = {
    governanceProgram: environment.governanceProgram,
    programCodeSha256: environment.expectedProgramCodeSha256,
    reserveMint: environment.reserveMint, reserveVault: derived.ata.toBase58(),
    capitalMint: environment.capitalMint, capitalTokenProgram: observation.capitalTokenProgram,
    config: derived.authority.toBase58(), proposalId: id.toString(), proposal: addresses.proposal.toBase58(),
    receipt: receipt.toBase58(), trader: trader.toBase58(), recipient: observation.recipient,
    proposalStateSha256: observation.proposalStateSha256,
    frozenReserveRawMstrx: observation.frozenRaw,
    votedMinSolLamports: observation.votedMinSolLamports,
    executionMinSolLamports: observation.votedMinSolLamports,
    pool: pin.pool, bitmap: quote.bitmap, tickArrayAddresses: [...quote.tickArrayAddresses],
    executableAt: observation.executableAt, verifiedAt: Date.now(),
  };
  validateMarketingExecutionIntent(intent, intent.verifiedAt);
  const candidate = buildMarketingExecutionInstruction(environment, intent);
  const draft = buildExecuteMarketingSaleDraft({
    route: { governanceProgram: environment.governanceProgram,
      expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
      reserveAuthority: environment.reserveAuthority, reserveMint: environment.reserveMint,
      capitalMint: environment.capitalMint, admin: environment.admin },
    payer: environment.admin, capitalTokenProgram: intent.capitalTokenProgram,
    observedClockUnix: observation.chainTime!,
    proposalStatus: {
      id: intent.proposalId, status: 1, proposalStateSha256: intent.proposalStateSha256,
      frozenRaw: intent.frozenReserveRawMstrx, fixedMarketingWallet: intent.recipient,
      options: [{ action: "MARKETING_SALE", reserveRaw: intent.frozenReserveRawMstrx,
        minOutputRaw: intent.votedMinSolLamports, recipient: intent.recipient, lockDurationSeconds: 0 }],
      startsAt: observation.startsAt, endsAt: observation.endsAt,
      executableAt: intent.executableAt, winningAction: "MARKETING_SALE", updatedAt: intent.verifiedAt,
    },
    executionMinSolLamports: BigInt(intent.executionMinSolLamports),
    marketViews: quote.marketViews,
  });
  if (!draft.programId.equals(candidate.programId) || !draft.data.equals(candidate.data)
    || JSON.stringify(draft.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]))
      !== JSON.stringify(candidate.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]))) {
    throw new Error("GOVERNANCE_MARKETING_DRAFT_DISAGREEMENT");
  }
  return { intent, finalizedSlot: agreed.slot, finalizedBlockhash: agreed.blockhash,
    spotUpperBoundLamports: quote.spotUpperBoundLamports.toString(),
    theoreticalUpperBoundLamports: quote.theoreticalUpperBoundLamports.toString(),
    exactOutputQuoteLamports: null, quoteStatus: quote.quoteStatus };
}

/** Reconstructs the exact outer Anchor instruction solely from signed terms. */
export function buildMarketingExecutionInstruction(environment: MarketingExecutionReadEnvironment,
  intent: MarketingExecutionIntent) {
  const { derived, addresses, receipt, trader } = identities(environment, intent);
  const k = (value: string) => new PublicKey(value);
  const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta =>
    ({ pubkey, isWritable, isSigner });
  const wsol = k(pin.wsolMint);
  const keys = [
    meta(derived.authority, true), meta(addresses.proposal, true), meta(receipt, true),
    meta(derived.mint), meta(derived.ata, true), meta(trader, true),
    meta(getAssociatedTokenAddressSync(derived.mint, trader, true, TOKEN_2022_PROGRAM_ID), true),
    meta(getAssociatedTokenAddressSync(wsol, trader, true, TOKEN_PROGRAM_ID), true),
    meta(k(intent.recipient), true), meta(k(pin.program)), meta(k(pin.pool), true),
    meta(k(pin.config)), meta(k(pin.observation), true), meta(wsol),
    meta(k(pin.mstrxVault), true), meta(k(pin.wsolVault), true), meta(k(intent.bitmap), true),
    meta(memo), meta(k(environment.admin), true, true), meta(TOKEN_PROGRAM_ID),
    meta(TOKEN_2022_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
    ...intent.tickArrayAddresses.map((tick) => meta(k(tick), true)),
  ];
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(positiveU64(intent.executionMinSolLamports, "GOVERNANCE_MARKETING_FLOOR_INVALID"));
  const data = Buffer.concat([createHash("sha256").update("global:execute_marketing_sale").digest().subarray(0, 8), amount]);
  return new TransactionInstruction({ programId: derived.program, keys, data });
}

function assertExactSignedTransaction(environment: MarketingExecutionEnvironment,
  intent: MarketingExecutionIntent, prepared: Prepared) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64")); }
  catch { throw new Error("GOVERNANCE_MARKETING_TRANSACTION_INVALID"); }
  const expected = buildMarketingExecutionInstruction(environment, intent);
  const keys = tx.message.staticAccountKeys;
  const ix = tx.message.compiledInstructions[0];
  const owner = new PublicKey(environment.admin);
  const unique = new Set([environment.admin, expected.programId.toBase58(),
    ...expected.keys.map((account) => account.pubkey.toBase58())]);
  if (tx.message.version !== 0 || tx.message.addressTableLookups.length !== 0
    || tx.message.compiledInstructions.length !== 1 || !ix || keys.length !== unique.size
    || !keys[0]?.equals(owner) || tx.message.header.numRequiredSignatures !== 1
    || tx.signatures.length !== 1 || !keys[ix.programIdIndex]?.equals(expected.programId)
    || ix.accountKeyIndexes.length !== expected.keys.length
    || !Buffer.from(ix.data).equals(expected.data)
    || tx.message.recentBlockhash !== prepared.blockhash
    || !Number.isSafeInteger(prepared.lastValidBlockHeight) || prepared.lastValidBlockHeight <= 0
    || bs58.encode(tx.signatures[0]) !== prepared.signature
    || !nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], owner.toBytes())
    || tx.message.isAccountWritable(ix.programIdIndex)) {
    throw new Error("GOVERNANCE_MARKETING_TRANSACTION_INVALID");
  }
  for (let index = 0; index < expected.keys.length; index++) {
    const account = expected.keys[index];
    const keyIndex = ix.accountKeyIndexes[index];
    if (!keys[keyIndex]?.equals(account.pubkey)
      || tx.message.isAccountSigner(keyIndex) !== account.isSigner
      || tx.message.isAccountWritable(keyIndex) !== account.isWritable) {
      throw new Error("GOVERNANCE_MARKETING_TRANSACTION_INVALID");
    }
  }
}

async function verifyCompletedMarketing(environment: MarketingExecutionEnvironment,
  intent: MarketingExecutionIntent) {
  const { derived, id, addresses, receipt } = identities(environment, intent);
  await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority, reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint, admin: environment.admin,
  });
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([
        derived.authority, addresses.proposal, receipt,
      ], { commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) {
      throw new Error("GOVERNANCE_MARKETING_RPC_STALE");
    }
    const [configInfo, proposalInfo, receiptInfo] = read.value;
    const config = await parseGovernanceConfig(required(configInfo, derived.program, 306));
    const proposal = await parseGovernanceProposal(addresses.proposal.toBase58(),
      required(proposalInfo, derived.program, 726));
    if (proposal.id !== id || proposal.status !== 4 || proposal.config !== derived.authority.toBase58()
      || proposal.capitalMint !== intent.capitalMint || proposal.reserveVault !== derived.ata.toBase58()
      || proposal.frozenReserveRawMstrx.toString() !== intent.frozenReserveRawMstrx
      || proposal.options[proposal.winningOption]?.action !== "MARKETING_SALE"
      || proposal.options[proposal.winningOption]?.minOutputRaw.toString() !== intent.votedMinSolLamports
      || proposal.options[proposal.winningOption]?.recipient !== intent.recipient
      || config.admin !== environment.admin || config.reserveVault !== derived.ata.toBase58()
      || config.activeProposalId === id || config.lastProposalId < id
      || (config.activeProposalId === 0n) !== (config.committedReserveRawMstrx === 0n)) {
      throw new Error("GOVERNANCE_MARKETING_COMPLETION_INVALID");
    }
    const verified = await inspectGovernanceExecutionReceipt(derived.program, derived.authority,
      config, addresses.proposal, proposal, null, receiptInfo, chainTime!);
    if (!verified || verified.kind !== "MARKETING_SALE"
      || verified.actualOutputRaw < BigInt(intent.executionMinSolLamports)
      || verified.inputRawMstrx.toString() !== intent.frozenReserveRawMstrx
      || verified.destination !== intent.recipient || verified.venue !== pin.pool) {
      throw new Error("GOVERNANCE_MARKETING_COMPLETION_INVALID");
    }
    return { config: fingerprint(configInfo), proposal: fingerprint(proposalInfo),
      receipt: fingerprint(receiptInfo), actual: verified.actualOutputRaw.toString() };
  }));
  requireMatchingValues(observations, "GOVERNANCE_MARKETING_COMPLETION_RPC_DISAGREEMENT");
}

async function transactionState(environment: MarketingExecutionEnvironment, prepared: Prepared,
  intent: MarketingExecutionIntent) {
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [status, height] = await Promise.all([
      connection.getSignatureStatuses([prepared.signature], { searchTransactionHistory: true }),
      connection.getBlockHeight("finalized"),
    ]);
    return { status: status.value[0], height };
  }));
  if (observations.every(({ status }) => status?.confirmationStatus === "finalized")) {
    requireMatchingValues(observations.map(({ status }) => JSON.stringify(status!.err)),
      "GOVERNANCE_MARKETING_SIGNATURE_RPC_DISAGREEMENT");
    if (observations[0].status!.err) return "failed" as const;
    await verifyCompletedMarketing(environment, intent);
    return "finalized" as const;
  }
  if (observations.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) {
    return "unresolved" as const;
  }
  return "pending" as const;
}

function productionEffects(environment: MarketingExecutionEnvironment): MarketingExecutionEffects {
  // Both onchain and offchain release gates remain closed until the disposable
  // canary and receipt checks are reviewed. No caller can opt out of this gate.
  requireGovernanceExecutionReleased();
  if (!MARKETING_EXECUTION_CONTROL_RELEASED) {
    throw new Error("GOVERNANCE_MARKETING_EXECUTION_NOT_RELEASED");
  }
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  const fallback = new Connection(environment.rpcUrls[1], "confirmed");
  return {
    audit: async (proposalId) => (await auditMarketingExecution(environment, proposalId)).intent,
    prepare: async (instruction) => {
      const signer = await loadKeypair(environment.adminKeypairPath);
      if (signer.publicKey.toBase58() !== environment.admin) {
        throw new Error("GOVERNANCE_MARKETING_ADMIN_KEY_MISMATCH");
      }
      // prepareSignedTransaction simulates the exact signed instruction before
      // returning; a failure never reaches the durable broadcast phase.
      const prepared = await prepareSignedTransaction({ connection, payer: signer, instructions: [instruction] });
      await requireFallbackMarketingSimulation(fallback, prepared);
      const height = await connection.getBlockHeight("confirmed");
      if (!Number.isSafeInteger(height) || prepared.lastValidBlockHeight <= height
        || prepared.lastValidBlockHeight > height + 300) {
        throw new Error("GOVERNANCE_MARKETING_BLOCKHASH_WINDOW_INVALID");
      }
      return prepared;
    },
    broadcast: async (prepared) => {
      const returned = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (returned !== prepared.signature) throw new Error("GOVERNANCE_MARKETING_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared, intent) => transactionState(environment, prepared, intent),
  };
}

/** The secondary provider must simulate the exact signed bytes already
 * simulated by prepareSignedTransaction on primary, before any durable ledger
 * entry or broadcast. No rebuilt or newly signed transaction is accepted. */
export async function requireFallbackMarketingSimulation(
  fallback: Pick<Connection, "simulateTransaction">,
  prepared: Prepared,
) {
  const raw = Buffer.from(prepared.transactionBase64, "base64");
  let transaction: VersionedTransaction;
  try { transaction = VersionedTransaction.deserialize(raw); }
  catch { throw new Error("GOVERNANCE_MARKETING_FALLBACK_TRANSACTION_INVALID"); }
  if (!Buffer.from(transaction.serialize()).equals(raw)
    || bs58.encode(transaction.signatures[0]) !== prepared.signature
    || transaction.message.recentBlockhash !== prepared.blockhash) {
    throw new Error("GOVERNANCE_MARKETING_FALLBACK_TRANSACTION_INVALID");
  }
  const simulation = await fallback.simulateTransaction(transaction, {
    commitment: "confirmed", sigVerify: true,
  });
  if (simulation.value.err) {
    throw new Error(`GOVERNANCE_MARKETING_FALLBACK_SIMULATION_FAILED:${JSON.stringify(simulation.value.err)}`);
  }
}

async function readLedger(environment: MarketingExecutionEnvironment) {
  const ledger = await readJsonIfExists<MarketingExecutionLedger>(ledgerPath(environment));
  if (!ledger) return undefined;
  if (ledger.version !== 1 || !["prepared", "pending", "finalized", "failed", "unresolved"].includes(ledger.state)
    || !/^\d+-[a-f0-9]{16}$/.test(ledger.requestId)
    || !ledger.transaction?.signature || !ledger.transaction.transactionBase64
    || sha256(Buffer.from(ledger.transaction.transactionBase64, "base64")) !== ledger.transactionSha256) {
    throw new Error("GOVERNANCE_MARKETING_LEDGER_INVALID");
  }
  verifySignedMarketingExecution(ledger.authorization, environment.admin, ledger.authorization.issuedAt);
  identities(environment, marketingIntent(ledger.authorization));
  assertExactSignedTransaction(environment, marketingIntent(ledger.authorization), ledger.transaction);
  return ledger;
}

export async function reconcileMarketingExecution(environment: MarketingExecutionEnvironment,
  effects: MarketingExecutionEffects = productionEffects(environment)): Promise<MarketingExecutionLedger | undefined> {
  const ledger = await readLedger(environment);
  if (!ledger) return ledger;
  if (ledger.state === "finalized" || ledger.state === "failed") return ledger;
  const state = await effects.transactionState(ledger.transaction, marketingIntent(ledger.authorization));
  if (ledger.state === "unresolved" && state !== "finalized" && state !== "failed") return ledger;
  if (state === "pending") {
    await effects.broadcast(ledger.transaction); // same signed bytes, never a new transaction
    if (ledger.state !== "pending") {
      ledger.state = "pending"; ledger.updatedAt = Date.now();
      await writeDurableJson(ledgerPath(environment), ledger);
    }
    return ledger;
  }
  ledger.state = state; ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(environment), ledger);
  return ledger;
}

/** Private panel session and single-runner serialization are caller concerns. */
export async function executeMarketingDecision(environment: MarketingExecutionEnvironment,
  request: { requestId: string; authorization: SignedSolanaControlAction },
  effects: MarketingExecutionEffects = productionEffects(environment)): Promise<MarketingExecutionLedger> {
  if (!/^\d+-[a-f0-9]{16}$/.test(request.requestId)) {
    throw new Error("GOVERNANCE_MARKETING_REQUEST_INVALID");
  }
  verifySignedMarketingExecution(request.authorization, environment.admin);
  const previous = await reconcileMarketingExecution(environment, effects);
  if (previous && ["prepared", "pending"].includes(previous.state)) {
    throw new Error("GOVERNANCE_MARKETING_PENDING_RECONCILIATION");
  }
  if (previous?.state === "unresolved") throw new Error("GOVERNANCE_MARKETING_UNRESOLVED_REVIEW_REQUIRED");
  if (previous?.authorization.nonce === request.authorization.nonce
    || previous?.state === "finalized"
      && marketingIntent(previous.authorization).proposalId === marketingIntent(request.authorization).proposalId
    || await readJsonIfExists(historyPath(environment, request.authorization.nonce))) {
    throw new Error("GOVERNANCE_MARKETING_REPLAY");
  }
  const signedIntent = marketingIntent(request.authorization);
  identities(environment, signedIntent);
  const freshIntent = await effects.audit(signedIntent.proposalId);
  const { verifiedAt: _signedAt, ...signedTerms } = signedIntent;
  const { verifiedAt: _freshAt, ...freshTerms } = freshIntent;
  if (JSON.stringify(signedTerms) !== JSON.stringify(freshTerms)) {
    throw new Error("GOVERNANCE_MARKETING_PREVIEW_CHANGED");
  }
  const transaction = await effects.prepare(buildMarketingExecutionInstruction(environment, signedIntent));
  assertExactSignedTransaction(environment, signedIntent, transaction);
  if (previous) await writeDurableJson(historyPath(environment, previous.authorization.nonce), previous);
  const ledger: MarketingExecutionLedger = {
    version: 1, requestId: request.requestId, authorization: request.authorization, transaction,
    transactionSha256: sha256(Buffer.from(transaction.transactionBase64, "base64")),
    state: "prepared", updatedAt: Date.now(),
  };
  await writeDurableJson(ledgerPath(environment), ledger);
  await effects.broadcast(transaction);
  ledger.state = "pending"; ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(environment), ledger);
  return ledger;
}
