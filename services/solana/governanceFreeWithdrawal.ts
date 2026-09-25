import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction, getMint, getTransferHook,
} from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED, type FreeReserveWithdrawalIntent } from "./controlAuth";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { deriveGovernanceReserveRoute, verifyGovernanceReserveRoute } from "./governanceVaultRoute";
import { mstrxAta } from "./mstrxTransfers";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type LedgerState = "prepared" | "pending" | "finalized" | "unresolved";
export interface FreeWithdrawalLedger {
  version: 1;
  requestId: string;
  nonce: string;
  intent: FreeReserveWithdrawalIntent;
  transaction: Prepared;
  transactionSha256: string;
  state: LedgerState;
  updatedAt: number;
}

export interface FreeWithdrawalEnvironment {
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
  verifiedFree: () => Promise<bigint>;
  prepare: (intent: FreeReserveWithdrawalIntent) => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared) => Promise<"pending" | "unresolved" | "finalized">;
}

function ledgerPath(environment: FreeWithdrawalEnvironment) {
  return resolve(environment.stateRoot, "governance-free-withdrawal.json");
}

function assertPreparedSignedTransaction(
  environment: FreeWithdrawalEnvironment,
  intent: FreeReserveWithdrawalIntent,
  prepared: Prepared,
) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64")); }
  catch { throw new Error("RESERVE_WITHDRAWAL_LEDGER_TRANSACTION_INVALID"); }
  const { route, admin, ata } = validateRouteIntent(environment, intent);
  const message = tx.message;
  if (message.version !== 0 || message.addressTableLookups.length !== 0
    || message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1
    || !message.staticAccountKeys[0]?.equals(admin)
    || message.recentBlockhash !== prepared.blockhash
    || !Number.isSafeInteger(prepared.lastValidBlockHeight) || prepared.lastValidBlockHeight <= 0
    || bs58.encode(tx.signatures[0]) !== prepared.signature
    || !nacl.sign.detached.verify(message.serialize(), tx.signatures[0], admin.toBytes())
    || message.compiledInstructions.length !== 2) throw new Error("RESERVE_WITHDRAWAL_LEDGER_TRANSACTION_INVALID");
  const keys = message.staticAccountKeys;
  const actual = message.compiledInstructions;
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(admin, ata, admin, route.mint, TOKEN_2022_PROGRAM_ID);
  const withdrawIx = buildWithdrawFreeInstruction(environment, intent, []);
  const expected = [ataIx, withdrawIx];
  for (let index = 0; index < expected.length; index++) {
    const ix = actual[index];
    const base = expected[index];
    if (!keys[ix.programIdIndex]?.equals(index === 0 ? ASSOCIATED_TOKEN_PROGRAM_ID : route.program)
      || !Buffer.from(ix.data).equals(base.data)
      || ix.accountKeyIndexes.length < base.keys.length
      || (index === 0 && ix.accountKeyIndexes.length !== base.keys.length)
      || base.keys.some((meta, keyIndex) => !keys[ix.accountKeyIndexes[keyIndex]]?.equals(meta.pubkey))) {
      throw new Error("RESERVE_WITHDRAWAL_LEDGER_TRANSACTION_INVALID");
    }
  }
  if (!message.isAccountWritable(0)
    || !message.isAccountWritable(actual[1].accountKeyIndexes[2])
    || !message.isAccountWritable(actual[1].accountKeyIndexes[3])) {
    throw new Error("RESERVE_WITHDRAWAL_LEDGER_TRANSACTION_INVALID");
  }
}

function validateRouteIntent(environment: FreeWithdrawalEnvironment, intent: FreeReserveWithdrawalIntent) {
  const route = deriveGovernanceReserveRoute(environment.governanceProgram, environment.reserveMint);
  const admin = new PublicKey(environment.admin);
  const ata = mstrxAta(admin, route.mint);
  if (intent.governanceProgram !== route.program.toBase58()
    || intent.programCodeSha256 !== environment.expectedProgramCodeSha256
    || intent.reserveMint !== route.mint.toBase58()
    || intent.reserveVault !== route.ata.toBase58()
    || intent.capitalMint !== new PublicKey(environment.capitalMint).toBase58()
    || intent.adminAta !== ata.toBase58()
    || environment.reserveAuthority !== route.authority.toBase58()) {
    throw new Error("RESERVE_WITHDRAWAL_ROUTE_MISMATCH");
  }
  return { route, admin, ata };
}

