import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { governanceAddresses, governanceExecutionReceiptAddresses, inspectGovernanceExecutionReceipt,
  parseGovernanceConfig, parseGovernanceProposal } from "../../apps/web/src/governanceClient";
import { verifySignedSolanaControlAction, type SignedSolanaControlAction } from "./controlAuth";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { buildExecuteBuybackDraft } from "./governanceExecutionInstruction";
import { validateBuybackExecutionIntent, type BuybackExecutionIntent } from "./governanceBuybackIntent";
import { inspectGovernanceBuybackVenue } from "./governanceBuybackVenue";
import { deriveGovernanceReserveRoute, verifyGovernanceReserveRoute,
  type GovernanceReserveRoute } from "./governanceVaultRoute";
import { type GovernanceProposalStatus, verifyGovernanceProposalStatus } from "./governanceProposalStatus";
import { requireGovernanceExecutionReleased } from "./releaseGates";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type LedgerState = "prepared" | "pending" | "finalized" | "failed" | "unresolved";
type BuybackAction = "BUYBACK_HOLD" | "BUYBACK_BURN" | "BUYBACK_LOCK";
const MAX_U64 = (1n << 64n) - 1n;
const LOCK_TERMS = new Set([30, 90, 180, 365, 730, 1095, 1825]
  .map((days) => days * 86_400).concat(0xffff_ffff));
const ZERO = SystemProgram.programId.toBase58();
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export { validateBuybackExecutionIntent } from "./governanceBuybackIntent";
export type { BuybackExecutionIntent } from "./governanceBuybackIntent";

export interface BuybackExecutionEnvironment {
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

export type BuybackExecutionReadEnvironment = Omit<BuybackExecutionEnvironment,
  "stateRoot" | "adminKeypairPath">;

/** The generic control challenge must add action/payload support separately.
 * Until then its verifier rejects this action, in addition to the global
 * source-controlled execution release gate. */
export type SignedBuybackExecution = SignedSolanaControlAction & {
  action: "execute_buyback";
  buybackExecution: BuybackExecutionIntent;
};

export interface BuybackExecutionLedger {
  version: 1;
  requestId: string;
  authorization: SignedBuybackExecution;
  transaction: Prepared;
  transactionSha256: string;
  state: LedgerState;
  updatedAt: number;
}

export interface BuybackExecutionEffects {
  audit: (proposalId: string) => Promise<BuybackExecutionIntent>;
  verifyAuthorization: (authorization: SignedBuybackExecution, owner: string, now?: number) => void;
  prepare: (instruction: TransactionInstruction) => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared, intent: BuybackExecutionIntent) => Promise<
    "pending" | "unresolved" | "failed" | "finalized">;
}

const ledgerPath = (environment: BuybackExecutionEnvironment) =>
  resolve(environment.stateRoot, "governance-buyback-execution.json");
const historyPath = (environment: BuybackExecutionEnvironment, nonce: string) =>
  resolve(environment.stateRoot, "governance-buyback-execution-history", `${nonce}.json`);

function exactKey(value: string, code: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error();
    return key;
  } catch { throw new Error(code); }
}

function positiveU64(value: string, code: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new Error(code);
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error(code);
  return parsed;
}

function route(environment: BuybackExecutionReadEnvironment): GovernanceReserveRoute {
  const derived = deriveGovernanceReserveRoute(environment.governanceProgram, environment.reserveMint);
  if (derived.authority.toBase58() !== environment.reserveAuthority
    || !/^[a-f0-9]{64}$/.test(environment.expectedProgramCodeSha256)) {
    throw new Error("GOVERNANCE_BUYBACK_ROUTE_INVALID");
  }
  exactKey(environment.capitalMint, "GOVERNANCE_BUYBACK_ROUTE_INVALID");
  exactKey(environment.admin, "GOVERNANCE_BUYBACK_ROUTE_INVALID");
  return { governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority, reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint, admin: environment.admin };
}

