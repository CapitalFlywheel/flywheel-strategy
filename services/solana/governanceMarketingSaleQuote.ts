import { createHash } from "node:crypto";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  MARKETING_SALE_POOL,
  assertPinnedMarketingSaleAccounts,
  decodePinnedMarketingSalePool,
  referenceSpotLamports,
} from "./marketingSaleRoute";
import {
  buildPinnedRaydiumSwapV2Manifest,
  type MarketingSwapView,
} from "./raydiumSwapV2Manifest";
import { finalizedConsensus } from "./rpcConsensus";

// This module only examines a proposed MSTRx -> SOL sale. A spot price or
// vault balance is an upper bound, never an executable CLMM amount-out quote.
const TICKS_PER_ARRAY = 60;
const MAX_TICK_ARRAYS = 4;
const BITMAP_LENGTH = 8 + 32 + 64 * 14 * 2;
const CONFIG_LENGTH = 117;
const FEE_DENOMINATOR = 1_000_000;
const BITMAP_SEED = Buffer.from("pool_tick_array_bitmap_extension");
const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const CONFIG_DISCRIMINATOR = discriminator("AmmConfig");
const BITMAP_DISCRIMINATOR = discriminator("TickArrayBitmapExtension");
const program = new PublicKey(MARKETING_SALE_POOL.program);
const pool = new PublicKey(MARKETING_SALE_POOL.pool);

export interface MarketingSaleQuoteView extends MarketingSwapView {
  bitmapAccount: AccountInfo<Buffer> | null;
}

export interface MarketingSaleQuoteRequest {
  trader: string;
  exactInputMstrxRaw: bigint;
  governanceMinSolLamports: bigint;
  requestedMinSolLamports: bigint;
  views: readonly [MarketingSaleQuoteView, MarketingSaleQuoteView];
}

function exactKeys(value: object, names: readonly string[], code: string) {
  if (Object.keys(value).sort().join("|") !== [...names].sort().join("|")) throw new Error(code);
}

function decodePinnedConfig(account: AccountInfo<Buffer> | null, expectedSpacing: number) {
  if (!account || account.executable || !account.owner.equals(program)
    || account.data.length !== CONFIG_LENGTH
    || !account.data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) {
    throw new Error("MARKETING_QUOTE_CONFIG_INVALID");
  }
  const data = account.data;
  const index = data.readUInt16LE(9);
  const indexSeed = Buffer.alloc(2);
  indexSeed.writeUInt16BE(index);
  const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from("amm_config"), indexSeed], program);
  const tradeFeeRate = data.readUInt32LE(47);
  const protocolFeeRate = data.readUInt32LE(43);
  const tickSpacing = data.readUInt16LE(51);
  const fundFeeRate = data.readUInt32LE(53);
  if (address.toBase58() !== MARKETING_SALE_POOL.config || data[8] !== bump
    || tickSpacing !== expectedSpacing || tradeFeeRate >= FEE_DENOMINATOR
    || protocolFeeRate + fundFeeRate > FEE_DENOMINATOR) {
    throw new Error("MARKETING_QUOTE_CONFIG_MISMATCH");
  }
  return { index, tradeFeeRate, protocolFeeRate, fundFeeRate, tickSpacing };
}

function assertPinnedBitmap(account: AccountInfo<Buffer> | null) {
  const address = PublicKey.findProgramAddressSync([BITMAP_SEED, pool.toBuffer()], program)[0];
  if (!account || account.executable || !account.owner.equals(program)
    || account.data.length !== BITMAP_LENGTH
    || !account.data.subarray(0, 8).equals(BITMAP_DISCRIMINATOR)
    || !account.data.subarray(8, 40).equals(pool.toBuffer())) {
    throw new Error("MARKETING_QUOTE_BITMAP_INVALID");
  }
  return address.toBase58();
}

/**
 * Cross-checks the existing exact-account swap manifest and two finalized
 * market views. Even a valid result deliberately contains no executable
 * output quote: Raydium's tick traversal, dynamic fee and token behavior must
 * be computed against the same state before a fresh minimum can be selected.
 */
