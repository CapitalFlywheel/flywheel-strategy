import { createHash } from "node:crypto";
import { PUMP_SDK, canonicalPumpPoolPdaWithQuote, bondingCurvePda,
  pumpPoolAuthorityPda } from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { AccountState, ExtensionType, getAssociatedTokenAddressSync,
  getDefaultAccountState, getExtensionTypes, getPausableConfig, getTransferHook,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { BUYBACK_QUOTE_MINT, PUMP_BUYBACK_PROGRAM, PUMP_FEE_PROGRAM,
  PUMPSWAP_BUYBACK_PROGRAM, type BuybackVenueState } from "./pumpBuybackInstructionManifest";
import { finalizedConsensus } from "./rpcConsensus";

// Read-only venue evidence. The installed SDK exposes exact-quote-in IDLs but
// not a reviewed quote for those instructions with the live custom-quote fee
// schedule. A pool spot estimate or the SDK's exact-base-output buy wrapper is
// deliberately NOT presented as an executable minimum-output quote.
const MAX_U64 = (1n << 64n) - 1n;
const MAX_VIEW_SLOT_DRIFT = 4;
const ZERO = PublicKey.default.toBase58();
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MSTRX_ALLOWED_EXTENSIONS = new Set([3, 4, 6, 10, 12, 14, 18, 19, 21, 22, 23, 25, 26]);
const CAPITAL_ALLOWED_EXTENSIONS = new Set([3, 4, 6, 10, 18, 19, 21, 22, 23, 25]);

export interface GovernanceBuybackVenueRequest {
  rpcUrls: readonly [string, string];
  capitalMint: string;
  capitalTokenProgram: string;
  frozenRawMstrx: bigint;
}

export interface GovernanceBuybackAddresses {
  curve: PublicKey;
  global: PublicKey;
  pool: PublicKey;
  poolAuthority: PublicKey;
  ammGlobal: PublicKey;
  curveBaseVault: PublicKey;
  curveQuoteVault: PublicKey;
  poolBaseVault: PublicKey;
  poolQuoteVault: PublicKey;
  curveFeeConfig: PublicKey;
  poolFeeConfig: PublicKey;
}

export type GovernanceBuybackAccountName =
  | "curve" | "global" | "pool" | "ammGlobal" | "capitalMint" | "mstrxMint"
  | "curveBaseVault" | "curveQuoteVault" | "poolBaseVault" | "poolQuoteVault"
  | "curveFeeConfig" | "poolFeeConfig" | "pumpProgram" | "pumpSwapProgram" | "feeProgram";

export type GovernanceBuybackAccounts = Record<GovernanceBuybackAccountName, AccountInfo<Buffer> | null>;

export interface GovernanceBuybackView {
  slot: number;
  accounts: GovernanceBuybackAccounts;
}

export interface InspectedGovernanceBuybackVenue {
  phase: "curve" | "pumpSwap";
  venueState: BuybackVenueState;
  frozenRawMstrx: string;
  venueBaseVaultRaw: string;
  venueQuoteVaultRaw: string;
  virtualBaseReservesRaw: string | null;
  virtualQuoteReservesRaw: string;
  creatorFeeBps: string;
  feeConfig: string;
  // No execution caller may turn this into a transaction without a separate,
  // verified exact-input quote and full signed-transaction simulation.
  quoteUnavailable: true;
  quoteStatus: "UNVERIFIED_EXACT_QUOTE_IN_FEE_AND_FULL_FILL";
  expectedCapitalRaw: null;
  executionPermitted: false;
}

function canonical(value: string, label: string): PublicKey {
  try {
    const result = new PublicKey(value);
    if (result.toBase58() !== value) throw new Error();
    return result;
  } catch { throw new Error(`BUYBACK_${label}_INVALID`); }
}

export function governanceBuybackAddresses(capital: PublicKey, baseTokenProgram: PublicKey): GovernanceBuybackAddresses {
  const curve = bondingCurvePda(capital);
  const poolAuthority = pumpPoolAuthorityPda(capital);
  const pool = canonicalPumpPoolPdaWithQuote(capital, BUYBACK_QUOTE_MINT);
  const expectedCurve = PublicKey.findProgramAddressSync([
    Buffer.from("bonding-curve"), capital.toBuffer(),
  ], PUMP_BUYBACK_PROGRAM)[0];
  const expectedPoolAuthority = PublicKey.findProgramAddressSync([
    Buffer.from("pool-authority"), capital.toBuffer(),
  ], PUMP_BUYBACK_PROGRAM)[0];
  const expectedPool = PublicKey.findProgramAddressSync([
    Buffer.from("pool"), Buffer.alloc(2), expectedPoolAuthority.toBuffer(),
    capital.toBuffer(), BUYBACK_QUOTE_MINT.toBuffer(),
  ], PUMPSWAP_BUYBACK_PROGRAM)[0];
  if (!curve.equals(expectedCurve) || !poolAuthority.equals(expectedPoolAuthority)
    || !pool.equals(expectedPool)) throw new Error("BUYBACK_SDK_PROGRAM_ID_MISMATCH");
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_BUYBACK_PROGRAM);
  const [ammGlobal] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP_BUYBACK_PROGRAM);
  const feeConfig = (venue: PublicKey) => PublicKey.findProgramAddressSync([
    Buffer.from("fee_config"), venue.toBuffer(),
  ], PUMP_FEE_PROGRAM)[0];
  const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, program);
  return {
    curve, global, pool, poolAuthority, ammGlobal,
    curveBaseVault: ata(curve, capital, baseTokenProgram),
    curveQuoteVault: ata(curve, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
    poolBaseVault: ata(pool, capital, baseTokenProgram),
    poolQuoteVault: ata(pool, BUYBACK_QUOTE_MINT, TOKEN_2022_PROGRAM_ID),
    curveFeeConfig: feeConfig(PUMP_BUYBACK_PROGRAM),
    poolFeeConfig: feeConfig(PUMPSWAP_BUYBACK_PROGRAM),
  };
}

