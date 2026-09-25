import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({}) }));
vi.mock("@solana/wallet-adapter-react-ui", () => ({ BaseWalletMultiButton: () => null }));

import { adminReadinessLabel, governanceLifecycleReadout, governanceProposalStatusLabel, hasRecentVerifiedReserve, SolanaAdminPanel } from "./solanaAdmin";
import { canCreateOwnerProposal, canExecuteOwnerBuyback, canExecuteOwnerMarketingSale, canExecuteOwnerMstrxLock,
  canFinalizeOwnerVote, canPublishOwnerSnapshot, canRequestOwnerLockRelease, matchesBuybackOwnerChallenge,
  matchesFinalizeOwnerChallenge, matchesMarketingSaleOwnerChallenge, matchesMstrxLockOwnerChallenge,
  matchesOwnerLockReleaseChallenge,
  matchesProposalOwnerChallenge, matchesSnapshotOwnerChallenge, normalizeOwnerProposalPreviewRequest,
  ownerActionDrafts, verifiedOwnerProposal, verifiedOwnerProposalPreview,
  type OwnerProposalOption, type OwnerProposalPreview } from "./governanceAdminClient";
import { MARKETING_POOL, MARKETING_PROGRAM, governanceExecutionReceiptAddresses } from "./governanceClient";

const now = 1_780_000_000_000;
const marketingWallet = Keypair.generate().publicKey.toBase58();
const emptyRecipient = SystemProgram.programId.toBase58();
const program = Keypair.generate().publicKey.toBase58();
const reserveMint = Keypair.generate().publicKey.toBase58();
const reserveVault = Keypair.generate().publicKey.toBase58();
const capitalMint = Keypair.generate().publicKey.toBase58();

function status(proposalStatus: number, overrides: Record<string, unknown> = {}) {
  const active = [0, 1, 6, 7, 8].includes(proposalStatus);
  return {
    network: "solana-mainnet-beta" as const,
    automationState: "stopped" as const,
    launch: { configured: true, armed: false, activated: false },
    services: {},
    balances: {},
    governance: {
      program, programCodeSha256: "a".repeat(64), reserveMint,
      withdrawalReleased: false, vaultTokenAccount: reserveVault, boundCapitalMint: capitalMint,
      vaultBalanceRaw: "150", committedRaw: active ? "100" : "0", freeRaw: active ? "50" : "150",
      lastProposalId: "7", activeProposalId: active ? "7" : "0", updatedAt: now,
    },
    governanceProposal: {
      id: "7", status: proposalStatus, proposalStateSha256: "b".repeat(64), frozenRaw: "100",
      startsAt: 1_779_999_000, endsAt: 1_780_002_600, executableAt: 1_780_002_900,
      fixedMarketingWallet: marketingWallet,
      options: [
        { action: "ACCUMULATE", reserveRaw: "0", minOutputRaw: "0", recipient: emptyRecipient, lockDurationSeconds: 0 },
        { action: "BUYBACK_HOLD", reserveRaw: "100", minOutputRaw: "1", recipient: emptyRecipient, lockDurationSeconds: 0 },
        { action: "MARKETING_SALE", reserveRaw: "100", minOutputRaw: "1", recipient: marketingWallet, lockDurationSeconds: 0 },
      ] satisfies OwnerProposalOption[],
      ...([1, 4, 5].includes(proposalStatus) ? { winningAction: "BUYBACK_HOLD" } : {}),
      updatedAt: now,
      ...overrides,
    },
    updatedAt: now,
  };
}

