import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  AccountState, getDefaultAccountState, getPausableConfig, getTransferFeeConfig,
  getTransferHook, TOKEN_2022_PROGRAM_ID, unpackMint,
} from "@solana/spl-token";
import {
  Connection, PublicKey, TransactionInstruction, VersionedTransaction, type AccountInfo,
  type AccountMeta,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  governanceAddresses, governanceLockAddresses, inspectGovernanceLock,
  parseGovernanceConfig, parseGovernanceProposal,
} from "../../apps/web/src/governanceClient";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { deriveGovernanceReserveRoute, verifyGovernanceReserveRoute } from "./governanceVaultRoute";
import { requireGovernanceExecutionReleased } from "./releaseGates";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type LedgerState = "prepared" | "pending" | "finalized" | "failed" | "unresolved";
const MAX_U64 = (1n << 64n) - 1n;
const CHALLENGE_MS = 5 * 60_000;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const discriminator = createHash("sha256").update("global:release_lock_mstrx").digest().subarray(0, 8);

export interface LockReleaseEnvironment {
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

export type LockReleaseReadEnvironment = Omit<LockReleaseEnvironment, "stateRoot" | "adminKeypairPath">;

/** The onchain program releases the entire current escrow balance, including
 * donations. This amount is an audited observation, not an onchain cap. */
export interface LockReleaseIntent {
  governanceProgram: string;
  programCodeSha256: string;
  reserveMint: string;
  reserveVault: string;
  capitalMint: string;
  config: string;
  proposalId: string;
  proposal: string;
  lockRecord: string;
  lockVault: string;
  proposalStateSha256: string;
  lockRecordStateSha256: string;
  recordCommittedRawMstrx: string;
  observedEscrowRawMstrx: string;
  releaseAt: number;
  verifiedAt: number;
}

export interface SignedLockRelease {
  network: "solana-mainnet-beta";
  action: "release_lock_mstrx";
  signer: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
  lockRelease: LockReleaseIntent;
}

export interface LockReleaseLedger {
  version: 1;
  requestId: string;
  authorization: SignedLockRelease;
  transaction: Prepared;
  transactionSha256: string;
  state: LedgerState;
  updatedAt: number;
}

interface Effects {
  audit: (proposalId: string) => Promise<LockReleaseIntent>;
  prepare: (instruction: TransactionInstruction) => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared, intent: LockReleaseIntent) =>
    Promise<"pending" | "unresolved" | "failed" | "finalized">;
}

const ledgerPath = (environment: LockReleaseEnvironment) =>
  resolve(environment.stateRoot, "governance-lock-release.json");
const historyPath = (environment: LockReleaseEnvironment, nonce: string) =>
  resolve(environment.stateRoot, "governance-lock-release-history", nonce + ".json");

function canonicalKey(value: string, code: string) {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error();
    return key;
  } catch { throw new Error(code); }
}

function positiveU64(value: string, code: string) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new Error(code);
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error(code);
  return parsed;
}

function route(environment: LockReleaseReadEnvironment) {
  const derived = deriveGovernanceReserveRoute(environment.governanceProgram, environment.reserveMint);
  if (derived.authority.toBase58() !== environment.reserveAuthority
    || !/^[a-f0-9]{64}$/.test(environment.expectedProgramCodeSha256)) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_ROUTE_INVALID");
  }
  canonicalKey(environment.capitalMint, "GOVERNANCE_LOCK_RELEASE_ROUTE_INVALID");
  canonicalKey(environment.admin, "GOVERNANCE_LOCK_RELEASE_ROUTE_INVALID");
  return derived;
}

