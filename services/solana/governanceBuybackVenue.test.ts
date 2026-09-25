import { afterEach, describe, expect, it, vi } from "vitest";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { AccountLayout, AccountState, MintLayout, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { BUYBACK_QUOTE_MINT, PUMP_BUYBACK_PROGRAM, PUMP_FEE_PROGRAM,
  PUMPSWAP_BUYBACK_PROGRAM } from "./pumpBuybackInstructionManifest";
import { assertMatchingGovernanceBuybackViews, governanceBuybackAddresses,
  inspectGovernanceBuybackAccounts, inspectGovernanceBuybackVenue,
  type GovernanceBuybackAccounts } from "./governanceBuybackVenue";

const capital = new PublicKey(new Uint8Array(32).fill(7));
const creator = new PublicKey(new Uint8Array(32).fill(8));
const fee = new PublicKey(new Uint8Array(32).fill(9));
const buybackFee = new PublicKey(new Uint8Array(32).fill(10));
const protocolFee = new PublicKey(new Uint8Array(32).fill(11));
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const addresses = governanceBuybackAddresses(capital, TOKEN_PROGRAM_ID);
const request = { capitalMint: capital.toBase58(), capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
  frozenRawMstrx: 1_000_000_000n };

function account(owner: PublicKey, data = Buffer.alloc(8), executable = false): AccountInfo<Buffer> {
  return { owner, data, executable, lamports: 1_000_000, rentEpoch: 0 };
}

function mint(decimals: number, token2022 = false) {
  // MSTRx's inert TransferHook and Initialized default state are represented
  // with real Token-2022 TLV bytes, not mocked extension getters.
  const data = Buffer.alloc(token2022 ? 239 : 82);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default,
    supply: 1_000_000n, decimals, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  if (token2022) {
    data[165] = 1;
    data.writeUInt16LE(14, 166); data.writeUInt16LE(64, 168);
    data.writeUInt16LE(6, 234); data.writeUInt16LE(1, 236); data[238] = 1;
  }
  return data;
}

function vault(mintKey: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: mintKey, owner, amount, delegateOption: 0,
    delegate: PublicKey.default, state: AccountState.Initialized,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return data;
}

function fixture(): GovernanceBuybackAccounts {
  return {
    curve: account(PUMP_BUYBACK_PROGRAM), global: account(PUMP_BUYBACK_PROGRAM),
    pool: account(PUMPSWAP_BUYBACK_PROGRAM), ammGlobal: account(PUMPSWAP_BUYBACK_PROGRAM),
    capitalMint: account(TOKEN_PROGRAM_ID, mint(6)),
    mstrxMint: account(TOKEN_2022_PROGRAM_ID, mint(8, true)),
    curveBaseVault: account(TOKEN_PROGRAM_ID, vault(capital, addresses.curve, 500_000_000n)),
    curveQuoteVault: account(TOKEN_2022_PROGRAM_ID, vault(BUYBACK_QUOTE_MINT, addresses.curve, 100_000n)),
    poolBaseVault: account(TOKEN_PROGRAM_ID, vault(capital, addresses.pool, 200_000_000n)),
    poolQuoteVault: account(TOKEN_2022_PROGRAM_ID, vault(BUYBACK_QUOTE_MINT, addresses.pool, 1_000_000n)),
    curveFeeConfig: account(PUMP_FEE_PROGRAM), poolFeeConfig: account(PUMP_FEE_PROGRAM),
    pumpProgram: account(loader, Buffer.alloc(0), true),
    pumpSwapProgram: account(loader, Buffer.alloc(0), true),
    feeProgram: account(loader, Buffer.alloc(0), true),
  };
}

const bn = (value: number) => ({ lten: (other: number) => value <= other,
  isNeg: () => value < 0, toString: () => value.toString() });
function mockSdk(complete: boolean) {
  vi.spyOn(PUMP_SDK, "decodeGlobal").mockReturnValue({ initialized: true,
    feeRecipient: fee, reservedFeeRecipient: fee, feeRecipients: [fee], reservedFeeRecipients: [fee],
    buybackFeeRecipients: [buybackFee] } as never);
  vi.spyOn(PUMP_SDK, "decodeBondingCurve").mockReturnValue({ complete,
    quoteMint: BUYBACK_QUOTE_MINT, creator, isMayhemMode: false,
    virtualTokenReserves: bn(900_000_000), virtualQuoteReserves: bn(10_000_000),
    realTokenReserves: bn(500_000_000), creatorFeeBps: bn(200) } as never);
  vi.spyOn(PUMP_SDK, "decodeFeeConfig").mockReturnValue({} as never);
  vi.spyOn(PUMP_AMM_SDK, "decodeGlobalConfig").mockReturnValue({
    protocolFeeRecipients: [protocolFee],
  } as never);
  vi.spyOn(PUMP_AMM_SDK, "decodePool").mockReturnValue({
    index: 0, creator: addresses.poolAuthority, baseMint: capital,
    quoteMint: BUYBACK_QUOTE_MINT, poolBaseTokenAccount: addresses.poolBaseVault,
    poolQuoteTokenAccount: addresses.poolQuoteVault, coinCreator: creator,
    virtualQuoteReserves: bn(30_000_000), creatorFeeBps: bn(200),
  } as never);
  vi.spyOn(PUMP_AMM_SDK, "decodeFeeConfig").mockReturnValue({} as never);
}

afterEach(() => vi.restoreAllMocks());

describe("finalized governance buyback venue inspection", () => {
  it("rejects duplicate RPC providers before reading accounts", async () => {
    await expect(inspectGovernanceBuybackVenue({ ...request,
      rpcUrls: ["https://api.mainnet-beta.solana.com", "https://api.mainnet-beta.solana.com"],
    })).rejects.toThrow("RPC_PROVIDERS_NOT_INDEPENDENT");
  });

  it("requires two near-synchronous byte-identical finalized views", () => {
    const first = fixture(); const second = fixture();
    expect(() => assertMatchingGovernanceBuybackViews([
      { slot: 100, accounts: first }, { slot: 101, accounts: second },
    ])).not.toThrow();
    expect(() => assertMatchingGovernanceBuybackViews([{ slot: 100, accounts: first }]))
      .toThrow("BUYBACK_TWO_FINALIZED_VIEWS_REQUIRED");
    expect(() => assertMatchingGovernanceBuybackViews([
      { slot: 100, accounts: first }, { slot: 105, accounts: second },
    ])).toThrow("BUYBACK_RPC_SLOT_DRIFT");
    second.curve!.data[0] = 1;
    expect(() => assertMatchingGovernanceBuybackViews([
      { slot: 100, accounts: first }, { slot: 101, accounts: second },
    ])).toThrow("BUYBACK_RPC_ACCOUNT_DISAGREEMENT");
  });

  it("uses the exact Pump curve and validates both canonical vault ATAs", () => {
    mockSdk(false);
    const result = inspectGovernanceBuybackAccounts(request, fixture());
    expect(result.phase).toBe("curve");
    expect(result.venueState).toMatchObject({ phase: "curve", bondingCurveAddress: addresses.curve.toBase58(),
      feeRecipient: fee.toBase58(), buybackFeeRecipient: buybackFee.toBase58() });
    expect(result.virtualQuoteReservesRaw).toBe("10000000");
    expect(result.venueBaseVaultRaw).toBe("500000000");
    expect(result.quoteUnavailable).toBe(true);
    expect(result.expectedCapitalRaw).toBeNull();
    expect(result.executionPermitted).toBe(false);
  });

  it("switches only after curve completion to the canonical index-zero PumpSwap pool", () => {
    mockSdk(true);
    const result = inspectGovernanceBuybackAccounts(request, fixture());
    expect(result.phase).toBe("pumpSwap");
    expect(result.venueState).toMatchObject({ phase: "pumpSwap", poolAddress: addresses.pool.toBase58(),
      poolCreator: addresses.poolAuthority.toBase58(), protocolFeeRecipient: protocolFee.toBase58() });
    expect(result.virtualQuoteReservesRaw).toBe("30000000");
    expect(result.venueQuoteVaultRaw).toBe("1000000");
    expect(result.quoteUnavailable).toBe(true);
  });

  it("rejects a completed curve without its canonical migration pool", () => {
    mockSdk(true);
    const accounts = fixture(); accounts.pool = null;
    expect(() => inspectGovernanceBuybackAccounts(request, accounts)).toThrow("BUYBACK_POOL_INVALID");
  });

  it("rejects substituted vault authority, inactive program and out-of-range spend", () => {
    mockSdk(false);
    const vaults = fixture();
    vaults.curveBaseVault!.data = vault(capital, creator, 500_000_000n);
    expect(() => inspectGovernanceBuybackAccounts(request, vaults)).toThrow("BUYBACK_VAULT_INVALID");
    const programs = fixture(); programs.pumpProgram!.executable = false;
    expect(() => inspectGovernanceBuybackAccounts(request, programs)).toThrow("BUYBACK_PUMPPROGRAM_INVALID");
    expect(() => inspectGovernanceBuybackAccounts({ ...request, frozenRawMstrx: 1n << 64n }, fixture()))
      .toThrow("BUYBACK_FROZEN_AMOUNT_INVALID");
  });

  it("fails closed if the MSTRx issuer activates its transfer hook", () => {
    mockSdk(false);
    const accounts = fixture();
    creator.toBuffer().copy(accounts.mstrxMint!.data, 202);
    expect(() => inspectGovernanceBuybackAccounts(request, accounts)).toThrow("BUYBACK_MSTRX_HOOK_ACTIVE");
  });

  it("rejects a post-migration pool with a changed quote mint or index", () => {
    mockSdk(true);
    vi.mocked(PUMP_AMM_SDK.decodePool).mockReturnValue({
      index: 1, creator: addresses.poolAuthority, baseMint: capital,
      quoteMint: BUYBACK_QUOTE_MINT, poolBaseTokenAccount: addresses.poolBaseVault,
      poolQuoteTokenAccount: addresses.poolQuoteVault, coinCreator: creator,
      virtualQuoteReserves: bn(30_000_000), creatorFeeBps: bn(200),
    } as never);
    expect(() => inspectGovernanceBuybackAccounts(request, fixture())).toThrow("BUYBACK_POOL_IDENTITY_INVALID");
  });
});
