import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { MARKETING_SALE_POOL, type MarketingSalePoolAccounts } from "./marketingSaleRoute";
import { assessPinnedMarketingSaleQuote, type MarketingSaleQuoteRequest } from "./governanceMarketingSaleQuote";

// The existing marketingSaleRoute tests exercise the full Token-2022/pool
// decoder. This fixture isolates the new fee, bitmap and output-bound checks.
vi.mock("./marketingSaleRoute", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./marketingSaleRoute")>();
  return {
    ...original,
    assertPinnedMarketingSaleAccounts: vi.fn((accounts: MarketingSalePoolAccounts) => ({
      tick: -26444, tickSpacing: 60,
      sqrtPriceX64: accounts.pool?.data[0] === 1 ? (1n << 64n) + 1n : 1n << 64n,
      wsolVaultRaw: accounts.wsolVault?.data.readBigUInt64LE(0) ?? 900n,
      feeOn: 0, executionPermitted: false,
    })),
  };
});

const pin = MARKETING_SALE_POOL;
const key = (value: string) => new PublicKey(value);
const trader = PublicKey.findProgramAddressSync([Buffer.from("marketing-trader-test")], key(pin.program))[0].toBase58();
const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const account = (data: Buffer, executable = false): AccountInfo<Buffer> => ({
  owner: key(pin.program), data, executable, lamports: 1, rentEpoch: 0,
});

function config() {
  const data = Buffer.alloc(117);
  discriminator("AmmConfig").copy(data);
  data[8] = 255; // canonical config index 1 bump for this pinned pool
  data.writeUInt16LE(1, 9);
  data.writeUInt32LE(20_000, 43);
  data.writeUInt32LE(3_000, 47);
  data.writeUInt16LE(60, 51);
  data.writeUInt32LE(10_000, 53);
  return account(data);
}

function bitmap() {
  const data = Buffer.alloc(8 + 32 + 64 * 14 * 2);
  discriminator("TickArrayBitmapExtension").copy(data);
  key(pin.pool).toBuffer().copy(data, 8);
  return account(data);
}

function tickArray(start: number) {
  const seed = Buffer.alloc(4);
  seed.writeInt32BE(start);
  const address = PublicKey.findProgramAddressSync([
    Buffer.from("tick_array"), key(pin.pool).toBuffer(), seed,
  ], key(pin.program))[0].toBase58();
  const data = Buffer.alloc(10_240);
  discriminator("TickArrayState").copy(data);
  key(pin.pool).toBuffer().copy(data, 8);
  data.writeInt32LE(start, 40);
  data[10_124] = 1;
  return { address, account: account(data) };
}

function programAccount() {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  key(pin.pool).toBuffer().copy(data, 4);
  return { ...account(data, true), owner: key("BPFLoaderUpgradeab1e11111111111111111111111") };
}

function marketAccounts(): MarketingSalePoolAccounts {
  const observation = Buffer.alloc(4483);
  discriminator("ObservationState").copy(observation);
  key(pin.pool).toBuffer().copy(observation, 19);
  return {
    pool: null, config: config(), observation: account(observation),
    wsolVault: null, mstrxVault: null, wsolMint: null, mstrxMint: null,
  };
}

function request(): MarketingSaleQuoteRequest {
  const view = (slot: number) => ({
    slot, programAccount: programAccount(), marketAccounts: marketAccounts(),
    bitmapAccount: bitmap(), tickArrays: [tickArray(-28800)],
  });
  return {
    trader, exactInputMstrxRaw: 1_000n, governanceMinSolLamports: 100n,
    requestedMinSolLamports: 500n, views: [view(100), view(101)],
  };
}

