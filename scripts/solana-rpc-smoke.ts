import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { readFinalizedBlockSignatures } from "../services/solana/rpcTransactionVersion";

const MAX_READ_TRANSACTION_VERSION = 1;
const RECENT_OFFSET_SLOTS = 100;
const HISTORICAL_OFFSET_SLOTS = 200_000;
const WINDOW_SLOTS = 16;

export interface BlockSummary {
  slot: number;
  hash: string;
  signatures: string[];
}

export interface RpcProbe {
  finalizedSlot(): Promise<number>;
  producedSlots(start: number, end: number): Promise<number[]>;
  fullBlock(slot: number): Promise<BlockSummary | null>;
  accountsBlock(slot: number): Promise<BlockSummary | null>;
}

function exactProducedSlots(left: number[], right: number[], start: number, end: number) {
  if (!left.length || left.length !== right.length || left.some((slot, index) =>
    !Number.isSafeInteger(slot) || slot < start || slot > end || slot !== right[index])) {
    throw new Error("RPC_PRODUCED_SLOT_DISAGREEMENT");
  }
  return left[0];
}

async function inspectWindow(probes: readonly [RpcProbe, RpcProbe], start: number) {
  if (!Number.isSafeInteger(start) || start <= 0) throw new Error("RPC_SLOT_INVALID");
  const end = start + WINDOW_SLOTS;
  const listed = await Promise.all(probes.map((probe) => probe.producedSlots(start, end)));
  const slot = exactProducedSlots(listed[0], listed[1], start, end);
  const blocks = await Promise.all(probes.map((probe) => probe.fullBlock(slot)));
  if (!blocks[0] || !blocks[1] || blocks.some((block) =>
    block?.slot !== slot || !block.hash || !Array.isArray(block.signatures)
    || block.signatures.some((signature) => typeof signature !== "string" || !signature))) {
    throw new Error("RPC_FULL_BLOCK_UNAVAILABLE");
  }
  if (blocks[0].hash !== blocks[1].hash
    || blocks[0].signatures.length !== blocks[1].signatures.length
    || blocks[0].signatures.some((signature, index) => signature !== blocks[1]?.signatures[index])) {
    throw new Error("RPC_FULL_BLOCK_DISAGREEMENT");
  }
  const accountBlocks = await Promise.all(probes.map((probe) => probe.accountsBlock(slot)));
  if (accountBlocks.some((block, index) => !block || block.slot !== slot
    || block.hash !== blocks[index]?.hash
    || block.signatures.length !== blocks[index]?.signatures.length
    || block.signatures.some((signature, position) => signature !== blocks[index]?.signatures[position]))) {
    throw new Error("RPC_ACCOUNTS_BLOCK_DISAGREEMENT");
  }
  return { slot, transactions: blocks[0].signatures.length };
}

/** Read-only probe: both providers must return the same recent and historical v1-capable full blocks. */
export async function inspectSolanaRpcSmoke(probes: readonly [RpcProbe, RpcProbe]) {
  const slots = await Promise.all(probes.map((probe) => probe.finalizedSlot()));
  if (slots.some((slot) => !Number.isSafeInteger(slot) || slot <= HISTORICAL_OFFSET_SLOTS + WINDOW_SLOTS)
    || Math.abs(slots[0] - slots[1]) > 32) throw new Error("RPC_FINALIZED_SLOT_DISAGREEMENT");
  const commonSlot = Math.min(...slots);
  const recent = await inspectWindow(probes, commonSlot - RECENT_OFFSET_SLOTS);
  const historical = await inspectWindow(probes, commonSlot - HISTORICAL_OFFSET_SLOTS);
  return { recent, historical };
}

export function rpcProbe(url: string): RpcProbe {
  const connection = new Connection(url, "finalized");
  return {
    finalizedSlot: () => connection.getSlot("finalized"),
    producedSlots: (start, end) => connection.getBlocks(start, end, "finalized"),
    fullBlock: async (slot) => {
      const block = await connection.getBlock(slot, {
        commitment: "finalized",
        transactionDetails: "full",
        rewards: false,
        maxSupportedTransactionVersion: MAX_READ_TRANSACTION_VERSION,
      });
      if (!block) return null;
      return {
        slot,
        hash: block.blockhash,
        signatures: block.transactions.map((entry) => entry.transaction.signatures[0]),
      };
    },
    accountsBlock: async (slot) => {
      const block = await readFinalizedBlockSignatures(connection, slot);
      return { slot, hash: block.blockhash, signatures: block.signatures };
    },
  };
}

async function main() {
  const primary = process.env.SOLANA_RPC_PRIMARY_URL?.trim();
  const fallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim();
  if (!primary || !fallback) throw new Error("RPC_URLS_MISSING");
  const urls = [primary, fallback].map((value) => new URL(value));
  if (urls.some((url) => url.protocol !== "https:" || url.username || url.password || url.hash)
    || urls[0].host === urls[1].host) throw new Error("RPC_PROVIDERS_NOT_INDEPENDENT");
  const result = await inspectSolanaRpcSmoke([rpcProbe(primary), rpcProbe(fallback)]);
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1]?.endsWith("solana-rpc-smoke.ts")) {
  void main().catch((error) => {
    // Provider exceptions may contain authenticated URLs. Never print them.
    console.error(error instanceof Error && error.message.startsWith("RPC_")
      ? error.message : "RPC_SMOKE_FAILED");
    process.exitCode = 1;
  });
}