export function buildWithdrawFreeInstruction(
  environment: FreeWithdrawalEnvironment,
  intent: FreeReserveWithdrawalIntent,
  hookAccounts: readonly { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
) {
  const { route, admin, ata } = validateRouteIntent(environment, intent);
  const data = Buffer.alloc(16);
  createHash("sha256").update("global:withdraw_free").digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(BigInt(intent.amountRaw), 8);
  return new TransactionInstruction({
    programId: route.program,
    keys: [
      { pubkey: route.authority, isSigner: false, isWritable: false },
      { pubkey: route.mint, isSigner: false, isWritable: false },
      { pubkey: route.ata, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ...hookAccounts,
    ],
    data,
  });
}

async function agreedHookAccounts(environment: FreeWithdrawalEnvironment, intent: FreeReserveWithdrawalIntent) {
  const { route, ata } = validateRouteIntent(environment, intent);
  const results = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const mint = await getMint(connection, route.mint, "finalized", TOKEN_2022_PROGRAM_ID);
    const hook = getTransferHook(mint)?.programId;
    if (!hook) throw new Error("RESERVE_WITHDRAWAL_HOOK_UNVERIFIED");
    const transfer = await createTransferCheckedWithTransferHookInstruction(
      connection, route.ata, route.mint, ata, route.authority,
      BigInt(intent.amountRaw), mint.decimals, [], "finalized", TOKEN_2022_PROGRAM_ID,
    );
    const extras = transfer.keys.slice(4);
    // MSTRx currently exposes the extension with the all-zero/default hook
    // program, which is inactive. A future non-default hook must supply its
    // executable program and resolved extra account metas on both RPCs.
    if (hook.equals(SystemProgram.programId)) {
      if (extras.length) throw new Error("RESERVE_WITHDRAWAL_HOOK_UNVERIFIED");
    } else if (!extras.some((meta) => meta.pubkey.equals(hook))) {
      throw new Error("RESERVE_WITHDRAWAL_HOOK_UNVERIFIED");
    }
    // A newly activated issuer hook may need additional review. Never pass an
    // unrelated writable account or an external signer through this financial
    // instruction merely because mutable hook metadata requested it.
    if (extras.some((meta) => meta.isSigner || (meta.isWritable
      && !meta.pubkey.equals(route.ata) && !meta.pubkey.equals(ata)))) {
      throw new Error("RESERVE_WITHDRAWAL_HOOK_PRIVILEGE_UNREVIEWED");
    }
    return { decimals: mint.decimals, hook: hook.toBase58(), extras,
      fingerprint: JSON.stringify(extras.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable])) };
  }));
  if (results[0].decimals !== results[1].decimals || results[0].hook !== results[1].hook
    || results[0].fingerprint !== results[1].fingerprint) throw new Error("RESERVE_WITHDRAWAL_HOOK_RPC_DISAGREEMENT");
  return results[0].extras;
}

async function agreedTransactionState(environment: FreeWithdrawalEnvironment, prepared: Prepared) {
  const statuses = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [response, height] = await Promise.all([
      connection.getSignatureStatuses([prepared.signature], { searchTransactionHistory: true }),
      connection.getBlockHeight("finalized"),
    ]);
    return { status: response.value[0], height };
  }));
  if (statuses.some(({ status }) => status?.err)) throw new Error("RESERVE_WITHDRAWAL_TRANSACTION_FAILED");
  if (statuses.every(({ status }) => status?.confirmationStatus === "finalized")) return "finalized" as const;
  // Even two null history responses after blockhash expiry do not prove that
  // an earlier broadcast never executed. Keep the ledger unresolved until a
  // stronger independent reconciliation is available; never sign a duplicate.
  if (statuses.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) return "unresolved" as const;
  return "pending" as const;
}

