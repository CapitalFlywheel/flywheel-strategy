import { createHash } from "node:crypto";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  AccountState,
  getDefaultAccountState,
  getPausableConfig,
  getTransferFeeConfig,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { finalizedConsensus } from "./rpcConsensus";

// A candidate market, not an executable governance adapter. Every key below
// was independently checked against the Raydium CLMM PoolState account.
export const MARKETING_SALE_POOL = Object.freeze({
  program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  pool: "2ngTuP7xA581dqX9uJkGRqxmKuehY3k4SDfPebeoRG2J",
  config: "E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp",
  wsolMint: "So11111111111111111111111111111111111111112",
  mstrxMint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  wsolVault: "8bGP3uD7vzGbdWhFxFs8ycQ5gSWUZsRCUGAHD3HxFaBT",
  mstrxVault: "6arQLB45rbMe8hHr5XaUvN9Qd38sArY4aevFohmyVeT9",
  observation: "EKZFB3t9DyayQFUpPJz8FSaxmx7dgE31Q354DMLrxCxH",
});

const POOL_LENGTH = 1544;
const CONFIG_LENGTH = 117;
const OBSERVATION_LENGTH = 4483;
const ZERO_KEY = new PublicKey(new Uint8Array(32));
const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const POOL_DISCRIMINATOR = discriminator("PoolState");
const CONFIG_DISCRIMINATOR = discriminator("AmmConfig");
const OBSERVATION_DISCRIMINATOR = discriminator("ObservationState");

export interface MarketingSalePoolAccounts {
  pool: AccountInfo<Buffer> | null;
  config: AccountInfo<Buffer> | null;
  wsolVault: AccountInfo<Buffer> | null;
  mstrxVault: AccountInfo<Buffer> | null;
  observation: AccountInfo<Buffer> | null;
  wsolMint: AccountInfo<Buffer> | null;
  mstrxMint: AccountInfo<Buffer> | null;
}

function key(data: Buffer, start: number) {
  return new PublicKey(data.subarray(start, start + 32)).toBase58();
}

function readU128(data: Buffer, offset: number) {
  return data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
}

export function decodePinnedMarketingSalePool(account: AccountInfo<Buffer> | null) {
  const pin = MARKETING_SALE_POOL;
  if (!account || !account.owner.equals(new PublicKey(pin.program))
    || account.data.length !== POOL_LENGTH
    || !account.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) {
    throw new Error("MARKETING_POOL_LAYOUT_INVALID");
  }
  const data = account.data;
  const [derived, bump] = PublicKey.findProgramAddressSync([
    Buffer.from("pool"), new PublicKey(pin.config).toBuffer(),
    new PublicKey(pin.wsolMint).toBuffer(), new PublicKey(pin.mstrxMint).toBuffer(),
  ], new PublicKey(pin.program));
  if (derived.toBase58() !== pin.pool || data[8] !== bump || data.readUInt16LE(391) !== 0
    || key(data, 9) !== pin.config || key(data, 73) !== pin.wsolMint
    || key(data, 105) !== pin.mstrxMint || key(data, 137) !== pin.wsolVault
    || key(data, 169) !== pin.mstrxVault || key(data, 201) !== pin.observation
    || data[233] !== 9 || data[234] !== 8) {
    throw new Error("MARKETING_POOL_IDENTITY_MISMATCH");
  }
  const status = data[389];
  if ((status & (1 << 4)) !== 0) throw new Error("MARKETING_POOL_SWAP_DISABLED");
  const liquidity = readU128(data, 237);
  const sqrtPriceX64 = readU128(data, 253);
  if (liquidity === 0n || sqrtPriceX64 === 0n || data.readUInt16LE(235) === 0) {
    throw new Error("MARKETING_POOL_LIQUIDITY_UNAVAILABLE");
  }
  return {
    pool: pin.pool,
    liquidity,
    sqrtPriceX64,
    tick: data.readInt32LE(269),
    tickSpacing: data.readUInt16LE(235),
    status,
    feeOn: data[390],
  };
}

