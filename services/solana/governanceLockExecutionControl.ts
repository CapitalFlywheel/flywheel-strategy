import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  AccountState, getDefaultAccountState, getPausableConfig, getTransferFeeConfig,
  getTransferHook, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction,
  type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  governanceAddresses, governanceLockAddresses, inspectGovernanceLock,
  parseGovernanceConfig, parseGovernanceProposal,
} from "../../apps/web/src/governanceClient";
import { validateLockExecutionIntent, verifySignedSolanaControlAction,
  type LockExecutionIntent, type SignedSolanaControlAction } from "./controlAuth";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { buildExecuteLockMstrxDraft, type GovernanceExecutionDraft } from "./governanceExecutionInstruction";
import { deriveGovernanceReserveRoute, verifyGovernanceReserveRoute } from "./governanceVaultRoute";
import { requireGovernanceExecutionReleased } from "./releaseGates";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type LedgerState = "prepared" | "pending" | "finalized" | "failed" | "unresolved";
const MAX_U64 = (1n << 64n) - 1n;
const LOCK_TERMS = new Set([30, 90, 180, 365, 730, 1095, 1825].map((days) => days * 86_400).concat(0xffff_ffff));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export interface LockExecutionEnvironment {
  rpcUrls: readonly [string, string];
  stateRoot: string;
  governanceProgram: string;
  expectedProgramCodeSha256: string;
  reserveAuthority: string;
  reserveMint: string;
  capitalMint: string;
  admin: string;
  adminKeypairPath: string;
}

export type LockExecutionReadEnvironment = Omit<LockExecutionEnvironment, "stateRoot" | "adminKeypairPath">;

/** Every economic term is in the owner's signed challenge. The reserve amount
 * and duration come from finalized onchain Proposal bytes, never a UI quote. */
export type SignedLockExecution = SignedSolanaControlAction & {
  action: "execute_lock_mstrx";
  lockExecution: LockExecutionIntent;
};

export interface LockExecutionLedger {
  version: 1;
  requestId: string;
  authorization: SignedSolanaControlAction;
  transaction: Prepared;
  transactionSha256: string;
  state: LedgerState;
  updatedAt: number;
}

interface Effects {
  audit: (proposalId: string) => Promise<LockExecutionIntent>;
  prepare: (instruction: TransactionInstruction) => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared, intent: LockExecutionIntent) => Promise<"pending" | "unresolved" | "failed" | "finalized">;
}

const ledgerPath = (environment: LockExecutionEnvironment) => resolve(environment.stateRoot, "governance-lock-execution.json");
const historyPath = (environment: LockExecutionEnvironment, nonce: string) =>
  resolve(environment.stateRoot, "governance-lock-execution-history", `${nonce}.json`);

function canonicalKey(value: string, code: string) {
  try {
    if (new PublicKey(value).toBase58() !== value) throw new Error();
    return new PublicKey(value);
  } catch { throw new Error(code); }
}

function positiveU64(value: string, code: string) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new Error(code);
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error(code);
  return parsed;
}

function route(environment: LockExecutionReadEnvironment) {
  const derived = deriveGovernanceReserveRoute(environment.governanceProgram, environment.reserveMint);
  if (derived.authority.toBase58() !== environment.reserveAuthority
    || !/^[a-f0-9]{64}$/.test(environment.expectedProgramCodeSha256)) {
    throw new Error("GOVERNANCE_LOCK_ROUTE_INVALID");
  }
  canonicalKey(environment.capitalMint, "GOVERNANCE_LOCK_ROUTE_INVALID");
  canonicalKey(environment.admin, "GOVERNANCE_LOCK_ROUTE_INVALID");
  return derived;
}

function identities(environment: LockExecutionReadEnvironment, intent: LockExecutionIntent) {
  validateLockExecutionIntent(intent, intent.verifiedAt);
  const derived = route(environment);
  const id = positiveU64(intent.proposalId, "GOVERNANCE_LOCK_ID_INVALID");
  const addresses = governanceAddresses(derived.program, id);
  const lock = governanceLockAddresses(derived.program, addresses.proposal, derived.mint);
  if (intent.governanceProgram !== environment.governanceProgram
    || intent.programCodeSha256 !== environment.expectedProgramCodeSha256
    || intent.reserveMint !== environment.reserveMint || intent.reserveVault !== derived.ata.toBase58()
    || intent.capitalMint !== environment.capitalMint || intent.config !== derived.authority.toBase58()
    || intent.proposal !== addresses.proposal.toBase58()
    || intent.lockRecord !== lock.record.toBase58() || intent.lockVault !== lock.escrow.toBase58()) {
    throw new Error("GOVERNANCE_LOCK_ROUTE_MISMATCH");
  }
  return { derived, id, addresses, lock };
}

