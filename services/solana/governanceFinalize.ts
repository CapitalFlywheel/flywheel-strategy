import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Connection, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { parseGovernanceConfig, parseGovernanceProposal } from "../../apps/web/src/governanceClient";
import { SOLANA_GOVERNANCE_FINALIZE_RELEASED, validateFinalizeVoteIntent, type FinalizeVoteIntent } from "./controlAuth";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { verifyGovernanceReserveRoute } from "./governanceVaultRoute";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type LedgerState = "prepared" | "pending" | "finalized" | "unresolved";
export interface FinalizeVoteLedger {
  version: 1;
  requestId: string;
  nonce: string;
  intent: FinalizeVoteIntent;
  intentSha256: string;
  transaction: Prepared;
  transactionSha256: string;
  state: LedgerState;
  updatedAt: number;
}
export interface FinalizeVoteEnvironment {
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
interface Effects {
  verify: (intent: FinalizeVoteIntent) => Promise<void>;
  prepare: (intent: FinalizeVoteIntent) => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared) => Promise<"pending" | "unresolved" | "finalized">;
}

function ledgerPath(environment: FinalizeVoteEnvironment) {
  return resolve(environment.stateRoot, "governance-finalize-vote.json");
}

function validateRoute(environment: FinalizeVoteEnvironment, intent: FinalizeVoteIntent) {
  validateFinalizeVoteIntent(intent, intent.verifiedAt);
  const program = new PublicKey(environment.governanceProgram);
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const id = BigInt(intent.proposalId);
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(id);
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program)[0];
  if (intent.governanceProgram !== program.toBase58()
    || intent.programCodeSha256 !== environment.expectedProgramCodeSha256
    || intent.reserveMint !== new PublicKey(environment.reserveMint).toBase58()
    || intent.capitalMint !== new PublicKey(environment.capitalMint).toBase58()
    || intent.config !== config.toBase58() || intent.proposal !== proposal.toBase58()) {
    throw new Error("GOVERNANCE_FINALIZE_ROUTE_MISMATCH");
  }
  return { program, config, proposal, id };
}

export function buildFinalizeVoteInstruction(environment: FinalizeVoteEnvironment, intent: FinalizeVoteIntent) {
  const { program, config, proposal } = validateRoute(environment, intent);
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: proposal, isSigner: false, isWritable: true },
    ],
    data: createHash("sha256").update("global:finalize").digest().subarray(0, 8),
  });
}

function assertExactSignedTransaction(environment: FinalizeVoteEnvironment, intent: FinalizeVoteIntent, prepared: Prepared) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64")); }
  catch { throw new Error("GOVERNANCE_FINALIZE_LEDGER_TRANSACTION_INVALID"); }
  const payer = new PublicKey(environment.admin);
  const expected = buildFinalizeVoteInstruction(environment, intent);
  const message = tx.message;
  const ix = message.compiledInstructions[0];
  const keys = message.staticAccountKeys;
  if (message.version !== 0 || message.addressTableLookups.length !== 0
    || message.compiledInstructions.length !== 1 || !ix
    || message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1
    || keys.length !== 4 || !keys[0]?.equals(payer)
    || !keys[ix.programIdIndex]?.equals(expected.programId)
    || ix.accountKeyIndexes.length !== 2
    || !keys[ix.accountKeyIndexes[0]]?.equals(expected.keys[0].pubkey)
    || !keys[ix.accountKeyIndexes[1]]?.equals(expected.keys[1].pubkey)
    || !message.isAccountWritable(0)
    || !message.isAccountWritable(ix.accountKeyIndexes[0])
    || !message.isAccountWritable(ix.accountKeyIndexes[1])
    || message.isAccountWritable(ix.programIdIndex)
    || !Buffer.from(ix.data).equals(expected.data)
    || message.recentBlockhash !== prepared.blockhash
    || !Number.isSafeInteger(prepared.lastValidBlockHeight) || prepared.lastValidBlockHeight <= 0
    || bs58.encode(tx.signatures[0]) !== prepared.signature
    || !nacl.sign.detached.verify(message.serialize(), tx.signatures[0], payer.toBytes())) {
    throw new Error("GOVERNANCE_FINALIZE_LEDGER_TRANSACTION_INVALID");
  }
}

