import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { governanceAddresses, governanceExecutionReceiptAddresses } from "../../apps/web/src/governanceClient";
import { BUYBACK_QUOTE_MINT, createBuybackInstructionManifest,
  type BuybackVenueState } from "./pumpBuybackInstructionManifest";

type BuybackAction = "BUYBACK_HOLD" | "BUYBACK_BURN" | "BUYBACK_LOCK";
const MAX_U64 = (1n << 64n) - 1n;
const LOCK_TERMS = new Set([30, 90, 180, 365, 730, 1095, 1825]
  .map((days) => days * 86_400).concat(0xffff_ffff));

/** All economic terms are immutable finalized Proposal fields. */
export interface BuybackExecutionIntent {
  governanceProgram: string;
  programCodeSha256: string;
  reserveMint: string;
  reserveVault: string;
  capitalMint: string;
  capitalTokenProgram: string;
  config: string;
  proposalId: string;
  proposal: string;
  receipt: string;
  trader: string;
  action: BuybackAction;
  proposalStateSha256: string;
  frozenReserveRawMstrx: string;
  votedMinOutputRawCapital: string;
  lockDurationSeconds: number;
  executableAt: number;
  venueState: BuybackVenueState;
  verifiedAt: number;
}

function exactKey(value: string, code: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error();
    return key;
  } catch { throw new Error(code); }
}

function positiveU64(value: string, code: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new Error(code);
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error(code);
  return parsed;
}

export function validateBuybackExecutionIntent(intent: BuybackExecutionIntent, issuedAt: number): void {
  const fields = ["governanceProgram", "programCodeSha256", "reserveMint", "reserveVault",
    "capitalMint", "capitalTokenProgram", "config", "proposalId", "proposal", "receipt", "trader",
    "action", "proposalStateSha256", "frozenReserveRawMstrx", "votedMinOutputRawCapital",
    "lockDurationSeconds", "executableAt", "venueState", "verifiedAt"];
  if (!intent || Object.keys(intent).sort().join("|") !== fields.sort().join("|")) {
    throw new Error("GOVERNANCE_BUYBACK_INTENT_FIELDS_INVALID");
  }
  const program = exactKey(intent.governanceProgram, "GOVERNANCE_BUYBACK_IDENTITY_INVALID");
  const mint = exactKey(intent.reserveMint, "GOVERNANCE_BUYBACK_IDENTITY_INVALID");
  const capital = exactKey(intent.capitalMint, "GOVERNANCE_BUYBACK_IDENTITY_INVALID");
  const baseProgram = exactKey(intent.capitalTokenProgram, "GOVERNANCE_BUYBACK_IDENTITY_INVALID");
  for (const address of [intent.reserveVault, intent.config, intent.proposal, intent.receipt, intent.trader]) {
    exactKey(address, "GOVERNANCE_BUYBACK_IDENTITY_INVALID");
  }
  if (!mint.equals(BUYBACK_QUOTE_MINT) || capital.equals(mint)
    || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((candidate) => candidate.equals(baseProgram))
    || !/^[a-f0-9]{64}$/.test(intent.programCodeSha256)
    || !/^[a-f0-9]{64}$/.test(intent.proposalStateSha256)
    || !["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK"].includes(intent.action)) {
    throw new Error("GOVERNANCE_BUYBACK_IDENTITY_INVALID");
  }
  const id = positiveU64(intent.proposalId, "GOVERNANCE_BUYBACK_AMOUNT_INVALID");
  const frozen = positiveU64(intent.frozenReserveRawMstrx, "GOVERNANCE_BUYBACK_AMOUNT_INVALID");
  const floor = positiveU64(intent.votedMinOutputRawCapital, "GOVERNANCE_BUYBACK_AMOUNT_INVALID");
  const addresses = governanceAddresses(program, id);
  const receipt = governanceExecutionReceiptAddresses(program, addresses.proposal).buyback;
  const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], program)[0];
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const vault = getAssociatedTokenAddressSync(mint, config, true, TOKEN_2022_PROGRAM_ID);
  if (intent.config !== config.toBase58() || intent.reserveVault !== vault.toBase58()
    || intent.proposal !== addresses.proposal.toBase58() || intent.receipt !== receipt.toBase58()
    || intent.trader !== trader.toBase58()) throw new Error("GOVERNANCE_BUYBACK_PDA_MISMATCH");
  if (intent.action === "BUYBACK_LOCK" ? !LOCK_TERMS.has(intent.lockDurationSeconds)
    : intent.lockDurationSeconds !== 0) throw new Error("GOVERNANCE_BUYBACK_LOCK_TERMS_INVALID");
  if (!Number.isSafeInteger(intent.executableAt) || intent.executableAt <= 0
    || !Number.isSafeInteger(intent.verifiedAt) || !Number.isSafeInteger(issuedAt)
    || intent.verifiedAt > issuedAt + 30_000 || issuedAt - intent.verifiedAt > 90_000) {
    throw new Error("GOVERNANCE_BUYBACK_PREVIEW_STALE");
  }
  // This pins the voted floor and rejects substituted venue program/mints,
  // arbitrary fee recipients, bad phase IDs and unknown account shapes.
  createBuybackInstructionManifest({ phase: intent.venueState.phase, capitalMint: capital.toBase58(),
    capitalTokenProgram: baseProgram.toBase58(), trader: trader.toBase58(),
    committedQuoteRaw: frozen, votedMinOutputRaw: floor, executionMinOutputRaw: floor,
    venueState: intent.venueState });
}
