import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import { bitqueryAuthFromEnv } from "./bitqueryAuth";
import { BitqueryTransferSource } from "./bitqueryTransferSource";
import { refreshHolderJournal } from "./holderJournal";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";

let transferSource: BitqueryTransferSource | undefined;

function mintTransferSource() {
  return transferSource ??= new BitqueryTransferSource(bitqueryAuthFromEnv());
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function agreedBlock(rpcUrls: readonly [string, string], proposedSlot: number) {
  for (let slot = proposedSlot; slot > proposedSlot - 64; slot -= 1) {
    const blocks = await Promise.all(rpcUrls.map(async (url) => new Connection(url, "finalized").getBlock(slot, {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
    })));
    if (blocks.every((block) => block === null)) continue;
    if (blocks.some((block) => !block || block.blockTime === null)) throw new Error("HOLDER_FINALIZED_BLOCK_RPC_DISAGREEMENT");
    const agreed = requireMatchingValues(blocks.map((block) => ({ slot, blockhash: block!.blockhash, blockTime: block!.blockTime! })), "HOLDER_FINALIZED_BLOCK_RPC_DISAGREEMENT");
    return agreed;
  }
  throw new Error("HOLDER_FINALIZED_BLOCK_UNAVAILABLE");
}

async function heartbeat(ok: boolean, detail: string) {
  const root = resolve(process.env.PUBLIC_DATA_ROOT || "data/public", "status");
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "solana-holder-indexer.json"), JSON.stringify({ service: "solana-holder-indexer", ok, updatedAt: Date.now(), detail }, null, 2), { encoding: "utf8", mode: 0o644, flush: true });
}

export async function indexHoldersOnce() {
  const publicRoot = resolve(process.env.PUBLIC_DATA_ROOT || "data/public");
  let config: { network?: string; projectMint?: string; launchedAtSlot?: number; launchedAtSignature?: string };
  try {
    config = JSON.parse(await readFile(resolve(publicRoot, "config.json"), "utf8")) as typeof config;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (config.network !== "solana-mainnet-beta" || !config.projectMint || !Number.isSafeInteger(config.launchedAtSlot) || !config.launchedAtSignature) throw new Error("HOLDER_INDEX_LAUNCH_CONFIG_INVALID");
  const rpcUrls = [required("SOLANA_RPC_PRIMARY_URL"), required("SOLANA_RPC_FALLBACK_URL")] as const;
  const consensus = await finalizedConsensus(rpcUrls);
  const lagSlots = Number(process.env.SOLANA_HOLDER_INDEX_LAG_SLOTS || "1500");
  if (!Number.isInteger(lagSlots) || lagSlots < 64 || lagSlots > 20_000) throw new Error("HOLDER_INDEX_LAG_INVALID");
  const target = await agreedBlock(rpcUrls, consensus.slot - lagSlots);
  if (target.slot < config.launchedAtSlot!) {
    await heartbeat(true, `waiting-for-finalized-index-lag:${target.slot}/${config.launchedAtSlot}`);
    return false;
  }
  const launch = await agreedBlock(rpcUrls, config.launchedAtSlot!);
  if (launch.slot !== config.launchedAtSlot) throw new Error("HOLDER_LAUNCH_SLOT_MISSING");
  const epochSeconds = Number(process.env.SOLANA_REWARD_EPOCH_SECONDS || "3600");
  if (!Number.isInteger(epochSeconds) || epochSeconds < 300) throw new Error("HOLDER_EPOCH_CADENCE_INVALID");
  const result = await refreshHolderJournal({
    environment: {
      rpcUrls,
      stateRoot: resolve(process.env.SOLANA_STATE_ROOT || "data/solana"),
      journalPath: resolve(required("SOLANA_HOLDER_JOURNAL_PATH")),
      mint: config.projectMint,
      launchSlot: config.launchedAtSlot!,
      launchSignature: config.launchedAtSignature,
      launchTime: launch.blockTime,
      epochSeconds,
    },
    source: mintTransferSource(),
    finalizedThroughSlot: target.slot,
    finalizedThroughTime: target.blockTime,
    finalizedBlockhash: target.blockhash,
  });
  await heartbeat(true, `finalized-slot=${target.slot}:transactions=${result.indexed}:journal=${result.published ? result.epochId : "waiting"}`);
  return true;
}

async function main() {
  while (true) {
    try {
      await indexHoldersOnce();
    } catch {
      // Public heartbeat files must not include RPC/client exception text,
      // which can contain authenticated endpoint URLs or API tokens.
      await heartbeat(false, "HOLDER_INDEXER_FAILED");
    }
    await new Promise((delay) => setTimeout(delay, Number(process.env.SOLANA_HOLDER_INDEX_INTERVAL_MS || "300000")));
  }
}

if (process.argv[1]?.endsWith("holderIndexerRunner.ts")) void main();