/** Re-check the exact ballot bytes, config, program hash and chain time at two
 * independent finalized RPCs before signing even the permissionless finalize ix. */
export async function verifyFinalizableVote(environment: FinalizeVoteEnvironment, intent: FinalizeVoteIntent) {
  const { program, config: configAddress, proposal: proposalAddress, id } = validateRoute(environment, intent);
  const route = await verifyGovernanceReserveRoute(environment.rpcUrls, {
    governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority,
    reserveMint: environment.reserveMint,
    capitalMint: environment.capitalMint,
    admin: environment.admin,
  });
  if (route.ata !== intent.reserveVault || route.activeProposalId !== id
    || route.committedRaw !== BigInt(intent.frozenReserveRawMstrx)) {
    throw new Error("GOVERNANCE_FINALIZE_COMMITMENT_MISMATCH");
  }
  const agreed = await finalizedConsensus(environment.rpcUrls);
  const states = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [read, chainTime] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext([configAddress, proposalAddress], {
        commitment: "finalized", minContextSlot: agreed.slot,
      }),
      connection.getBlockTime(agreed.slot),
    ]);
    if (read.context.slot < agreed.slot || !Number.isSafeInteger(chainTime)) {
      throw new Error("GOVERNANCE_FINALIZE_RPC_STALE");
    }
    const [configAccount, proposalAccount] = read.value;
    if (!configAccount || !proposalAccount || !configAccount.owner.equals(program)
      || !proposalAccount.owner.equals(program) || configAccount.executable || proposalAccount.executable
      || configAccount.data.length !== 306 || proposalAccount.data.length !== 726) {
      throw new Error("GOVERNANCE_FINALIZE_ACCOUNT_INVALID");
    }
    const config = await parseGovernanceConfig(configAccount);
    const proposal = await parseGovernanceProposal(proposalAddress.toBase58(), proposalAccount);
    const digest = createHash("sha256").update(proposalAccount.data).digest("hex");
    if (config.admin !== environment.admin || config.capitalMint !== environment.capitalMint
      || config.reserveMint !== environment.reserveMint || config.reserveVault !== intent.reserveVault
      || config.activeProposalId !== id || config.committedReserveRawMstrx !== proposal.frozenReserveRawMstrx
      || proposal.id !== id || proposal.config !== configAddress.toBase58()
      || proposal.capitalMint !== environment.capitalMint || proposal.reserveVault !== intent.reserveVault
      || ![0, 6].includes(proposal.status)
      || proposal.frozenReserveRawMstrx !== BigInt(intent.frozenReserveRawMstrx)
      || proposal.executableAt !== intent.executableAt
      || proposal.executableAt !== proposal.endsAt + 300
      || digest !== intent.proposalStateSha256 || chainTime! < proposal.executableAt) {
      throw new Error("GOVERNANCE_FINALIZE_STATE_MISMATCH");
    }
    return { config: configAccount.data.toString("hex"), proposal: proposalAccount.data.toString("hex"), chainTime };
  }));
  requireMatchingValues(states, "GOVERNANCE_FINALIZE_RPC_DISAGREEMENT");
}

async function agreedTransactionState(environment: FinalizeVoteEnvironment, prepared: Prepared) {
  const states = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [status, height] = await Promise.all([
      connection.getSignatureStatuses([prepared.signature], { searchTransactionHistory: true }),
      connection.getBlockHeight("finalized"),
    ]);
    return { status: status.value[0], height };
  }));
  if (states.some(({ status }) => status?.err)) throw new Error("GOVERNANCE_FINALIZE_TRANSACTION_FAILED");
  if (states.every(({ status }) => status?.confirmationStatus === "finalized")) return "finalized" as const;
  if (states.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) {
    return "unresolved" as const;
  }
  return "pending" as const;
}

