import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED, validateProposalControlIntent,
  verifySignedSolanaControlAction, type ProposalControlIntent, type SignedSolanaControlAction } from "./controlAuth";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { buildCreateProposalInstruction, buildCreateRevoteInstruction,
  type GovernanceProposalInstructionInput, type GovernanceRevoteInstructionInput } from "./governanceProposalInstruction";
import { auditGovernanceProposal, governanceProposalPreviewHash } from "./governanceProposalPreview";
import { RESERVE_ACTIONS } from "./governancePolicy";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type LedgerState = "prepared" | "pending" | "finalized" | "unresolved";
interface StoredInstruction {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  dataHex: string;
}
export interface ProposalControlLedger {
  version: 1;
  requestId: string;
  authorization: SignedSolanaControlAction;
  instruction: StoredInstruction;
  transaction: Prepared;
  transactionSha256: string;
  state: LedgerState;
  updatedAt: number;
}
export interface ProposalControlEnvironment {
  rpcUrls: readonly [string, string];
  stateRoot: string;
  publicDataRoot: string;
  governanceProgram: string;
  expectedProgramCodeSha256: string;
  reserveMint: string;
  capitalMint: string;
  admin: string;
  adminKeypairPath: string;
}
interface Effects {
  verify: (intent: ProposalControlIntent) => Promise<TransactionInstruction>;
  prepare: (instruction: TransactionInstruction) => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared) => Promise<"pending" | "unresolved" | "finalized">;
}

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const ledgerPath = (env: ProposalControlEnvironment) => resolve(env.stateRoot, "governance-proposal-control.json");

function exactRoute(env: ProposalControlEnvironment, intent: ProposalControlIntent) {
  validateProposalControlIntent(intent, intent.auditedAtUnix * 1_000);
  const derived = deriveGovernanceReserveRoute(env.governanceProgram, env.reserveMint);
  if (intent.governanceProgram !== derived.program.toBase58()
    || intent.programCodeSha256 !== env.expectedProgramCodeSha256
    || intent.reserveMint !== env.reserveMint || intent.capitalMint !== env.capitalMint
    || intent.config !== derived.authority.toBase58() || intent.reserveVault !== derived.ata.toBase58()) {
    throw new Error("GOVERNANCE_PROPOSAL_ROUTE_MISMATCH");
  }
  return derived;
}

function freezeInstruction(ix: TransactionInstruction): StoredInstruction {
  return { programId: ix.programId.toBase58(), dataHex: Buffer.from(ix.data).toString("hex"),
    keys: ix.keys.map((key) => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })) };
}