export function verifySignedLockExecution(input: SignedSolanaControlAction, owner: string, now = Date.now()) {
  if (input.action !== "execute_lock_mstrx" || !input.lockExecution) {
    throw new Error("GOVERNANCE_LOCK_ACTION_INVALID");
  }
  return verifySignedSolanaControlAction(input, owner, now);
}

function lockIntent(input: SignedSolanaControlAction) {
  if (input.action !== "execute_lock_mstrx" || !input.lockExecution) {
    throw new Error("GOVERNANCE_LOCK_ACTION_INVALID");
  }
  return input.lockExecution;
}

function fingerprint(account: AccountInfo<Buffer> | null) {
  return account ? { owner: account.owner.toBase58(), executable: account.executable,
    data: sha256(account.data) } : null;
}

function requiredAccount(account: AccountInfo<Buffer> | null, owner: PublicKey, length?: number) {
  if (!account || account.executable || !account.owner.equals(owner)
    || (length !== undefined && account.data.length !== length)) throw new Error("GOVERNANCE_LOCK_ACCOUNT_INVALID");
  return account;
}

function assertMstrxMint(account: AccountInfo<Buffer> | null, mintAddress: PublicKey) {
  const info = requiredAccount(account, TOKEN_2022_PROGRAM_ID);
  let mint;
  try { mint = unpackMint(mintAddress, info, TOKEN_2022_PROGRAM_ID); }
  catch { throw new Error("GOVERNANCE_LOCK_MSTRX_MINT_INVALID"); }
  if (!mint.isInitialized || mint.decimals !== 8
    || !getTransferHook(mint)?.programId.equals(PublicKey.default)
    || getTransferFeeConfig(mint) || getPausableConfig(mint)?.paused
    || getDefaultAccountState(mint)?.state !== AccountState.Initialized) {
    throw new Error("GOVERNANCE_LOCK_MSTRX_SEMANTICS_UNSUPPORTED");
  }
}