function productionEffects(environment: FreeWithdrawalEnvironment): Effects {
  if (!SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED) throw new Error("RESERVE_WITHDRAWAL_NOT_RELEASED");
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  const route = {
    governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority,
    reserveMint: environment.reserveMint,
    admin: environment.admin,
    capitalMint: environment.capitalMint,
  };
  return {
    verifiedFree: async () => (await verifyGovernanceReserveRoute(environment.rpcUrls, route)).freeRaw,
    prepare: async (intent) => {
      const { route: derived, admin, ata } = validateRouteIntent(environment, intent);
      const signer = await loadKeypair(environment.adminKeypairPath);
      if (!signer.publicKey.equals(admin)) throw new Error("RESERVE_WITHDRAWAL_ADMIN_KEY_MISMATCH");
      const hookAccounts = await agreedHookAccounts(environment, intent);
      const createAta = createAssociatedTokenAccountIdempotentInstruction(
        admin, ata, admin, derived.mint, TOKEN_2022_PROGRAM_ID,
      );
      const prepared = await prepareSignedTransaction({
        connection, payer: signer,
        instructions: [createAta, buildWithdrawFreeInstruction(environment, intent, hookAccounts)],
      });
      const height = await connection.getBlockHeight("confirmed");
      if (!Number.isSafeInteger(height) || prepared.lastValidBlockHeight <= height
        || prepared.lastValidBlockHeight > height + 300) throw new Error("RESERVE_WITHDRAWAL_BLOCKHASH_WINDOW_INVALID");
      return prepared;
    },
    broadcast: async (prepared) => {
      const returned = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (returned !== prepared.signature) throw new Error("RESERVE_WITHDRAWAL_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared) => agreedTransactionState(environment, prepared),
  };
}

async function readLedger(environment: FreeWithdrawalEnvironment) {
  const ledger = await readJsonIfExists<FreeWithdrawalLedger>(ledgerPath(environment));
  if (!ledger) return;
  if (ledger.version !== 1 || !["prepared", "pending", "finalized", "unresolved"].includes(ledger.state)
    || !/^[a-f0-9]{40}$/.test(ledger.nonce)
    || !/^\d+-[a-f0-9]{16}$/.test(ledger.requestId)
    || !ledger.transaction?.signature || !ledger.transaction.transactionBase64
    || createHash("sha256").update(Buffer.from(ledger.transaction.transactionBase64, "base64")).digest("hex") !== ledger.transactionSha256) {
    throw new Error("RESERVE_WITHDRAWAL_LEDGER_INVALID");
  }
  validateRouteIntent(environment, ledger.intent);
  assertPreparedSignedTransaction(environment, ledger.intent, ledger.transaction);
  return ledger;
}

export async function reconcileFreeWithdrawal(
  environment: FreeWithdrawalEnvironment,
  effects: Effects = productionEffects(environment),
): Promise<FreeWithdrawalLedger | undefined> {
  const ledger = await readLedger(environment);
  if (!ledger || ledger.state === "finalized") return ledger;
  if (ledger.state === "unresolved") {
    if (await effects.transactionState(ledger.transaction) === "finalized") {
      ledger.state = "finalized";
      ledger.updatedAt = Date.now();
      await writeDurableJson(ledgerPath(environment), ledger);
    }
    return ledger;
  }
  const state = await effects.transactionState(ledger.transaction);
  if (state === "pending") {
    // A restart after durable prepare but before first send may rebroadcast
    // precisely the same signed bytes, never a freshly signed duplicate.
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

export async function withdrawFreeReserve(
  environment: FreeWithdrawalEnvironment,
  request: { requestId: string; nonce: string; intent: FreeReserveWithdrawalIntent },
  effects: Effects = productionEffects(environment),
): Promise<FreeWithdrawalLedger> {
  if (!/^\d+-[a-f0-9]{16}$/.test(request.requestId) || !/^[a-f0-9]{40}$/.test(request.nonce)) {
    throw new Error("RESERVE_WITHDRAWAL_REQUEST_INVALID");
  }
  const prior = await reconcileFreeWithdrawal(environment, effects);
  if (prior && (prior.state === "prepared" || prior.state === "pending")) {
    throw new Error("RESERVE_WITHDRAWAL_PENDING_RECONCILIATION");
  }
  if (prior?.state === "unresolved") throw new Error("RESERVE_WITHDRAWAL_UNRESOLVED_REVIEW_REQUIRED");
  if (prior?.nonce === request.nonce) throw new Error("RESERVE_WITHDRAWAL_NONCE_ALREADY_USED");
  validateRouteIntent(environment, request.intent);
  const free = await effects.verifiedFree();
  const amount = BigInt(request.intent.amountRaw);
  if (amount <= 0n || amount > free) throw new Error("RESERVE_WITHDRAWAL_EXCEEDS_FREE");
  const transaction = await effects.prepare(request.intent);
  if (!transaction.signature || !transaction.transactionBase64 || !transaction.blockhash
    || !Number.isSafeInteger(transaction.lastValidBlockHeight)) throw new Error("RESERVE_WITHDRAWAL_PREPARED_INVALID");
  assertPreparedSignedTransaction(environment, request.intent, transaction);
  if (prior) {
    await writeDurableJson(resolve(environment.stateRoot, "governance-free-withdrawal-history", `${prior.nonce}.json`), prior);
  }
  const ledger: FreeWithdrawalLedger = {
    version: 1, requestId: request.requestId, nonce: request.nonce, intent: request.intent,
    transaction, transactionSha256: createHash("sha256").update(Buffer.from(transaction.transactionBase64, "base64")).digest("hex"),
    state: "prepared", updatedAt: Date.now(),
  };
  await writeDurableJson(ledgerPath(environment), ledger);
  await effects.broadcast(transaction);
  ledger.state = "pending";
  ledger.updatedAt = Date.now();
  await writeDurableJson(ledgerPath(environment), ledger);
  return ledger;
}
