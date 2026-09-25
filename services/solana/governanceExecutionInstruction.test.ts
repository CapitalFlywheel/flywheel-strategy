import { createHash } from "node:crypto";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { BUYBACK_QUOTE_MINT, PUMP_BUYBACK_PROGRAM, PUMPSWAP_BUYBACK_PROGRAM,
  type BuybackVenueState } from "./pumpBuybackInstructionManifest";
import { deriveGovernanceReserveRoute, type GovernanceReserveRoute } from "./governanceVaultRoute";
import type { GovernanceProposalStatus } from "./governanceProposalStatus";
import { MARKETING_SALE_POOL, type MarketingSalePoolAccounts } from "./marketingSaleRoute";
import type { MarketingSwapView, TickArrayView } from "./raydiumSwapV2Manifest";
import { buildExecuteBuybackDraft, buildExecuteLockMstrxDraft, buildExecuteMarketingSaleDraft,
  buildRefundTraderDraft, buildReleaseCapitalLockDraft, type BuybackExecutionInput,
  type MarketingSaleExecutionInput, type ReleaseCapitalLockInput } from "./governanceExecutionInstruction";

// The separate marketingSaleRoute tests validate live PoolState bytes. These
// tests isolate the outer governance ABI while retaining the pinned Raydium
// manifest's two-view, program and ordered tick-array checks.
vi.mock("./marketingSaleRoute", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./marketingSaleRoute")>();
  return { ...original, assertPinnedMarketingSaleAccounts: vi.fn(() => ({
    tick: -26444, tickSpacing: 60, executionPermitted: false,
  })) };
});

const address = (byte: number) => new PublicKey(Buffer.alloc(32, byte)).toBase58();
const capitalMint = address(7);
const owner = address(8);
const program = address(9);
const marketingWallet = address(10);
const route = (): GovernanceReserveRoute => ({
  governanceProgram: program,
  reserveAuthority: deriveGovernanceReserveRoute(program, BUYBACK_QUOTE_MINT.toBase58()).authority.toBase58(),
  capitalMint, reserveMint: BUYBACK_QUOTE_MINT.toBase58(), admin: owner,
  expectedProgramCodeSha256: "a".repeat(64),
});
const status = (action: string, recipient = SystemProgram.programId.toBase58()): GovernanceProposalStatus => ({
  id: "9", status: 1, proposalStateSha256: "b".repeat(64), frozenRaw: "500", fixedMarketingWallet: marketingWallet,
  options: [{ action, reserveRaw: "500", minOutputRaw: "10", recipient,
    lockDurationSeconds: action === "BUYBACK_LOCK" ? 30 * 86_400 : 0 }],
  startsAt: 100, endsAt: 900, executableAt: 1_000, winningAction: action, updatedAt: 1_000,
});
const curve = PublicKey.findProgramAddressSync([
  Buffer.from("bonding-curve"), new PublicKey(capitalMint).toBuffer(),
], PUMP_BUYBACK_PROGRAM)[0];
const poolAuthority = PublicKey.findProgramAddressSync([
  Buffer.from("pool-authority"), new PublicKey(capitalMint).toBuffer(),
], PUMP_BUYBACK_PROGRAM)[0];
const pool = PublicKey.findProgramAddressSync([
  Buffer.from("pool"), Buffer.from([0, 0]), poolAuthority.toBuffer(),
  new PublicKey(capitalMint).toBuffer(), BUYBACK_QUOTE_MINT.toBuffer(),
], PUMPSWAP_BUYBACK_PROGRAM)[0];
const curveVenue = (): Extract<BuybackVenueState, { phase: "curve" }> => ({
  phase: "curve", bondingCurveAddress: curve.toBase58(), bondingCurveOwner: PUMP_BUYBACK_PROGRAM.toBase58(),
  complete: false, curveBaseMint: capitalMint, curveQuoteMint: BUYBACK_QUOTE_MINT.toBase58(),
  creator: address(11), feeRecipient: address(12), buybackFeeRecipient: address(13),
});
const swapVenue = (): Extract<BuybackVenueState, { phase: "pumpSwap" }> => ({
  phase: "pumpSwap", bondingCurveComplete: true, poolAddress: pool.toBase58(),
  poolOwner: PUMPSWAP_BUYBACK_PROGRAM.toBase58(), poolIndex: 0,
  poolCreator: poolAuthority.toBase58(), poolBaseMint: capitalMint,
  poolQuoteMint: BUYBACK_QUOTE_MINT.toBase58(), coinCreator: address(14),
  protocolFeeRecipient: address(15),
});
const buyback = (venueState: BuybackVenueState = curveVenue()): BuybackExecutionInput => ({
  route: route(), payer: owner, capitalTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
  proposalStatus: status("BUYBACK_HOLD"), observedClockUnix: 1_001, venueState,
});

function programAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2);
  new PublicKey(MARKETING_SALE_POOL.pool).toBuffer().copy(data, 4);
  return { owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    data, executable: true, lamports: 1, rentEpoch: 0 };
}
const blankMarket = (): MarketingSalePoolAccounts => ({
  pool: null, config: null, wsolVault: null, mstrxVault: null,
  observation: null, wsolMint: null, mstrxMint: null,
});
function tickArray(start: number): TickArrayView {
  const seed = Buffer.alloc(4);
  seed.writeInt32BE(start);
  const address = PublicKey.findProgramAddressSync([
    Buffer.from("tick_array"), new PublicKey(MARKETING_SALE_POOL.pool).toBuffer(), seed,
  ], new PublicKey(MARKETING_SALE_POOL.program))[0].toBase58();
  const data = Buffer.alloc(10_240);
  createHash("sha256").update("account:TickArrayState").digest().subarray(0, 8).copy(data);
  new PublicKey(MARKETING_SALE_POOL.pool).toBuffer().copy(data, 8);
  data.writeInt32LE(start, 40);
  data[10_124] = 1;
  return { address, account: { owner: new PublicKey(MARKETING_SALE_POOL.program), data,
    executable: false, lamports: 1, rentEpoch: 0 } };
}
const view = (slot: number): MarketingSwapView => ({
  slot, programAccount: programAccount(), marketAccounts: blankMarket(),
  tickArrays: [tickArray(-28800), tickArray(-25200)],
});
const marketing = (): MarketingSaleExecutionInput => ({
  route: route(), payer: owner, capitalTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
  proposalStatus: status("MARKETING_SALE", marketingWallet), observedClockUnix: 1_001,
  executionMinSolLamports: 12n, marketViews: [view(100), view(101)],
});