function assertPreexistingEscrow(info: AccountInfo<Buffer> | null, escrow: PublicKey,
  record: PublicKey, mint: PublicKey) {
  if (!info) return 0n;
  const account = unpackAccount(escrow, requiredAccount(info, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  if (!account.isInitialized || account.isFrozen || !account.owner.equals(record) || !account.mint.equals(mint)
    || account.delegate !== null || account.closeAuthority !== null) throw new Error("GOVERNANCE_LOCK_ESCROW_INVALID");
  return account.amount;
}

/** A fresh two-RPC read of the exact passed proposal, config, mint policy and
 * optional precreated ATA. The LockRecord must not already exist. */
export async function auditLockExecution(environment: LockExecutionReadEnvironment, proposalId: string) {
  const derived = route(environment);
  const id = positiveU64(proposalId, "GOVERNANCE_LOCK_ID_INVALID");
  const addresses = governanceAddresses(derived.program, id);
  const lock = governanceLockAddresses(derived.program, addresses.proposal, derived.mint);
  const checkedRoute = await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram, expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority, reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint, admin: environment.admin,
  });
  if (checkedRoute.activeProposalId !== id || checkedRoute.committedRaw <= 0n
    || checkedRoute.vaultBalanceRaw < checkedRoute.committedRaw) throw new Error("GOVERNANCE_LOCK_COMMITMENT_INVALID");
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([
        derived.authority, addresses.proposal, derived.mint, new PublicKey(environment.capitalMint),
        lock.record, lock.escrow,
      ], { commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) {
      throw new Error("GOVERNANCE_LOCK_RPC_STALE");
    }
    const [configInfo, proposalInfo, mintInfo, capitalInfo, recordInfo, escrowInfo] = read.value;
    const config = await parseGovernanceConfig(requiredAccount(configInfo, derived.program, 306));
    const proposal = await parseGovernanceProposal(addresses.proposal.toBase58(),
      requiredAccount(proposalInfo, derived.program, 726));
    assertMstrxMint(mintInfo, derived.mint);
    const capital = requiredAccount(capitalInfo, new PublicKey(config.capitalTokenProgram));
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((program) => capital.owner.equals(program))) {
      throw new Error("GOVERNANCE_LOCK_CAPITAL_PROGRAM_INVALID");
    }
    const baselineEscrowRawMstrx = assertPreexistingEscrow(escrowInfo, lock.escrow, lock.record, derived.mint);
    if (recordInfo !== null || config.admin !== environment.admin
      || config.capitalMint !== environment.capitalMint || config.reserveMint !== environment.reserveMint
      || config.reserveVault !== derived.ata.toBase58() || config.activeProposalId !== id
      || config.committedReserveRawMstrx !== checkedRoute.committedRaw || config.bump !== derived.bump
      || proposal.id !== id || proposal.config !== derived.authority.toBase58()
      || proposal.capitalMint !== environment.capitalMint || proposal.reserveVault !== derived.ata.toBase58()
      || proposal.status !== 1 || proposal.frozenReserveRawMstrx !== checkedRoute.committedRaw
      || proposal.executableAt !== proposal.endsAt + 300 || chainTime! < proposal.executableAt) {
      throw new Error("GOVERNANCE_LOCK_DECISION_INVALID");
    }
    const winning = proposal.options[proposal.winningOption];
    if (!winning || winning.action !== "LOCK_MSTRX" || winning.reserveRawMstrx !== checkedRoute.committedRaw
      || winning.minOutputRaw !== 0n || winning.recipient !== SystemProgram.programId.toBase58()
      || !LOCK_TERMS.has(winning.lockDurationSeconds)) throw new Error("GOVERNANCE_LOCK_OPTION_INVALID");
    return {
      config: fingerprint(configInfo), proposal: fingerprint(proposalInfo), mint: fingerprint(mintInfo),
      capital: fingerprint(capitalInfo), record: fingerprint(recordInfo), escrow: fingerprint(escrowInfo),
      chainTime, capitalTokenProgram: config.capitalTokenProgram,
      proposalStateSha256: sha256(proposalInfo!.data), frozenRaw: proposal.frozenReserveRawMstrx.toString(),
      executableAt: proposal.executableAt, lockDurationSeconds: winning.lockDurationSeconds,
      baselineEscrowRawMstrx: baselineEscrowRawMstrx.toString(),
    };
  }));
  const observation = requireMatchingValues(observations, "GOVERNANCE_LOCK_RPC_DISAGREEMENT");
  const intent: LockExecutionIntent = {
    governanceProgram: environment.governanceProgram, programCodeSha256: environment.expectedProgramCodeSha256,
    reserveMint: environment.reserveMint, reserveVault: derived.ata.toBase58(),
    capitalMint: environment.capitalMint, capitalTokenProgram: observation.capitalTokenProgram,
    config: derived.authority.toBase58(), proposalId: id.toString(), proposal: addresses.proposal.toBase58(),
    lockRecord: lock.record.toBase58(), lockVault: lock.escrow.toBase58(),
    proposalStateSha256: observation.proposalStateSha256, frozenReserveRawMstrx: observation.frozenRaw,
    lockDurationSeconds: observation.lockDurationSeconds, executableAt: observation.executableAt,
    verifiedAt: Date.now(),
  };
  validateLockExecutionIntent(intent, intent.verifiedAt);
  return { intent, baselineEscrowRawMstrx: observation.baselineEscrowRawMstrx,
    finalizedSlot: agreed.slot, finalizedBlockhash: agreed.blockhash };
}

function draftFromIntent(environment: LockExecutionEnvironment, intent: LockExecutionIntent): GovernanceExecutionDraft {
  identities(environment, intent);
  return buildExecuteLockMstrxDraft({
    route: { governanceProgram: environment.governanceProgram,
      expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
      reserveAuthority: environment.reserveAuthority, reserveMint: environment.reserveMint,
      capitalMint: environment.capitalMint, admin: environment.admin },
    payer: environment.admin, capitalTokenProgram: intent.capitalTokenProgram,
    observedClockUnix: intent.executableAt,
    proposalStatus: {
      id: intent.proposalId, status: 1, proposalStateSha256: intent.proposalStateSha256,
      frozenRaw: intent.frozenReserveRawMstrx, fixedMarketingWallet: SystemProgram.programId.toBase58(),
      options: [{ action: "LOCK_MSTRX", reserveRaw: intent.frozenReserveRawMstrx, minOutputRaw: "0",
        recipient: SystemProgram.programId.toBase58(), lockDurationSeconds: intent.lockDurationSeconds }],
      startsAt: intent.executableAt - 301, endsAt: intent.executableAt - 300,
      executableAt: intent.executableAt, winningAction: "LOCK_MSTRX", updatedAt: intent.verifiedAt,
    },
  });
}

export function buildLockExecutionInstruction(environment: LockExecutionEnvironment, intent: LockExecutionIntent) {
  const draft = draftFromIntent(environment, intent);
  return new TransactionInstruction({ programId: draft.programId, keys: [...draft.keys], data: draft.data });
}

