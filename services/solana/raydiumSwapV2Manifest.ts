import { createHash } from "node:crypto";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import {
  MARKETING_SALE_POOL,
  assertMatchingMarketingSaleAccountViews,
  assertPinnedMarketingSaleAccounts,
  decodePinnedMarketingSalePool,
  type MarketingSalePoolAccounts,
} from "./marketingSaleRoute";
import { finalizedConsensus } from "./rpcConsensus";

// Read-only manifest for one candidate market, NOT a TransactionInstruction or
// an authorization to trade. These account positions follow Raydium swap_v2.
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const TICKS_PER_ARRAY = 60;
const TICK_ARRAY_LENGTH = 10_240;
const INITIALIZED_TICK_COUNT_OFFSET = 10_124;
const MAX_TICK_ARRAYS = 4;
const U64_MAX = (1n << 64n) - 1n;
const TICK_ARRAY_DISCRIMINATOR = createHash("sha256")
  .update("account:TickArrayState").digest().subarray(0, 8);

export interface TickArrayView {
  address: string;
  account: AccountInfo<Buffer> | null;
}

export interface MarketingSwapView {
  slot: number;
  programAccount: AccountInfo<Buffer> | null;
  marketAccounts: MarketingSalePoolAccounts;
  tickArrays: readonly TickArrayView[];
}

export interface MarketingSwapManifestRequest {
  trader: string;
  exactInputMstrxRaw: bigint;
  governanceMinWsolOutRaw: bigint;
  requestedMinWsolOutRaw: bigint;
  views: readonly [MarketingSwapView, MarketingSwapView];
}