function winningOption(status: GovernanceProposalStatus) {
  if (status.status !== 1 || status.executionReceipt || !status.winningAction
    || !["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK"].includes(status.winningAction)) {
    throw new Error("GOVERNANCE_BUYBACK_DECISION_NOT_READY");
  }
  const options = status.options.filter((option) => option.action === status.winningAction);
  if (options.length !== 1 || options[0].reserveRaw !== status.frozenRaw
    || options[0].recipient !== ZERO) throw new Error("GOVERNANCE_BUYBACK_OPTION_INVALID");
  positiveU64(status.frozenRaw, "GOVERNANCE_BUYBACK_AMOUNT_INVALID");
  positiveU64(options[0].minOutputRaw, "GOVERNANCE_BUYBACK_AMOUNT_INVALID");
  if (status.winningAction === "BUYBACK_LOCK" ? !LOCK_TERMS.has(options[0].lockDurationSeconds)
    : options[0].lockDurationSeconds !== 0) throw new Error("GOVERNANCE_BUYBACK_OPTION_INVALID");
  return { action: status.winningAction as BuybackAction, option: options[0] };
}

/** All authoritative inputs are independently checked at finalized state.
 * No offchain quote is required to execute the already voted positive floor. */
export async function auditBuybackExecution(environment: BuybackExecutionReadEnvironment, proposalId: string) {
  const identity = route(environment);
  const id = positiveU64(proposalId, "GOVERNANCE_BUYBACK_ID_INVALID");
  const verifiedRoute = await verifyGovernanceReserveRoute(environment.rpcUrls, identity);
  if (verifiedRoute.activeProposalId !== id || verifiedRoute.committedRaw <= 0n
    || verifiedRoute.vaultBalanceRaw < verifiedRoute.committedRaw) {
    throw new Error("GOVERNANCE_BUYBACK_COMMITMENT_INVALID");
  }
  const [status, venue, agreed] = await Promise.all([
    verifyGovernanceProposalStatus(environment.rpcUrls, {
      program: environment.governanceProgram, admin: environment.admin,
      capitalMint: environment.capitalMint, reserveMint: environment.reserveMint,
      reserveVault: verifiedRoute.ata, activeProposalId: id, committedRaw: verifiedRoute.committedRaw,
    }),
    inspectGovernanceBuybackVenue({ rpcUrls: environment.rpcUrls,
      capitalMint: environment.capitalMint, capitalTokenProgram: verifiedRoute.capitalTokenProgram,
      frozenRawMstrx: verifiedRoute.committedRaw }),
    finalizedConsensus(environment.rpcUrls),
  ]);
  if (!status || status.id !== id.toString() || status.frozenRaw !== verifiedRoute.committedRaw.toString()
    || status.executableAt !== status.endsAt + 300
    || venue.frozenRawMstrx !== status.frozenRaw) {
    throw new Error("GOVERNANCE_BUYBACK_DECISION_INVALID");
  }
  const { action, option } = winningOption(status);
  const program = new PublicKey(verifiedRoute.program);
  const addresses = governanceAddresses(program, id);
  const receipt = governanceExecutionReceiptAddresses(program, addresses.proposal).buyback;
  const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], program)[0];
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, blockTime, rent] = await Promise.all([
      connection.getAccountInfoAndContext(trader, { commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
      connection.getMinimumBalanceForRentExemption(0, "finalized"),
    ]);
    const account = read.value;
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(blockTime)
      || !account || !account.owner.equals(SystemProgram.programId) || account.executable
      || account.data.length !== 0 || account.lamports < rent) {
      throw new Error("GOVERNANCE_BUYBACK_TRADER_UNFUNDED");
    }
    return { chainTime: blockTime as number, traderLamports: account.lamports, rent };
  }));
  const agreedTime = requireMatchingValues(observations, "GOVERNANCE_BUYBACK_RPC_DISAGREEMENT").chainTime;
  if (agreedTime < status.executableAt) throw new Error("GOVERNANCE_BUYBACK_TOO_EARLY");
  const intent: BuybackExecutionIntent = {
    governanceProgram: environment.governanceProgram,
    programCodeSha256: environment.expectedProgramCodeSha256,
    reserveMint: environment.reserveMint, reserveVault: verifiedRoute.ata,
    capitalMint: environment.capitalMint, capitalTokenProgram: verifiedRoute.capitalTokenProgram,
    config: verifiedRoute.authority, proposalId: id.toString(), proposal: addresses.proposal.toBase58(),
    receipt: receipt.toBase58(), trader: trader.toBase58(), action,
    proposalStateSha256: status.proposalStateSha256,
    frozenReserveRawMstrx: status.frozenRaw,
    votedMinOutputRawCapital: option.minOutputRaw,
    lockDurationSeconds: option.lockDurationSeconds,
    executableAt: status.executableAt, venueState: venue.venueState, verifiedAt: Date.now(),
  };
  validateBuybackExecutionIntent(intent, intent.verifiedAt);
  return { intent, finalizedSlot: agreed.slot, finalizedBlockhash: agreed.blockhash,
    venueFinalizedSlot: venue.finalizedBlockSlot, traderLamports: observations[0].traderLamports,
    quoteUnavailable: venue.quoteUnavailable };
}