export function validateLockReleaseIntent(intent: LockReleaseIntent, issuedAt: number) {
  const fields = [
    "governanceProgram", "programCodeSha256", "reserveMint", "reserveVault", "capitalMint",
    "config", "proposalId", "proposal", "lockRecord", "lockVault", "proposalStateSha256",
    "lockRecordStateSha256", "recordCommittedRawMstrx", "observedEscrowRawMstrx",
    "releaseAt", "verifiedAt",
  ];
  if (!intent || Object.keys(intent).sort().join("|") !== fields.sort().join("|")) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_INTENT_FIELDS_INVALID");
  }
  let program: PublicKey;
  let mint: PublicKey;
  try {
    for (const address of [intent.governanceProgram, intent.reserveMint, intent.reserveVault,
      intent.capitalMint, intent.config, intent.proposal, intent.lockRecord, intent.lockVault]) {
      canonicalKey(address, "GOVERNANCE_LOCK_RELEASE_IDENTITY_INVALID");
    }
    program = new PublicKey(intent.governanceProgram);
    mint = new PublicKey(intent.reserveMint);
  } catch { throw new Error("GOVERNANCE_LOCK_RELEASE_IDENTITY_INVALID"); }
  const id = positiveU64(intent.proposalId, "GOVERNANCE_LOCK_RELEASE_ID_INVALID");
  const committed = positiveU64(intent.recordCommittedRawMstrx, "GOVERNANCE_LOCK_RELEASE_AMOUNT_INVALID");
  const observed = positiveU64(intent.observedEscrowRawMstrx, "GOVERNANCE_LOCK_RELEASE_AMOUNT_INVALID");
  if (observed < committed
    || !/^[a-f0-9]{64}$/.test(intent.programCodeSha256)
    || !/^[a-f0-9]{64}$/.test(intent.proposalStateSha256)
    || !/^[a-f0-9]{64}$/.test(intent.lockRecordStateSha256)
    || !Number.isSafeInteger(intent.releaseAt) || intent.releaseAt <= 0
    || !Number.isSafeInteger(intent.verifiedAt)
    || intent.verifiedAt > issuedAt + 30_000 || issuedAt - intent.verifiedAt > 90_000) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_INTENT_INVALID");
  }
  const addresses = governanceAddresses(program, id);
  const lock = governanceLockAddresses(program, addresses.proposal, mint);
  const derived = deriveGovernanceReserveRoute(intent.governanceProgram, intent.reserveMint);
  if (intent.config !== derived.authority.toBase58()
    || intent.reserveVault !== derived.ata.toBase58()
    || intent.proposal !== addresses.proposal.toBase58()
    || intent.lockRecord !== lock.record.toBase58()
    || intent.lockVault !== lock.escrow.toBase58()) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_PDA_MISMATCH");
  }
}

function identities(environment: LockReleaseReadEnvironment, intent: LockReleaseIntent) {
  validateLockReleaseIntent(intent, intent.verifiedAt);
  const derived = route(environment);
  const id = positiveU64(intent.proposalId, "GOVERNANCE_LOCK_RELEASE_ID_INVALID");
  const addresses = governanceAddresses(derived.program, id);
  const lock = governanceLockAddresses(derived.program, addresses.proposal, derived.mint);
  if (intent.governanceProgram !== environment.governanceProgram
    || intent.programCodeSha256 !== environment.expectedProgramCodeSha256
    || intent.reserveMint !== environment.reserveMint
    || intent.reserveVault !== derived.ata.toBase58()
    || intent.capitalMint !== environment.capitalMint
    || intent.config !== derived.authority.toBase58()
    || intent.proposal !== addresses.proposal.toBase58()
    || intent.lockRecord !== lock.record.toBase58()
    || intent.lockVault !== lock.escrow.toBase58()) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_ROUTE_MISMATCH");
  }
  return { derived, id, addresses, lock };
}

/** Exact fields to add to the generic SOLANA CONTROL challenge. */
export function lockReleaseMessage(input: Omit<SignedLockRelease, "signature">) {
  validateLockReleaseIntent(input.lockRelease, input.issuedAt);
  const release = input.lockRelease;
  return [
    "FLYWHEEL STRATEGY SOLANA CONTROL",
    "Action: release_lock_mstrx",
    "Owner: " + input.signer,
    "Network: Solana Mainnet Beta",
    "Allocation: 60% holders / 40% strategic reserve",
    "Governance program: " + release.governanceProgram,
    "Reviewed program SHA-256: " + release.programCodeSha256,
    "Reserve mint: " + release.reserveMint,
    "Canonical reserve vault: " + release.reserveVault,
    "Bound CAPITAL mint: " + release.capitalMint,
    "Config PDA: " + release.config,
    "Proposal ID: " + release.proposalId,
    "Proposal PDA: " + release.proposal,
    "Lock record PDA: " + release.lockRecord,
    "Lock vault ATA: " + release.lockVault,
    "Finalized proposal SHA-256: " + release.proposalStateSha256,
    "Finalized lock record SHA-256: " + release.lockRecordStateSha256,
    "Record committed raw MSTRx: " + release.recordCommittedRawMstrx,
    "Observed escrow raw MSTRx: " + release.observedEscrowRawMstrx,
    "Releases all current escrow to the canonical reserve vault",
    "Release at: " + new Date(release.releaseAt * 1_000).toISOString(),
    "Verified at: " + new Date(release.verifiedAt).toISOString(),
    "Issued: " + new Date(input.issuedAt).toISOString(),
    "Expires: " + new Date(input.expiresAt).toISOString(),
    "Nonce: " + input.nonce,
  ].join("\n");
}