function assertExactSignedTransaction(environment: LockExecutionEnvironment, intent: LockExecutionIntent, prepared: Prepared) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64")); }
  catch { throw new Error("GOVERNANCE_LOCK_TRANSACTION_INVALID"); }
  const expected = buildLockExecutionInstruction(environment, intent);
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
    || tx.message.isAccountWritable(ix.programIdIndex)) throw new Error("GOVERNANCE_LOCK_TRANSACTION_INVALID");
  for (let index = 0; index < expected.keys.length; index++) {
    const account = expected.keys[index];
    const keyIndex = ix.accountKeyIndexes[index];
    if (!keys[keyIndex]?.equals(account.pubkey)
      || tx.message.isAccountSigner(keyIndex) !== account.isSigner
      || tx.message.isAccountWritable(keyIndex) !== account.isWritable) {
      throw new Error("GOVERNANCE_LOCK_TRANSACTION_INVALID");
    }
  }
}

async function verifyCompletedLock(environment: LockExecutionEnvironment, intent: LockExecutionIntent) {
  const { derived, id, addresses, lock } = identities(environment, intent);
  await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram, expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority, reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint, admin: environment.admin,
  });
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([
        derived.authority, addresses.proposal, lock.record, lock.escrow,
      ], { commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) throw new Error("GOVERNANCE_LOCK_RPC_STALE");
    const [configInfo, proposalInfo, recordInfo, escrowInfo] = read.value;
    const config = await parseGovernanceConfig(requiredAccount(configInfo, derived.program, 306));
    const proposal = await parseGovernanceProposal(addresses.proposal.toBase58(),
      requiredAccount(proposalInfo, derived.program, 726));
    if (proposal.id !== id || proposal.status !== 4 || proposal.config !== derived.authority.toBase58()
      || proposal.capitalMint !== intent.capitalMint || proposal.reserveVault !== derived.ata.toBase58()
      || proposal.frozenReserveRawMstrx.toString() !== intent.frozenReserveRawMstrx
      || proposal.options[proposal.winningOption]?.action !== "LOCK_MSTRX"
      || proposal.options[proposal.winningOption]?.lockDurationSeconds !== intent.lockDurationSeconds
      || config.admin !== environment.admin || config.reserveVault !== derived.ata.toBase58()
      || config.activeProposalId === id || config.lastProposalId < id
      || (config.activeProposalId === 0n) !== (config.committedReserveRawMstrx === 0n)) {
      throw new Error("GOVERNANCE_LOCK_COMPLETION_INVALID");
    }
    const verified = await inspectGovernanceLock(derived.program, derived.authority, config,
      addresses.proposal, proposal, derived.mint, recordInfo, escrowInfo, chainTime!);
    if (verified.record.amount.toString() !== intent.frozenReserveRawMstrx) {
      throw new Error("GOVERNANCE_LOCK_COMPLETION_INVALID");
    }
    return { config: fingerprint(configInfo), proposal: fingerprint(proposalInfo),
      record: fingerprint(recordInfo), escrow: fingerprint(escrowInfo), amount: verified.record.amount.toString() };
  }));
  requireMatchingValues(observations, "GOVERNANCE_LOCK_COMPLETION_RPC_DISAGREEMENT");
}

async function transactionState(environment: LockExecutionEnvironment, prepared: Prepared, intent: LockExecutionIntent) {
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [status, height] = await Promise.all([
      connection.getSignatureStatuses([prepared.signature], { searchTransactionHistory: true }),
      connection.getBlockHeight("finalized"),
    ]);
    return { status: status.value[0], height };
  }));
  if (observations.every(({ status }) => status?.confirmationStatus === "finalized")) {
    const errors = observations.map(({ status }) => JSON.stringify(status!.err));
    requireMatchingValues(errors, "GOVERNANCE_LOCK_SIGNATURE_RPC_DISAGREEMENT");
    if (observations[0].status!.err) return "failed" as const;
    await verifyCompletedLock(environment, intent);
    return "finalized" as const;
  }
  if (observations.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) {
    return "unresolved" as const;
  }
  return "pending" as const;
}