export function buildBuybackExecutionInstruction(environment: BuybackExecutionReadEnvironment,
  intent: BuybackExecutionIntent) {
  validateBuybackExecutionIntent(intent, intent.verifiedAt);
  route(environment);
  if (intent.governanceProgram !== environment.governanceProgram
    || intent.programCodeSha256 !== environment.expectedProgramCodeSha256
    || intent.reserveMint !== environment.reserveMint || intent.capitalMint !== environment.capitalMint
    || intent.config !== environment.reserveAuthority) {
    throw new Error("GOVERNANCE_BUYBACK_ROUTE_MISMATCH");
  }
  const decision: GovernanceProposalStatus = {
    id: intent.proposalId, status: 1, proposalStateSha256: intent.proposalStateSha256,
    frozenRaw: intent.frozenReserveRawMstrx, fixedMarketingWallet: ZERO,
    options: [{ action: intent.action, reserveRaw: intent.frozenReserveRawMstrx,
      minOutputRaw: intent.votedMinOutputRawCapital, recipient: ZERO,
      lockDurationSeconds: intent.lockDurationSeconds }],
    startsAt: intent.executableAt - 301, endsAt: intent.executableAt - 300,
    executableAt: intent.executableAt, winningAction: intent.action, updatedAt: intent.verifiedAt,
  };
  const draft = buildExecuteBuybackDraft({ route: route(environment), payer: environment.admin,
    capitalTokenProgram: intent.capitalTokenProgram, proposalStatus: decision,
    observedClockUnix: intent.executableAt, venueState: intent.venueState });
  if (!draft.proposal.equals(new PublicKey(intent.proposal))
    || !draft.receipt.equals(new PublicKey(intent.receipt))) {
    throw new Error("GOVERNANCE_BUYBACK_DRAFT_MISMATCH");
  }
  return new TransactionInstruction({ programId: draft.programId, keys: [...draft.keys], data: draft.data });
}

/** This byte-for-byte recompilation handles duplicate readonly/writable
 * metas correctly and rejects extra instructions, ALTs and second signers. */
export function assertExactSignedBuybackTransaction(environment: BuybackExecutionReadEnvironment,
  intent: BuybackExecutionIntent, prepared: Prepared) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64")); }
  catch { throw new Error("GOVERNANCE_BUYBACK_TRANSACTION_INVALID"); }
  const owner = new PublicKey(environment.admin);
  const expected = buildBuybackExecutionInstruction(environment, intent);
  const rebuilt = new TransactionMessage({ payerKey: owner,
    recentBlockhash: prepared.blockhash, instructions: [expected] }).compileToV0Message();
  if (tx.message.version !== 0 || tx.message.addressTableLookups.length !== 0
    || tx.message.compiledInstructions.length !== 1 || tx.signatures.length !== 1
    || tx.message.header.numRequiredSignatures !== 1
    || !Buffer.from(tx.message.serialize()).equals(Buffer.from(rebuilt.serialize()))
    || tx.message.recentBlockhash !== prepared.blockhash
    || !Number.isSafeInteger(prepared.lastValidBlockHeight) || prepared.lastValidBlockHeight <= 0
    || bs58.encode(tx.signatures[0]) !== prepared.signature
    || !nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], owner.toBytes())) {
    throw new Error("GOVERNANCE_BUYBACK_TRANSACTION_INVALID");
  }
}