function accountFingerprint(account: AccountInfo<Buffer> | null) {
  return account && {
    owner: account.owner.toBase58(), executable: account.executable,
    lamports: account.lamports,
    dataSha256: createHash("sha256").update(account.data).digest("hex"),
  };
}

/** Two near-synchronous finalized reads must contain byte-identical state. */
export function assertMatchingGovernanceBuybackViews(views: readonly GovernanceBuybackView[]): void {
  if (views.length !== 2 || views.some((view) => !Number.isSafeInteger(view.slot) || view.slot <= 0)) {
    throw new Error("BUYBACK_TWO_FINALIZED_VIEWS_REQUIRED");
  }
  if (Math.abs(views[0].slot - views[1].slot) > MAX_VIEW_SLOT_DRIFT) {
    throw new Error("BUYBACK_RPC_SLOT_DRIFT");
  }
  const names: GovernanceBuybackAccountName[] = [
    "curve", "global", "pool", "ammGlobal", "capitalMint", "mstrxMint",
    "curveBaseVault", "curveQuoteVault", "poolBaseVault", "poolQuoteVault",
    "curveFeeConfig", "poolFeeConfig", "pumpProgram", "pumpSwapProgram", "feeProgram",
  ];
  const fingerprints = views.map((view) => names.map((name) => accountFingerprint(view.accounts[name])));
  if (JSON.stringify(fingerprints[0]) !== JSON.stringify(fingerprints[1])) {
    throw new Error("BUYBACK_RPC_ACCOUNT_DISAGREEMENT");
  }
}

function required(accounts: GovernanceBuybackAccounts, name: GovernanceBuybackAccountName,
  owner: PublicKey): AccountInfo<Buffer> {
  const account = accounts[name];
  if (!account || !account.owner.equals(owner) || account.executable) {
    throw new Error(`BUYBACK_${name.toUpperCase()}_INVALID`);
  }
  return account;
}

function executable(accounts: GovernanceBuybackAccounts, name: GovernanceBuybackAccountName) {
  const account = accounts[name];
  if (!account?.executable || !account.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error(`BUYBACK_${name.toUpperCase()}_INVALID`);
  }
}

