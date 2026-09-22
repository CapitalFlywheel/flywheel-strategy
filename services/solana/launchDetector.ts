import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

export interface PumpCreateCandidate {
  signature: string;
  slot: number;
  blockTime: number;
  mint: string;
  creator: string;
  user: string;
  quoteMint: string;
  tokenProgram: string;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
}

export function selectArmedLaunchCandidate(args: {
  candidates: readonly PumpCreateCandidate[];
  creator: string;
  armedAtMs: number;
}) {
  const creator = new PublicKey(args.creator).toBase58();
  const candidates = args.candidates.filter((candidate) => (
    candidate.creator === creator && candidate.blockTime * 1_000 >= args.armedAtMs
  ));
  if (candidates.length > 1) throw new Error("MULTIPLE_PUMP_LAUNCHES_AFTER_ARM");
  return candidates[0];
}

function decodePumpCreateLogs(args: {
  signature: string;
  slot: number;
  blockTime: number;
  logs: readonly string[];
}) {
  const candidates: PumpCreateCandidate[] = [];
  for (const log of args.logs) {
    const encoded = log.startsWith("Program data: ") ? log.slice("Program data: ".length) : undefined;
    if (!encoded) continue;
    try {
      const event = PUMP_SDK.decodeCreateEventBc(Buffer.from(encoded, "base64"));
      candidates.push({
        signature: args.signature,
        slot: args.slot,
        blockTime: args.blockTime,
        mint: event.mint.toBase58(),
        creator: event.creator.toBase58(),
        user: event.user.toBase58(),
        quoteMint: event.quoteMint.toBase58(),
        tokenProgram: event.tokenProgram.toBase58(),
        creatorFeeBps: BigInt(event.creatorFeeBps.toString()),
        isHolderReward: event.isHolderReward,
      });
    } catch {
      // Other Anchor events share the same log prefix and are intentionally ignored
    }
  }
  return candidates;
}

export async function detectCreatorPumpLaunch(args: {
  rpcUrl: string;
  creator: string;
  armedAtMs: number;
  limit?: number;
}) {
  const connection = new Connection(args.rpcUrl, "finalized");
  const signatures = await connection.getSignaturesForAddress(
    new PublicKey(args.creator),
    { limit: args.limit ?? 100 },
    "finalized",
  );
  const eligible = signatures.filter((entry): entry is typeof entry & { blockTime: number } => (
    !entry.err && typeof entry.blockTime === "number" && entry.blockTime * 1_000 >= args.armedAtMs
  ));
  const transactions = await Promise.all(eligible.map(async (entry) => {
    const transaction = await connection.getTransaction(entry.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction?.blockTime || !transaction.meta?.logMessages) return [];
    return decodePumpCreateLogs({
      signature: entry.signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      logs: transaction.meta.logMessages,
    });
  }));
  return selectArmedLaunchCandidate({
    candidates: transactions.flat(),
    creator: args.creator,
    armedAtMs: args.armedAtMs,
  });
}
