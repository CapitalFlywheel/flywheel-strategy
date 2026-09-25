import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { assertFixedMstrxPumpLaunch } from "./launchVerifier";
import { verifyAgreedPumpCreateCandidate, type PumpCreateCandidate } from "./launchDetector";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { deriveGovernanceReserveRoute, verifyGovernanceReserveRoute, verifyGovernanceReserveSetup } from "./governanceVaultRoute";
import { loadKeypair, prepareSignedTransaction } from "./transactions";

type Prepared = Awaited<ReturnType<typeof prepareSignedTransaction>>;
type Attempt = { transaction: Prepared; state: "prepared" | "expired" };
interface BindLedger {
  version: 1;
  identity: string;
  attempts: Attempt[];
  finalized: boolean;
}

export interface GovernanceBindEnvironment {
  rpcUrls: readonly [string, string];
  stateRoot: string;
  governanceProgram: string;
  expectedProgramCodeSha256: string;
  reserveAuthority: string;
  reserveMint: string;
  admin: string;
  adminKeypairPath: string;
  expectedCreator: string;
  launch: PumpCreateCandidate;
}

interface BindEffects {
  verifyLaunch: () => Promise<void>;
  readBinding: () => Promise<"unbound" | "bound">;
  prepare: () => Promise<Prepared>;
  broadcast: (transaction: Prepared) => Promise<void>;
  transactionState: (transaction: Prepared) => Promise<"pending" | "expired" | "finalized">;
}

function identity(environment: GovernanceBindEnvironment) {
  const { launch } = environment;
  return JSON.stringify({
    network: "solana-mainnet-beta", program: new PublicKey(environment.governanceProgram).toBase58(),
    programCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: new PublicKey(environment.reserveAuthority).toBase58(),
    reserveMint: new PublicKey(environment.reserveMint).toBase58(),
    admin: new PublicKey(environment.admin).toBase58(),
    creator: new PublicKey(environment.expectedCreator).toBase58(),
    mint: new PublicKey(launch.mint).toBase58(), signature: launch.signature,
    slot: launch.slot, blockTime: launch.blockTime,
    launchCreator: new PublicKey(launch.creator).toBase58(),
    launchUser: new PublicKey(launch.user).toBase58(),
    quoteMint: new PublicKey(launch.quoteMint).toBase58(),
    tokenProgram: new PublicKey(launch.tokenProgram).toBase58(),
    creatorFeeBps: launch.creatorFeeBps.toString(),
    isHolderReward: launch.isHolderReward,
  });
}

function ledgerPath(environment: GovernanceBindEnvironment) {
  return resolve(environment.stateRoot, "governance-capital-bind.json");
}