function assertRaydiumAccount(account: AccountInfo<Buffer> | null, length: number, expectedDiscriminator: Buffer, error: string) {
  if (!account || !account.owner.equals(new PublicKey(MARKETING_SALE_POOL.program))
    || account.data.length !== length
    || !account.data.subarray(0, 8).equals(expectedDiscriminator)) throw new Error(error);
}

/** Returns only a reference at the current spot. It is NOT a swap quote or min-out. */
export function referenceSpotLamports(rawMstrxIn: bigint, sqrtPriceX64: bigint) {
  if (rawMstrxIn <= 0n || rawMstrxIn > (1n << 64n) - 1n || sqrtPriceX64 <= 0n) {
    throw new Error("MARKETING_SPOT_INPUT_INVALID");
  }
  // Pool price is sqrt(raw MSTRx / raw WSOL) in Q64.64. Input is token1.
  return rawMstrxIn * (1n << 128n) / (sqrtPriceX64 * sqrtPriceX64);
}

export function assertPinnedMarketingSaleAccounts(accounts: MarketingSalePoolAccounts, rawMstrxIn?: bigint) {
  const pool = decodePinnedMarketingSalePool(accounts.pool);
  assertRaydiumAccount(accounts.config, CONFIG_LENGTH, CONFIG_DISCRIMINATOR, "MARKETING_CONFIG_INVALID");
  assertRaydiumAccount(accounts.observation, OBSERVATION_LENGTH, OBSERVATION_DISCRIMINATOR, "MARKETING_OBSERVATION_INVALID");

  if (!accounts.wsolMint?.owner.equals(TOKEN_PROGRAM_ID)
    || !accounts.mstrxMint?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("MARKETING_MINT_PROGRAM_MISMATCH");
  }
  const wsolMint = unpackMint(new PublicKey(MARKETING_SALE_POOL.wsolMint), accounts.wsolMint, TOKEN_PROGRAM_ID);
  const mstrxMint = unpackMint(new PublicKey(MARKETING_SALE_POOL.mstrxMint), accounts.mstrxMint, TOKEN_2022_PROGRAM_ID);
  if (!wsolMint.isInitialized || wsolMint.decimals !== 9 || !mstrxMint.isInitialized || mstrxMint.decimals !== 8) {
    throw new Error("MARKETING_MINT_DECIMALS_MISMATCH");
  }
  const hook = getTransferHook(mstrxMint);
  if (!hook || !hook.programId.equals(ZERO_KEY)) throw new Error("MARKETING_MSTRX_HOOK_UNSUPPORTED");
  if (getTransferFeeConfig(mstrxMint)) throw new Error("MARKETING_MSTRX_TRANSFER_FEE_UNSUPPORTED");
  if (getPausableConfig(mstrxMint)?.paused) throw new Error("MARKETING_MSTRX_PAUSED");
  if (getDefaultAccountState(mstrxMint)?.state !== AccountState.Initialized) {
    throw new Error("MARKETING_MSTRX_DEFAULT_STATE_UNSUPPORTED");
  }

  const vaults = [
    { address: MARKETING_SALE_POOL.wsolVault, account: accounts.wsolVault, program: TOKEN_PROGRAM_ID, mint: MARKETING_SALE_POOL.wsolMint },
    { address: MARKETING_SALE_POOL.mstrxVault, account: accounts.mstrxVault, program: TOKEN_2022_PROGRAM_ID, mint: MARKETING_SALE_POOL.mstrxMint },
  ];
  const balances = vaults.map((vault) => {
    if (!vault.account?.owner.equals(vault.program)) throw new Error("MARKETING_POOL_VAULT_INVALID");
    let token;
    try { token = unpackAccount(new PublicKey(vault.address), vault.account, vault.program); }
    catch { throw new Error("MARKETING_POOL_VAULT_INVALID"); }
    if (token.mint.toBase58() !== vault.mint || token.owner.toBase58() !== MARKETING_SALE_POOL.pool
      || !token.isInitialized || token.isFrozen || token.delegate || token.amount === 0n) {
      throw new Error("MARKETING_POOL_VAULT_INVALID");
    }
    return token.amount;
  });
  const spotReferenceLamports = rawMstrxIn === undefined ? null : referenceSpotLamports(rawMstrxIn, pool.sqrtPriceX64);
  return {
    ...pool,
    wsolVaultRaw: balances[0], mstrxVaultRaw: balances[1],
    spotReferenceLamports,
    executionPermitted: false as const,
    quoteStatus: "NO_TICK_ARRAY_DEPTH_OR_ONCHAIN_PRICE_GUARD" as const,
  };
}