describe("gated governance execution outer instruction drafts", () => {
  it("builds exact proposal-specific MSTRx lock accounts and no external signer", () => {
    const proposalStatus = status("LOCK_MSTRX");
    proposalStatus.options[0].minOutputRaw = "0";
    proposalStatus.options[0].lockDurationSeconds = 30 * 86_400;
    const input = { route: route(), payer: owner, capitalTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      proposalStatus, observedClockUnix: 1_001 };
    const result = buildExecuteLockMstrxDraft(input);
    const proposal = result.proposal;
    const record = PublicKey.findProgramAddressSync([
      Buffer.from("reserve-lock"), proposal.toBuffer(),
    ], new PublicKey(program))[0];
    expect(result.data).toEqual(createHash("sha256").update("global:execute_lock_mstrx").digest().subarray(0, 8));
    expect(result.keys).toHaveLength(10);
    expect(result.keys[4].pubkey).toEqual(record);
    expect(result.receipt).toEqual(record);
    expect(result.keys[6]).toMatchObject({ pubkey: new PublicKey(owner), isSigner: true, isWritable: true });
    expect(result.keys.filter((account) => account.isSigner)).toHaveLength(1);
    expect(result.executionPermitted).toBe(false);
    expect(() => buildExecuteLockMstrxDraft({ ...input, observedClockUnix: 999 }))
      .toThrow("GOVERNANCE_LOCK_DECISION_NOT_READY");
    expect(() => buildExecuteLockMstrxDraft({ ...input, proposalStatus: {
      ...proposalStatus, options: [{ ...proposalStatus.options[0], minOutputRaw: "1" }],
    } })).toThrow("GOVERNANCE_LOCK_DECISION_INVALID");
    expect(() => buildExecuteLockMstrxDraft({ ...input, proposalStatus: {
      ...proposalStatus, options: [{ ...proposalStatus.options[0], recipient: marketingWallet }],
    } })).toThrow("GOVERNANCE_LOCK_DECISION_INVALID");
    expect(() => buildExecuteLockMstrxDraft(Object.assign({ ...input }, { remainingAccounts: [marketingWallet] })))
      .toThrow("GOVERNANCE_EXECUTION_EXTRA_FIELDS");
  });
  it("pins both Pump phases, exact account order and only payer as outer signer", () => {
    for (const [venueState, length] of [[curveVenue(), 27], [swapVenue(), 23]] as const) {
      const result = buildExecuteBuybackDraft(buyback(venueState));
      const config = deriveGovernanceReserveRoute(program, BUYBACK_QUOTE_MINT.toBase58());
      expect(result.data.toString("hex")).toBe("2f201364b8609031");
      expect(result.executionPermitted).toBe(false);
      expect(result.keys).toHaveLength(18 + length);
      expect(result.keys[0]).toMatchObject({ pubkey: config.authority, isWritable: true, isSigner: false });
      expect(result.keys[3].pubkey).toEqual(config.ata);
      expect(result.keys[12]).toMatchObject({ pubkey: curve, isWritable: false, isSigner: false });
      expect(result.keys[13]).toMatchObject({ pubkey: new PublicKey(owner), isWritable: true, isSigner: true });
      expect(result.keys.filter((account) => account.isSigner)).toHaveLength(1);
      expect(result.keys[18 + (venueState.phase === "curve" ? 13 : 1)]).toMatchObject({
        pubkey: result.keys[5].pubkey, isWritable: true, isSigner: false,
      });
      if (venueState.phase === "curve") {
        expect(result.keys[18 + 10]).toMatchObject({ pubkey: curve, isWritable: true, isSigner: false });
      } else {
        expect(result.keys[18].pubkey).toEqual(pool);
      }
    }
  });

  it("binds the exact voted buyback terms and rejects altered identities or arbitrary remaining accounts", () => {
    const input = buyback();
    expect(() => buildExecuteBuybackDraft({ ...input, proposalStatus: { ...input.proposalStatus,
      status: 0 } })).toThrow("GOVERNANCE_EXECUTION_DECISION_NOT_READY");
    expect(() => buildExecuteBuybackDraft({ ...input, proposalStatus: { ...input.proposalStatus,
      frozenRaw: "499" } })).toThrow("GOVERNANCE_EXECUTION_DECISION_INVALID");
    expect(() => buildExecuteBuybackDraft({ ...input, route: { ...input.route,
      reserveAuthority: address(22) } })).toThrow("GOVERNANCE_EXECUTION_ROUTE_INVALID");
    expect(() => buildExecuteBuybackDraft({ ...input, payer: address(22) })).toThrow("GOVERNANCE_EXECUTION_ROUTE_INVALID");
    expect(() => buildExecuteBuybackDraft({ ...input, venueState: { ...curveVenue(),
      bondingCurveAddress: address(22) } })).toThrow("BUYBACK_CURVE_IDENTITY_INVALID");
    expect(() => buildExecuteBuybackDraft(Object.assign(buyback(), {
      remainingAccounts: [address(22)],
    }))).toThrow("GOVERNANCE_EXECUTION_EXTRA_FIELDS");
    expect(() => buildExecuteBuybackDraft({ ...input,
      venueState: Object.assign(curveVenue(), { arbitraryAccount: address(22) }),
    })).toThrow("GOVERNANCE_EXECUTION_EXTRA_FIELDS");
  });

  it("serializes lock release for an older executed proposal without additional accounts", () => {
    const input: ReleaseCapitalLockInput = { route: route(), payer: owner,
      capitalTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), proposalId: 3n };
    const result = buildReleaseCapitalLockDraft(input);
    expect(result.data.toString("hex")).toBe("6f1e687569cefa24");
    expect(result.keys).toHaveLength(11);
    expect(result.keys.filter((account) => account.isSigner)).toHaveLength(1);
    expect(result.keys[2].pubkey).toEqual(result.receipt);
    expect(result.keys[7].pubkey.toBase58()).toBe(owner);
    expect(() => buildReleaseCapitalLockDraft({ ...input, proposalId: 0n }))
      .toThrow("GOVERNANCE_EXECUTION_U64_INVALID");
    expect(() => buildReleaseCapitalLockDraft(Object.assign({ ...input }, {
      remainingAccounts: [address(22)],
    }))).toThrow("GOVERNANCE_EXECUTION_EXTRA_FIELDS");
  });

  it("serializes the voted marketing floor and fixed recipient with ordered checked Raydium ticks", () => {
    const result = buildExecuteMarketingSaleDraft(marketing());
    expect(result.data.toString("hex")).toBe("5bba14b53b133ede0c00000000000000");
    expect(result.keys).toHaveLength(23 + 2);
    expect(result.keys[8].pubkey.toBase58()).toBe(marketingWallet);
    expect(result.keys[9].pubkey.toBase58()).toBe(MARKETING_SALE_POOL.program);
    expect(result.keys[10].pubkey.toBase58()).toBe(MARKETING_SALE_POOL.pool);
    expect(result.keys[16].pubkey).toEqual(PublicKey.findProgramAddressSync([
      Buffer.from("pool_tick_array_bitmap_extension"), new PublicKey(MARKETING_SALE_POOL.pool).toBuffer(),
    ], new PublicKey(MARKETING_SALE_POOL.program))[0]);
    expect(result.keys[23].pubkey.toBase58()).toBe(marketing().marketViews[0].tickArrays[0].address);
    expect(result.keys.filter((account) => account.isSigner)).toHaveLength(1);
    expect(result.executionPermitted).toBe(false);
  });

  it("rejects marketing recipient swaps, lowered floors and unreviewed extra tick routes", () => {
    const input = marketing();
    expect(() => buildExecuteMarketingSaleDraft({ ...input, proposalStatus: {
      ...input.proposalStatus, fixedMarketingWallet: address(22),
    } })).toThrow("GOVERNANCE_EXECUTION_MARKETING_RECIPIENT_INVALID");
    expect(() => buildExecuteMarketingSaleDraft({ ...input, executionMinSolLamports: 9n }))
      .toThrow("GOVERNANCE_EXECUTION_MARKETING_FLOOR_INVALID");
    const five = marketing();
    for (let i = 2; i < 5; i += 1) {
      (five.marketViews[0].tickArrays as TickArrayView[]).push(tickArray(-28800 + i * 3600));
      (five.marketViews[1].tickArrays as TickArrayView[]).push(tickArray(-28800 + i * 3600));
    }
    expect(() => buildExecuteMarketingSaleDraft(five)).toThrow("MARKETING_TICK_ARRAY_COUNT_INVALID");
    expect(() => buildExecuteMarketingSaleDraft(Object.assign(marketing(), {
      remainingAccounts: [address(22)],
    }))).toThrow("GOVERNANCE_EXECUTION_EXTRA_FIELDS");
  });

  it("pins owner-only trader refund without arbitrary recipients or remaining accounts", () => {
    const result = buildRefundTraderDraft({ route: route(), payer: owner, lamports: 12n });
    expect(result.data.toString("hex")).toBe("da4154fe5af3eefd0c00000000000000");
    expect(result.keys).toHaveLength(4);
    expect(result.keys.map((account) => [account.isWritable, account.isSigner]))
      .toEqual([[false, false], [true, false], [true, true], [false, false]]);
    expect(result.keys[2].pubkey.toBase58()).toBe(owner);
    expect(result.executionPermitted).toBe(false);
    expect(() => buildRefundTraderDraft({ route: route(), payer: address(22), lamports: 12n }))
      .toThrow("GOVERNANCE_EXECUTION_ROUTE_INVALID");
    expect(() => buildRefundTraderDraft({ route: route(), payer: owner, lamports: 0n }))
      .toThrow("GOVERNANCE_TRADER_REFUND_AMOUNT_INVALID");
    expect(() => buildRefundTraderDraft(Object.assign({ route: route(), payer: owner, lamports: 12n }, {
      remainingAccounts: [address(22)],
    }))).toThrow("GOVERNANCE_EXECUTION_EXTRA_FIELDS");
  });
});
