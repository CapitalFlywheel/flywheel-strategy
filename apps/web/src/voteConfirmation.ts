import type { Connection } from "@solana/web3.js";

type StatusReader = Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;

/** HTTP-only finalized confirmation; never interprets missing history as failure. */
export async function awaitFinalizedVote(reader: StatusReader, signature: string,
  lastValidBlockHeight: number, options: { now?: () => number; delay?: () => Promise<void>; timeoutMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_500)));
  const deadline = now() + (options.timeoutMs ?? 90_000);
  while (now() < deadline) {
    const response = await reader.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = response.value[0];
    if (status?.confirmationStatus === "finalized") {
      if (status.err) throw new Error("Vote finalized with an onchain error");
      return;
    }
    // Expiry does not prove the transaction absent; keep the signature visible
    // for independent later reconciliation rather than invite a blind resend.
    if (await reader.getBlockHeight("finalized") > lastValidBlockHeight) {
      throw new Error(`Vote outcome not proven after blockhash expiry · ${signature}`);
    }
    await delay();
  }
  throw new Error(`Vote outcome not proven before confirmation timeout · ${signature}`);
}
