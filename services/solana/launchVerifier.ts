import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";

export interface PumpLaunchFacts {
  mint: string;
  creator: string;
  quoteMint: string;
  tokenProgram: string;
  holderReward: false;
  creatorFeeModel: "fixed-custom-pair";
  creatorFeeBps: 200;
  complete: boolean;
  finalizedSlot: number;
  finalizedBlockhash: string;
}

export function assertFixedMstrxPumpLaunch(input: {
  mint: string;
  creator: string;
  expectedCreator: string;
  quoteMint: string;
  tokenProgram: string;
  isHolderReward: boolean;
  creatorFeeBps: bigint;
  expectedQuoteMint: string;
}) {
  if (new PublicKey(input.creator).toBase58() !== new PublicKey(input.expectedCreator).toBase58()) throw new Error("PUMP_CREATOR_MISMATCH");
  if (new PublicKey(input.quoteMint).toBase58() !== new PublicKey(input.expectedQuoteMint).toBase58()) throw new Error("PUMP_QUOTE_NOT_MSTRX");
  if (new PublicKey(input.tokenProgram).toBase58() !== TOKEN_2022_PROGRAM_ID.toBase58()) throw new Error("PUMP_TOKEN_PROGRAM_MISMATCH");
  if (input.isHolderReward) throw new Error("PUMP_NATIVE_HOLDER_REWARD_ENABLED");
  if (input.creatorFeeBps !== 200n) throw new Error("PUMP_CREATOR_FEE_NOT_2_PERCENT");
  return true;
}

export async function verifyFixedMstrxPumpLaunch(args: {
  rpcUrls: readonly string[];
  mint: string;
  expectedCreator: string;
  expectedQuoteMint: string;
}): Promise<PumpLaunchFacts> {
  const consensus = await finalizedConsensus(args.rpcUrls);
  const mint = new PublicKey(args.mint);
  const snapshots = await Promise.all(args.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [curve, mintAccount] = await Promise.all([
      new OnlinePumpSdk(connection).fetchBondingCurve(mint),
      connection.getAccountInfo(mint, "finalized"),
    ]);
    if (!mintAccount) throw new Error("PUMP_MINT_NOT_FOUND");
    const snapshot = {
      mint: mint.toBase58(),
      creator: curve.creator.toBase58(),
      quoteMint: curve.quoteMint.toBase58(),
      tokenProgram: mintAccount.owner.toBase58(),
      isHolderReward: curve.isHolderReward,
      creatorFeeBps: BigInt(curve.creatorFeeBps.toString()),
      complete: curve.complete,
    };
    assertFixedMstrxPumpLaunch({ ...snapshot, expectedCreator: args.expectedCreator, expectedQuoteMint: args.expectedQuoteMint });
    return snapshot;
  }));
  const snapshot = requireMatchingValues(snapshots, "PUMP_LAUNCH_RPC_DISAGREEMENT");
  return {
    mint: snapshot.mint,
    creator: snapshot.creator,
    quoteMint: snapshot.quoteMint,
    tokenProgram: snapshot.tokenProgram,
    holderReward: false,
    creatorFeeModel: "fixed-custom-pair",
    creatorFeeBps: 200,
    complete: snapshot.complete,
    finalizedSlot: consensus.slot,
    finalizedBlockhash: consensus.blockhash,
  };
}
