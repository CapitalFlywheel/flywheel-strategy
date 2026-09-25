import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  AccountLayout, AccountState, ExtensionType, getExtensionData, MintLayout,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint,
} from "@solana/spl-token";
import {
  MARKETING_SALE_POOL,
  assertMatchingMarketingSaleAccountViews,
  assertPinnedMarketingSaleAccounts,
  decodePinnedMarketingSalePool,
  inspectPinnedMarketingSalePool,
  referenceSpotLamports,
  type MarketingSalePoolAccounts,
} from "./marketingSaleRoute";

const pin = MARKETING_SALE_POOL;
const pk = (value: string) => new PublicKey(value);
const anchorDiscriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const account = (owner: string | PublicKey, data: Buffer): AccountInfo<Buffer> => ({
  data, owner: typeof owner === "string" ? pk(owner) : owner,
  executable: false, lamports: 1, rentEpoch: 0,
});

if (process.env.LIVE_MARKETING_POOL_READ_ONLY === "1") {
  it("checks the live pinned pool without preparing or sending a transaction", async () => {
    const market = await inspectPinnedMarketingSalePool([
      "https://api.mainnet-beta.solana.com", "https://solana.publicnode.com",
    ], 100_000_000n);
    console.info(JSON.stringify({
      finalizedBlockSlot: market.finalizedBlockSlot,
      accountContextSlots: market.accountContextSlots,
      rawWsol: market.wsolVaultRaw.toString(),
      rawMstrx: market.mstrxVaultRaw.toString(),
      activeLiquidity: market.liquidity.toString(),
      referenceSpotLamportsForOneMstrx: market.spotReferenceLamports?.toString(),
      quoteStatus: market.quoteStatus,
    }));
    expect(market.pool).toBe(pin.pool);
    expect(market.executionPermitted).toBe(false);
  }, 30_000);
}

// Finalized public mint bytes captured 2026-09-24. This fixture has an inert
// transfer-hook program, but retains the issuer's hook authority and delegate.
const MSTRX_MINT_FIXTURE = Buffer.from(
  "AQAAAGVqQkIv6okUBqQZ0dHeCPQqhHlBtaGulevOYZrDFyk0PU0f7DosAAAIAQEAAAD/3+wbzSzTg5PITaoIyRzA041nf/jQq3tdAz8A9zLMMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQABD+fHuLje4B+pFy3TmAJcivsAJKWAm5ORVi0NeJKXpxgfoZAOvj/uGv+NHiPXEQ9o2S0d8DCURbmW8YwwwEcgkDAAgAEP58e4uN7gH6kXLdOYAlyK+wAkpYCbk5FWLQ14kpenGBgABAAEZADgABm9ZIlHMR3R4JaWa0UIupDVz9SjaXe4q94ErMU+ZReMAAAAAAADwPwAAAAAAAAAAAAAAAAAA8D8aACEA/9/sG80s04OTyE2qCMkcwNONZ3/40Kt7XQM/APcyzDAABABBAEP58e4uN7gH6kXLdOYAlyK+wAkpYCbk5FWLQ14kpenGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgBAAEP58e4uN7gH6kXLdOYAlyK+wAkpYCbk5FWLQ14kpenGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAK0AQ/nx7i43uAfqRct05gCXIr7ACSlgJuTkVYtDXiSl6cYH6GQDr4/7hr/jR4j1xEPaNktHfAwlEW5lvGMMMBHIJBQAAABNaWNyb1N0cmF0ZWd5IHhTdG9jawUAAABNU1RSeEQAAABodHRwczovL3hzdG9ja3MtbWV0YWRhdGEuYmFja2VkLmZpL3Rva2Vucy9Tb2xhbmEvTVNUUngvbWV0YWRhdGEuanNvbgAAAAA=",
  "base64",
);

function poolData() {
  const data = Buffer.alloc(1544);
  anchorDiscriminator("PoolState").copy(data);
  const [derived, bump] = PublicKey.findProgramAddressSync([
    Buffer.from("pool"), pk(pin.config).toBuffer(), pk(pin.wsolMint).toBuffer(), pk(pin.mstrxMint).toBuffer(),
  ], pk(pin.program));
  expect(derived.toBase58()).toBe(pin.pool);
  data[8] = bump;
  for (const [offset, value] of [[9, pin.config], [73, pin.wsolMint], [105, pin.mstrxMint],
    [137, pin.wsolVault], [169, pin.mstrxVault], [201, pin.observation]] as const) {
    pk(value).toBuffer().copy(data, offset);
  }
  data[233] = 9;
  data[234] = 8;
  data.writeUInt16LE(60, 235);
  data.writeBigUInt64LE(9_305_242_878_817n, 237);
  data.writeBigUInt64LE(4_921_917_992_644_141_010n, 253);
  data.writeInt32LE(-26444, 269);
  return data;
}

function mintData() {
  const data = Buffer.alloc(82);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1n,
    decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, data);
  return data;
}