function assertStoredInstruction(env: ProposalControlEnvironment, intent: ProposalControlIntent, ix: StoredInstruction) {
  const derived = exactRoute(env, intent);
  const mode = intent.request.mode;
  const expectedKeys = [
    [intent.config, false, true], [intent.reserveVault, false, false],
    ...(mode === "revote" ? [[intent.previousProposal!, false, true]] : []),
    [intent.proposal, false, true], [env.admin, true, true],
    [intent.governanceProgram, false, false], [derived.programDataAddress.toBase58(), false, false],
    [SystemProgram.programId.toBase58(), false, false],
  ];
  if (ix.programId !== intent.governanceProgram || !Array.isArray(ix.keys)
    || JSON.stringify(ix.keys.map((key) => [key.pubkey, key.isSigner, key.isWritable])) !== JSON.stringify(expectedKeys)
    || typeof ix.dataHex !== "string" || !/^[a-f0-9]+$/.test(ix.dataHex)) {
    throw new Error("GOVERNANCE_PROPOSAL_INSTRUCTION_INVALID");
  }
  const data = Buffer.from(ix.dataHex, "hex");
  const expectedPrefix = createHash("sha256").update(mode === "initial" ? "global:create_proposal" : "global:create_revote")
    .digest().subarray(0, 8);
  if (data.length !== 180 + 45 * intent.request.options.length || !data.subarray(0, 8).equals(expectedPrefix)
    || data.readBigUInt64LE(8) !== BigInt(intent.proposalId)
    || data.readBigInt64LE(16) !== BigInt(intent.request.votingDurationSeconds)
    || data.subarray(112, 144).toString("hex") !== intent.publication.merkleRoot
    || data.readBigUInt64LE(168) !== BigInt(intent.frozenReserveRawMstrx)
    || data.readUInt32LE(176) !== intent.request.options.length) {
    throw new Error("GOVERNANCE_PROPOSAL_INSTRUCTION_INVALID");
  }
  intent.request.options.forEach((option, index) => {
    const offset = 180 + index * 45;
    const recipient = option.action === "MARKETING_SALE" ? intent.fixedMarketingRecipient : SystemProgram.programId.toBase58();
    if (data.readUInt8(offset) !== RESERVE_ACTIONS.indexOf(option.action)
      || data.readUInt32LE(offset + 1) !== (option.lockDurationSeconds ?? 0)
      || !data.subarray(offset + 5, offset + 37).equals(new PublicKey(recipient).toBuffer())
      || data.readBigUInt64LE(offset + 37) !== BigInt(option.minOutputRaw ?? "0")) {
      throw new Error("GOVERNANCE_PROPOSAL_INSTRUCTION_INVALID");
    }
  });
  const previewHash = governanceProposalPreviewHash({ mode, program: ix.programId, proposal: intent.proposal,
    previousProposal: intent.previousProposal, data: ix.dataHex,
    keys: ix.keys.map((key) => [key.pubkey, key.isSigner, key.isWritable]),
    programCodeSha256: intent.programCodeSha256, publication: intent.publication });
  if (previewHash !== intent.previewHash) throw new Error("GOVERNANCE_PROPOSAL_PREVIEW_HASH_MISMATCH");
}

function assertExactSignedTransaction(env: ProposalControlEnvironment, intent: ProposalControlIntent,
  instruction: StoredInstruction, prepared: Prepared) {
  assertStoredInstruction(env, intent, instruction);
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64")); }
  catch { throw new Error("GOVERNANCE_PROPOSAL_LEDGER_TRANSACTION_INVALID"); }
  const message = tx.message;
  const keys = message.staticAccountKeys;
  const ix = message.compiledInstructions[0];
  const payer = new PublicKey(env.admin);
  const unique = new Set([env.admin, instruction.programId, ...instruction.keys.map((key) => key.pubkey)]);
  if (message.version !== 0 || message.addressTableLookups.length !== 0 || message.compiledInstructions.length !== 1
    || !ix || !keys[0]?.equals(payer) || message.header.numRequiredSignatures !== 1
    || tx.signatures.length !== 1 || keys.length !== unique.size
    || !keys[ix.programIdIndex]?.equals(new PublicKey(instruction.programId))
    || ix.accountKeyIndexes.length !== instruction.keys.length
    || !Buffer.from(ix.data).equals(Buffer.from(instruction.dataHex, "hex"))
    || message.recentBlockhash !== prepared.blockhash
    || !Number.isSafeInteger(prepared.lastValidBlockHeight) || prepared.lastValidBlockHeight <= 0
    || bs58.encode(tx.signatures[0]) !== prepared.signature
    || !nacl.sign.detached.verify(message.serialize(), tx.signatures[0], payer.toBytes())) {
    throw new Error("GOVERNANCE_PROPOSAL_LEDGER_TRANSACTION_INVALID");
  }
  for (let index = 0; index < instruction.keys.length; index++) {
    const expected = instruction.keys[index];
    const keyIndex = ix.accountKeyIndexes[index];
    if (!keys[keyIndex]?.equals(new PublicKey(expected.pubkey))
      || message.isAccountSigner(keyIndex) !== expected.isSigner
      || message.isAccountWritable(keyIndex) !== expected.isWritable) {
      throw new Error("GOVERNANCE_PROPOSAL_LEDGER_TRANSACTION_INVALID");
    }
  }
  if (message.isAccountWritable(ix.programIdIndex) !== false) {
    throw new Error("GOVERNANCE_PROPOSAL_LEDGER_TRANSACTION_INVALID");
  }
}