function productionEffects(environment: FinalizeVoteEnvironment): Effects {
  if (!SOLANA_GOVERNANCE_FINALIZE_RELEASED) throw new Error("GOVERNANCE_FINALIZE_NOT_RELEASED");
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  return {
    verify: (intent) => verifyFinalizableVote(environment, intent),
    prepare: async (intent) => {
      const signer = await loadKeypair(environment.adminKeypairPath);
      if (signer.publicKey.toBase58() !== environment.admin) throw new Error("GOVERNANCE_FINALIZE_ADMIN_KEY_MISMATCH");
      const prepared = await prepareSignedTransaction({
        connection, payer: signer, instructions: [buildFinalizeVoteInstruction(environment, intent)],
      });
      const height = await connection.getBlockHeight("confirmed");
      if (!Number.isSafeInteger(height) || prepared.lastValidBlockHeight <= height
        || prepared.lastValidBlockHeight > height + 300) throw new Error("GOVERNANCE_FINALIZE_BLOCKHASH_WINDOW_INVALID");
      return prepared;
    },
    broadcast: async (prepared) => {
      const returned = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (returned !== prepared.signature) throw new Error("GOVERNANCE_FINALIZE_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared) => agreedTransactionState(environment, prepared),
  };
}

async function readLedger(environment: FinalizeVoteEnvironment) {
  const ledger = await readJsonIfExists<FinalizeVoteLedger>(ledgerPath(environment));
  if (!ledger) return;
  if (ledger.version !== 1 || !["prepared", "pending", "finalized", "unresolved"].includes(ledger.state)
    || !/^\d+-[a-f0-9]{16}$/.test(ledger.requestId) || !/^[a-f0-9]{40}$/.test(ledger.nonce)
    || createHash("sha256").update(JSON.stringify(ledger.intent)).digest("hex") !== ledger.intentSha256
    || !ledger.transaction?.signature || !ledger.transaction.transactionBase64
    || createHash("sha256").update(Buffer.from(ledger.transaction.transactionBase64, "base64")).digest("hex") !== ledger.transactionSha256) {
    throw new Error("GOVERNANCE_FINALIZE_LEDGER_INVALID");
  }
  validateRoute(environment, ledger.intent);
  assertExactSignedTransaction(environment, ledger.intent, ledger.transaction);
  return ledger;
}

export async function reconcileFinalizeVote(
  environment: FinalizeVoteEnvironment, effects: Effects = productionEffects(environment),
): Promise<FinalizeVoteLedger | undefined> {
  const ledger = await readLedger(environment);
  if (!ledger || ledger.state === "finalized") return ledger;
  const state = await effects.transactionState(ledger.transaction);
  if (ledger.state === "unresolved" && state !== "finalized") return ledger;
  if (state === "pending") {
    // Crash after durable prepare may rebroadcast these exact bytes only.
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

export async function finalizeVote(
  environment: FinalizeVoteEnvironment,
  request: { requestId: string; nonce: string; intent: FinalizeVoteIntent },
  effects: Effects = productionEffects(environment),
): Promise<FinalizeVoteLedger> {
  if (!/^\d+-[a-f0-9]{16}$/.test(request.requestId) || !/^[a-f0-9]{40}$/.test(request.nonce)) {
    throw new Error("GOVERNANCE_FINALIZE_REQUEST_INVALID");
  }
  const prior = await reconcileFinalizeVote(environment, effects);
  if (prior && ["prepared", "pending"].includes(prior.state)) throw new Error("GOVERNANCE_FINALIZE_PENDING_RECONCILIATION");
  if (prior?.state === "unresolved") throw new Error("GOVERNANCE_FINALIZE_UNRESOLVED_REVIEW_REQUIRED");
  if (prior?.nonce === request.nonce) throw new Error("GOVERNANCE_FINALIZE_NONCE_ALREADY_USED");
  validateRoute(environment, request.intent);
  await effects.verify(request.intent);
  const transaction = await effects.prepare(request.intent);
  assertExactSignedTransaction(environment, request.intent, transaction);
  if (prior) {
    await writeDurableJson(resolve(environment.stateRoot, "governance-finalize-vote-history", `${prior.nonce}.json`), prior);
  }
  const ledger: FinalizeVoteLedger = {
    version: 1, requestId: request.requestId, nonce: request.nonce, intent: request.intent,
    intentSha256: createHash("sha256").update(JSON.stringify(request.intent)).digest("hex"),
    transaction, transactionSha256: createHash("sha256").update(Buffer.from(transaction.transactionBase64, "base64")).digest("hex"),
    state: "prepared", updatedAt: Date.now(),
  };
  await writeDurableJson(ledgerPath(environment), ledger);
  await effects.broadcast(transaction);
  ledger.state = "pending"; ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(environment), ledger);
  return ledger;
}