export function verifySignedLockRelease(input: SignedLockRelease, owner: string, now = Date.now()) {
  if (input.network !== "solana-mainnet-beta" || input.action !== "release_lock_mstrx"
    || canonicalKey(input.signer, "GOVERNANCE_LOCK_RELEASE_SIGNER_INVALID").toBase58() !== owner
    || !Number.isSafeInteger(input.issuedAt) || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt !== input.issuedAt + CHALLENGE_MS
    || input.issuedAt > now + 30_000 || input.expiresAt < now
    || !/^[a-f0-9]{40}$/.test(input.nonce)) throw new Error("GOVERNANCE_LOCK_RELEASE_AUTH_INVALID");
  validateLockReleaseIntent(input.lockRelease, input.issuedAt);
  let signature: Uint8Array;
  try { signature = bs58.decode(input.signature); }
  catch { throw new Error("GOVERNANCE_LOCK_RELEASE_SIGNATURE_INVALID"); }
  if (signature.length !== 64 || !nacl.sign.detached.verify(
    new TextEncoder().encode(lockReleaseMessage(input)), signature, new PublicKey(owner).toBytes(),
  )) throw new Error("GOVERNANCE_LOCK_RELEASE_SIGNATURE_INVALID");
  return true;
}

function fingerprint(info: AccountInfo<Buffer> | null) {
  return info ? { owner: info.owner.toBase58(), executable: info.executable, data: sha256(info.data) } : null;
}

function requiredAccount(info: AccountInfo<Buffer> | null, owner: PublicKey, length?: number) {
  if (!info || info.executable || !info.owner.equals(owner)
    || (length !== undefined && info.data.length !== length)) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_ACCOUNT_INVALID");
  }
  return info;
}