export interface SwapAccountMeta {
  role: string;
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

function exactKeys(value: object, allowed: readonly string[], error: string) {
  if (Object.keys(value).sort().join("|") !== [...allowed].sort().join("|")) throw new Error(error);
}

function positiveU64(value: bigint, error: string) {
  if (typeof value !== "bigint" || value <= 0n || value > U64_MAX) throw new Error(error);
}

function deriveTickArray(startTickIndex: number) {
  const startBytes = Buffer.alloc(4);
  startBytes.writeInt32BE(startTickIndex);
  return PublicKey.findProgramAddressSync([
    Buffer.from("tick_array"), new PublicKey(MARKETING_SALE_POOL.pool).toBuffer(), startBytes,
  ], new PublicKey(MARKETING_SALE_POOL.program))[0].toBase58();
}

function assertTickArray(view: TickArrayView, expectedStart: number) {
  exactKeys(view, ["address", "account"], "MARKETING_TICK_ARRAY_EXTRA_FIELDS");
  const { address, account } = view;
  if (!account || account.executable || !account.owner.equals(new PublicKey(MARKETING_SALE_POOL.program))
    || account.data.length !== TICK_ARRAY_LENGTH
    || !account.data.subarray(0, 8).equals(TICK_ARRAY_DISCRIMINATOR)) {
    throw new Error("MARKETING_TICK_ARRAY_LAYOUT_INVALID");
  }
  if (account.data.subarray(8, 40).toString("hex") !== new PublicKey(MARKETING_SALE_POOL.pool).toBuffer().toString("hex")
    || account.data.readInt32LE(40) !== expectedStart || address !== deriveTickArray(expectedStart)
    || account.data[INITIALIZED_TICK_COUNT_OFFSET] > TICKS_PER_ARRAY) {
    throw new Error("MARKETING_TICK_ARRAY_IDENTITY_MISMATCH");
  }
}

function assertProgramAccount(account: AccountInfo<Buffer> | null) {
  // Solana UpgradeableLoaderState::Program serializes to 36 bytes with
  // bincode enum tag 2 and a 32-byte ProgramData address.
  if (!account || !account.owner.equals(UPGRADEABLE_LOADER) || !account.executable
    || account.data.length !== 36 || account.data.readUInt32LE(0) !== 2
    || account.data.subarray(4).equals(PublicKey.default.toBuffer())) {
    throw new Error("MARKETING_RAYDIUM_PROGRAM_ACCOUNT_INVALID");
  }
}

function meta(role: string, pubkey: string, isSigner = false, isWritable = false): SwapAccountMeta {
  return Object.freeze({ role, pubkey, isSigner, isWritable });
}

/**
 * Verifies two supplied near-synchronous finalized account snapshots and
 * constructs the exact fixed account list for a possible swap_v2 CPI.
 * Snapshot provenance, trade depth, external price, governance authorization,
 * PDA derivation and atomic SOL forwarding remain unproven here.
 */
export function buildPinnedRaydiumSwapV2Manifest(request: MarketingSwapManifestRequest) {
  exactKeys(request, ["trader", "exactInputMstrxRaw", "governanceMinWsolOutRaw", "requestedMinWsolOutRaw", "views"], "MARKETING_SWAP_EXTRA_FIELDS");
  positiveU64(request.exactInputMstrxRaw, "MARKETING_SWAP_INPUT_INVALID");
  positiveU64(request.governanceMinWsolOutRaw, "MARKETING_SWAP_MIN_OUT_INVALID");
  positiveU64(request.requestedMinWsolOutRaw, "MARKETING_SWAP_MIN_OUT_INVALID");
  if (request.requestedMinWsolOutRaw < request.governanceMinWsolOutRaw) {
    throw new Error("MARKETING_SWAP_BELOW_GOVERNANCE_FLOOR");
  }
  if (!Array.isArray(request.views) || request.views.length !== 2) throw new Error("MARKETING_SWAP_TWO_VIEWS_REQUIRED");
  for (const view of request.views) {
    exactKeys(view, ["slot", "programAccount", "marketAccounts", "tickArrays"], "MARKETING_SWAP_EXTRA_VIEW_FIELDS");
    assertProgramAccount(view.programAccount);
  }
  if (!request.views[0].programAccount!.data.equals(request.views[1].programAccount!.data)) {
    throw new Error("MARKETING_RAYDIUM_PROGRAM_RPC_DISAGREEMENT");
  }
  assertMatchingMarketingSaleAccountViews(request.views.map((view) => ({ slot: view.slot, accounts: view.marketAccounts })));
  const pool = assertPinnedMarketingSaleAccounts(request.views[0].marketAccounts, request.exactInputMstrxRaw);
  const secondPool = assertPinnedMarketingSaleAccounts(request.views[1].marketAccounts, request.exactInputMstrxRaw);
  if (pool.tickSpacing !== secondPool.tickSpacing) throw new Error("MARKETING_POOL_RPC_IDENTITY_DISAGREEMENT");
  if (pool.executionPermitted !== false) throw new Error("MARKETING_POOL_UNEXPECTED_EXECUTION_STATUS");
  const step = pool.tickSpacing * TICKS_PER_ARRAY;
  const currentStart = Math.floor(pool.tick / step) * step;
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(currentStart)
    || currentStart < -0x80000000 || currentStart + step * (MAX_TICK_ARRAYS - 1) > 0x7fffffff) {
    throw new Error("MARKETING_TICK_ARRAY_RANGE_INVALID");
  }
  const [first, second] = request.views;
  if (!Array.isArray(first.tickArrays) || first.tickArrays.length < 1 || first.tickArrays.length > MAX_TICK_ARRAYS
    || !Array.isArray(second.tickArrays) || second.tickArrays.length !== first.tickArrays.length) {
    throw new Error("MARKETING_TICK_ARRAY_COUNT_INVALID");
  }
  for (let index = 0; index < first.tickArrays.length; index += 1) {
    const expectedStart = currentStart + index * step;
    assertTickArray(first.tickArrays[index], expectedStart);
    assertTickArray(second.tickArrays[index], expectedStart);
    // Initialized ticks and liquidity can change between nearby finalized
    // reads. Their address, owner, pool and start index must agree; the onchain
    // voted output floor is the binding price protection at execution.
  }
  let trader: PublicKey;
  try { trader = new PublicKey(request.trader); }
  catch { throw new Error("MARKETING_TRADER_INVALID"); }
  if (trader.equals(PublicKey.default) || trader.equals(SystemProgram.programId)
    || trader.equals(new PublicKey(MARKETING_SALE_POOL.pool))
    || PublicKey.isOnCurve(trader.toBuffer())) throw new Error("MARKETING_TRADER_PDA_REQUIRED");
  const mstrxAta = getAssociatedTokenAddressSync(new PublicKey(MARKETING_SALE_POOL.mstrxMint), trader, true, TOKEN_2022_PROGRAM_ID);
  const wsolAta = getAssociatedTokenAddressSync(new PublicKey(MARKETING_SALE_POOL.wsolMint), trader, true, TOKEN_PROGRAM_ID);
  const accounts: readonly SwapAccountMeta[] = Object.freeze([
    meta("payer", trader.toBase58(), true),
    meta("amm_config", MARKETING_SALE_POOL.config),
    meta("pool_state", MARKETING_SALE_POOL.pool, false, true),
    meta("input_token_account", mstrxAta.toBase58(), false, true),
    meta("output_token_account", wsolAta.toBase58(), false, true),
    meta("input_vault", MARKETING_SALE_POOL.mstrxVault, false, true),
    meta("output_vault", MARKETING_SALE_POOL.wsolVault, false, true),
    meta("observation_state", MARKETING_SALE_POOL.observation, false, true),
    meta("token_program", TOKEN_PROGRAM_ID.toBase58()),
    meta("token_program_2022", TOKEN_2022_PROGRAM_ID.toBase58()),
    meta("memo_program", MEMO_PROGRAM),
    meta("input_vault_mint", MARKETING_SALE_POOL.mstrxMint),
    meta("output_vault_mint", MARKETING_SALE_POOL.wsolMint),
    ...first.tickArrays.map((array, index) => meta(`tick_array_${index}`, array.address, false, true)),
  ]);
  return Object.freeze({
    instruction: "swap_v2" as const,
    programId: MARKETING_SALE_POOL.program,
    pool: MARKETING_SALE_POOL.pool,
    exactInputMstrxRaw: request.exactInputMstrxRaw,
    minWsolOutRaw: request.requestedMinWsolOutRaw,
    isBaseInput: true as const,
    sqrtPriceLimitX64: 0n,
    accounts,
    snapshotSlots: Object.freeze([first.slot, second.slot] as const),
    executionPermitted: false as const,
    unverified: Object.freeze([
      "SNAPSHOT_RPC_PROVENANCE_NOT_ATTESTED",
      "PROGRAM_BINARY_AND_UPGRADE_AUTHORITY_NOT_PINNED",
      "TICK_DEPTH_AND_QUOTE_NOT_PROVEN",
      "BITMAP_EXTENSION_UNSUPPORTED",
      "TRADER_PDA_AND_CUSTODY_NOT_VERIFIED",
      "ONCHAIN_FAIR_PRICE_GUARD_NOT_IMPLEMENTED",
      "ATOMIC_UNWRAP_AND_FIXED_SOL_FORWARD_NOT_IMPLEMENTED",
      "VALIDATOR_CPI_NOT_TESTED",
    ] as const),
  });
}