export function buildBindCapitalMintInstruction(environment: GovernanceBindEnvironment) {
  const launch = environment.launch;
  if (!Number.isSafeInteger(launch.slot) || launch.slot <= 0
    || !Number.isSafeInteger(launch.blockTime) || launch.blockTime <= 0) throw new Error("GOVERNANCE_LAUNCH_EVIDENCE_INVALID");
  const launchSignature = Buffer.from(bs58.decode(launch.signature));
  if (launchSignature.length !== 64 || launchSignature.every((byte) => byte === 0)) {
    throw new Error("GOVERNANCE_LAUNCH_SIGNATURE_INVALID");
  }
  const route = deriveGovernanceReserveRoute(environment.governanceProgram, environment.reserveMint);
  if (route.authority.toBase58() !== environment.reserveAuthority) throw new Error("GOVERNANCE_RESERVE_AUTHORITY_MISMATCH");
  const data = Buffer.alloc(8 + 8 + 8 + 64);
  createHash("sha256").update("global:bind_capital_mint").digest().copy(data, 0, 0, 8);
  data.writeBigInt64LE(BigInt(launch.blockTime), 8);
  data.writeBigUInt64LE(BigInt(launch.slot), 16);
  launchSignature.copy(data, 24);
  return new TransactionInstruction({
    programId: route.program,
    keys: [
      { pubkey: route.authority, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(launch.mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(environment.admin), isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function onchainBinding(environment: GovernanceBindEnvironment): Promise<"unbound" | "bound"> {
  const route = {
    governanceProgram: environment.governanceProgram,
    expectedProgramCodeSha256: environment.expectedProgramCodeSha256,
    reserveAuthority: environment.reserveAuthority,
    reserveMint: environment.reserveMint,
    admin: environment.admin,
    capitalMint: environment.launch.mint,
  };
  try {
    const bound = await verifyGovernanceReserveRoute(environment.rpcUrls, route);
    const signature = Buffer.from(bs58.decode(environment.launch.signature));
    if (signature.length !== 64 || !bound.launchSignature.equals(signature)
      || bound.launchSlot !== BigInt(environment.launch.slot)
      || bound.launchedAt !== BigInt(environment.launch.blockTime)) {
      throw new Error("GOVERNANCE_LAUNCH_BINDING_MISMATCH");
    }
    return "bound";
  } catch (boundError) {
    // A bound but mismatched program must never be treated as unbound. Only an
    // independently verified pristine Config permits the one-time instruction.
    try {
      await verifyGovernanceReserveSetup(environment.rpcUrls, route);
      return "unbound";
    } catch {
      throw boundError;
    }
  }
}

async function agreedTransactionState(environment: GovernanceBindEnvironment, prepared: Prepared) {
  const statuses = await Promise.all(environment.rpcUrls.map(async (rpcUrl) => {
    const connection = new Connection(rpcUrl, "finalized");
    const [response, height] = await Promise.all([
      connection.getSignatureStatuses([prepared.signature], { searchTransactionHistory: true }),
      connection.getBlockHeight("finalized"),
    ]);
    return { status: response.value[0], height };
  }));
  if (statuses.some(({ status }) => status?.err)) throw new Error("GOVERNANCE_BIND_TRANSACTION_FAILED");
  if (statuses.every(({ status }) => status?.confirmationStatus === "finalized")) return "finalized" as const;
  if (statuses.every(({ status, height }) => status === null && height > prepared.lastValidBlockHeight + 32)) return "expired" as const;
  return "pending" as const;
}

function productionEffects(environment: GovernanceBindEnvironment): BindEffects {
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  return {
    verifyLaunch: async () => {
      await verifyAgreedPumpCreateCandidate(environment.rpcUrls, environment.launch);
      assertFixedMstrxPumpLaunch({
        ...environment.launch,
        expectedCreator: environment.expectedCreator,
        expectedQuoteMint: environment.reserveMint,
      });
    },
    readBinding: () => onchainBinding(environment),
    prepare: async () => {
      const admin = await loadKeypair(environment.adminKeypairPath);
      if (!admin.publicKey.equals(new PublicKey(environment.admin))) throw new Error("GOVERNANCE_ADMIN_KEYPAIR_MISMATCH");
      return prepareSignedTransaction({
        connection, payer: admin,
        instructions: [buildBindCapitalMintInstruction(environment)],
      });
    },
    broadcast: async (prepared) => {
      const submitted = await connection.sendRawTransaction(Buffer.from(prepared.transactionBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
      });
      if (submitted !== prepared.signature) throw new Error("GOVERNANCE_BIND_SIGNATURE_MISMATCH");
    },
    transactionState: (prepared) => agreedTransactionState(environment, prepared),
  };
}

/** Returns true only after both finalized RPCs see the exact onchain binding. */
export async function ensureGovernanceCapitalBound(
  environment: GovernanceBindEnvironment,
  effects: BindEffects = productionEffects(environment),
): Promise<boolean> {
  const expectedIdentity = identity(environment);
  const path = ledgerPath(environment);
  const ledger = await readJsonIfExists<BindLedger>(path) ?? {
    version: 1 as const, identity: expectedIdentity, attempts: [], finalized: false,
  };
  if (ledger.version !== 1 || ledger.identity !== expectedIdentity || !Array.isArray(ledger.attempts)) {
    throw new Error("GOVERNANCE_BIND_LEDGER_IDENTITY_MISMATCH");
  }
  // Re-check the exact finalized Pump CreateEvent on both providers at every
  // retry, before using a previously signed transaction or signing a new one.
  await effects.verifyLaunch();
  if (await effects.readBinding() === "bound") {
    if (!ledger.finalized) {
      ledger.finalized = true;
      await writeDurableJson(path, ledger);
    }
    return true;
  }
  if (ledger.finalized) throw new Error("GOVERNANCE_BIND_REORG_OR_CONFIG_CHANGE");
  const last = ledger.attempts.at(-1);
  if (last?.state === "prepared") {
    const state = await effects.transactionState(last.transaction);
    if (state === "finalized") throw new Error("GOVERNANCE_BIND_FINALIZED_BUT_UNBOUND");
    if (state === "pending") {
      // Identical signed bytes are safe to rebroadcast after a crash between
      // the durable write and the first network send.
      await effects.broadcast(last.transaction);
      return false;
    }
    last.state = "expired";
    await writeDurableJson(path, ledger);
  }
  if (ledger.attempts.length >= 5) throw new Error("GOVERNANCE_BIND_RETRY_LIMIT");
  const transaction = await effects.prepare();
  if (!transaction.signature || !transaction.transactionBase64
    || !transaction.blockhash || !Number.isSafeInteger(transaction.lastValidBlockHeight)) {
    throw new Error("GOVERNANCE_BIND_PREPARED_INVALID");
  }
  ledger.attempts.push({ transaction, state: "prepared" });
  await writeDurableJson(path, ledger); // Never broadcast before durable persistence.
  await effects.broadcast(transaction);
  return false;
}