export function assessPinnedMarketingSaleQuote(request: MarketingSaleQuoteRequest) {
  exactKeys(request, ["trader", "exactInputMstrxRaw", "governanceMinSolLamports", "requestedMinSolLamports", "views"],
    "MARKETING_QUOTE_EXTRA_FIELDS");
  if (!Array.isArray(request.views) || request.views.length !== 2) {
    throw new Error("MARKETING_QUOTE_TWO_VIEWS_REQUIRED");
  }
  for (const view of request.views) {
    exactKeys(view, ["slot", "programAccount", "marketAccounts", "tickArrays", "bitmapAccount"],
      "MARKETING_QUOTE_EXTRA_VIEW_FIELDS");
  }
  const manifest = buildPinnedRaydiumSwapV2Manifest({
    trader: request.trader,
    exactInputMstrxRaw: request.exactInputMstrxRaw,
    governanceMinWsolOutRaw: request.governanceMinSolLamports,
    requestedMinWsolOutRaw: request.requestedMinSolLamports,
    views: request.views.map(({ slot, programAccount, marketAccounts, tickArrays }) => ({
      slot, programAccount, marketAccounts, tickArrays,
    })) as [MarketingSwapView, MarketingSwapView],
  });
  const bitmap = assertPinnedBitmap(request.views[0].bitmapAccount);
  assertPinnedBitmap(request.views[1].bitmapAccount);
  // A live bitmap, observation, vault balance or tick array may legitimately
  // differ at adjacent finalized slots. Validate each provider independently
  // and use the least favorable theoretical bound for an advisory floor check.
  const markets = request.views.map((view) => {
    const market = assertPinnedMarketingSaleAccounts(view.marketAccounts, request.exactInputMstrxRaw);
    if (!Number.isInteger(market.feeOn) || market.feeOn < 0 || market.feeOn > 2) {
      throw new Error("MARKETING_QUOTE_FEE_MODE_INVALID");
    }
    const config = decodePinnedConfig(view.marketAccounts.config, market.tickSpacing);
    const observation = view.marketAccounts.observation;
    if (!observation || observation.data.length !== 4483
      || !observation.data.subarray(19, 51).equals(pool.toBuffer())) {
      throw new Error("MARKETING_QUOTE_OBSERVATION_POOL_MISMATCH");
    }
    if (view.tickArrays.some(({ account }) => !account || account.data[10_124] === 0)) {
      throw new Error("MARKETING_QUOTE_TICK_DEPTH_EMPTY");
    }
    return { market, config };
  });
  const lower = (first: bigint, second: bigint) => first < second ? first : second;
  const spotUpperBoundLamports = lower(
    referenceSpotLamports(request.exactInputMstrxRaw, markets[0].market.sqrtPriceX64),
    referenceSpotLamports(request.exactInputMstrxRaw, markets[1].market.sqrtPriceX64),
  );
  const vaultUpperBoundLamports = lower(markets[0].market.wsolVaultRaw, markets[1].market.wsolVaultRaw);
  const theoreticalUpperBoundLamports = spotUpperBoundLamports < vaultUpperBoundLamports
    ? spotUpperBoundLamports : vaultUpperBoundLamports;
  if (theoreticalUpperBoundLamports === 0n
    || request.requestedMinSolLamports > theoreticalUpperBoundLamports) {
    throw new Error("MARKETING_QUOTE_FLOOR_EXCEEDS_THEORETICAL_MAX");
  }
  return Object.freeze({
    programId: manifest.programId,
    pool: manifest.pool,
    bitmap,
    exactInputMstrxRaw: request.exactInputMstrxRaw,
    votedMinSolLamports: request.governanceMinSolLamports,
    requestedMinSolLamports: request.requestedMinSolLamports,
    spotUpperBoundLamports,
    vaultUpperBoundLamports,
    theoreticalUpperBoundLamports,
    tradeFeeRate: Math.max(markets[0].config.tradeFeeRate, markets[1].config.tradeFeeRate),
    feeOn: Math.max(markets[0].market.feeOn, markets[1].market.feeOn),
    tickArrayAddresses: Object.freeze(request.views[0].tickArrays.map((item) => item.address)),
    snapshotSlots: manifest.snapshotSlots,
    exactOutputQuoteLamports: null,
    quoteStatus: "NO_VERIFIED_CLMM_TICK_AND_DYNAMIC_FEE_QUOTE" as const,
    executionPermitted: false as const,
  });
}

