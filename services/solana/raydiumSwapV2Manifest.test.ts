import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { MARKETING_SALE_POOL, type MarketingSalePoolAccounts } from "./marketingSaleRoute";
import { buildPinnedRaydiumSwapV2Manifest, type MarketingSwapManifestRequest, type TickArrayView } from "./raydiumSwapV2Manifest";

// Adjacent marketingSaleRoute.test.ts exercises the full pinned pool decoder.
// Here that decoder is stubbed so these tests isolate swap_v2 manifest rules.
vi.mock("./marketingSaleRoute", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./marketingSaleRoute")>();
  return {
    ...original,
    assertPinnedMarketingSaleAccounts: vi.fn(() => ({
      tick: -26444, tickSpacing: 60, executionPermitted: false,
    })),
  };
});

const pin = MARKETING_SALE_POOL;
const pk = (value: string) => new PublicKey(value);
const trader = PublicKey.findProgramAddressSync([Buffer.from("test-trader")], pk(pin.program))[0].toBase58();
const blankAccounts = (): MarketingSalePoolAccounts => ({
  pool: null, config: null, wsolVault: null, mstrxVault: null,
  observation: null, wsolMint: null, mstrxMint: null,
});

function tickArray(start: number): TickArrayView {
  const seed = Buffer.alloc(4);
  seed.writeInt32BE(start);
  const address = PublicKey.findProgramAddressSync([
    Buffer.from("tick_array"), pk(pin.pool).toBuffer(), seed,
  ], pk(pin.program))[0].toBase58();
  const data = Buffer.alloc(10_240);
  createHash("sha256").update("account:TickArrayState").digest().subarray(0, 8).copy(data);
  pk(pin.pool).toBuffer().copy(data, 8);
  data.writeInt32LE(start, 40);
  data[10_124] = 1;
  const account: AccountInfo<Buffer> = {
    owner: pk(pin.program), data, executable: false, lamports: 1, rentEpoch: 0,
  };
  return { address, account };
}

function programAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  pk(pin.pool).toBuffer().copy(data, 4);
  return { owner: pk("BPFLoaderUpgradeab1e11111111111111111111111"), data, executable: true, lamports: 1, rentEpoch: 0 };
}

function request(): MarketingSwapManifestRequest {
  return {
    trader,
    exactInputMstrxRaw: 100_000_000n,
    governanceMinWsolOutRaw: 1_000n,
    requestedMinWsolOutRaw: 1_200n,
    views: [
      { slot: 100, programAccount: programAccount(), marketAccounts: blankAccounts(), tickArrays: [tickArray(-28800), tickArray(-25200)] },
      { slot: 101, programAccount: programAccount(), marketAccounts: blankAccounts(), tickArrays: [tickArray(-28800), tickArray(-25200)] },
    ],
  };
}