function signedIntent(authorization: SignedBuybackExecution) {
  if (authorization.action !== "execute_buyback" || !authorization.buybackExecution) {
    throw new Error("GOVERNANCE_BUYBACK_ACTION_INVALID");
  }
  return authorization.buybackExecution;
}

function required(account: AccountInfo<Buffer> | null, owner: PublicKey, size: number) {
  if (!account || account.executable || !account.owner.equals(owner) || account.data.length !== size) {
    throw new Error("GOVERNANCE_BUYBACK_COMPLETION_ACCOUNT_INVALID");
  }
  return account;
}

async function verifyCompletedBuyback(environment: BuybackExecutionReadEnvironment,
  intent: BuybackExecutionIntent) {
  const identity = route(environment);
  await verifyGovernanceReserveRoute(environment.rpcUrls, identity);
  const program = new PublicKey(environment.governanceProgram);
  const config = new PublicKey(intent.config);
  const proposal = new PublicKey(intent.proposal);
  const receipt = new PublicKey(intent.receipt);
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([config, proposal, receipt], {
        commitment: "finalized", minContextSlot: agreed.slot }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) {
      throw new Error("GOVERNANCE_BUYBACK_COMPLETION_STALE");
    }
    const [configInfo, proposalInfo, receiptInfo] = read.value;
    const parsedConfig = await parseGovernanceConfig(required(configInfo, program, 306));
    const parsedProposal = await parseGovernanceProposal(intent.proposal,
      required(proposalInfo, program, 726));
    const option = parsedProposal.options[parsedProposal.winningOption];
    if (parsedConfig.admin !== environment.admin || parsedConfig.capitalMint !== intent.capitalMint
      || parsedConfig.reserveMint !== intent.reserveMint || parsedConfig.reserveVault !== intent.reserveVault
      || parsedConfig.lastProposalId < BigInt(intent.proposalId)
      || parsedProposal.id !== BigInt(intent.proposalId) || parsedProposal.status !== 4
      || parsedProposal.config !== intent.config || parsedProposal.capitalMint !== intent.capitalMint
      || parsedProposal.reserveVault !== intent.reserveVault
      || parsedProposal.frozenReserveRawMstrx.toString() !== intent.frozenReserveRawMstrx
      || option?.action !== intent.action || option.minOutputRaw.toString() !== intent.votedMinOutputRawCapital
      || option.reserveRawMstrx.toString() !== intent.frozenReserveRawMstrx
      || option.lockDurationSeconds !== intent.lockDurationSeconds) {
      throw new Error("GOVERNANCE_BUYBACK_COMPLETION_INVALID");
    }
    const checkedReceipt = await inspectGovernanceExecutionReceipt(program, config, parsedConfig,
      proposal, parsedProposal, receiptInfo, null, chainTime!);
    const expectedVenue = intent.venueState.phase === "curve"
      ? intent.venueState.bondingCurveAddress : intent.venueState.poolAddress;
    if (!checkedReceipt || checkedReceipt.kind !== "BUYBACK"
      || checkedReceipt.address.toBase58() !== intent.receipt
      || checkedReceipt.venue !== expectedVenue
      || checkedReceipt.inputRawMstrx.toString() !== intent.frozenReserveRawMstrx
      || checkedReceipt.votedMinOutputRaw.toString() !== intent.votedMinOutputRawCapital) {
      throw new Error("GOVERNANCE_BUYBACK_COMPLETION_INVALID");
    }
    if (intent.action !== "BUYBACK_BURN") {
      const destination = new PublicKey(checkedReceipt.destination);
      const custody = await connection.getAccountInfoAndContext(destination, {
        commitment: "finalized", minContextSlot: read.context.slot });
      if (custody.context.slot < read.context.slot || !custody.value) {
        throw new Error("GOVERNANCE_BUYBACK_CUSTODY_INVALID");
      }
      const token = unpackAccount(destination, custody.value, new PublicKey(intent.capitalTokenProgram));
      const expectedOwner = intent.action === "BUYBACK_HOLD"
        ? PublicKey.findProgramAddressSync([Buffer.from("capital-hold")], program)[0] : receipt;
      if (!token.isInitialized || token.isFrozen || !token.mint.equals(new PublicKey(intent.capitalMint))
        || !token.owner.equals(expectedOwner) || token.amount < checkedReceipt.actualOutputRaw
        || token.delegate || token.closeAuthority) {
        throw new Error("GOVERNANCE_BUYBACK_CUSTODY_INVALID");
      }
    }
    return { config: sha256(configInfo!.data), proposal: sha256(proposalInfo!.data),
      receipt: sha256(receiptInfo!.data), actualRaw: checkedReceipt.actualOutputRaw.toString(),
      venue: checkedReceipt.venue };
  }));
  requireMatchingValues(observations, "GOVERNANCE_BUYBACK_COMPLETION_RPC_DISAGREEMENT");
}