/** Re-read two finalized RPCs and the already-published immutable snapshot.
 * Refuse any drift from the exact owner-signed preview before the gated builder. */
export async function verifyProposalCreation(env: ProposalControlEnvironment, intent: ProposalControlIntent) {
  validateProposalControlIntent(intent, Date.now());
  const derived = exactRoute(env, intent);
  const audited = await auditGovernanceProposal({
    request: intent.request, rpcUrls: env.rpcUrls, publicDataRoot: env.publicDataRoot,
    route: { governanceProgram: env.governanceProgram,
      reserveAuthority: derived.authority.toBase58(), reserveMint: env.reserveMint,
      capitalMint: env.capitalMint, admin: env.admin,
      expectedProgramCodeSha256: env.expectedProgramCodeSha256 },
  });
  const preview = audited.preview;
  if (preview.previewHash !== intent.previewHash || preview.draft.id !== intent.proposalId
    || preview.draft.proposal !== intent.proposal || preview.draft.config !== intent.config
    || preview.draft.reserveVault !== intent.reserveVault
    || preview.draft.frozenReserveRawMstrx !== intent.frozenReserveRawMstrx
    || preview.draft.previousProposal !== intent.previousProposal
    || preview.fixedMarketingRecipient !== intent.fixedMarketingRecipient
    || JSON.stringify(preview.publication) !== JSON.stringify(intent.publication)
    || preview.draft.unreleasedExecutors.length > 0) {
    throw new Error("GOVERNANCE_PROPOSAL_PREVIEW_CHANGED");
  }
  const instruction = audited.mode === "initial"
    ? buildCreateProposalInstruction(audited.instructionInput as GovernanceProposalInstructionInput)
    : buildCreateRevoteInstruction(audited.instructionInput as GovernanceRevoteInstructionInput);
  assertStoredInstruction(env, intent, freezeInstruction(instruction));
  return instruction;
}

async function agreedTransactionState(env: ProposalControlEnvironment, prepared: Prepared) {
  const states = await Promise.all(env.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [status, height] = await Promise.all([
      connection.getSignatureStatuses([prepared.signature], { searchTransactionHistory: true }),
      connection.getBlockHeight("finalized"),
    ]);
    return { status: status.value[0], height };
  }));
  if (states.some(({ status }) => status?.err)) throw new Error("GOVERNANCE_PROPOSAL_TRANSACTION_FAILED");
  if (states.every(({ status }) => status?.confirmationStatus === "finalized")) return "finalized" as const;
  if (states.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) {
    return "unresolved" as const;
  }
  return "pending" as const;
}