describe("private Solana governance readout", () => {
  it("shows buyback execution only for the released, exact winner and checks signed economic terms", () => {
    const due = now + 3_000_000;
    const base = status(1);
    const ready = { ...base,
      launch: { ...base.launch, activated: true, executionReleased: true,
        governanceBindState: "bound", detectedMint: capitalMint },
      governance: { ...base.governance, capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(), updatedAt: due },
      governanceProposal: { ...base.governanceProposal, updatedAt: due },
    };
    const programKey = new PublicKey(program);
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programKey)[0];
    const id = Buffer.alloc(8); id.writeBigUInt64LE(7n);
    const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), id], programKey)[0];
    const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], programKey)[0];
    const receipt = governanceExecutionReceiptAddresses(programKey, proposal).buyback;
    const venue = Keypair.generate().publicKey.toBase58();
    const message = ["Action: execute_buyback", "Network: Solana Mainnet Beta",
      `Governance program: ${program}`, `Reviewed program SHA-256: ${"a".repeat(64)}`,
      `Reserve mint: ${reserveMint}`, `Reserve vault: ${reserveVault}`,
      `Bound CAPITAL mint: ${capitalMint}`, `CAPITAL token program: ${TOKEN_PROGRAM_ID.toBase58()}`,
      `Config PDA: ${config}`, "Proposal ID: 7", `Proposal PDA: ${proposal}`,
      `Finalized proposal SHA-256: ${"b".repeat(64)}`, "Winning action: BUYBACK_HOLD",
      "Frozen raw MSTRx: 100", "Voted minimum raw CAPITAL: 1", "Lock duration seconds: 0",
      `Buyback receipt PDA: ${receipt}`, `Trader PDA: ${trader}`,
      "Venue phase: curve", `Venue address: ${venue}`, `Venue state SHA-256: ${"c".repeat(64)}`,
      `Executable at: ${new Date(ready.governanceProposal.executableAt * 1_000).toISOString()}`,
      `Verified at: ${new Date(due).toISOString()}`].join("\n");
    expect(canExecuteOwnerBuyback(ready, due)).toBe(true);
    expect(matchesBuybackOwnerChallenge(message, ready, due)).toBe(true);
    for (const changed of [
      message.replace("Frozen raw MSTRx: 100", "Frozen raw MSTRx: 101"),
      message.replace("Voted minimum raw CAPITAL: 1", "Voted minimum raw CAPITAL: 2"),
      message.replace("Winning action: BUYBACK_HOLD", "Winning action: BUYBACK_BURN"),
      message.replace("Venue phase: curve", "Venue phase: unsupported"),
      message.replace(`Venue address: ${venue}`, "Venue address: invalid"),
      message.replace(`Venue state SHA-256: ${"c".repeat(64)}`, "Venue state SHA-256: invalid"),
    ]) expect(matchesBuybackOwnerChallenge(changed, ready, due)).toBe(false);
    expect(canExecuteOwnerBuyback({ ...ready, launch: { ...ready.launch, executionReleased: false } }, due)).toBe(false);
    expect(canExecuteOwnerBuyback({ ...ready, governanceBuybackExecution: { state: "unresolved" } }, due)).toBe(false);
    expect(canExecuteOwnerBuyback({ ...ready, governance: { ...ready.governance,
      boundCapitalMint: Keypair.generate().publicKey.toBase58() } }, due)).toBe(false);
    expect(canExecuteOwnerBuyback({ ...ready, governanceProposal: { ...ready.governanceProposal,
      winningAction: "MARKETING_SALE" } }, due)).toBe(false);
    expect(canExecuteOwnerBuyback({ ...ready, governance: { ...ready.governance, updatedAt: due - 90_000 } }, due)).toBe(false);
  });

  it("checks marketing-sale recipient, fixed pool, bitmap and tick-array identities before owner signing", () => {
    const due = now + 3_000_000;
    const base = status(1);
    const ready = { ...base,
      launch: { ...base.launch, activated: true, executionReleased: true,
        governanceBindState: "bound", detectedMint: capitalMint },
      governance: { ...base.governance, capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(), updatedAt: due },
      governanceProposal: { ...base.governanceProposal, winningAction: "MARKETING_SALE", updatedAt: due },
    };
    const programKey = new PublicKey(program);
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programKey)[0];
    const id = Buffer.alloc(8); id.writeBigUInt64LE(7n);
    const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), id], programKey)[0];
    const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], programKey)[0];
    const receipt = governanceExecutionReceiptAddresses(programKey, proposal).marketing;
    const bitmap = PublicKey.findProgramAddressSync([Buffer.from("pool_tick_array_bitmap_extension"),
      new PublicKey(MARKETING_POOL).toBuffer()], new PublicKey(MARKETING_PROGRAM))[0];
    const tick = Keypair.generate().publicKey.toBase58();
    const message = ["Action: execute_marketing_sale", "Network: Solana Mainnet Beta",
      `Governance program: ${program}`, `Reviewed program SHA-256: ${"a".repeat(64)}`,
      `Reserve mint: ${reserveMint}`, `Reserve vault: ${reserveVault}`,
      `Bound CAPITAL mint: ${capitalMint}`, `CAPITAL token program: ${TOKEN_PROGRAM_ID.toBase58()}`,
      `Config PDA: ${config}`, "Proposal ID: 7", `Proposal PDA: ${proposal}`,
      `Finalized proposal SHA-256: ${"b".repeat(64)}`, "Frozen raw MSTRx: 100",
      "Voted minimum SOL lamports: 1", "Execution minimum SOL lamports: 1",
      `Fixed marketing recipient: ${marketingWallet}`, `Marketing receipt PDA: ${receipt}`,
      `Trader PDA: ${trader}`, `Raydium pool: ${MARKETING_POOL}`, `Raydium bitmap: ${bitmap}`,
      `Tick array 1: ${tick}`,
      `Executable at: ${new Date(ready.governanceProposal.executableAt * 1_000).toISOString()}`,
      `Verified at: ${new Date(due).toISOString()}`].join("\n");
    expect(canExecuteOwnerMarketingSale(ready, due)).toBe(true);
    expect(matchesMarketingSaleOwnerChallenge(message, ready, due)).toBe(true);
    for (const changed of [
      message.replace(`Fixed marketing recipient: ${marketingWallet}`, `Fixed marketing recipient: ${emptyRecipient}`),
      message.replace("Voted minimum SOL lamports: 1", "Voted minimum SOL lamports: 2"),
      message.replace(`Raydium pool: ${MARKETING_POOL}`, `Raydium pool: ${program}`),
      message.replace(`Raydium bitmap: ${bitmap}`, `Raydium bitmap: ${program}`),
      message.replace(`Tick array 1: ${tick}`, "Tick array 1: invalid"),
      message.replace(`Tick array 1: ${tick}`, `Tick array 2: ${tick}`),
    ]) expect(matchesMarketingSaleOwnerChallenge(changed, ready, due)).toBe(false);
    expect(canExecuteOwnerMarketingSale({ ...ready, governanceMarketingExecution: { state: "pending" } }, due)).toBe(false);
    expect(canExecuteOwnerMarketingSale({ ...ready, launch: { ...ready.launch, executionReleased: false } }, due)).toBe(false);
    expect(canExecuteOwnerMarketingSale({ ...ready, governance: { ...ready.governance,
      boundCapitalMint: Keypair.generate().publicKey.toBase58() } }, due)).toBe(false);
    expect(canExecuteOwnerMarketingSale({ ...ready, governanceProposal: { ...ready.governanceProposal,
      fixedMarketingWallet: emptyRecipient } }, due)).toBe(false);
  });

  it("accepts lock release only for a bounded proposal and a fresh, matured, canonical escrow challenge", () => {
    const due = now + 3_000_000;
    const base = status(2);
    const programKey = new PublicKey(program);
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programKey)[0];
    const canonicalReserve = getAssociatedTokenAddressSync(new PublicKey(reserveMint), config, true,
      TOKEN_2022_PROGRAM_ID).toBase58();
    const ready = { ...base,
      launch: { ...base.launch, activated: true, executionReleased: true,
        governanceBindState: "bound", detectedMint: capitalMint },
      governance: { ...base.governance, vaultTokenAccount: canonicalReserve, updatedAt: due },
    };
    const id = Buffer.alloc(8); id.writeBigUInt64LE(7n);
    const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), id], programKey)[0];
    const record = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], programKey)[0];
    const escrow = getAssociatedTokenAddressSync(new PublicKey(reserveMint), record, true,
      TOKEN_2022_PROGRAM_ID);
    const message = ["Action: release_lock_mstrx", "Network: Solana Mainnet Beta",
      `Governance program: ${program}`, `Reviewed program SHA-256: ${"a".repeat(64)}`,
      `Reserve mint: ${reserveMint}`, `Canonical reserve vault: ${canonicalReserve}`,
      `Bound CAPITAL mint: ${capitalMint}`, `Config PDA: ${config}`,
      "Proposal ID: 7", `Proposal PDA: ${proposal}`, `Lock record PDA: ${record}`,
      `Lock vault ATA: ${escrow}`, `Finalized proposal SHA-256: ${"b".repeat(64)}`,
      `Finalized lock record SHA-256: ${"c".repeat(64)}`,
      "Record committed raw MSTRx: 100", "Observed escrow raw MSTRx: 110",
      "Releases all current escrow to the canonical reserve vault",
      `Release at: ${new Date(due - 60_000).toISOString()}`,
      `Verified at: ${new Date(due).toISOString()}`].join("\n");
    expect(canRequestOwnerLockRelease(ready, "7", due)).toBe(true);
    expect(matchesOwnerLockReleaseChallenge(message, ready, "7", due)).toBe(true);
    for (const changed of [
      message.replace("Observed escrow raw MSTRx: 110", "Observed escrow raw MSTRx: 99"),
      message.replace(`Canonical reserve vault: ${canonicalReserve}`, `Canonical reserve vault: ${reserveVault}`),
      message.replace(`Lock record PDA: ${record}`, `Lock record PDA: ${proposal}`),
      message.replace(`Release at: ${new Date(due - 60_000).toISOString()}`,
        `Release at: ${new Date(due + 60_000).toISOString()}`),
      message.replace(`Verified at: ${new Date(due).toISOString()}`,
        `Verified at: ${new Date(due - 91_000).toISOString()}`),
    ]) expect(matchesOwnerLockReleaseChallenge(changed, ready, "7", due)).toBe(false);
    expect(canRequestOwnerLockRelease(ready, "8", due)).toBe(false);
    expect(canRequestOwnerLockRelease(ready, "0", due)).toBe(false);
    expect(canRequestOwnerLockRelease({ ...ready, governanceLockRelease: { state: "unresolved" } }, "7", due)).toBe(false);
    expect(canRequestOwnerLockRelease({ ...ready, launch: { ...ready.launch, executionReleased: false } }, "7", due)).toBe(false);
  });

  it("enables only an exact, finalized LOCK_MSTRX winner and rejects altered owner challenges", () => {
    const due = now + 3_000_000;
    const base = status(1);
    const ready = { ...base,
      launch: { ...base.launch, activated: true, executionReleased: true,
        governanceBindState: "bound", detectedMint: capitalMint },
      governance: { ...base.governance, capitalTokenProgram: TOKEN_PROGRAM_ID.toBase58(), updatedAt: due },
      governanceProposal: { ...base.governanceProposal, winningAction: "LOCK_MSTRX", updatedAt: due,
        options: [base.governanceProposal.options[0], {
          action: "LOCK_MSTRX", reserveRaw: "100", minOutputRaw: "0", recipient: emptyRecipient,
          lockDurationSeconds: 30 * 86_400,
        }] },
    };
    expect(canExecuteOwnerMstrxLock(ready, due)).toBe(true);
    const programKey = new PublicKey(program);
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programKey)[0];
    const id = Buffer.alloc(8); id.writeBigUInt64LE(7n);
    const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), id], programKey)[0];
    const record = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], programKey)[0];
    const escrow = getAssociatedTokenAddressSync(new PublicKey(reserveMint), record, true, TOKEN_2022_PROGRAM_ID);
    const message = ["Action: execute_lock_mstrx", "Network: Solana Mainnet Beta",
      `Governance program: ${program}`, `Reviewed program SHA-256: ${"a".repeat(64)}`,
      `Reserve mint: ${reserveMint}`, `Reserve vault: ${reserveVault}`,
      `Bound CAPITAL mint: ${capitalMint}`, `CAPITAL token program: ${TOKEN_PROGRAM_ID.toBase58()}`,
      `Config PDA: ${config.toBase58()}`, "Proposal ID: 7", `Proposal PDA: ${proposal.toBase58()}`,
      `Finalized proposal SHA-256: ${"b".repeat(64)}`, "Frozen raw MSTRx: 100",
      `Lock duration seconds: ${30 * 86_400}`, `Lock record PDA: ${record.toBase58()}`,
      `Lock vault ATA: ${escrow.toBase58()}`,
      `Executable at: ${new Date(ready.governanceProposal.executableAt * 1_000).toISOString()}`,
      `Verified at: ${new Date(due).toISOString()}`].join("\n");
    expect(matchesMstrxLockOwnerChallenge(message, ready, due)).toBe(true);
    expect(matchesMstrxLockOwnerChallenge(message.replace("Frozen raw MSTRx: 100", "Frozen raw MSTRx: 101"), ready, due)).toBe(false);
    expect(canExecuteOwnerMstrxLock({ ...ready, launch: { ...ready.launch, executionReleased: false } }, due)).toBe(false);
    expect(canExecuteOwnerMstrxLock({ ...ready, governanceLockExecution: { state: "unresolved" } }, due)).toBe(false);
    expect(canExecuteOwnerMstrxLock({ ...ready, governanceProposal: { ...ready.governanceProposal,
      winningAction: "ACCUMULATE" } }, due)).toBe(false);
  });

  it("signs the next snapshot ID from lastProposalId, not a cleared activeProposalId", () => {
    const ready = { ...status(4), proposalControlReleased: true,
      launch: { ...status(4).launch, activated: true, governanceBindState: "bound", detectedMint: capitalMint } };
    expect(ready.governance.activeProposalId).toBe("0");
    expect(canPublishOwnerSnapshot(ready, now)).toBe(true);
    const message = ["Action: publish_snapshot", "Network: Solana Mainnet Beta",
      `Governance program: ${program}`, `Reviewed program SHA-256: ${"a".repeat(64)}`,
      `Bound CAPITAL mint: ${capitalMint}`, `Reserve mint: ${reserveMint}`,
      "Next proposal ID: 8",
      "Purpose: audit and publish a holder voting snapshot; no onchain transaction"].join("\n");
    expect(matchesSnapshotOwnerChallenge(message, ready, now)).toBe(true);
    expect(matchesSnapshotOwnerChallenge(message.replace("Next proposal ID: 8", "Next proposal ID: 1"), ready, now)).toBe(false);
  });

  it("never labels a diagnostic configuration ready while the executor release gate is off", () => {
    expect(adminReadinessLabel(status(0))).toBe("BLOCKED");
    expect(adminReadinessLabel({ ...status(0), launch: { ...status(0).launch, activated: true } })).toBe("BLOCKED");
    expect(adminReadinessLabel({ ...status(0), launch: { ...status(0).launch, executionReleased: true } })).toBe("CONFIGURED");
  });

  it("distinguishes an unexecuted passed decision from an executed one", () => {
    expect(governanceLifecycleReadout(status(1), now).execution).toBe("COMMITTED · NOT EXECUTED");
    expect(governanceLifecycleReadout(status(4), now).execution).toBe("UNVERIFIED");
    const checkedAt = now + 3_000_000;
    const receipt = {
      address: Keypair.generate().publicKey.toBase58(), kind: "BUYBACK" as const,
      action: "BUYBACK_HOLD", inputRawMstrx: "100", votedMinOutputRaw: "1", actualOutputRaw: "10",
      executedAt: 1_780_002_900, destination: Keypair.generate().publicKey.toBase58(),
      venue: Keypair.generate().publicKey.toBase58(),
    };
    const completed = status(4, { updatedAt: checkedAt, executionReceipt: receipt });
    completed.governance.updatedAt = checkedAt;
    expect(governanceLifecycleReadout(completed, checkedAt).execution).toBe("EXECUTED");
    expect(verifiedOwnerProposal({ ...completed, governanceProposal: { ...completed.governanceProposal,
      executionReceipt: { ...receipt, actualOutputRaw: "0" },
    } }, checkedAt)).toBeUndefined();
  });

  it("shows a finalized marketing execution only with a matching fixed recipient and exact floor", () => {
    const checkedAt = now + 3_000_000;
    const receipt = {
      address: Keypair.generate().publicKey.toBase58(), kind: "MARKETING_SALE" as const,
      action: "MARKETING_SALE", inputRawMstrx: "100", votedMinOutputRaw: "1", actualOutputRaw: "2",
      executedAt: 1_780_002_900, destination: marketingWallet,
      venue: Keypair.generate().publicKey.toBase58(),
    };
    const completed = status(4, { winningAction: "MARKETING_SALE", updatedAt: checkedAt,
      executionReceipt: receipt });
    completed.governance.updatedAt = checkedAt;
    expect(governanceLifecycleReadout(completed, checkedAt).execution).toBe("EXECUTED");
    expect(verifiedOwnerProposal({ ...completed, governanceProposal: { ...completed.governanceProposal,
      executionReceipt: { ...receipt, destination: Keypair.generate().publicKey.toBase58() },
    } }, checkedAt)).toBeUndefined();
    expect(verifiedOwnerProposal({ ...completed, governanceProposal: { ...completed.governanceProposal,
      executionReceipt: { ...receipt, votedMinOutputRaw: "2" },
    } }, checkedAt)).toBeUndefined();
  });

  it("keeps failed re-votes visibly frozen instead of marking the reserve free", () => {
    expect(governanceProposalStatusLabel(7)).toContain("FROZEN");
    expect(governanceLifecycleReadout(status(8), now).execution).toBe("FROZEN · RE-VOTE REQUIRED");
    expect(governanceProposalStatusLabel(2)).toContain("RELEASED");
  });

  it("does not display stale, mismatched, malformed or missing proposal status as current", () => {
    expect(governanceLifecycleReadout(status(1, { updatedAt: now - 90_000 }), now).result).toBe("UNVERIFIED");
    expect(governanceLifecycleReadout(status(1, { id: "8" }), now).result).toBe("UNVERIFIED");
    expect(governanceLifecycleReadout(status(99), now).result).toBe("UNVERIFIED");
    expect(governanceLifecycleReadout(status(1, { executableAt: 1_780_002_901 }), now).result).toBe("UNVERIFIED");
    expect(governanceLifecycleReadout(undefined, now).result).toBe("UNVERIFIED");
    const noActive = { ...status(0), governance: { ...status(0).governance, activeProposalId: "0" } };
    expect(governanceLifecycleReadout(noActive, now).result).toBe("UNVERIFIED");
  });

  it("shows only a fully verified immutable option set and exact owner draft amounts", () => {
    const verified = verifiedOwnerProposal(status(1), now);
    expect(verified?.options[1]).toMatchObject({ action: "BUYBACK_HOLD", reserveRaw: "100", minOutputRaw: "1",
      recipient: emptyRecipient });
    expect(verified?.options[2]).toMatchObject({ action: "MARKETING_SALE", reserveRaw: "100", minOutputRaw: "1",
      recipient: marketingWallet });
    const due = now + 3_000_000;
    const moved = { ...status(1), governance: { ...status(1).governance, updatedAt: due },
      governanceProposal: { ...status(1).governanceProposal, updatedAt: due } };
    expect(ownerActionDrafts(moved, due).find((item) => item.key === "revote"))
      .toMatchObject({ exactRaw: "100", button: "OPEN RE-VOTE · LOCKED" });
    expect(ownerActionDrafts(moved, due).find((item) => item.key === "execute"))
      .toMatchObject({ exactRaw: "100", button: "EXECUTE WINNER · LOCKED" });
    for (const failedRevoteStatus of [7, 8]) {
      const failed = { ...status(failedRevoteStatus), governance: { ...status(failedRevoteStatus).governance,
        updatedAt: due }, governanceProposal: { ...status(failedRevoteStatus).governanceProposal,
        updatedAt: due } };
      expect(ownerActionDrafts(failed, due).find((item) => item.key === "revote")?.exactRaw).toBe("100");
      expect(ownerActionDrafts(failed, due).find((item) => item.key === "initial")?.exactRaw).toBeUndefined();
    }
    expect(ownerActionDrafts(status(0), now).find((item) => item.key === "initial")?.exactRaw).toBeUndefined();
    const noBallot = { ...status(2), governanceProposal: undefined };
    expect(ownerActionDrafts(noBallot, now).find((item) => item.key === "initial")?.exactRaw).toBe("150");
  });

  it("fails closed on changed option amount, floor, recipient or missing option list", () => {
    const base = status(1);
    const option = base.governanceProposal.options[2];
    for (const modified of [
      { ...option, reserveRaw: "99" },
      { ...option, minOutputRaw: "0" },
      { ...option, recipient: emptyRecipient },
    ]) {
      const altered = { ...base, governanceProposal: { ...base.governanceProposal,
        options: [...base.governanceProposal.options.slice(0, 2), modified] } };
      expect(verifiedOwnerProposal(altered, now)).toBeUndefined();
    }
    expect(verifiedOwnerProposal({ ...base, governanceProposal: { ...base.governanceProposal,
      options: undefined } }, now)).toBeUndefined();
    expect(verifiedOwnerProposal({ ...base, governanceProposal: { ...base.governanceProposal,
      fixedMarketingWallet: undefined } }, now)).toBeUndefined();
    expect(verifiedOwnerProposal({ ...base, governance: { ...base.governance, committedRaw: "99",
      freeRaw: "51" } }, now)).toBeUndefined();
    expect(verifiedOwnerProposal({ ...base, governanceProposal: { ...base.governanceProposal,
      options: base.governanceProposal.options.slice(1) } }, now)).toBeUndefined();
    expect(verifiedOwnerProposal({ ...base, governanceProposal: { ...base.governanceProposal,
      winningAction: "BUYBACK_BURN" } }, now)).toBeUndefined();
    expect(verifiedOwnerProposal({ ...base, governanceProposal: { ...base.governanceProposal,
      options: [base.governanceProposal.options[0], base.governanceProposal.options[0]] } }, now)).toBeUndefined();
  });

  it("does not call a stale or arithmetically inconsistent reserve quote verified", () => {
    const valid = status(0);
    expect(hasRecentVerifiedReserve(valid, now)).toBe(true);
    expect(hasRecentVerifiedReserve({ ...valid, governance: { ...valid.governance, updatedAt: 0 } }, now)).toBe(false);
    expect(hasRecentVerifiedReserve({ ...valid, governance: { ...valid.governance, updatedAt: now - 90_000 } }, now)).toBe(false);
    expect(hasRecentVerifiedReserve({ ...valid, governance: { ...valid.governance, freeRaw: "51" } }, now)).toBe(false);
    expect(hasRecentVerifiedReserve({ ...valid, governance: { ...valid.governance, committedRaw: "unknown" } }, now)).toBe(false);
  });

  it("keeps finalization hard-disabled until release and checks the exact signed ballot challenge", () => {
    const due = now + 3_000_000;
    const base = status(0);
    const ready = {
      ...base, finalizeVoteReleased: true,
      launch: { ...base.launch, activated: true, governanceBindState: "bound", detectedMint: capitalMint },
      governance: { ...base.governance, updatedAt: due },
      governanceProposal: { ...base.governanceProposal, updatedAt: due },
    };
    expect(canFinalizeOwnerVote({ ...ready, finalizeVoteReleased: false }, due)).toBe(false);
    expect(canFinalizeOwnerVote(ready, due)).toBe(true);
    const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], new PublicKey(program))[0];
    const seed = Buffer.alloc(8); seed.writeBigUInt64LE(7n);
    const proposalPda = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], new PublicKey(program))[0];
    const message = [
      "Action: finalize_vote", "Network: Solana Mainnet Beta",
      `Governance program: ${program}`, `Reviewed program SHA-256: ${"a".repeat(64)}`,
      `Reserve mint: ${reserveMint}`, `Reserve vault: ${reserveVault}`,
      `Bound CAPITAL mint: ${capitalMint}`, `Config PDA: ${configPda}`,
      "Proposal ID: 7", `Proposal PDA: ${proposalPda}`,
      `Finalized proposal state SHA-256: ${"b".repeat(64)}`,
      "Frozen raw MSTRx: 100",
    ].join("\n");
    expect(matchesFinalizeOwnerChallenge(message, ready, due)).toBe(true);
    expect(matchesFinalizeOwnerChallenge(message.replace("Frozen raw MSTRx: 100", "Frozen raw MSTRx: 99"), ready, due)).toBe(false);
    expect(matchesFinalizeOwnerChallenge(message.replace(`Proposal PDA: ${proposalPda}`, `Proposal PDA: ${configPda}`), ready, due)).toBe(false);
    expect(canFinalizeOwnerVote({ ...ready, governanceProposal: { ...ready.governanceProposal,
      proposalStateSha256: "not-a-hash" } }, due)).toBe(false);
    expect(canFinalizeOwnerVote({ ...ready, launch: { ...ready.launch, governanceBindState: "pending" } }, due)).toBe(false);
  });

  it("shows one-step token detection and owner-controlled reserve without inactive governance controls", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __FLYWHEEL_ADMIN_API__: undefined } });
    const html = renderToStaticMarkup(createElement(SolanaAdminPanel));
    expect(html).toContain("Проверить и включить детектор токена");
    expect(html).toContain('aria-label="Резерв под контролем владельца"');
    expect(html).toContain("КОШЕЛЁК РЕЗЕРВА");
    expect(html).toContain("Событий пока нет");
    expect(html).not.toContain("Governance executor released");
    expect(html).not.toContain("Create initial ballot");
  });
});