function assertMintPolicy(info: AccountInfo<Buffer> | null, address: PublicKey) {
  const mint = unpackMint(address, requiredAccount(info, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  if (!mint.isInitialized || mint.decimals !== 8
    || !getTransferHook(mint)?.programId.equals(PublicKey.default)
    || getTransferFeeConfig(mint) || getPausableConfig(mint)?.paused
    || getDefaultAccountState(mint)?.state !== AccountState.Initialized) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_MINT_UNSAFE");
  }
}

/** A historical executed proposal is valid even while a later ballot is active. */
export async function auditLockRelease(environment: LockReleaseReadEnvironment, proposalId: string) {
  const derived = route(environment);
  const id = positiveU64(proposalId, "GOVERNANCE_LOCK_RELEASE_ID_INVALID");
  const addresses = governanceAddresses(derived.program, id);
  const lock = governanceLockAddresses(derived.program, addresses.proposal, derived.mint);
  const checkedRoute = await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority,
    reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint,
    admin: environment.admin,
  });
  if (checkedRoute.lastProposalId < id) throw new Error("GOVERNANCE_LOCK_RELEASE_PROPOSAL_NOT_FOUND");
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([
        derived.authority, addresses.proposal, lock.record, lock.escrow, derived.mint,
      ], { commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_RPC_STALE");
    }
    const [configInfo, proposalInfo, recordInfo, escrowInfo, mintInfo] = read.value;
    const config = await parseGovernanceConfig(requiredAccount(configInfo, derived.program, 306));
    const proposal = await parseGovernanceProposal(addresses.proposal.toBase58(),
      requiredAccount(proposalInfo, derived.program, 726));
    assertMintPolicy(mintInfo, derived.mint);
    if (config.admin !== environment.admin || config.capitalMint !== environment.capitalMint
      || config.reserveMint !== environment.reserveMint
      || config.reserveVault !== derived.ata.toBase58() || config.bump !== derived.bump
      || config.lastProposalId < id
      || proposal.id !== id || proposal.config !== derived.authority.toBase58()
      || proposal.capitalMint !== environment.capitalMint
      || proposal.reserveVault !== derived.ata.toBase58()
      || proposal.status !== 4) throw new Error("GOVERNANCE_LOCK_RELEASE_DECISION_INVALID");
    const verified = await inspectGovernanceLock(derived.program, derived.authority, config,
      addresses.proposal, proposal, derived.mint, recordInfo, escrowInfo, chainTime!);
    if (verified.record.status !== 0 || verified.record.durationSeconds === 0xffff_ffff
      || verified.record.releaseAt <= 0 || chainTime! < verified.record.releaseAt
      || verified.escrowBalanceRawMstrx < verified.record.amount) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_NOT_MATURE");
    }
    return {
      config: fingerprint(configInfo), proposal: fingerprint(proposalInfo),
      record: fingerprint(recordInfo), escrow: fingerprint(escrowInfo), mint: fingerprint(mintInfo),
      chainTime, committed: verified.record.amount.toString(),
      observedEscrow: verified.escrowBalanceRawMstrx.toString(),
      releaseAt: verified.record.releaseAt,
      proposalStateSha256: sha256(proposalInfo!.data),
      lockRecordStateSha256: sha256(recordInfo!.data),
    };
  }));
  const observation = requireMatchingValues(observations, "GOVERNANCE_LOCK_RELEASE_RPC_DISAGREEMENT");
  const intent: LockReleaseIntent = {
    governanceProgram: environment.governanceProgram,
    programCodeSha256: environment.expectedProgramCodeSha256,
    reserveMint: environment.reserveMint,
    reserveVault: derived.ata.toBase58(),
    capitalMint: environment.capitalMint,
    config: derived.authority.toBase58(),
    proposalId: id.toString(),
    proposal: addresses.proposal.toBase58(),
    lockRecord: lock.record.toBase58(),
    lockVault: lock.escrow.toBase58(),
    proposalStateSha256: observation.proposalStateSha256,
    lockRecordStateSha256: observation.lockRecordStateSha256,
    recordCommittedRawMstrx: observation.committed,
    observedEscrowRawMstrx: observation.observedEscrow,
    releaseAt: observation.releaseAt,
    verifiedAt: Date.now(),
  };
  validateLockReleaseIntent(intent, intent.verifiedAt);
  return { intent, finalizedSlot: agreed.slot, finalizedBlockhash: agreed.blockhash };
}

export function buildLockReleaseInstruction(environment: LockReleaseEnvironment, intent: LockReleaseIntent) {
  const { derived, lock } = identities(environment, intent);
  const keys: AccountMeta[] = [
    { pubkey: derived.authority, isWritable: false, isSigner: false },
    { pubkey: lock.record, isWritable: true, isSigner: false },
    { pubkey: derived.mint, isWritable: false, isSigner: false },
    { pubkey: derived.ata, isWritable: true, isSigner: false },
    { pubkey: lock.escrow, isWritable: true, isSigner: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
  ];
  return new TransactionInstruction({ programId: derived.program, keys, data: discriminator });
}

function assertExactSignedTransaction(environment: LockReleaseEnvironment, intent: LockReleaseIntent, prepared: Prepared) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64")); }
  catch { throw new Error("GOVERNANCE_LOCK_RELEASE_TRANSACTION_INVALID"); }
  const expected = buildLockReleaseInstruction(environment, intent);
  const keys = tx.message.staticAccountKeys;
  const ix = tx.message.compiledInstructions[0];
  const payer = new PublicKey(environment.admin);
  const unique = new Set([environment.admin, expected.programId.toBase58(),
    ...expected.keys.map((account) => account.pubkey.toBase58())]);
  if (tx.message.version !== 0 || tx.message.addressTableLookups.length !== 0
    || tx.message.compiledInstructions.length !== 1 || !ix || keys.length !== unique.size
    || !keys[0]?.equals(payer) || tx.message.header.numRequiredSignatures !== 1
    || tx.signatures.length !== 1 || !keys[ix.programIdIndex]?.equals(expected.programId)
    || ix.accountKeyIndexes.length !== expected.keys.length
    || !Buffer.from(ix.data).equals(expected.data)
    || tx.message.recentBlockhash !== prepared.blockhash
    || !Number.isSafeInteger(prepared.lastValidBlockHeight) || prepared.lastValidBlockHeight <= 0
    || bs58.encode(tx.signatures[0]) !== prepared.signature
    || !nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], payer.toBytes())
    || tx.message.isAccountWritable(ix.programIdIndex)) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_TRANSACTION_INVALID");
  }
  for (let index = 0; index < expected.keys.length; index++) {
    const account = expected.keys[index];
    const keyIndex = ix.accountKeyIndexes[index];
    if (!keys[keyIndex]?.equals(account.pubkey)
      || tx.message.isAccountSigner(keyIndex) !== account.isSigner
      || tx.message.isAccountWritable(keyIndex) !== account.isWritable) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_TRANSACTION_INVALID");
    }
  }
}