/** Fetches all manifest accounts read-only from two finalized RPC endpoints. */
export async function inspectPinnedRaydiumSwapV2Manifest(options: {
  rpcUrls: readonly [string, string];
  trader: string;
  exactInputMstrxRaw: bigint;
  governanceMinWsolOutRaw: bigint;
  requestedMinWsolOutRaw: bigint;
  tickArrayCount: number;
}) {
  exactKeys(options, ["rpcUrls", "trader", "exactInputMstrxRaw", "governanceMinWsolOutRaw", "requestedMinWsolOutRaw", "tickArrayCount"], "MARKETING_SWAP_INSPECT_EXTRA_FIELDS");
  if (!Array.isArray(options.rpcUrls) || options.rpcUrls.length !== 2
    || !options.rpcUrls[0] || !options.rpcUrls[1] || options.rpcUrls[0] === options.rpcUrls[1]) {
    throw new Error("MARKETING_SWAP_DISTINCT_RPCS_REQUIRED");
  }
  if (!Number.isInteger(options.tickArrayCount) || options.tickArrayCount < 1 || options.tickArrayCount > MAX_TICK_ARRAYS) {
    throw new Error("MARKETING_TICK_ARRAY_COUNT_INVALID");
  }
  const consensus = await finalizedConsensus(options.rpcUrls);
  const connections = options.rpcUrls.map((url) => new Connection(url, "finalized"));
  const poolAddress = new PublicKey(MARKETING_SALE_POOL.pool);
  const firstPools = await Promise.all(connections.map((connection) => connection.getAccountInfoAndContext(poolAddress, {
    commitment: "finalized", minContextSlot: consensus.slot,
  })));
  if (firstPools.some((response) => response.context.slot < consensus.slot)
    || Math.abs(firstPools[0].context.slot - firstPools[1].context.slot) > 4) {
    throw new Error("MARKETING_SWAP_POOL_RPC_SLOT_DRIFT");
  }
  const firstPool = decodePinnedMarketingSalePool(firstPools[0].value);
  decodePinnedMarketingSalePool(firstPools[1].value);
  // An active CLMM pool changes as swaps finalize. The account identities are
  // checked independently below; equality of mutable pool bytes is not a
  // meaningful two-RPC safety condition at different finalized slots.
  const step = firstPool.tickSpacing * TICKS_PER_ARRAY;
  const start = Math.floor(firstPool.tick / step) * step;
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(start)
    || start < -0x80000000 || start + step * (options.tickArrayCount - 1) > 0x7fffffff) {
    throw new Error("MARKETING_TICK_ARRAY_RANGE_INVALID");
  }
  const tickAddresses = Array.from({ length: options.tickArrayCount }, (_, index) => deriveTickArray(start + step * index));
  const addresses = [
    MARKETING_SALE_POOL.program, MARKETING_SALE_POOL.pool, MARKETING_SALE_POOL.config,
    MARKETING_SALE_POOL.wsolVault, MARKETING_SALE_POOL.mstrxVault, MARKETING_SALE_POOL.observation,
    MARKETING_SALE_POOL.wsolMint, MARKETING_SALE_POOL.mstrxMint, ...tickAddresses,
  ].map((value) => new PublicKey(value));
  const views = await Promise.all(connections.map(async (connection) => {
    const response = await connection.getMultipleAccountsInfoAndContext(addresses, {
      commitment: "finalized", minContextSlot: consensus.slot,
    });
    if (response.context.slot < consensus.slot) throw new Error("MARKETING_SWAP_RPC_CONTEXT_STALE");
    const [programAccount, pool, config, wsolVault, mstrxVault, observation, wsolMint, mstrxMint, ...ticks] = response.value;
    return {
      slot: response.context.slot,
      programAccount,
      marketAccounts: { pool, config, wsolVault, mstrxVault, observation, wsolMint, mstrxMint },
      tickArrays: tickAddresses.map((address, index) => ({ address, account: ticks[index] })),
    };
  }));
  const manifest = buildPinnedRaydiumSwapV2Manifest({
    trader: options.trader,
    exactInputMstrxRaw: options.exactInputMstrxRaw,
    governanceMinWsolOutRaw: options.governanceMinWsolOutRaw,
    requestedMinWsolOutRaw: options.requestedMinWsolOutRaw,
    views: [views[0], views[1]],
  });
  return Object.freeze({ ...manifest, finalizedBlockSlot: consensus.slot, finalizedBlockhash: consensus.blockhash });
}