function vaultData(mint: string, amount: bigint) {
  const data = Buffer.alloc(165);
  AccountLayout.encode({
    mint: pk(mint), owner: pk(pin.pool), amount, delegateOption: 0,
    delegate: PublicKey.default, state: AccountState.Initialized,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  return data;
}

function fixture(): MarketingSalePoolAccounts {
  const config = Buffer.alloc(117);
  const observation = Buffer.alloc(4483);
  anchorDiscriminator("AmmConfig").copy(config);
  anchorDiscriminator("ObservationState").copy(observation);
  return {
    pool: account(pin.program, poolData()), config: account(pin.program, config),
    observation: account(pin.program, observation),
    wsolVault: account(TOKEN_PROGRAM_ID, vaultData(pin.wsolMint, 3_900_000_000_000n)),
    mstrxVault: account(TOKEN_2022_PROGRAM_ID, vaultData(pin.mstrxMint, 200_000_000_000n)),
    wsolMint: account(TOKEN_PROGRAM_ID, mintData()),
    mstrxMint: account(TOKEN_2022_PROGRAM_ID, Buffer.from(MSTRX_MINT_FIXTURE)),
  };
}

describe("pinned MSTRx/WSOL marketing-sale candidate", () => {
  it("checks official pool identity, Token-2022 mint and vaults but never enables execution", () => {
    const market = assertPinnedMarketingSaleAccounts(fixture(), 100_000_000n);
    expect(market.pool).toBe(pin.pool);
    expect(market.tickSpacing).toBe(60);
    expect(market.mstrxVaultRaw).toBe(200_000_000_000n);
    expect(market.spotReferenceLamports).toBeGreaterThan(0n);
    expect(market.executionPermitted).toBe(false);
    expect(market.quoteStatus).toBe("NO_TICK_ARRAY_DEPTH_OR_ONCHAIN_PRICE_GUARD");
  });

  it("rejects a substituted pool, switched mint, disabled swap or no active liquidity", () => {
    const substituted = fixture();
    substituted.pool!.data.writeUInt8(1, 8);
    expect(() => decodePinnedMarketingSalePool(substituted.pool)).toThrow("MARKETING_POOL_IDENTITY_MISMATCH");
    const switched = fixture();
    PublicKey.default.toBuffer().copy(switched.pool!.data, 105);
    expect(() => decodePinnedMarketingSalePool(switched.pool)).toThrow("MARKETING_POOL_IDENTITY_MISMATCH");
    const disabled = fixture();
    disabled.pool!.data[389] = 1 << 4;
    expect(() => decodePinnedMarketingSalePool(disabled.pool)).toThrow("MARKETING_POOL_SWAP_DISABLED");
    const dry = fixture();
    dry.pool!.data.fill(0, 237, 253);
    expect(() => decodePinnedMarketingSalePool(dry.pool)).toThrow("MARKETING_POOL_LIQUIDITY_UNAVAILABLE");
  });

  it("rejects mismatched mint and vault ownership", () => {
    const mint = fixture();
    mint.mstrxMint!.owner = TOKEN_PROGRAM_ID;
    expect(() => assertPinnedMarketingSaleAccounts(mint)).toThrow("MARKETING_MINT_PROGRAM_MISMATCH");
    const vault = fixture();
    vault.mstrxVault!.owner = TOKEN_PROGRAM_ID;
    expect(() => assertPinnedMarketingSaleAccounts(vault)).toThrow("MARKETING_POOL_VAULT_INVALID");
  });

  it("fails closed if the MSTRx issuer activates its currently inert transfer hook", () => {
    const accounts = fixture();
    const mint = unpackMint(pk(pin.mstrxMint), accounts.mstrxMint!, TOKEN_2022_PROGRAM_ID);
    const extension = getExtensionData(ExtensionType.TransferHook, mint.tlvData);
    expect(extension?.length).toBe(64);
    pk(pin.program).toBuffer().copy(extension!, 32);
    expect(() => assertPinnedMarketingSaleAccounts(accounts)).toThrow("MARKETING_MSTRX_HOOK_UNSUPPORTED");
  });

  it("requires two near-synchronous independently valid finalized views", () => {
    const a = fixture();
    const b = fixture();
    expect(() => assertMatchingMarketingSaleAccountViews([{ slot: 100, accounts: a }, { slot: 101, accounts: b }])).not.toThrow();
    expect(() => assertMatchingMarketingSaleAccountViews([{ slot: 100, accounts: a }])).toThrow("MARKETING_TWO_FINALIZED_VIEWS_REQUIRED");
    expect(() => assertMatchingMarketingSaleAccountViews([{ slot: 100, accounts: a }, { slot: 105, accounts: b }])).toThrow("MARKETING_RPC_SLOT_DRIFT");
    b.pool!.data.writeInt32LE(-26443, 269);
    b.wsolVault!.data.writeBigUInt64LE(3_800_000_000_000n, 64);
    b.observation!.data[100] = 1;
    expect(() => assertMatchingMarketingSaleAccountViews([{ slot: 100, accounts: a }, { slot: 101, accounts: b }])).not.toThrow();
    expect(() => assertPinnedMarketingSaleAccounts(b)).not.toThrow();
    PublicKey.default.toBuffer().copy(b.pool!.data, 105);
    expect(() => assertPinnedMarketingSaleAccounts(b)).toThrow("MARKETING_POOL_IDENTITY_MISMATCH");
  });

  it("keeps spot arithmetic integer-only and refuses zero or oversized input", () => {
    const spot = referenceSpotLamports(100_000_000n, 4_921_917_992_644_141_010n);
    expect(spot).toBeGreaterThan(1_000_000_000n);
    expect(() => referenceSpotLamports(0n, 1n)).toThrow("MARKETING_SPOT_INPUT_INVALID");
    expect(() => referenceSpotLamports(1n << 64n, 1n)).toThrow("MARKETING_SPOT_INPUT_INVALID");
  });
});