export function assertMatchingMarketingSaleAccountViews(
  views: readonly { slot: number; accounts: MarketingSalePoolAccounts }[],
) {
  if (views.length !== 2 || views.some((view) => !Number.isSafeInteger(view.slot) || view.slot <= 0)) {
    throw new Error("MARKETING_TWO_FINALIZED_VIEWS_REQUIRED");
  }
  if (Math.abs(views[0].slot - views[1].slot) > 4) throw new Error("MARKETING_RPC_SLOT_DRIFT");
  // minContextSlot is only a lower bound: two honest finalized providers can
  // return adjacent pool states after a trade. The callers validate each
  // account view independently against pinned identity and mint policy.
}

export async function inspectPinnedMarketingSalePool(rpcUrls: readonly [string, string], rawMstrxIn?: bigint) {
  const consensus = await finalizedConsensus(rpcUrls);
  const addresses = [
    MARKETING_SALE_POOL.pool, MARKETING_SALE_POOL.config, MARKETING_SALE_POOL.wsolVault,
    MARKETING_SALE_POOL.mstrxVault, MARKETING_SALE_POOL.observation,
    MARKETING_SALE_POOL.wsolMint, MARKETING_SALE_POOL.mstrxMint,
  ].map((value) => new PublicKey(value));
  const snapshots = await Promise.all(rpcUrls.map(async (url) => {
    const response = await new Connection(url, "finalized").getMultipleAccountsInfoAndContext(addresses, {
      commitment: "finalized", minContextSlot: consensus.slot,
    });
    if (response.context.slot < consensus.slot) throw new Error("MARKETING_RPC_CONTEXT_STALE");
    const [pool, config, wsolVault, mstrxVault, observation, wsolMint, mstrxMint] = response.value;
    return { slot: response.context.slot, accounts: { pool, config, wsolVault, mstrxVault, observation, wsolMint, mstrxMint } };
  }));
  assertMatchingMarketingSaleAccountViews(snapshots);
  const markets = snapshots.map((snapshot) => assertPinnedMarketingSaleAccounts(snapshot.accounts, rawMstrxIn));
  if (markets[0].tickSpacing !== markets[1].tickSpacing) {
    throw new Error("MARKETING_POOL_RPC_IDENTITY_DISAGREEMENT");
  }
  const lower = (first: bigint, second: bigint) => first < second ? first : second;
  return {
    ...markets[0],
    // Spot is only advisory; display the lower of the two observed views.
    wsolVaultRaw: lower(markets[0].wsolVaultRaw, markets[1].wsolVaultRaw),
    mstrxVaultRaw: lower(markets[0].mstrxVaultRaw, markets[1].mstrxVaultRaw),
    spotReferenceLamports: rawMstrxIn === undefined ? null : lower(
      referenceSpotLamports(rawMstrxIn, markets[0].sqrtPriceX64),
      referenceSpotLamports(rawMstrxIn, markets[1].sqrtPriceX64),
    ),
    finalizedBlockSlot: consensus.slot,
    finalizedBlockhash: consensus.blockhash,
    accountContextSlots: [snapshots[0].slot, snapshots[1].slot] as const,
  };
}