describe("read-only governance proposal preview", () => {
  const input = {
    mode: "initial" as const, durationHours: 2,
    selected: ["ACCUMULATE", "BUYBACK_HOLD", "MARKETING_SALE"] as const,
    minimums: { BUYBACK_HOLD: "5", MARKETING_SALE: "10" },
    lockTerms: {},
  };

  it("normalizes only fixed ballot options, a bounded duration and positive immutable swap floors", () => {
    expect(normalizeOwnerProposalPreviewRequest(input)).toEqual({
      mode: "initial", votingDurationSeconds: 7_200,
      options: [
        { action: "ACCUMULATE" },
        { action: "BUYBACK_HOLD", minOutputRaw: "5" },
        { action: "MARKETING_SALE", minOutputRaw: "10" },
      ],
    });
    expect(() => normalizeOwnerProposalPreviewRequest({ ...input, selected: ["ACCUMULATE"] })).toThrow("PROPOSAL_OPTIONS_INVALID");
    expect(() => normalizeOwnerProposalPreviewRequest({ ...input, selected: ["ACCUMULATE", "ACCUMULATE"] })).toThrow("PROPOSAL_OPTIONS_INVALID");
    expect(() => normalizeOwnerProposalPreviewRequest({ ...input, durationHours: 13 })).toThrow("PROPOSAL_DURATION_INVALID");
    expect(() => normalizeOwnerProposalPreviewRequest({ ...input, minimums: { ...input.minimums,
      MARKETING_SALE: "0" } })).toThrow("PROPOSAL_MINIMUM_INVALID");
    expect(() => normalizeOwnerProposalPreviewRequest({ ...input, minimums: { ...input.minimums,
      BUYBACK_HOLD: ((1n << 64n)).toString() } })).toThrow("PROPOSAL_MINIMUM_INVALID");
    expect(() => normalizeOwnerProposalPreviewRequest({ ...input, lockTerms: { MARKETING_SALE: 2_592_000 } })).toThrow("PROPOSAL_LOCK_TERM_INVALID");
    expect(() => normalizeOwnerProposalPreviewRequest({ ...input, selected: ["ACCUMULATE", "BUYBACK_LOCK"],
      minimums: { BUYBACK_LOCK: "1" }, lockTerms: { BUYBACK_LOCK: 86_400 } })).toThrow("PROPOSAL_LOCK_TERM_INVALID");
    expect(normalizeOwnerProposalPreviewRequest({ ...input, mode: "revote",
      selected: ["ACCUMULATE", "BUYBACK_LOCK"], minimums: { BUYBACK_LOCK: "1" },
      lockTerms: { BUYBACK_LOCK: 30 * 86_400 } })).toEqual({
      mode: "revote", votingDurationSeconds: 7_200,
      options: [{ action: "ACCUMULATE" },
        { action: "BUYBACK_LOCK", minOutputRaw: "1", lockDurationSeconds: 30 * 86_400 }],
    });
    const request = normalizeOwnerProposalPreviewRequest(input);
    expect(JSON.stringify(request)).not.toMatch(/recipient|private|signature|transaction/i);
  });

  it("displays only the matching exact audit result and rejects a sendable or altered response", () => {
    const request = normalizeOwnerProposalPreviewRequest(input);
    const proposal = Keypair.generate().publicKey.toBase58();
    const config = Keypair.generate().publicKey.toBase58();
    const result: OwnerProposalPreview = {
      ok: true, sendable: false, previewHash: "d".repeat(64),
      auditedAtUnix: 1_780_000_000, fixedMarketingRecipient: marketingWallet,
      draft: { id: "7", proposal, config, reserveVault, frozenReserveRawMstrx: "100",
        estimatedStartsAt: 1_780_000_000, estimatedEndsAt: 1_780_007_200,
        estimatedExecutableAt: 1_780_007_500, unreleasedExecutors: ["BUYBACK_HOLD", "MARKETING_SALE"] },
      publication: { version: 2, network: "solana-mainnet-beta", proposalId: "7",
        merkleRoot: "a".repeat(64), totalAvailableWeight: ((1n << 64n) + 1n).toString(),
        sourceSha256: "b".repeat(64), snapshotSha256: "c".repeat(64),
        publishedAtUnix: 1_779_999_000,
        source: "governance/proposals/7/source.json", snapshot: "governance/proposals/7/snapshot.json" },
      options: [
        { action: "ACCUMULATE", reserveRaw: "0", minOutputRaw: "0", recipient: emptyRecipient, lockDurationSeconds: 0 },
        { action: "BUYBACK_HOLD", reserveRaw: "100", minOutputRaw: "5", recipient: emptyRecipient, lockDurationSeconds: 0 },
        { action: "MARKETING_SALE", reserveRaw: "100", minOutputRaw: "10", recipient: marketingWallet, lockDurationSeconds: 0 },
      ],
    };
    expect(verifiedOwnerProposalPreview(result, request)).toEqual(result);
    for (const changed of [
      { ...result, sendable: true },
      { ...result, previewHash: "bad" },
      { ...result, draft: { ...result.draft, frozenReserveRawMstrx: "99" } },
      { ...result, publication: { ...result.publication, proposalId: "8" } },
      { ...result, options: [...result.options.slice(0, 2), { ...result.options[2], recipient: "invalid" }] },
      { ...result, options: [...result.options.slice(0, 1), { ...result.options[1], minOutputRaw: "1" }, result.options[2]] },
    ]) expect(verifiedOwnerProposalPreview(changed, request)).toBeUndefined();

    const base = status(2);
    const ready = { ...base, proposalControlReleased: true,
      launch: { ...base.launch, activated: true, governanceBindState: "bound", detectedMint: capitalMint },
      governance: { ...base.governance, vaultBalanceRaw: "100", freeRaw: "100" },
      governanceProposal: undefined };
    expect(canCreateOwnerProposal({ ...ready, proposalControlReleased: false }, result, request, now)).toBe(false);
    expect(canCreateOwnerProposal(ready, result, request, now)).toBe(true);
    expect(canCreateOwnerProposal(ready, result, request, now + 91_000)).toBe(false);
    const challenge = [
      "Action: create_proposal", `Governance program: ${program}`,
      `Reviewed program SHA-256: ${"a".repeat(64)}`, `Reserve mint: ${reserveMint}`,
      `Bound CAPITAL mint: ${capitalMint}`, `Config PDA: ${config}`,
      `Reserve vault: ${reserveVault}`, "Proposal ID: 7", `Proposal PDA: ${proposal}`,
      "Frozen raw MSTRx: 100", `Fixed marketing recipient: ${marketingWallet}`,
      "Voting duration seconds: 7200",
      "Option 1: ACCUMULATE | minimum raw output 0 | lock seconds 0",
      "Option 2: BUYBACK_HOLD | minimum raw output 5 | lock seconds 0",
      "Option 3: MARKETING_SALE | minimum raw output 10 | lock seconds 0",
      `Published snapshot root: ${"a".repeat(64)}`,
      `Published total voting weight: ${((1n << 64n) + 1n).toString()}`,
      `Published source SHA-256: ${"b".repeat(64)}`,
      `Published snapshot SHA-256: ${"c".repeat(64)}`,
      `Publication time: ${new Date(1_779_999_000_000).toISOString()}`,
      `Exact preview SHA-256: ${"d".repeat(64)}`,
      `Audited at: ${new Date(now).toISOString()}`,
    ].join("\n");
    expect(matchesProposalOwnerChallenge(challenge, ready, result, request, now)).toBe(true);
    expect(matchesProposalOwnerChallenge(challenge.replace("Frozen raw MSTRx: 100", "Frozen raw MSTRx: 99"),
      ready, result, request, now)).toBe(false);
  });
});