async function transactionState(environment: BuybackExecutionReadEnvironment,
  prepared: Prepared, intent: BuybackExecutionIntent) {
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
      "GOVERNANCE_BUYBACK_SIGNATURE_RPC_DISAGREEMENT");
    if (observations[0].status!.err) return "failed" as const;
    await verifyCompletedBuyback(environment, intent);
    return "finalized" as const;
  }
  if (observations.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) {
    return "unresolved" as const;
  }
  return "pending" as const;
}

function productionEffects(environment: BuybackExecutionEnvironment): BuybackExecutionEffects {
  requireGovernanceExecutionReleased();
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  return {
    audit: async (proposalId) => (await auditBuybackExecution(environment, proposalId)).intent,
    verifyAuthorization: (authorization, owner, now) => {
      validateBuybackExecutionIntent(signedIntent(authorization), authorization.issuedAt);
      verifySignedSolanaControlAction(authorization, owner, now);
    },
    prepare: async (instruction) => {
      const signer = await loadKeypair(environment.adminKeypairPath);
      if (signer.publicKey.toBase58() !== environment.admin) {
        throw new Error("GOVERNANCE_BUYBACK_ADMIN_KEY_MISMATCH");
      }
      const prepared = await prepareSignedTransaction({ connection, payer: signer, instructions: [instruction] });
      const second = new Connection(environment.rpcUrls[1], "confirmed");
      const signed = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64"));
      const [simulation, height] = await Promise.all([
        second.simulateTransaction(signed, { commitment: "confirmed", sigVerify: true }),
        connection.getBlockHeight("confirmed"),
      ]);
      if (simulation.value.err) throw new Error(`GOVERNANCE_BUYBACK_SECOND_SIMULATION_FAILED:${JSON.stringify(simulation.value.err)}`);
      if (!Number.isSafeInteger(height) || prepared.lastValidBlockHeight <= height
        || prepared.lastValidBlockHeight > height + 300) {
        throw new Error("GOVERNANCE_BUYBACK_BLOCKHASH_WINDOW_INVALID");
      }
      return prepared;
    },
    broadcast: async (prepared) => {
      const returned = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (returned !== prepared.signature) throw new Error("GOVERNANCE_BUYBACK_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared, intent) => transactionState(environment, prepared, intent),
  };
}

async function readLedger(environment: BuybackExecutionEnvironment, effects: BuybackExecutionEffects) {
  const ledger = await readJsonIfExists<BuybackExecutionLedger>(ledgerPath(environment));
  if (!ledger) return undefined;
  if (ledger.version !== 1 || !["prepared", "pending", "finalized", "failed", "unresolved"].includes(ledger.state)
    || !/^\d+-[a-f0-9]{16}$/.test(ledger.requestId)
    || !ledger.transaction?.signature || !ledger.transaction.transactionBase64
    || sha256(Buffer.from(ledger.transaction.transactionBase64, "base64")) !== ledger.transactionSha256) {
    throw new Error("GOVERNANCE_BUYBACK_LEDGER_INVALID");
  }
  effects.verifyAuthorization(ledger.authorization, environment.admin, ledger.authorization.issuedAt);
  assertExactSignedBuybackTransaction(environment, signedIntent(ledger.authorization), ledger.transaction);
  return ledger;
}

export async function reconcileBuybackExecution(environment: BuybackExecutionEnvironment,
  effects: BuybackExecutionEffects = productionEffects(environment)): Promise<BuybackExecutionLedger | undefined> {
  const ledger = await readLedger(environment, effects);
  if (!ledger) return undefined;
  // The ledger already contains exact owner authorization and a verified
  // signed transaction. Historical RPC signature retention is finite; a
  // terminal record must not become unprovable merely because it aged out.
  if (ledger.state === "finalized" || ledger.state === "failed") return ledger;
  const state = await effects.transactionState(ledger.transaction, signedIntent(ledger.authorization));
  if (ledger.state === "unresolved" && state !== "finalized" && state !== "failed") return ledger;
  if (state === "pending") {
    await effects.broadcast(ledger.transaction); // Same durable signed bytes only.
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

/** The default effects cannot execute while the source-controlled release
 * gate is false. A test may inject effects; no private key is ever returned. */
export async function executeBuybackDecision(environment: BuybackExecutionEnvironment,
  request: { requestId: string; authorization: SignedBuybackExecution },
  effects: BuybackExecutionEffects = productionEffects(environment)): Promise<BuybackExecutionLedger> {
  if (!/^\d+-[a-f0-9]{16}$/.test(request.requestId)) throw new Error("GOVERNANCE_BUYBACK_REQUEST_INVALID");
  if (!/^[a-f0-9]{40}$/.test(request.authorization.nonce)) {
    throw new Error("GOVERNANCE_BUYBACK_NONCE_INVALID");
  }
  effects.verifyAuthorization(request.authorization, environment.admin);
  const previous = await reconcileBuybackExecution(environment, effects);
  if (previous && ["prepared", "pending"].includes(previous.state)) {
    throw new Error("GOVERNANCE_BUYBACK_PENDING_RECONCILIATION");
  }
  if (previous?.state === "unresolved") throw new Error("GOVERNANCE_BUYBACK_UNRESOLVED_REVIEW_REQUIRED");
  const signed = signedIntent(request.authorization);
  validateBuybackExecutionIntent(signed, request.authorization.issuedAt);
  if (previous?.authorization.nonce === request.authorization.nonce
    || previous?.state === "finalized"
      && signedIntent(previous.authorization).proposalId === signed.proposalId
    || await readJsonIfExists(historyPath(environment, request.authorization.nonce))) {
    throw new Error("GOVERNANCE_BUYBACK_REPLAY");
  }
  const fresh = await effects.audit(signed.proposalId);
  const { verifiedAt: _old, ...signedTerms } = signed;
  const { verifiedAt: _new, ...freshTerms } = fresh;
  if (JSON.stringify(signedTerms) !== JSON.stringify(freshTerms)) {
    throw new Error("GOVERNANCE_BUYBACK_PREVIEW_CHANGED");
  }
  const transaction = await effects.prepare(buildBuybackExecutionInstruction(environment, signed));
  assertExactSignedBuybackTransaction(environment, signed, transaction);
  if (previous) await writeDurableJson(historyPath(environment, previous.authorization.nonce), previous);
  const ledger: BuybackExecutionLedger = { version: 1, requestId: request.requestId,
    authorization: request.authorization, transaction,
    transactionSha256: sha256(Buffer.from(transaction.transactionBase64, "base64")),
    state: "prepared", updatedAt: Date.now() };
  await writeDurableJson(ledgerPath(environment), ledger);
  await effects.broadcast(transaction);
  ledger.state = "pending"; ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(environment), ledger);
  return ledger;
}