describe("fixed Raydium swap_v2 offchain manifest", () => {
  it("pins ordered MSTRx -> WSOL accounts, exact input, positive min-out and never enables execution", () => {
    const result = buildPinnedRaydiumSwapV2Manifest(request());
    expect(result.programId).toBe(pin.program);
    expect(result.pool).toBe(pin.pool);
    expect(result.exactInputMstrxRaw).toBe(100_000_000n);
    expect(result.minWsolOutRaw).toBe(1_200n);
    expect(result.isBaseInput).toBe(true);
    expect(result.accounts.map((account) => account.role)).toEqual([
      "payer", "amm_config", "pool_state", "input_token_account", "output_token_account",
      "input_vault", "output_vault", "observation_state", "token_program",
      "token_program_2022", "memo_program", "input_vault_mint", "output_vault_mint",
      "tick_array_0", "tick_array_1",
    ]);
    expect(result.accounts[5].pubkey).toBe(pin.mstrxVault);
    expect(result.accounts[6].pubkey).toBe(pin.wsolVault);
    expect(result.accounts[13].pubkey).toBe(request().views[0].tickArrays[0].address);
    expect(result.executionPermitted).toBe(false);
    expect(result.unverified).toContain("ONCHAIN_FAIR_PRICE_GUARD_NOT_IMPLEMENTED");
  });

  it("rejects zero, oversized or governance-violating amounts", () => {
    const zeroInput = request(); zeroInput.exactInputMstrxRaw = 0n;
    expect(() => buildPinnedRaydiumSwapV2Manifest(zeroInput)).toThrow("MARKETING_SWAP_INPUT_INVALID");
    const oversized = request(); oversized.exactInputMstrxRaw = 1n << 64n;
    expect(() => buildPinnedRaydiumSwapV2Manifest(oversized)).toThrow("MARKETING_SWAP_INPUT_INVALID");
    const zeroOut = request(); zeroOut.requestedMinWsolOutRaw = 0n;
    expect(() => buildPinnedRaydiumSwapV2Manifest(zeroOut)).toThrow("MARKETING_SWAP_MIN_OUT_INVALID");
    const belowFloor = request(); belowFloor.requestedMinWsolOutRaw = 999n;
    expect(() => buildPinnedRaydiumSwapV2Manifest(belowFloor)).toThrow("MARKETING_SWAP_BELOW_GOVERNANCE_FLOOR");
  });

  it("rejects an ordinary wallet as governance swap trader", () => {
    const ordinary = request(); ordinary.trader = "9tiKUSwJrdJQzySro2pWJmWLw83NpdGwrvTCUesSP9NQ";
    expect(() => buildPinnedRaydiumSwapV2Manifest(ordinary)).toThrow("MARKETING_TRADER_PDA_REQUIRED");
  });

  it("rejects substituted, unowned, wrong-sized or out-of-order tick arrays", () => {
    const wrongPool = request();
    pk(pin.config).toBuffer().copy(wrongPool.views[0].tickArrays[0].account!.data, 8);
    expect(() => buildPinnedRaydiumSwapV2Manifest(wrongPool)).toThrow("MARKETING_TICK_ARRAY_IDENTITY_MISMATCH");
    const wrongOwner = request(); wrongOwner.views[0].tickArrays[0].account!.owner = pk(pin.config);
    expect(() => buildPinnedRaydiumSwapV2Manifest(wrongOwner)).toThrow("MARKETING_TICK_ARRAY_LAYOUT_INVALID");
    const wrongLength = request(); wrongLength.views[0].tickArrays[0].account!.data = Buffer.alloc(10_239);
    expect(() => buildPinnedRaydiumSwapV2Manifest(wrongLength)).toThrow("MARKETING_TICK_ARRAY_LAYOUT_INVALID");
    const reversed = request(); (reversed.views[0].tickArrays as TickArrayView[]).reverse();
    expect(() => buildPinnedRaydiumSwapV2Manifest(reversed)).toThrow("MARKETING_TICK_ARRAY_IDENTITY_MISMATCH");
  });

  it("rejects non-executable or inconsistent Raydium program accounts", () => {
    const nonExecutable = request(); nonExecutable.views[0].programAccount!.executable = false;
    expect(() => buildPinnedRaydiumSwapV2Manifest(nonExecutable)).toThrow("MARKETING_RAYDIUM_PROGRAM_ACCOUNT_INVALID");
    const disagree = request(); disagree.views[1].programAccount!.data[10] = 9;
    expect(() => buildPinnedRaydiumSwapV2Manifest(disagree)).toThrow("MARKETING_RAYDIUM_PROGRAM_RPC_DISAGREEMENT");
  });

  it("accepts nearby dynamic tick changes but rejects wrong identities and extra accounts", () => {
    const changed = request(); changed.views[1].tickArrays[1].account!.data[100] = 1;
    expect(() => buildPinnedRaydiumSwapV2Manifest(changed)).not.toThrow();
    const wrongIdentity = request(); wrongIdentity.views[1].tickArrays[1].account!.data.writeInt32LE(-21600, 40);
    expect(() => buildPinnedRaydiumSwapV2Manifest(wrongIdentity)).toThrow("MARKETING_TICK_ARRAY_IDENTITY_MISMATCH");
    const extra = Object.assign(request(), { remainingAccounts: [pk(pin.config).toBase58()] });
    expect(() => buildPinnedRaydiumSwapV2Manifest(extra)).toThrow("MARKETING_SWAP_EXTRA_FIELDS");
    const extraTick = request(); Object.assign(extraTick.views[0].tickArrays[0], { remainingAccount: pin.config });
    expect(() => buildPinnedRaydiumSwapV2Manifest(extraTick)).toThrow("MARKETING_TICK_ARRAY_EXTRA_FIELDS");
  });

  it("refuses missing, sparse, more than four or mismatched-view arrays", () => {
    const none = request(); (none.views[0].tickArrays as TickArrayView[]).splice(0);
    expect(() => buildPinnedRaydiumSwapV2Manifest(none)).toThrow("MARKETING_TICK_ARRAY_COUNT_INVALID");
    const sparse = request(); (sparse.views[0].tickArrays as TickArrayView[])[1] = tickArray(-21600);
    expect(() => buildPinnedRaydiumSwapV2Manifest(sparse)).toThrow("MARKETING_TICK_ARRAY_IDENTITY_MISMATCH");
    const mismatch = request(); (mismatch.views[1].tickArrays as TickArrayView[]).pop();
    expect(() => buildPinnedRaydiumSwapV2Manifest(mismatch)).toThrow("MARKETING_TICK_ARRAY_COUNT_INVALID");
    const tooMany = request();
    for (let i = 2; i < 5; i += 1) {
      (tooMany.views[0].tickArrays as TickArrayView[]).push(tickArray(-28800 + i * 3600));
      (tooMany.views[1].tickArrays as TickArrayView[]).push(tickArray(-28800 + i * 3600));
    }
    expect(() => buildPinnedRaydiumSwapV2Manifest(tooMany)).toThrow("MARKETING_TICK_ARRAY_COUNT_INVALID");
  });
});