async function verifyCompletedRelease(environment: LockReleaseEnvironment, intent: LockReleaseIntent) {
  const { derived, id, addresses, lock } = identities(environment, intent);
  const checkedRoute = await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority,
    reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint,
    admin: environment.admin,
  });
  if (checkedRoute.lastProposalId < id) throw new Error("GOVERNANCE_LOCK_RELEASE_COMPLETION_INVALID");
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([
        derived.authority, addresses.proposal, lock.record, lock.escrow,
      ], { commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_RPC_STALE");
    }
    const [configInfo, proposalInfo, recordInfo, escrowInfo] = read.value;
    const config = await parseGovernanceConfig(requiredAccount(configInfo, derived.program, 306));
    const proposal = await parseGovernanceProposal(addresses.proposal.toBase58(),
      requiredAccount(proposalInfo, derived.program, 726));
    const verified = await inspectGovernanceLock(derived.program, derived.authority, config,
      addresses.proposal, proposal, derived.mint, recordInfo, escrowInfo, chainTime!);
    if (config.admin !== environment.admin || config.capitalMint !== environment.capitalMint
      || config.reserveMint !== environment.reserveMint || config.reserveVault !== derived.ata.toBase58()
      || proposal.id !== id || sha256(proposalInfo!.data) !== intent.proposalStateSha256
      || verified.record.status !== 1 || verified.record.amount.toString() !== intent.recordCommittedRawMstrx
      || verified.record.releaseAt !== intent.releaseAt || verified.escrowBalanceRawMstrx !== 0n) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_COMPLETION_INVALID");
    }
    return { config: fingerprint(configInfo), proposal: fingerprint(proposalInfo),
      record: fingerprint(recordInfo), escrow: fingerprint(escrowInfo) };
  }));
  requireMatchingValues(observations, "GOVERNANCE_LOCK_RELEASE_COMPLETION_RPC_DISAGREEMENT");
}

async function transactionState(environment: LockReleaseEnvironment, prepared: Prepared, intent: LockReleaseIntent) {
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
    requireMatchingValues(errors, "GOVERNANCE_LOCK_RELEASE_SIGNATURE_RPC_DISAGREEMENT");
    if (observations[0].status!.err) return "failed" as const;
    await verifyCompletedRelease(environment, intent);
    return "finalized" as const;
  }
  if (observations.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) {
    return "unresolved" as const;
  }
  return "pending" as const;
}

