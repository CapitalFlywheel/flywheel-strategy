import {
  ammCreatorVaultPda, creatorVaultPda, OnlinePumpSdk, PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID, quoteAta,
} from "@pump-fun/pump-sdk";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";

export async function buildCustomQuoteCreatorFeeSweep(args: {
  rpcUrl: string;
  creator: string;
  quoteMint: string;
  quoteTokenProgram: string;
  feePayer?: string;
}): Promise<TransactionInstruction[]> {
  const connection = new Connection(args.rpcUrl, "finalized");
  const creator = new PublicKey(args.creator);
  const feePayer = args.feePayer ? new PublicKey(args.feePayer) : creator;
  const sdk = new OnlinePumpSdk(connection);
  return sdk.collectCoinCreatorFeeV2Instructions(
    creator,
    new PublicKey(args.quoteMint),
    new PublicKey(args.quoteTokenProgram),
    feePayer,
  );
}

export async function buildCustomQuoteCreatorFeeSweepPlan(args: {
  rpcUrl: string;
  creator: string;
  quoteMint: string;
  quoteTokenProgram: string;
  feePayer?: string;
}) {
  const instructions = await buildCustomQuoteCreatorFeeSweep(args);
  const curve = instructions.filter((instruction) => instruction.programId.equals(PUMP_PROGRAM_ID));
  const pumpSwap = instructions.filter((instruction) => instruction.programId.equals(PUMP_AMM_PROGRAM_ID));
  if (curve.length !== 1) throw new Error("PUMP_CURVE_SWEEP_INVALID");
  if (instructions.length !== curve.length + pumpSwap.length) throw new Error("PUMP_SWEEP_PROGRAM_UNEXPECTED");
  return { curve, pumpSwap };
}

export async function readCustomQuoteCreatorFeeBalances(args: {
  rpcUrl: string;
  creator: string;
  quoteMint: string;
  quoteTokenProgram: string;
}) {
  // The SDK's getCreatorVaultQuoteBalances enumerates only quote mints that
  // are *currently* listed in Global/QuoteControl. A delisted quote can still
  // accrue fees for an existing coin, so always inspect this fixed quote's
  // canonical vault ATAs directly.
  const connection = new Connection(args.rpcUrl, "finalized");
  const creator = new PublicKey(args.creator);
  const quoteMint = new PublicKey(args.quoteMint);
  const quoteTokenProgram = new PublicKey(args.quoteTokenProgram);
  if (!quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("PUMP_QUOTE_TOKEN_PROGRAM_INVALID");
  const curveAuthority = creatorVaultPda(creator);
  const pumpSwapAuthority = ammCreatorVaultPda(creator);
  const curveAta = quoteAta(curveAuthority, quoteMint, quoteTokenProgram);
  const pumpSwapAta = quoteAta(pumpSwapAuthority, quoteMint, quoteTokenProgram);
  const [curveAccount, pumpSwapAccount] = await connection.getMultipleAccountsInfo(
    [curveAta, pumpSwapAta], "finalized",
  );
  const readAmount = (account: typeof curveAccount, ata: PublicKey, authority: PublicKey) => {
    if (!account) return 0n;
    let decoded;
    try { decoded = unpackAccount(ata, account, quoteTokenProgram); }
    catch { throw new Error("PUMP_MSTRX_FEE_VAULT_INVALID"); }
    if (!decoded.mint.equals(quoteMint) || !decoded.owner.equals(authority)
      || !decoded.isInitialized || decoded.isFrozen || decoded.delegate !== null
      || decoded.closeAuthority !== null) throw new Error("PUMP_MSTRX_FEE_VAULT_INVALID");
    return decoded.amount;
  };
  const curveRaw = readAmount(curveAccount, curveAta, curveAuthority);
  const pumpSwapRaw = readAmount(pumpSwapAccount, pumpSwapAta, pumpSwapAuthority);
  return {
    curveRaw,
    pumpSwapRaw,
    totalRaw: curveRaw + pumpSwapRaw,
  };
}

export function assertSweepDestinations(instructions: readonly TransactionInstruction[], creator: string) {
  const creatorKey = new PublicKey(creator);
  if (!instructions.length) throw new Error("PUMP_SWEEP_EMPTY");
  if (!instructions.some((instruction) => instruction.keys.some((key) => key.pubkey.equals(creatorKey)))) {
    throw new Error("PUMP_CREATOR_NOT_PRESENT");
  }
}