describe("read-only pinned marketing-sale quote preflight", () => {
  it("checks the fixed venue, fee config and two bitmap views without inventing an output quote", () => {
    const result = assessPinnedMarketingSaleQuote(request());
    expect(result.pool).toBe(pin.pool);
    expect(result.tradeFeeRate).toBe(3_000);
    expect(result.spotUpperBoundLamports).toBe(1_000n);
    expect(result.vaultUpperBoundLamports).toBe(900n);
    expect(result.theoreticalUpperBoundLamports).toBe(900n);
    expect(result.exactOutputQuoteLamports).toBeNull();
    expect(result.executionPermitted).toBe(false);
  });

  it("rejects an output floor beyond the maximum possible spot/vault output", () => {
    const tooHigh = request();
    tooHigh.requestedMinSolLamports = 901n;
    expect(() => assessPinnedMarketingSaleQuote(tooHigh)).toThrow("MARKETING_QUOTE_FLOOR_EXCEEDS_THEORETICAL_MAX");
  });

  it("rejects a substituted bitmap while accepting legitimate nearby bitmap changes", () => {
    const wrongPool = request();
    key(pin.config).toBuffer().copy(wrongPool.views[0].bitmapAccount!.data, 8);
    expect(() => assessPinnedMarketingSaleQuote(wrongPool)).toThrow("MARKETING_QUOTE_BITMAP_INVALID");
    const changed = request();
    changed.views[1].bitmapAccount!.data[100] = 1;
    expect(() => assessPinnedMarketingSaleQuote(changed)).not.toThrow();
  });

  it("uses the least favorable spot and vault bounds from two finalized views", () => {
    const changed = request();
    const poolState = Buffer.from([1]);
    changed.views[1].marketAccounts.pool = account(poolState);
    const vault = Buffer.alloc(8);
    vault.writeBigUInt64LE(600n);
    changed.views[1].marketAccounts.wsolVault = account(vault);
    changed.views[1].marketAccounts.observation!.data[100] = 1;
    changed.views[1].bitmapAccount!.data[100] = 1;
    changed.views[1].tickArrays[0].account!.data[100] = 1;
    const result = assessPinnedMarketingSaleQuote(changed);
    expect(result.vaultUpperBoundLamports).toBe(600n);
    expect(result.theoreticalUpperBoundLamports).toBe(600n);
    changed.requestedMinSolLamports = 601n;
    expect(() => assessPinnedMarketingSaleQuote(changed)).toThrow("MARKETING_QUOTE_FLOOR_EXCEEDS_THEORETICAL_MAX");
  });

  it("rejects a changed fee config or conflicting pool tick spacing", () => {
    const fee = request();
    fee.views[0].marketAccounts.config!.data.writeUInt32LE(1_000_000, 47);
    fee.views[1].marketAccounts.config!.data.writeUInt32LE(1_000_000, 47);
    expect(() => assessPinnedMarketingSaleQuote(fee)).toThrow("MARKETING_QUOTE_CONFIG_MISMATCH");
    const spacing = request();
    spacing.views[0].marketAccounts.config!.data.writeUInt16LE(50, 51);
    spacing.views[1].marketAccounts.config!.data.writeUInt16LE(50, 51);
    expect(() => assessPinnedMarketingSaleQuote(spacing)).toThrow("MARKETING_QUOTE_CONFIG_MISMATCH");
  });

  it("rejects an observation account for another pool or empty tick depth", () => {
    const observation = request();
    key(pin.config).toBuffer().copy(observation.views[0].marketAccounts.observation!.data, 19);
    observation.views[1].marketAccounts.observation!.data = Buffer.from(observation.views[0].marketAccounts.observation!.data);
    expect(() => assessPinnedMarketingSaleQuote(observation)).toThrow("MARKETING_QUOTE_OBSERVATION_POOL_MISMATCH");
    const empty = request();
    empty.views[0].tickArrays[0].account!.data[10_124] = 0;
    empty.views[1].tickArrays[0].account!.data[10_124] = 0;
    expect(() => assessPinnedMarketingSaleQuote(empty)).toThrow("MARKETING_QUOTE_TICK_DEPTH_EMPTY");
  });

  it("rejects unrecognized request fields before evaluating a route", () => {
    const additional = Object.assign(request(), { arbitraryRecipient: pin.pool });
    expect(() => assessPinnedMarketingSaleQuote(additional)).toThrow("MARKETING_QUOTE_EXTRA_FIELDS");
  });
});