function productionEffects(environment: LockReleaseEnvironment): Effects {
  requireGovernanceExecutionReleased();
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  return {
    audit: async (proposalId) => (await auditLockRelease(environment, proposalId)).intent,
    prepare: async (instruction) => {
      const signer = await loadKeypair(environment.adminKeypairPath);
      if (signer.publicKey.toBase58() !== environment.admin) {
        throw new Error("GOVERNANCE_LOCK_RELEASE_ADMIN_KEY_MISMATCH");
      }
      const prepared = await prepareSignedTransaction({ connection, payer: signer, instructions: [instruction] });
      const height = await connection.getBlockHeight("confirmed");
      if (!Number.isSafeInteger(height) || prepared.lastValidBlockHeight <= height
        || prepared.lastValidBlockHeight > height + 300) {
        throw new Error("GOVERNANCE_LOCK_RELEASE_BLOCKHASH_WINDOW_INVALID");
      }
      return prepared;
    },
    broadcast: async (prepared) => {
      const returned = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (returned !== prepared.signature) throw new Error("GOVERNANCE_LOCK_RELEASE_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared, intent) => transactionState(environment, prepared, intent),
  };
}

async function readLedger(environment: LockReleaseEnvironment) {
  const ledger = await readJsonIfExists<LockReleaseLedger>(ledgerPath(environment));
  if (!ledger) return undefined;
  if (ledger.version !== 1 || !["prepared", "pending", "finalized", "failed", "unresolved"].includes(ledger.state)
    || !/^\d+-[a-f0-9]{16}$/.test(ledger.requestId)
    || !ledger.transaction?.signature || !ledger.transaction.transactionBase64
    || sha256(Buffer.from(ledger.transaction.transactionBase64, "base64")) !== ledger.transactionSha256) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_LEDGER_INVALID");
  }
  verifySignedLockRelease(ledger.authorization, environment.admin, ledger.authorization.issuedAt);
  identities(environment, ledger.authorization.lockRelease);
  assertExactSignedTransaction(environment, ledger.authorization.lockRelease, ledger.transaction);
  return ledger;
}

export async function reconcileLockRelease(environment: LockReleaseEnvironment,
  effects: Effects = productionEffects(environment)): Promise<LockReleaseLedger | undefined> {
  const ledger = await readLedger(environment);
  if (!ledger) return ledger;
  if (ledger.state === "finalized" || ledger.state === "failed") return ledger;
  const state = await effects.transactionState(ledger.transaction, ledger.authorization.lockRelease);
  if (ledger.state === "unresolved" && state !== "finalized" && state !== "failed") return ledger;
  if (state === "pending") {
    await effects.broadcast(ledger.transaction);
    if (ledger.state !== "pending") {
      ledger.state = "pending";
      ledger.updatedAt = Date.now();
      await writeDurableJson(ledgerPath(environment), ledger);
    }
    return ledger;
  }
  ledger.state = state;
  ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(environment), ledger);
  return ledger;
}

/** The generic control runner must enforce its own single-process queue. */
export async function releaseMatureMstrxLock(environment: LockReleaseEnvironment,
  request: { requestId: string; authorization: SignedLockRelease },
  effects: Effects = productionEffects(environment)): Promise<LockReleaseLedger> {
  if (!/^\d+-[a-f0-9]{16}$/.test(request.requestId)) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_REQUEST_INVALID");
  }
  verifySignedLockRelease(request.authorization, environment.admin);
  const previous = await reconcileLockRelease(environment, effects);
  if (previous && ["prepared", "pending"].includes(previous.state)) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_PENDING_RECONCILIATION");
  }
  if (previous?.state === "unresolved") throw new Error("GOVERNANCE_LOCK_RELEASE_UNRESOLVED_REVIEW_REQUIRED");
  if (previous?.authorization.nonce === request.authorization.nonce
    || previous?.state === "finalized"
      && previous.authorization.lockRelease.proposalId === request.authorization.lockRelease.proposalId
    || await readJsonIfExists(historyPath(environment, request.authorization.nonce))) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_REPLAY");
  }
  const signedIntent = request.authorization.lockRelease;
  identities(environment, signedIntent);
  const freshIntent = await effects.audit(signedIntent.proposalId);
  const { verifiedAt: _signedAt, ...signedTerms } = signedIntent;
  const { verifiedAt: _freshAt, ...freshTerms } = freshIntent;
  if (JSON.stringify(signedTerms) !== JSON.stringify(freshTerms)) {
    throw new Error("GOVERNANCE_LOCK_RELEASE_PREVIEW_CHANGED");
  }
  const transaction = await effects.prepare(buildLockReleaseInstruction(environment, signedIntent));
  assertExactSignedTransaction(environment, signedIntent, transaction);
  if (previous) await writeDurableJson(historyPath(environment, previous.authorization.nonce), previous);
  const ledger: LockReleaseLedger = {
    version: 1, requestId: request.requestId, authorization: request.authorization, transaction,
    transactionSha256: sha256(Buffer.from(transaction.transactionBase64, "base64")),
    state: "prepared", updatedAt: Date.now(),
  };
  await writeDurableJson(ledgerPath(environment), ledger);
  await effects.broadcast(transaction);
  ledger.state = "pending";
  ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(environment), ledger);
  return ledger;
}