function productionEffects(env: ProposalControlEnvironment): Effects {
  if (!SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED) throw new Error("GOVERNANCE_PROPOSAL_NOT_RELEASED");
  const connection = new Connection(env.rpcUrls[0], "confirmed");
  return {
    verify: (intent) => verifyProposalCreation(env, intent),
    prepare: async (instruction) => {
      const signer = await loadKeypair(env.adminKeypairPath);
      if (signer.publicKey.toBase58() !== env.admin) throw new Error("GOVERNANCE_PROPOSAL_ADMIN_KEY_MISMATCH");
      const prepared = await prepareSignedTransaction({ connection, payer: signer, instructions: [instruction] });
      const height = await connection.getBlockHeight("confirmed");
      if (!Number.isSafeInteger(height) || prepared.lastValidBlockHeight <= height
        || prepared.lastValidBlockHeight > height + 300) throw new Error("GOVERNANCE_PROPOSAL_BLOCKHASH_WINDOW_INVALID");
      return prepared;
    },
    broadcast: async (prepared) => {
      const returned = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (returned !== prepared.signature) throw new Error("GOVERNANCE_PROPOSAL_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared) => agreedTransactionState(env, prepared),
  };
}

async function readLedger(env: ProposalControlEnvironment) {
  const ledger = await readJsonIfExists<ProposalControlLedger>(ledgerPath(env));
  if (!ledger) return;
  if (ledger.version !== 1 || !["prepared", "pending", "finalized", "unresolved"].includes(ledger.state)
    || !/^\d+-[a-f0-9]{16}$/.test(ledger.requestId)
    || !ledger.transaction?.signature || !ledger.transaction.transactionBase64
    || hash(Buffer.from(ledger.transaction.transactionBase64, "base64")) !== ledger.transactionSha256) {
    throw new Error("GOVERNANCE_PROPOSAL_LEDGER_INVALID");
  }
  verifySignedSolanaControlAction(ledger.authorization, env.admin, ledger.authorization.issuedAt);
  if (!ledger.authorization.proposalCreation || ledger.authorization.action !== (ledger.authorization.proposalCreation.request.mode === "initial"
    ? "create_proposal" : "create_revote")) throw new Error("GOVERNANCE_PROPOSAL_LEDGER_INVALID");
  assertExactSignedTransaction(env, ledger.authorization.proposalCreation, ledger.instruction, ledger.transaction);
  return ledger;
}

export async function reconcileProposalControl(env: ProposalControlEnvironment,
  effects: Effects = productionEffects(env)): Promise<ProposalControlLedger | undefined> {
  const ledger = await readLedger(env);
  if (!ledger || ledger.state === "finalized") return ledger;
  const state = await effects.transactionState(ledger.transaction);
  if (ledger.state === "unresolved" && state !== "finalized") return ledger;
  if (state === "pending") {
    await effects.broadcast(ledger.transaction);
    if (ledger.state !== "pending") {
      ledger.state = "pending"; ledger.updatedAt = Date.now();
      await writeDurableJson(ledgerPath(env), ledger);
    }
    return ledger;
  }
  ledger.state = state; ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(env), ledger);
  return ledger;
}

export async function createProposalControl(env: ProposalControlEnvironment,
  request: { requestId: string; authorization: SignedSolanaControlAction },
  effects: Effects = productionEffects(env)): Promise<ProposalControlLedger> {
  if (!/^\d+-[a-f0-9]{16}$/.test(request.requestId) || !request.authorization.proposalCreation
    || !["create_proposal", "create_revote"].includes(request.authorization.action)) {
    throw new Error("GOVERNANCE_PROPOSAL_REQUEST_INVALID");
  }
  verifySignedSolanaControlAction(request.authorization, env.admin);
  const prior = await reconcileProposalControl(env, effects);
  if (prior && ["prepared", "pending"].includes(prior.state)) throw new Error("GOVERNANCE_PROPOSAL_PENDING_RECONCILIATION");
  if (prior?.state === "unresolved") throw new Error("GOVERNANCE_PROPOSAL_UNRESOLVED_REVIEW_REQUIRED");
  if (prior?.authorization.nonce === request.authorization.nonce) throw new Error("GOVERNANCE_PROPOSAL_NONCE_ALREADY_USED");
  const intent = request.authorization.proposalCreation;
  validateProposalControlIntent(intent, Date.now());
  const ix = await effects.verify(intent);
  const instruction = freezeInstruction(ix);
  assertStoredInstruction(env, intent, instruction);
  const transaction = await effects.prepare(ix);
  assertExactSignedTransaction(env, intent, instruction, transaction);
  if (prior) await writeDurableJson(resolve(env.stateRoot, "governance-proposal-control-history",
    `${prior.authorization.nonce}.json`), prior);
  const ledger: ProposalControlLedger = { version: 1, requestId: request.requestId,
    authorization: request.authorization, instruction, transaction,
    transactionSha256: hash(Buffer.from(transaction.transactionBase64, "base64")),
    state: "prepared", updatedAt: Date.now() };
  await writeDurableJson(ledgerPath(env), ledger);
  await effects.broadcast(transaction);
  ledger.state = "pending"; ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(env), ledger);
  return ledger;
}