function productionEffects(environment: LockExecutionEnvironment): Effects {
  requireGovernanceExecutionReleased();
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  return {
    audit: async (proposalId) => (await auditLockExecution(environment, proposalId)).intent,
    prepare: async (instruction) => {
      const signer = await loadKeypair(environment.adminKeypairPath);
      if (signer.publicKey.toBase58() !== environment.admin) throw new Error("GOVERNANCE_LOCK_ADMIN_KEY_MISMATCH");
      const prepared = await prepareSignedTransaction({ connection, payer: signer, instructions: [instruction] });
      const height = await connection.getBlockHeight("confirmed");
      if (!Number.isSafeInteger(height) || prepared.lastValidBlockHeight <= height
        || prepared.lastValidBlockHeight > height + 300) throw new Error("GOVERNANCE_LOCK_BLOCKHASH_WINDOW_INVALID");
      return prepared;
    },
    broadcast: async (prepared) => {
      const returned = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (returned !== prepared.signature) throw new Error("GOVERNANCE_LOCK_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared, intent) => transactionState(environment, prepared, intent),
  };
}

async function readLedger(environment: LockExecutionEnvironment) {
  const ledger = await readJsonIfExists<LockExecutionLedger>(ledgerPath(environment));
  if (!ledger) return undefined;
  if (ledger.version !== 1 || !["prepared", "pending", "finalized", "failed", "unresolved"].includes(ledger.state)
    || !/^\d+-[a-f0-9]{16}$/.test(ledger.requestId)
    || !ledger.transaction?.signature || !ledger.transaction.transactionBase64
    || sha256(Buffer.from(ledger.transaction.transactionBase64, "base64")) !== ledger.transactionSha256) {
    throw new Error("GOVERNANCE_LOCK_LEDGER_INVALID");
  }
  // A historical authorization may be expired, but its signature and exact
  // signed transaction remain valid evidence for reconciliation after restart.
  verifySignedLockExecution(ledger.authorization, environment.admin, ledger.authorization.issuedAt);
  identities(environment, lockIntent(ledger.authorization));
  assertExactSignedTransaction(environment, lockIntent(ledger.authorization), ledger.transaction);
  return ledger;
}

export async function reconcileLockExecution(environment: LockExecutionEnvironment,
  effects: Effects = productionEffects(environment)): Promise<LockExecutionLedger | undefined> {
  const ledger = await readLedger(environment);
  if (!ledger) return ledger;
  // The transition to either terminal state required both providers to
  // finalize the signature. Historical signature lookups are not guaranteed
  // to remain available forever; keep the durable terminal result.
  if (ledger.state === "finalized" || ledger.state === "failed") return ledger;
  const state = await effects.transactionState(ledger.transaction, lockIntent(ledger.authorization));
  if (ledger.state === "unresolved" && state !== "finalized" && state !== "failed") return ledger;
  if (state === "pending") {
    // Re-send only the durable exact same signed transaction after a crash.
    await effects.broadcast(ledger.transaction);
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

/** Caller must additionally enforce the private control-panel session and
 * single runner. The owner challenge itself is verified here. */
export async function executeLockDecision(environment: LockExecutionEnvironment,
  request: { requestId: string; authorization: SignedSolanaControlAction },
  effects: Effects = productionEffects(environment)): Promise<LockExecutionLedger> {
  if (!/^\d+-[a-f0-9]{16}$/.test(request.requestId)) throw new Error("GOVERNANCE_LOCK_REQUEST_INVALID");
  verifySignedLockExecution(request.authorization, environment.admin);
  const previous = await reconcileLockExecution(environment, effects);
  if (previous && ["prepared", "pending"].includes(previous.state)) {
    throw new Error("GOVERNANCE_LOCK_PENDING_RECONCILIATION");
  }
  if (previous?.state === "unresolved") throw new Error("GOVERNANCE_LOCK_UNRESOLVED_REVIEW_REQUIRED");
  if (previous?.authorization.nonce === request.authorization.nonce
    || previous?.state === "finalized" && lockIntent(previous.authorization).proposalId === lockIntent(request.authorization).proposalId) {
    throw new Error("GOVERNANCE_LOCK_REPLAY");
  }
  if (await readJsonIfExists(historyPath(environment, request.authorization.nonce))) {
    throw new Error("GOVERNANCE_LOCK_REPLAY");
  }
  const signedIntent = lockIntent(request.authorization);
  identities(environment, signedIntent);
  const freshIntent = await effects.audit(signedIntent.proposalId);
  const { verifiedAt: _signedAt, ...signedTerms } = signedIntent;
  const { verifiedAt: _freshAt, ...freshTerms } = freshIntent;
  if (JSON.stringify(signedTerms) !== JSON.stringify(freshTerms)) throw new Error("GOVERNANCE_LOCK_PREVIEW_CHANGED");
  const transaction = await effects.prepare(buildLockExecutionInstruction(environment, signedIntent));
  assertExactSignedTransaction(environment, signedIntent, transaction);
  if (previous) await writeDurableJson(historyPath(environment, previous.authorization.nonce), previous);
  const ledger: LockExecutionLedger = {
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