function assertMintPolicy(accounts: GovernanceBuybackAccounts, capital: PublicKey, baseTokenProgram: PublicKey) {
  const quote = unpackMint(BUYBACK_QUOTE_MINT,
    required(accounts, "mstrxMint", TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  const base = unpackMint(capital, required(accounts, "capitalMint", baseTokenProgram), baseTokenProgram);
  if (!quote.isInitialized || quote.decimals !== 8 || !base.isInitialized
    || base.freezeAuthority !== null) throw new Error("BUYBACK_MINT_POLICY_INVALID");
  const assertExtensions = (types: number[], allowed: Set<number>) => {
    if (types.some((type) => !allowed.has(type))) throw new Error("BUYBACK_MINT_EXTENSION_UNSUPPORTED");
  };
  assertExtensions(getExtensionTypes(quote.tlvData), MSTRX_ALLOWED_EXTENSIONS);
  assertExtensions(getExtensionTypes(base.tlvData), CAPITAL_ALLOWED_EXTENSIONS);
  const hook = getTransferHook(quote);
  if (hook && !hook.programId.equals(PublicKey.default)) throw new Error("BUYBACK_MSTRX_HOOK_ACTIVE");
  if (getPausableConfig(quote)?.paused) throw new Error("BUYBACK_MSTRX_PAUSED");
  if (getDefaultAccountState(quote)?.state === AccountState.Frozen
    || getDefaultAccountState(base)?.state === AccountState.Frozen) {
    throw new Error("BUYBACK_MINT_DEFAULT_FROZEN");
  }
  // Explicitly reject Token-2022 CAPITAL powers that could defeat a voted
  // burn, lock or permanent hold even if they are currently inactive.
  if (baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    && [ExtensionType.PermanentDelegate, ExtensionType.TransferHook, ExtensionType.PausableConfig]
      .some((type) => getExtensionTypes(base.tlvData).includes(type))) {
    throw new Error("BUYBACK_CAPITAL_AUTHORITY_UNSAFE");
  }
}

function vaultBalance(account: AccountInfo<Buffer> | null, address: PublicKey,
  tokenProgram: PublicKey, mint: PublicKey, authority: PublicKey): bigint {
  if (!account?.owner.equals(tokenProgram) || account.executable) throw new Error("BUYBACK_VAULT_INVALID");
  const vault = unpackAccount(address, account, tokenProgram);
  if (!vault.isInitialized || vault.isFrozen || !vault.mint.equals(mint)
    || !vault.owner.equals(authority) || vault.delegate || vault.closeAuthority) {
    throw new Error("BUYBACK_VAULT_INVALID");
  }
  return vault.amount;
}

const positiveKey = (value: PublicKey, label: string) => {
  if (value.toBase58() === ZERO) throw new Error(`BUYBACK_${label}_INVALID`);
  return value;
};

/** Pure validation after the two RPC views have already agreed. */
export function inspectGovernanceBuybackAccounts(request: Omit<GovernanceBuybackVenueRequest, "rpcUrls">,
  accounts: GovernanceBuybackAccounts): InspectedGovernanceBuybackVenue {
  if (typeof request.frozenRawMstrx !== "bigint" || request.frozenRawMstrx <= 0n
    || request.frozenRawMstrx > MAX_U64) throw new Error("BUYBACK_FROZEN_AMOUNT_INVALID");
  const capital = canonical(request.capitalMint, "CAPITAL_MINT");
  const baseTokenProgram = canonical(request.capitalTokenProgram, "CAPITAL_PROGRAM");
  if (capital.equals(BUYBACK_QUOTE_MINT) || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
    .some((value) => value.equals(baseTokenProgram))) throw new Error("BUYBACK_CAPITAL_PROGRAM_INVALID");
  const addresses = governanceBuybackAddresses(capital, baseTokenProgram);
  executable(accounts, "pumpProgram");
  executable(accounts, "pumpSwapProgram");
  executable(accounts, "feeProgram");
  assertMintPolicy(accounts, capital, baseTokenProgram);
  const global = PUMP_SDK.decodeGlobal(required(accounts, "global", PUMP_BUYBACK_PROGRAM));
  const curve = PUMP_SDK.decodeBondingCurve(required(accounts, "curve", PUMP_BUYBACK_PROGRAM));
  if (!global.initialized || !curve.quoteMint.equals(BUYBACK_QUOTE_MINT)
    || curve.creator.equals(PublicKey.default)) throw new Error("BUYBACK_CURVE_IDENTITY_INVALID");
  if (curve.virtualTokenReserves.lten(0) || curve.virtualQuoteReserves.lten(0)) {
    throw new Error("BUYBACK_CURVE_RESERVES_INVALID");
  }
  const feeRecipient = positiveKey(curve.isMayhemMode ? global.reservedFeeRecipient : global.feeRecipient,
    "FEE_RECIPIENT");
  const buybackFeeRecipient = global.buybackFeeRecipients.find((value) => !value.equals(PublicKey.default));
  if (!buybackFeeRecipient) throw new Error("BUYBACK_BUYBACK_FEE_RECIPIENT_INVALID");
  const quoteBase = {
    frozenRawMstrx: request.frozenRawMstrx.toString(), quoteUnavailable: true as const,
    quoteStatus: "UNVERIFIED_EXACT_QUOTE_IN_FEE_AND_FULL_FILL" as const,
    expectedCapitalRaw: null, executionPermitted: false as const,
  };
  if (!curve.complete) {
    PUMP_SDK.decodeFeeConfig(required(accounts, "curveFeeConfig", PUMP_FEE_PROGRAM));
    const base = vaultBalance(accounts.curveBaseVault, addresses.curveBaseVault,
      baseTokenProgram, capital, addresses.curve);
    const quote = vaultBalance(accounts.curveQuoteVault, addresses.curveQuoteVault,
      TOKEN_2022_PROGRAM_ID, BUYBACK_QUOTE_MINT, addresses.curve);
    if (base === 0n || curve.realTokenReserves.lten(0)) throw new Error("BUYBACK_CURVE_LIQUIDITY_UNAVAILABLE");
    const venueState: BuybackVenueState = {
      phase: "curve", bondingCurveAddress: addresses.curve.toBase58(),
      bondingCurveOwner: PUMP_BUYBACK_PROGRAM.toBase58(), complete: false,
      curveBaseMint: capital.toBase58(), curveQuoteMint: BUYBACK_QUOTE_MINT.toBase58(),
      creator: curve.creator.toBase58(), feeRecipient: feeRecipient.toBase58(),
      buybackFeeRecipient: buybackFeeRecipient.toBase58(),
    };
    return { ...quoteBase, phase: "curve", venueState,
      venueBaseVaultRaw: base.toString(), venueQuoteVaultRaw: quote.toString(),
      virtualBaseReservesRaw: curve.virtualTokenReserves.toString(),
      virtualQuoteReservesRaw: curve.virtualQuoteReserves.toString(),
      creatorFeeBps: curve.creatorFeeBps.toString(), feeConfig: addresses.curveFeeConfig.toBase58() };
  }
  // A completed curve without the canonical index-0 pool is a migration gap,
  // not permission to use an arbitrary market or the old curve.
  const poolAccount = required(accounts, "pool", PUMPSWAP_BUYBACK_PROGRAM);
  const ammGlobal = PUMP_AMM_SDK.decodeGlobalConfig(required(accounts, "ammGlobal", PUMPSWAP_BUYBACK_PROGRAM));
  const pool = PUMP_AMM_SDK.decodePool(poolAccount);
  PUMP_AMM_SDK.decodeFeeConfig(required(accounts, "poolFeeConfig", PUMP_FEE_PROGRAM));
  if (pool.index !== 0 || !pool.creator.equals(addresses.poolAuthority)
    || !pool.baseMint.equals(capital) || !pool.quoteMint.equals(BUYBACK_QUOTE_MINT)
    || !pool.poolBaseTokenAccount.equals(addresses.poolBaseVault)
    || !pool.poolQuoteTokenAccount.equals(addresses.poolQuoteVault)) {
    throw new Error("BUYBACK_POOL_IDENTITY_INVALID");
  }
  const protocolFeeRecipient = ammGlobal.protocolFeeRecipients.find((value) => !value.equals(PublicKey.default));
  if (!protocolFeeRecipient) throw new Error("BUYBACK_PROTOCOL_FEE_RECIPIENT_INVALID");
  const base = vaultBalance(accounts.poolBaseVault, addresses.poolBaseVault,
    baseTokenProgram, capital, addresses.pool);
  const quote = vaultBalance(accounts.poolQuoteVault, addresses.poolQuoteVault,
    TOKEN_2022_PROGRAM_ID, BUYBACK_QUOTE_MINT, addresses.pool);
  if (base === 0n || quote === 0n || pool.virtualQuoteReserves.isNeg()) {
    throw new Error("BUYBACK_POOL_LIQUIDITY_UNAVAILABLE");
  }
  const venueState: BuybackVenueState = {
    phase: "pumpSwap", bondingCurveComplete: true, poolAddress: addresses.pool.toBase58(),
    poolOwner: PUMPSWAP_BUYBACK_PROGRAM.toBase58(), poolIndex: 0,
    poolCreator: addresses.poolAuthority.toBase58(), poolBaseMint: capital.toBase58(),
    poolQuoteMint: BUYBACK_QUOTE_MINT.toBase58(), coinCreator: pool.coinCreator.toBase58(),
    protocolFeeRecipient: protocolFeeRecipient.toBase58(),
  };
  return { ...quoteBase, phase: "pumpSwap", venueState,
    venueBaseVaultRaw: base.toString(), venueQuoteVaultRaw: quote.toString(),
    virtualBaseReservesRaw: null, virtualQuoteReservesRaw: pool.virtualQuoteReserves.toString(),
    creatorFeeBps: pool.creatorFeeBps.toString(), feeConfig: addresses.poolFeeConfig.toBase58() };
}

/** Network read only: no signer, transaction construction, simulation or send. */
export async function inspectGovernanceBuybackVenue(request: GovernanceBuybackVenueRequest) {
  if (request.rpcUrls.length !== 2) throw new Error("BUYBACK_TWO_RPC_URLS_REQUIRED");
  if (typeof request.frozenRawMstrx !== "bigint" || request.frozenRawMstrx <= 0n
    || request.frozenRawMstrx > MAX_U64) throw new Error("BUYBACK_FROZEN_AMOUNT_INVALID");
  const capital = canonical(request.capitalMint, "CAPITAL_MINT");
  const baseTokenProgram = canonical(request.capitalTokenProgram, "CAPITAL_PROGRAM");
  const addresses = governanceBuybackAddresses(capital, baseTokenProgram);
  const named: readonly [GovernanceBuybackAccountName, PublicKey][] = [
    ["curve", addresses.curve], ["global", addresses.global], ["pool", addresses.pool],
    ["ammGlobal", addresses.ammGlobal], ["capitalMint", capital], ["mstrxMint", BUYBACK_QUOTE_MINT],
    ["curveBaseVault", addresses.curveBaseVault], ["curveQuoteVault", addresses.curveQuoteVault],
    ["poolBaseVault", addresses.poolBaseVault], ["poolQuoteVault", addresses.poolQuoteVault],
    ["curveFeeConfig", addresses.curveFeeConfig], ["poolFeeConfig", addresses.poolFeeConfig],
    ["pumpProgram", PUMP_BUYBACK_PROGRAM], ["pumpSwapProgram", PUMPSWAP_BUYBACK_PROGRAM],
    ["feeProgram", PUMP_FEE_PROGRAM],
  ];
  const agreed = await finalizedConsensus(request.rpcUrls);
  const views = await Promise.all(request.rpcUrls.map(async (url): Promise<GovernanceBuybackView> => {
    const response = await new Connection(url, "finalized").getMultipleAccountsInfoAndContext(
      named.map(([, address]) => address), { commitment: "finalized", minContextSlot: agreed.slot });
    if (response.context.slot < agreed.slot) {
      throw new Error("BUYBACK_RPC_CONTEXT_STALE");
    }
    return { slot: response.context.slot, accounts: Object.fromEntries(named.map(([name], index) =>
      [name, response.value[index] ?? null])) as GovernanceBuybackAccounts };
  }));
  assertMatchingGovernanceBuybackViews(views);
  return { ...inspectGovernanceBuybackAccounts(request, views[0].accounts),
    finalizedBlockSlot: agreed.slot, finalizedBlockhash: agreed.blockhash,
    accountContextSlots: [views[0].slot, views[1].slot] as const,
    observedAtUnix: Math.floor(Date.now() / 1_000),
  };
}