/** Read-only live preflight using independent, finalized RPC endpoints. */
export async function inspectPinnedMarketingSaleQuote(options: {
  rpcUrls: readonly [string, string];
  trader: string;
  exactInputMstrxRaw: bigint;
  governanceMinSolLamports: bigint;
  requestedMinSolLamports: bigint;
  tickArrayCount: number;
}) {
  exactKeys(options, ["rpcUrls", "trader", "exactInputMstrxRaw", "governanceMinSolLamports", "requestedMinSolLamports", "tickArrayCount"],
    "MARKETING_QUOTE_EXTRA_FIELDS");
  if (!Array.isArray(options.rpcUrls) || options.rpcUrls.length !== 2) {
    throw new Error("MARKETING_QUOTE_TWO_RPCS_REQUIRED");
  }
  if (!Number.isInteger(options.tickArrayCount) || options.tickArrayCount < 1
    || options.tickArrayCount > MAX_TICK_ARRAYS) throw new Error("MARKETING_QUOTE_TICK_COUNT_INVALID");
  const consensus = await finalizedConsensus(options.rpcUrls);
  const connections = options.rpcUrls.map((url) => new Connection(url, "finalized"));
  const firstPools = await Promise.all(connections.map((connection) => connection.getAccountInfoAndContext(pool, {
    commitment: "finalized", minContextSlot: consensus.slot,
  })));
  if (firstPools.some((response) => response.context.slot < consensus.slot)
    || Math.abs(firstPools[0].context.slot - firstPools[1].context.slot) > 4) {
    throw new Error("MARKETING_QUOTE_POOL_SLOT_DRIFT");
  }
  const poolState = decodePinnedMarketingSalePool(firstPools[0].value);
  decodePinnedMarketingSalePool(firstPools[1].value);
  // Different nearby finalized slots can contain different, valid CLMM state.
  const step = poolState.tickSpacing * TICKS_PER_ARRAY;
  const start = Math.floor(poolState.tick / step) * step;
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(start)
    || start < -0x80000000 || start + step * (options.tickArrayCount - 1) > 0x7fffffff) {
    throw new Error("MARKETING_QUOTE_TICK_RANGE_INVALID");
  }
  const tickAddresses = Array.from({ length: options.tickArrayCount }, (_, index) => {
    const seed = Buffer.alloc(4);
    seed.writeInt32BE(start + index * step);
    return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), seed], program)[0];
  });
  const bitmap = PublicKey.findProgramAddressSync([BITMAP_SEED, pool.toBuffer()], program)[0];
  const addresses = [
    program, pool, new PublicKey(MARKETING_SALE_POOL.config),
    new PublicKey(MARKETING_SALE_POOL.wsolVault), new PublicKey(MARKETING_SALE_POOL.mstrxVault),
    new PublicKey(MARKETING_SALE_POOL.observation), new PublicKey(MARKETING_SALE_POOL.wsolMint),
    new PublicKey(MARKETING_SALE_POOL.mstrxMint), bitmap, ...tickAddresses,
  ];
  const views = await Promise.all(connections.map(async (connection) => {
    const response = await connection.getMultipleAccountsInfoAndContext(addresses, {
      commitment: "finalized", minContextSlot: consensus.slot,
    });
    if (response.context.slot < consensus.slot) throw new Error("MARKETING_QUOTE_RPC_CONTEXT_STALE");
    const [programAccount, poolAccount, config, wsolVault, mstrxVault, observation,
      wsolMint, mstrxMint, bitmapAccount, ...ticks] = response.value;
    return {
      slot: response.context.slot,
      programAccount,
      marketAccounts: {
        pool: poolAccount, config, wsolVault, mstrxVault, observation, wsolMint, mstrxMint,
      },
      bitmapAccount,
      tickArrays: tickAddresses.map((address, index) => ({ address: address.toBase58(), account: ticks[index] })),
    };
  }));
  const preflight = assessPinnedMarketingSaleQuote({
    trader: options.trader,
    exactInputMstrxRaw: options.exactInputMstrxRaw,
    governanceMinSolLamports: options.governanceMinSolLamports,
    requestedMinSolLamports: options.requestedMinSolLamports,
    views: [views[0], views[1]],
  });
  return Object.freeze({ ...preflight, marketViews: [views[0], views[1]] as const,
    finalizedBlockSlot: consensus.slot,
    finalizedBlockhash: consensus.blockhash });
}
