import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

// Pinned from the official Pump IDLs shipped with @pump-fun/pump-sdk 2.0.0:
// src/idl/pump.json buy_exact_quote_in_v2 and src/idl/pump_amm.json buy_exact_quote_in.
// This is an OFFCHAIN instruction manifest, not an onchain trading adapter.
export const PUMP_BUYBACK_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMPSWAP_BUYBACK_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const BUYBACK_QUOTE_MINT = new PublicKey("XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ");
export const PUMP_CURVE_BUY_DISCRIMINATOR = "c2ab1c46684d5b2f";
export const PUMPSWAP_BUY_DISCRIMINATOR = "c62e1552b4d9e870";

type LayoutEntry = readonly [name: string, writable: boolean, signer: boolean];
const freezeLayout = (entries: readonly LayoutEntry[]): readonly LayoutEntry[] =>
  Object.freeze(entries.map((entry) => Object.freeze(entry)));
export const CURVE_BUY_ACCOUNT_LAYOUT: readonly LayoutEntry[] = freezeLayout([
  ["global", false, false], ["base_mint", false, false], ["quote_mint", false, false],
  ["base_token_program", false, false], ["quote_token_program", false, false],
  ["associated_token_program", false, false], ["fee_recipient", true, false],
  ["associated_quote_fee_recipient", true, false], ["buyback_fee_recipient", true, false],
  ["associated_quote_buyback_fee_recipient", true, false], ["bonding_curve", true, false],
  ["associated_base_bonding_curve", true, false], ["associated_quote_bonding_curve", true, false],
  ["user", true, true], ["associated_base_user", true, false],
  ["associated_quote_user", true, false], ["creator_vault", true, false],
  ["associated_creator_vault", true, false], ["sharing_config", false, false],
  ["global_volume_accumulator", false, false], ["user_volume_accumulator", true, false],
  ["associated_user_volume_accumulator", true, false], ["fee_config", false, false],
  ["fee_program", false, false], ["system_program", false, false],
  ["event_authority", false, false], ["program", false, false],
]);

export const PUMPSWAP_BUY_ACCOUNT_LAYOUT: readonly LayoutEntry[] = freezeLayout([
  ["pool", true, false], ["user", true, true], ["global_config", false, false],
  ["base_mint", false, false], ["quote_mint", false, false],
  ["user_base_token_account", true, false], ["user_quote_token_account", true, false],
  ["pool_base_token_account", true, false], ["pool_quote_token_account", true, false],
  ["protocol_fee_recipient", false, false], ["protocol_fee_recipient_token_account", true, false],
  ["base_token_program", false, false], ["quote_token_program", false, false],
  ["system_program", false, false], ["associated_token_program", false, false],
  ["event_authority", false, false], ["program", false, false],
  ["coin_creator_vault_ata", true, false], ["coin_creator_vault_authority", false, false],
  ["global_volume_accumulator", false, false], ["user_volume_accumulator", true, false],
  ["fee_config", false, false], ["fee_program", false, false],
]);

export type BuybackPhase = "curve" | "pumpSwap";

/** Dynamic fields must first be read from independently agreed finalized venue accounts. */
export type BuybackVenueState = {
  phase: "curve";
  bondingCurveAddress: string;
  bondingCurveOwner: string;
  complete: false;
  curveBaseMint: string;
  curveQuoteMint: string;
  creator: string;
  feeRecipient: string;
  buybackFeeRecipient: string;
} | {
  phase: "pumpSwap";
  bondingCurveComplete: true;
  poolAddress: string;
  poolOwner: string;
  poolIndex: 0;
  poolCreator: string;
  poolBaseMint: string;
  poolQuoteMint: string;
  coinCreator: string;
  protocolFeeRecipient: string;
};

export interface BuybackManifestRequest {
  phase: BuybackPhase;
  capitalMint: string;
  capitalTokenProgram: string;
  trader: string;
  committedQuoteRaw: bigint;
  votedMinOutputRaw: bigint;
  executionMinOutputRaw: bigint;
  venueState: BuybackVenueState;
}

export interface BuybackInstructionManifest {
  phase: BuybackPhase;
  programId: string;
  discriminatorHex: string;
  dataHex: string;
  spendableQuoteInRaw: string;
  minBaseOutputRaw: string;
  accounts: ReadonlyArray<{
    name: string; address: string; isWritable: boolean; isSigner: boolean;
  }>;
}

const MAX_U64 = (1n << 64n) - 1n;
const pda = (program: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
const seed = (value: string) => Buffer.from(value, "utf8");
const key = (value: string) => new PublicKey(value);
const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, program);
const feeConfig = (venue: PublicKey) => pda(PUMP_FEE_PROGRAM, seed("fee_config"), venue.toBuffer());
const eventAuthority = (venue: PublicKey) => pda(venue, seed("__event_authority"));

