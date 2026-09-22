import { OnlinePumpSdk, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
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
  const connection = new Connection(args.rpcUrl, "finalized");
  const sdk = new OnlinePumpSdk(connection);
  const quoteMint = new PublicKey(args.quoteMint);
  const quoteTokenProgram = new PublicKey(args.quoteTokenProgram);
  const balances = await sdk.getCreatorVaultQuoteBalances(new PublicKey(args.creator));
  const matching = balances.filter((balance) => (
    balance.mint.equals(quoteMint) && balance.quoteTokenProgram.equals(quoteTokenProgram)
  ));
  if (matching.length !== 1) throw new Error("PUMP_MSTRX_QUOTE_BALANCE_UNAVAILABLE");
  return {
    curveRaw: BigInt(matching[0].pumpVault.toString()),
    pumpSwapRaw: BigInt(matching[0].ammVault.toString()),
    totalRaw: BigInt(matching[0].total.toString()),
  };
}

export function assertSweepDestinations(instructions: readonly TransactionInstruction[], creator: string) {
  const creatorKey = new PublicKey(creator);
  if (!instructions.length) throw new Error("PUMP_SWEEP_EMPTY");
  if (!instructions.some((instruction) => instruction.keys.some((key) => key.pubkey.equals(creatorKey)))) {
    throw new Error("PUMP_CREATOR_NOT_PRESENT");
  }
}
