import { expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { offchainVoteMessage } from "../../../services/solana/offchainGovernance";
import { offchainVoteMessageClient } from "./offchainGovernance";

it("asks the wallet to sign exactly the message verified by the server", () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58();
  const ballot = { version: 1 as const, network: "solana-mainnet-beta" as const, advisory: true as const,
    id: "12345", capitalMint: mint, reserveWallet: wallet, reserveRawMstrx: "100000000",
    startsAt: 2_000, endsAt: 5_600, snapshotSha256: "a".repeat(64), merkleRoot: "b".repeat(64),
    totalAvailableWeight: "100", options: ["ACCUMULATE", "BUYBACK_BURN"] as ("ACCUMULATE" | "BUYBACK_BURN")[],
  };
  expect(offchainVoteMessageClient(ballot, wallet, "BUYBACK_BURN"))
    .toBe(offchainVoteMessage(ballot, wallet, "BUYBACK_BURN"));
});