function accountAddresses(request: BuybackManifestRequest): Record<string, PublicKey> {
  if (request.phase !== "curve" && request.phase !== "pumpSwap") throw new Error("BUYBACK_PHASE_UNSUPPORTED");
  const capital = key(request.capitalMint);
  const baseToken = key(request.capitalTokenProgram);
  if (!baseToken.equals(TOKEN_PROGRAM_ID) && !baseToken.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("BUYBACK_BASE_TOKEN_PROGRAM_UNSUPPORTED");
  }
  const trader = key(request.trader);
  if (request.phase !== request.venueState.phase) throw new Error("BUYBACK_PHASE_MISMATCH");
  const common = {
    base_mint: capital, quote_mint: BUYBACK_QUOTE_MINT,
    base_token_program: baseToken, quote_token_program: TOKEN_2022_PROGRAM_ID,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
    fee_program: PUMP_FEE_PROGRAM,
    user: trader,
  };
  if (request.venueState.phase === "curve") {
    const state = request.venueState;
    if (state.complete !== false) throw new Error("BUYBACK_CURVE_PHASE_INVALID");
    const curve = pda(PUMP_BUYBACK_PROGRAM, seed("bonding-curve"), capital.toBuffer());
    if (!curve.equals(key(state.bondingCurveAddress)) || !key(state.bondingCurveOwner).equals(PUMP_BUYBACK_PROGRAM)
      || !capital.equals(key(state.curveBaseMint)) || !BUYBACK_QUOTE_MINT.equals(key(state.curveQuoteMint))) {
      throw new Error("BUYBACK_CURVE_IDENTITY_INVALID");
    }
    const feeRecipient = key(state.feeRecipient);
    const buybackFeeRecipient = key(state.buybackFeeRecipient);
    const creatorVault = pda(PUMP_BUYBACK_PROGRAM, seed("creator-vault"), key(state.creator).toBuffer());
    const userVolume = pda(PUMP_BUYBACK_PROGRAM, seed("user_volume_accumulator"), trader.toBuffer());
    return { ...common,
      global: pda(PUMP_BUYBACK_PROGRAM, seed("global")),
      fee_recipient: feeRecipient,
      associated_quote_fee_recipient: ata(feeRecipient, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
      buyback_fee_recipient: buybackFeeRecipient,
      associated_quote_buyback_fee_recipient: ata(buybackFeeRecipient, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
      bonding_curve: curve,
      associated_base_bonding_curve: ata(curve, capital, baseToken),
      associated_quote_bonding_curve: ata(curve, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
      associated_base_user: ata(trader, capital, baseToken),
      associated_quote_user: ata(trader, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
      creator_vault: creatorVault,
      associated_creator_vault: ata(creatorVault, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
      sharing_config: pda(PUMP_FEE_PROGRAM, seed("sharing-config"), capital.toBuffer()),
      global_volume_accumulator: pda(PUMP_BUYBACK_PROGRAM, seed("global_volume_accumulator")),
      user_volume_accumulator: userVolume,
      associated_user_volume_accumulator: ata(userVolume, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
      fee_config: feeConfig(PUMP_BUYBACK_PROGRAM),
      event_authority: eventAuthority(PUMP_BUYBACK_PROGRAM),
      program: PUMP_BUYBACK_PROGRAM,
    };
  }
  const state = request.venueState;
  if (!state.bondingCurveComplete || state.poolIndex !== 0) throw new Error("BUYBACK_POOL_PHASE_INVALID");
  const poolAuthority = pda(PUMP_BUYBACK_PROGRAM, seed("pool-authority"), capital.toBuffer());
  const pool = pda(PUMPSWAP_BUYBACK_PROGRAM, seed("pool"), Buffer.from([0, 0]),
    poolAuthority.toBuffer(), capital.toBuffer(), BUYBACK_QUOTE_MINT.toBuffer());
  if (!pool.equals(key(state.poolAddress)) || !key(state.poolOwner).equals(PUMPSWAP_BUYBACK_PROGRAM)
    || !poolAuthority.equals(key(state.poolCreator)) || !capital.equals(key(state.poolBaseMint))
    || !BUYBACK_QUOTE_MINT.equals(key(state.poolQuoteMint))) {
    throw new Error("BUYBACK_POOL_IDENTITY_INVALID");
  }
  const protocolRecipient = key(state.protocolFeeRecipient);
  const creatorVaultAuthority = pda(PUMPSWAP_BUYBACK_PROGRAM, seed("creator_vault"), key(state.coinCreator).toBuffer());
  return { ...common,
    pool, global_config: pda(PUMPSWAP_BUYBACK_PROGRAM, seed("global_config")),
    user_base_token_account: ata(trader, capital, baseToken),
    user_quote_token_account: ata(trader, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
    pool_base_token_account: ata(pool, capital, baseToken),
    pool_quote_token_account: ata(pool, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
    protocol_fee_recipient: protocolRecipient,
    protocol_fee_recipient_token_account: ata(protocolRecipient, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
    event_authority: eventAuthority(PUMPSWAP_BUYBACK_PROGRAM), program: PUMPSWAP_BUYBACK_PROGRAM,
    coin_creator_vault_ata: ata(creatorVaultAuthority, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
    coin_creator_vault_authority: creatorVaultAuthority,
    global_volume_accumulator: pda(PUMPSWAP_BUYBACK_PROGRAM, seed("global_volume_accumulator")),
    user_volume_accumulator: pda(PUMPSWAP_BUYBACK_PROGRAM, seed("user_volume_accumulator"), trader.toBuffer()),
    fee_config: feeConfig(PUMPSWAP_BUYBACK_PROGRAM),
  };
}

/**
 * A strict offchain preflight against a separately verified venue snapshot.
 * It does not verify RPC finality, token-account contents, fresh price, hooks,
 * CPI feasibility, governance state, or the program's actual onchain behavior.
 */
export function createBuybackInstructionManifest(request: BuybackManifestRequest): BuybackInstructionManifest {
  const { committedQuoteRaw, votedMinOutputRaw, executionMinOutputRaw } = request;
  if (committedQuoteRaw <= 0n || committedQuoteRaw > MAX_U64) throw new Error("BUYBACK_COMMITMENT_INVALID");
  if (votedMinOutputRaw <= 0n || votedMinOutputRaw > MAX_U64
    || executionMinOutputRaw < votedMinOutputRaw || executionMinOutputRaw > MAX_U64) {
    throw new Error("BUYBACK_MIN_OUTPUT_INVALID");
  }
  const addresses = accountAddresses(request);
  const layout = request.phase === "curve" ? CURVE_BUY_ACCOUNT_LAYOUT : PUMPSWAP_BUY_ACCOUNT_LAYOUT;
  const venue = request.phase === "curve" ? PUMP_BUYBACK_PROGRAM : PUMPSWAP_BUYBACK_PROGRAM;
  const discriminatorHex = request.phase === "curve" ? PUMP_CURVE_BUY_DISCRIMINATOR : PUMPSWAP_BUY_DISCRIMINATOR;
  const data = Buffer.alloc(request.phase === "curve" ? 24 : 25);
  Buffer.from(discriminatorHex, "hex").copy(data);
  data.writeBigUInt64LE(committedQuoteRaw, 8);
  data.writeBigUInt64LE(executionMinOutputRaw, 16);
  // PumpSwap OptionBool is a one-byte bool. Disable volume tracking and
  // reject any alternative payload until all extra accounts are reviewed.
  if (request.phase === "pumpSwap") data[24] = 0;
  return {
    phase: request.phase, programId: venue.toBase58(), discriminatorHex,
    dataHex: data.toString("hex"), spendableQuoteInRaw: committedQuoteRaw.toString(),
    minBaseOutputRaw: executionMinOutputRaw.toString(),
    accounts: layout.map(([name, isWritable, isSigner]) => {
      const address = addresses[name];
      if (!address) throw new Error(`BUYBACK_ACCOUNT_LAYOUT_UNRESOLVED:${name}`);
      return { name, address: address.toBase58(), isWritable, isSigner };
    }),
  };
}

export function assertBuybackInstructionMatchesManifest(
  instruction: TransactionInstruction, request: BuybackManifestRequest,
): BuybackInstructionManifest {
  // Never accept a caller-supplied manifest as the source of truth: regenerate
  // it from the pinned layout and the separately verified venue state.
  const manifest = createBuybackInstructionManifest(request);
  if (!instruction.programId.equals(key(manifest.programId))) throw new Error("BUYBACK_PROGRAM_MISMATCH");
  if (instruction.keys.length !== manifest.accounts.length) throw new Error("BUYBACK_ACCOUNT_COUNT_MISMATCH");
  manifest.accounts.forEach((expected, index) => {
    const actual = instruction.keys[index];
    if (!actual.pubkey.equals(key(expected.address)) || actual.isWritable !== expected.isWritable
      || actual.isSigner !== expected.isSigner) throw new Error(`BUYBACK_ACCOUNT_MISMATCH:${expected.name}`);
  });
  if (!Buffer.from(instruction.data).equals(Buffer.from(manifest.dataHex, "hex"))) {
    throw new Error("BUYBACK_PAYLOAD_MISMATCH");
  }
  return manifest;
}
