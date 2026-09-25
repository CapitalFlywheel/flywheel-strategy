import { AccountInfo, Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { sha256 as streamingSha256 } from "@noble/hashes/sha256";

const ACCOUNT_CONFIG = "account:Config";
const ACCOUNT_PROPOSAL = "account:Proposal";
const ACCOUNT_VOTE_RECORD = "account:VoteRecord";
const ACCOUNT_LOCK_RECORD = "account:LockRecord";
const ACCOUNT_BUYBACK_RECEIPT = "account:BuybackExecutionReceipt";
const ACCOUNT_MARKETING_RECEIPT = "account:MarketingSaleReceipt";
const CAST_VOTE = "global:cast_vote";
const LEAF_DOMAIN = "flywheel-solana-governance-leaf-v1\0";
const NODE_DOMAIN = "flywheel-solana-governance-node-v1\0";
const ROOT_DOMAIN = "flywheel-solana-governance-root-v1\0";
const NETWORK_DOMAIN = "solana-mainnet-beta\0";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const TEST_ONLY_PROGRAM = "3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh";
const OFFICIAL_MSTRX_MINT = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_SWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const MARKETING_POOL = "2ngTuP7xA581dqX9uJkGRqxmKuehY3k4SDfPebeoRG2J";
export const MARKETING_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const ACCOUNT_SCHEMA_VERSION = 3;
const ACTIONS = ["ACCUMULATE", "BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "LOCK_MSTRX", "MARKETING_SALE"] as const;
// A signed vote must never elect an action without a reviewed, released
// executor. The entire ballot stays locked until every listed action is safe.
const EXECUTOR_ACTIONS_RELEASED: ReadonlySet<typeof ACTIONS[number]> = new Set();
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const MIN_PUBLIC_REVIEW_SECONDS = 86_400;
const MAX_PUBLIC_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PUBLIC_MANIFEST_BYTES = 16 * 1024;
const MAX_PUBLIC_SOURCE_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_FETCH_TIMEOUT_MS = 10_000;
const SOURCE_FETCH_TIMEOUT_MS = 30_000;

export interface GovernancePublicConfig {
  network: "solana-mainnet-beta";
  projectMint: string;
  mstrxMint: string;
  governanceProgram?: string;
  governanceProgramCodeSha256?: string;
  governanceAccountSchemaVersion?: number;
}

export interface OnchainGovernanceConfig {
  schemaVersion: number;
  admin: string;
  capitalMint: string;
  capitalTokenProgram: string;
  reserveMint: string;
  reserveVault: string;
  marketingWallet: string;
  launchedAt: number;
  launchSlot: bigint;
  launchSignatureHex: string;
  lastProposalId: bigint;
  activeProposalId: bigint;
  committedReserveRawMstrx: bigint;
  bump: number;
}

export interface OnchainGovernanceOption {
  action: typeof ACTIONS[number];
  lockDurationSeconds: number;
  recipient: string;
  reserveRawMstrx: bigint;
  /** CAPITAL raw units for buybacks, lamports for marketing sales. */
  minOutputRaw: bigint;
}

export interface OnchainGovernanceProposal {
  schemaVersion: number;
  address: string;
  config: string;
  capitalMint: string;
  reserveVault: string;
  id: bigint;
  startsAt: number;
  endsAt: number;
  executableAt: number;
  windowStart: number;
  windowEnd: number;
  finalizedThroughSlot: bigint;
  finalizedBlockhash: string;
  exclusionsHash: string;
  merkleRoot: string;
  leafCount: bigint;
  totalAvailableWeight: bigint;
  frozenReserveRawMstrx: bigint;
  options: OnchainGovernanceOption[];
  optionWeights: bigint[];
  totalCast: bigint;
  status: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  winningOption: number;
  bump: number;
}

export interface GovernanceManifest {
  version: 2;
  network: "solana-mainnet-beta";
  proposalId: string;
  /** Operator-declared first-publication time; the onchain delayed start is independently checkable. */
  publishedAtUnix: number;
  merkleRoot: string;
  totalAvailableWeight: string;
  sourceSha256: string;
  snapshotSha256: string;
  source: string;
  snapshot: string;
}

export interface GovernanceWalletProof {
  version: 1;
  proposalId: string;
  account: string;
  weight: string;
  proof: string[];
  merkleRoot: string;
}

export interface GovernanceVoteRecord {
  proposal: string;
  voter: string;
  optionIndex: number;
  weight: bigint;
  bump: number;
}

export interface GovernanceLockRecord {
  proposal: string;
  config: string;
  reserveVault: string;
  escrowVault: string;
  amount: bigint;
  lockedAt: number;
  releaseAt: number;
  durationSeconds: number;
  status: 0 | 1;
  bump: number;
}

export interface VerifiedGovernanceLock {
  address: PublicKey;
  escrowAddress: PublicKey;
  record: GovernanceLockRecord;
  escrowBalanceRawMstrx: bigint;
  state: "ACTIVE" | "MATURED_AWAITING_RELEASE" | "RELEASED";
}

export interface VerifiedGovernanceExecutionReceipt {
  address: PublicKey;
  kind: "BUYBACK" | "MARKETING_SALE";
  action: OnchainGovernanceOption["action"];
  inputRawMstrx: bigint;
  votedMinOutputRaw: bigint;
  actualOutputRaw: bigint;
  executedAt: number;
  destination: string;
  venue: string;
  lockReleaseAt?: number;
  lockReleasedAt?: number;
}

export interface VerifiedGovernance {
  programId: PublicKey;
  configAddress: PublicKey;
  config: OnchainGovernanceConfig;
  proposalAddress: PublicKey;
  proposal: OnchainGovernanceProposal;
  manifest: GovernanceManifest;
  upgradeAuthority: string;
  programCodeSha256: string;
  vaultBalanceRawMstrx: bigint;
  committedReserveRawMstrx: bigint;
  freeReserveRawMstrx: bigint;
  capitalDecimals: number;
  custodyVerifiedForProposal: boolean;
  lock?: VerifiedGovernanceLock;
  executionReceipt?: VerifiedGovernanceExecutionReceipt;
  accountSnapshotSlot: number;
  chainTime: number;
}

function utf8(value: string) { return new TextEncoder().encode(value); }

function joinBytes(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

async function sha256(...parts: Uint8Array[]) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joinBytes(...parts)));
}

function hex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function fromHex(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("GOVERNANCE_HASH_INVALID");
  return Uint8Array.from(value.match(/.{2}/g)!, (part) => Number.parseInt(part, 16));
}

function uintLE(value: bigint, bytes: 8 | 16) {
  if (value < 0n || value > (bytes === 8 ? MAX_U64 : MAX_U128)) throw new Error("GOVERNANCE_INTEGER_RANGE");
  const out = new Uint8Array(bytes);
  let remaining = value;
  for (let index = 0; index < bytes; index += 1) { out[index] = Number(remaining & 255n); remaining >>= 8n; }
  return out;
}

export function formatRawTokenExact(raw: bigint, decimals: number) {
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("GOVERNANCE_RAW_AMOUNT_INVALID");
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const decimal = decimals === 0 ? "" : (raw % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return decimal ? `${whole}.${decimal}` : whole.toString();
}

export function formatMstrxExact(raw: bigint) {
  return formatRawTokenExact(raw, 8);
}

function exactKey(value: string) {
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new Error("GOVERNANCE_ADDRESS_INVALID");
  return key;
}

class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) throw new Error("GOVERNANCE_ACCOUNT_TRUNCATED");
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  u8() { return this.take(1)[0]; }
  u32() { const value = this.take(4); return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true); }
  u64() { const value = this.take(8); return new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0, true); }
  u128() { return this.u64() | this.u64() << 64n; }
  i64() {
    const value = this.take(8);
    const number = Number(new DataView(value.buffer, value.byteOffset, 8).getBigInt64(0, true));
    if (!Number.isSafeInteger(number)) throw new Error("GOVERNANCE_TIME_RANGE");
    return number;
  }
  key() { return new PublicKey(this.take(32)).toBase58(); }
  hash() { return hex(this.take(32)); }
  trailingZerosOnly() {
    if (this.data.subarray(this.offset).some((byte) => byte !== 0)) throw new Error("GOVERNANCE_ACCOUNT_TRAILING_DATA");
  }
}

async function readerFor(info: AccountInfo<Buffer>, name: string) {
  const reader = new Reader(info.data);
  const discriminator = await sha256(utf8(name));
  if (hex(reader.take(8)) !== hex(discriminator.subarray(0, 8))) throw new Error("GOVERNANCE_ACCOUNT_DISCRIMINATOR");
  return reader;
}

export async function parseGovernanceConfig(info: AccountInfo<Buffer>): Promise<OnchainGovernanceConfig> {
  const reader = await readerFor(info, ACCOUNT_CONFIG);
  const schemaVersion = reader.u8();
  if (schemaVersion !== ACCOUNT_SCHEMA_VERSION) throw new Error("GOVERNANCE_ACCOUNT_SCHEMA_MISMATCH");
  const config = {
    schemaVersion,
    admin: reader.key(), capitalMint: reader.key(), capitalTokenProgram: reader.key(),
    reserveMint: reader.key(), reserveVault: reader.key(), marketingWallet: reader.key(),
    launchedAt: reader.i64(), launchSlot: reader.u64(), launchSignatureHex: hex(reader.take(64)),
    lastProposalId: reader.u64(), activeProposalId: reader.u64(),
    committedReserveRawMstrx: reader.u64(), bump: reader.u8(),
  };
  reader.trailingZerosOnly();
  return config;
}

export async function parseGovernanceProposal(address: string, info: AccountInfo<Buffer>): Promise<OnchainGovernanceProposal> {
  const reader = await readerFor(info, ACCOUNT_PROPOSAL);
  const schemaVersion = reader.u8();
  if (schemaVersion !== ACCOUNT_SCHEMA_VERSION) throw new Error("GOVERNANCE_ACCOUNT_SCHEMA_MISMATCH");
  const base = {
    schemaVersion, address, config: reader.key(), capitalMint: reader.key(), reserveVault: reader.key(), id: reader.u64(),
    startsAt: reader.i64(), endsAt: reader.i64(), executableAt: reader.i64(),
    windowStart: reader.i64(), windowEnd: reader.i64(), finalizedThroughSlot: reader.u64(),
    finalizedBlockhash: new PublicKey(reader.take(32)).toBase58(), exclusionsHash: reader.hash(), merkleRoot: reader.hash(),
    leafCount: reader.u64(), totalAvailableWeight: reader.u128(), frozenReserveRawMstrx: reader.u64(),
  };
  const count = reader.u32();
  if (count < 2 || count > 6) throw new Error("GOVERNANCE_OPTIONS_INVALID");
  const options = Array.from({ length: count }, (): OnchainGovernanceOption => {
    const actionIndex = reader.u8();
    if (actionIndex >= ACTIONS.length) throw new Error("GOVERNANCE_ACTION_INVALID");
    return { action: ACTIONS[actionIndex], lockDurationSeconds: reader.u32(), recipient: reader.key(), reserveRawMstrx: reader.u64(), minOutputRaw: reader.u64() };
  });
  if (options.some((option) => ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "MARKETING_SALE"].includes(option.action)
    ? option.minOutputRaw === 0n : option.minOutputRaw !== 0n)) throw new Error("GOVERNANCE_OPTION_POLICY_MISMATCH");
  const allOptionWeights = Array.from({ length: 6 }, () => reader.u128());
  const optionWeights = allOptionWeights.slice(0, count);
  const totalCast = reader.u128();
  const status = reader.u8();
  const winningOption = reader.u8();
  const bump = reader.u8();
  reader.trailingZerosOnly();
  // A superseded ballot may have been a passed decision (winner present) or
  // a failed re-vote (no winner). Its tally must still support that outcome.
  const hasWinner = winningOption < count;
  const noWinner = winningOption === 255;
  if (status > 8 || allOptionWeights.slice(count).some((weight) => weight !== 0n)
    || optionWeights.reduce((sum, weight) => sum + weight, 0n) !== totalCast
    || totalCast > base.totalAvailableWeight || !options.some((option) => option.action === "ACCUMULATE")
    || new Set(options.map((option) => option.action)).size !== options.length
    || ([1, 4].includes(status) && !hasWinner)
    || (status === 5 && !hasWinner && !noWinner)
    || (![1, 4, 5].includes(status) && !noWinner)) {
    throw new Error("GOVERNANCE_PROPOSAL_STATE_INVALID");
  }
  const quorum = (base.totalAvailableWeight * 700n + 9_999n) / 10_000n;
  const maximum = optionWeights.reduce((largest, weight) => weight > largest ? weight : largest, 0n);
  const leaders = optionWeights.flatMap((weight, index) => weight === maximum ? [index] : []);
  const decisiveWinner = totalCast >= quorum && leaders.length === 1;
  if ((([1, 4].includes(status) || status === 5 && hasWinner)
      && (!decisiveWinner || leaders[0] !== winningOption))
    || (status === 5 && noWinner && decisiveWinner)
    || ([2, 7].includes(status) && totalCast >= quorum)
    || ([3, 8].includes(status) && (totalCast < quorum || leaders.length < 2))
    || ([0, 6].includes(status) && (totalCast !== optionWeights.reduce((sum, weight) => sum + weight, 0n)))) {
    throw new Error("GOVERNANCE_RESULT_MISMATCH");
  }
  return { ...base, options, optionWeights, totalCast, status: status as OnchainGovernanceProposal["status"], winningOption, bump };
}

export async function parseGovernanceVoteRecord(info: AccountInfo<Buffer>): Promise<GovernanceVoteRecord> {
  const reader = await readerFor(info, ACCOUNT_VOTE_RECORD);
  const record = { proposal: reader.key(), voter: reader.key(), optionIndex: reader.u8(), weight: reader.u128(), bump: reader.u8() };
  reader.trailingZerosOnly();
  return record;
}

export async function parseGovernanceLockRecord(info: AccountInfo<Buffer>): Promise<GovernanceLockRecord> {
  const reader = await readerFor(info, ACCOUNT_LOCK_RECORD);
  const record = {
    proposal: reader.key(), config: reader.key(), reserveVault: reader.key(), escrowVault: reader.key(),
    amount: reader.u64(), lockedAt: reader.i64(), releaseAt: reader.i64(), durationSeconds: reader.u32(),
    status: reader.u8(), bump: reader.u8(),
  };
  reader.trailingZerosOnly();
  if (record.status !== 0 && record.status !== 1) throw new Error("GOVERNANCE_LOCK_STATUS_INVALID");
  return { ...record, status: record.status as 0 | 1 };
}

export function governanceAddresses(programId: PublicKey, id: bigint, voter?: PublicKey) {
  const [config] = PublicKey.findProgramAddressSync([utf8("config")], programId);
  const [proposal] = PublicKey.findProgramAddressSync([utf8("proposal"), uintLE(id, 8)], programId);
  const voteRecord = voter ? PublicKey.findProgramAddressSync([utf8("vote"), proposal.toBytes(), voter.toBytes()], programId)[0] : undefined;
  return { config, proposal, voteRecord };
}

export function governanceLockAddresses(programId: PublicKey, proposalAddress: PublicKey, mstrxMint: PublicKey) {
  const [record, bump] = PublicKey.findProgramAddressSync([utf8("reserve-lock"), proposalAddress.toBytes()], programId);
  const escrow = getAssociatedTokenAddressSync(mstrxMint, record, true, TOKEN_2022_PROGRAM_ID);
  return { record, escrow, bump };
}

export function governanceExecutionReceiptAddresses(programId: PublicKey, proposalAddress: PublicKey) {
  const [buyback, buybackBump] = PublicKey.findProgramAddressSync([utf8("buyback-receipt"), proposalAddress.toBytes()], programId);
  const [marketing, marketingBump] = PublicKey.findProgramAddressSync([utf8("marketing-sale-receipt"), proposalAddress.toBytes()], programId);
  return { buyback, buybackBump, marketing, marketingBump };
}

/** A status byte is not proof of a swap or destination custody. Receipt PDAs
 * are unique per proposal and are initialized atomically with execution by
 * the reviewed program. Validate their complete durable record at finality. */
export async function inspectGovernanceExecutionReceipt(programId: PublicKey, configAddress: PublicKey,
  config: OnchainGovernanceConfig, proposalAddress: PublicKey, proposal: OnchainGovernanceProposal,
  buybackInfo: AccountInfo<Buffer> | null, marketingInfo: AccountInfo<Buffer> | null,
  chainTime: number): Promise<VerifiedGovernanceExecutionReceipt | undefined> {
  const action = proposal.options[proposal.winningOption]?.action;
  const { buyback, buybackBump, marketing, marketingBump } = governanceExecutionReceiptAddresses(programId, proposalAddress);
  const needsBuyback = proposal.status === 4 && ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK"].includes(action);
  const needsMarketing = proposal.status === 4 && action === "MARKETING_SALE";
  if (!Number.isSafeInteger(chainTime) || (proposal.status === 4 && chainTime < proposal.executableAt)
    || (buybackInfo !== null) !== needsBuyback || (marketingInfo !== null) !== needsMarketing) {
    throw new Error("GOVERNANCE_EXECUTION_RECEIPT_STATE_MISMATCH");
  }
  if (!needsBuyback && !needsMarketing) return undefined;
  const option = proposal.options[proposal.winningOption];
  if (needsBuyback) {
    const info = requireAccount(buybackInfo, programId);
    if (info.executable || info.data.length !== 335) throw new Error("GOVERNANCE_BUYBACK_RECEIPT_LAYOUT_INVALID");
    const reader = await readerFor(info, ACCOUNT_BUYBACK_RECEIPT);
    const schema = reader.u8();
    const identity = [reader.key(), reader.key(), reader.key(), reader.key(), reader.key()];
    const venueProgram = reader.key();
    const venueAccount = reader.key();
    const destination = reader.key();
    const actionIndex = reader.u8();
    const input = reader.u64();
    const votedMin = reader.u64();
    const acquired = reader.u64();
    const supplyBefore = reader.u64();
    const supplyAfter = reader.u64();
    const executedAt = reader.i64();
    const lockReleaseAt = reader.i64();
    const lockReleasedAt = reader.i64();
    const duration = reader.u32();
    const bump = reader.u8();
    if (reader.offset !== info.data.length) throw new Error("GOVERNANCE_BUYBACK_RECEIPT_LAYOUT_INVALID");
    const trader = PublicKey.findProgramAddressSync([utf8("proposal-trader")], programId)[0].toBase58();
    const hold = PublicKey.findProgramAddressSync([utf8("capital-hold")], programId)[0];
    const capital = exactKey(config.capitalMint);
    const tokenProgram = exactKey(config.capitalTokenProgram);
    const expectedDestination = action === "BUYBACK_HOLD"
      ? getAssociatedTokenAddressSync(capital, hold, true, tokenProgram).toBase58()
      : action === "BUYBACK_LOCK"
        ? getAssociatedTokenAddressSync(capital, buyback, true, tokenProgram).toBase58()
        : SystemProgram.programId.toBase58();
    const pumpCurve = PublicKey.findProgramAddressSync([utf8("bonding-curve"), capital.toBytes()], PUMP_PROGRAM)[0].toBase58();
    const validVenue = venueProgram === PUMP_PROGRAM.toBase58() ? venueAccount === pumpCurve
      : venueProgram === PUMP_SWAP_PROGRAM.toBase58() && venueAccount !== SystemProgram.programId.toBase58();
    const validSupply = action === "BUYBACK_BURN"
      ? supplyBefore >= acquired && supplyAfter === supplyBefore - acquired
      : supplyAfter === supplyBefore;
    const validLock = action === "BUYBACK_LOCK"
      ? duration === option.lockDurationSeconds
        && lockReleaseAt === (duration === 0xffffffff ? 0 : executedAt + duration)
        && (lockReleasedAt === 0 || duration !== 0xffffffff && lockReleasedAt >= lockReleaseAt && lockReleasedAt <= chainTime)
      : duration === 0 && lockReleaseAt === 0 && lockReleasedAt === 0;
    if (schema !== ACCOUNT_SCHEMA_VERSION
      || identity[0] !== proposalAddress.toBase58() || identity[1] !== configAddress.toBase58()
      || identity[2] !== config.capitalMint || identity[3] !== config.reserveVault || identity[4] !== trader
      || !validVenue || destination !== expectedDestination || actionIndex !== ACTIONS.indexOf(action)
      || input !== proposal.frozenReserveRawMstrx || input !== option.reserveRawMstrx || input === 0n
      || votedMin !== option.minOutputRaw || votedMin === 0n || acquired < votedMin
      || !validSupply || !validLock || executedAt < proposal.executableAt || executedAt > chainTime
      || bump !== buybackBump) throw new Error("GOVERNANCE_BUYBACK_RECEIPT_MISMATCH");
    return { address: buyback, kind: "BUYBACK", action, inputRawMstrx: input, votedMinOutputRaw: votedMin,
      actualOutputRaw: acquired, executedAt, destination, venue: venueAccount, lockReleaseAt, lockReleasedAt };
  }
  const info = requireAccount(marketingInfo, programId);
  if (info.executable || info.data.length !== 251) throw new Error("GOVERNANCE_MARKETING_RECEIPT_LAYOUT_INVALID");
  const reader = await readerFor(info, ACCOUNT_MARKETING_RECEIPT);
  const schema = reader.u8();
  const actionIndex = reader.u8();
  const identity = [reader.key(), reader.key(), reader.key(), reader.key(), reader.key(), reader.key()];
  const input = reader.u64();
  const votedMin = reader.u64();
  const executionMin = reader.u64();
  const actual = reader.u64();
  reader.u64(); // WSOL ATA rent returned to the clean trader, not sale proceeds
  const executedAt = reader.i64();
  const bump = reader.u8();
  if (reader.offset !== info.data.length) throw new Error("GOVERNANCE_MARKETING_RECEIPT_LAYOUT_INVALID");
  if (schema !== ACCOUNT_SCHEMA_VERSION || actionIndex !== ACTIONS.indexOf("MARKETING_SALE")
    || identity[0] !== proposalAddress.toBase58() || identity[1] !== configAddress.toBase58()
    || identity[2] !== config.reserveMint || identity[3] !== config.reserveVault
    || identity[4] !== config.marketingWallet || identity[4] !== option.recipient || identity[5] !== MARKETING_POOL
    || input !== proposal.frozenReserveRawMstrx || input !== option.reserveRawMstrx || input === 0n
    || votedMin !== option.minOutputRaw || votedMin === 0n || executionMin < votedMin || actual < executionMin
    || executedAt < proposal.executableAt || executedAt > chainTime || bump !== marketingBump) {
    throw new Error("GOVERNANCE_MARKETING_RECEIPT_MISMATCH");
  }
  return { address: marketing, kind: "MARKETING_SALE", action, inputRawMstrx: input,
    votedMinOutputRaw: votedMin, actualOutputRaw: actual, executedAt,
    destination: identity[4], venue: identity[5] };
}

function requireAccount(info: AccountInfo<Buffer> | null, owner: PublicKey) {
  if (!info || !info.owner.equals(owner)) throw new Error("GOVERNANCE_ONCHAIN_ACCOUNT_MISSING");
  return info;
}

export function inspectGovernanceVault(configAddress: PublicKey, onchainConfig: OnchainGovernanceConfig,
  mint: PublicKey, vaultInfo: AccountInfo<Buffer> | null) {
  const reserveVaultAddress = exactKey(onchainConfig.reserveVault);
  const expectedVault = getAssociatedTokenAddressSync(mint, configAddress, true, TOKEN_2022_PROGRAM_ID);
  if (!reserveVaultAddress.equals(expectedVault)) throw new Error("GOVERNANCE_RESERVE_VAULT_ADDRESS_MISMATCH");
  const vault = unpackAccount(reserveVaultAddress, requireAccount(vaultInfo, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  if (!vault.isInitialized || vault.isFrozen || !vault.mint.equals(mint) || !vault.owner.equals(configAddress)
    || vault.delegate !== null || vault.closeAuthority !== null
    || vault.amount < onchainConfig.committedReserveRawMstrx) throw new Error("GOVERNANCE_RESERVE_VAULT_INVALID");
  return { address: reserveVaultAddress, balance: vault.amount,
    free: vault.amount - onchainConfig.committedReserveRawMstrx };
}

export async function inspectGovernanceLock(programId: PublicKey, configAddress: PublicKey,
  onchainConfig: OnchainGovernanceConfig, proposalAddress: PublicKey, proposal: OnchainGovernanceProposal,
  mstrxMint: PublicKey, recordInfo: AccountInfo<Buffer> | null, escrowInfo: AccountInfo<Buffer> | null,
  chainTime: number): Promise<VerifiedGovernanceLock> {
  if (proposal.status !== 4 || proposal.options[proposal.winningOption]?.action !== "LOCK_MSTRX") {
    throw new Error("GOVERNANCE_EXECUTED_ACTION_INVALID");
  }
  const { record: address, escrow: escrowAddress, bump } = governanceLockAddresses(programId, proposalAddress, mstrxMint);
  const record = await parseGovernanceLockRecord(requireAccount(recordInfo, programId));
  const duration = proposal.options[proposal.winningOption].lockDurationSeconds;
  const permanent = duration === 0xffffffff;
  const expectedReleaseAt = permanent ? 0 : record.lockedAt + duration;
  if (!Number.isSafeInteger(chainTime) || !Number.isSafeInteger(expectedReleaseAt)
    || record.proposal !== proposalAddress.toBase58() || record.config !== configAddress.toBase58()
    || record.reserveVault !== onchainConfig.reserveVault || record.escrowVault !== escrowAddress.toBase58()
    || record.amount !== proposal.frozenReserveRawMstrx || record.amount === 0n
    || record.lockedAt < proposal.executableAt || record.lockedAt > chainTime
    || record.releaseAt !== expectedReleaseAt || record.durationSeconds !== duration
    || record.bump !== bump || (record.status === 1 && (permanent || record.releaseAt > chainTime))) {
    throw new Error("GOVERNANCE_LOCK_RECORD_MISMATCH");
  }
  const escrow = unpackAccount(escrowAddress, requireAccount(escrowInfo, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  if (!escrow.isInitialized || !escrow.mint.equals(mstrxMint) || !escrow.owner.equals(address)
    || escrow.delegate !== null || escrow.closeAuthority !== null
    || (record.status === 0 && (escrow.isFrozen || escrow.amount < record.amount))
    || (record.status === 1 && escrow.amount !== 0n)) {
    throw new Error("GOVERNANCE_LOCK_ESCROW_INVALID");
  }
  return { address, escrowAddress, record, escrowBalanceRawMstrx: escrow.amount,
    state: record.status === 1 ? "RELEASED"
      : !permanent && chainTime >= record.releaseAt ? "MATURED_AWAITING_RELEASE" : "ACTIVE" };
}

function assertManifest(value: unknown, proposal: OnchainGovernanceProposal, id: bigint): GovernanceManifest {
  const manifest = value as GovernanceManifest;
  const base = `governance/proposals/${id}`;
  if (!manifest || manifest.version !== 2 || manifest.network !== "solana-mainnet-beta"
    || manifest.proposalId !== id.toString() || manifest.merkleRoot !== proposal.merkleRoot
    || manifest.totalAvailableWeight !== proposal.totalAvailableWeight.toString()
    || !Number.isSafeInteger(manifest.publishedAtUnix) || manifest.publishedAtUnix <= 0
    || manifest.publishedAtUnix < proposal.windowEnd
    || manifest.publishedAtUnix > proposal.startsAt
    // Only an active initial ballot (status 0) has a 24-hour review window.
    // Re-votes open at creation; after finalization status alone cannot show
    // whether a ballot was initial or a re-vote.
    || (proposal.status === 0
      && proposal.startsAt - manifest.publishedAtUnix < MIN_PUBLIC_REVIEW_SECONDS)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.snapshotSha256)
    || manifest.source !== `${base}/source.json` || manifest.snapshot !== `${base}/snapshot.json`) {
    throw new Error("GOVERNANCE_PUBLISHED_SNAPSHOT_MISMATCH");
  }
  return manifest;
}

/** Hash the exact published bytes, then bind public metadata and weights to the onchain proposal. */
export async function verifyGovernanceSnapshotArtifact(bytes: Uint8Array, manifest: GovernanceManifest,
  proposal: OnchainGovernanceProposal, programId: PublicKey) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PUBLIC_SNAPSHOT_BYTES
    || hex(await sha256(bytes)) !== manifest.snapshotSha256) throw new Error("GOVERNANCE_SNAPSHOT_CHECKSUM_MISMATCH");
  let value: Record<string, unknown>;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>; }
  catch { throw new Error("GOVERNANCE_SNAPSHOT_JSON_INVALID"); }
  if (!value || value.version !== 1 || value.network !== "solana-mainnet-beta"
    || value.governanceProgram !== programId.toBase58() || value.proposalId !== proposal.id.toString()
    || value.capitalMint !== proposal.capitalMint || value.windowStart !== proposal.windowStart
    || value.windowEnd !== proposal.windowEnd || value.finalizedThroughSlot !== Number(proposal.finalizedThroughSlot)
    || value.finalizedBlockhash !== proposal.finalizedBlockhash || value.exclusionsHash !== proposal.exclusionsHash
    || value.merkleRoot !== proposal.merkleRoot || value.totalAvailableWeight !== proposal.totalAvailableWeight.toString()
    || value.leafCount !== Number(proposal.leafCount) || !Array.isArray(value.entries)
    || value.entries.length !== Number(proposal.leafCount)) throw new Error("GOVERNANCE_SNAPSHOT_CONTENT_MISMATCH");
  let total = 0n;
  let previous: Uint8Array | undefined;
  for (const entry of value.entries as Record<string, unknown>[]) {
    if (!entry || typeof entry.account !== "string" || typeof entry.weight !== "string"
      || !/^[1-9]\d*$/.test(entry.weight) || !Array.isArray(entry.proof)
      || entry.proof.some((piece) => typeof piece !== "string" || !/^[a-f0-9]{64}$/.test(piece))) {
      throw new Error("GOVERNANCE_SNAPSHOT_CONTENT_MISMATCH");
    }
    const address = exactKey(entry.account).toBytes();
    if (previous && (hex(previous) >= hex(address))) throw new Error("GOVERNANCE_SNAPSHOT_CONTENT_MISMATCH");
    previous = address;
    total += BigInt(entry.weight);
    if (total > proposal.totalAvailableWeight) throw new Error("GOVERNANCE_SNAPSHOT_CONTENT_MISMATCH");
  }
  if (total !== proposal.totalAvailableWeight) throw new Error("GOVERNANCE_SNAPSHOT_CONTENT_MISMATCH");
}

async function fetchBoundedPublicArtifact(path: string, maxBytes: number) {
  // Only the canonical same-origin path constructed from a checked proposal ID
  // may reach this function. Do not accept absolute, user-supplied or redirect URLs.
  if (!/^\/governance\/proposals\/[1-9]\d*\/(?:manifest|snapshot)\.json$/.test(path)) {
    throw new Error("GOVERNANCE_SNAPSHOT_PATH_INVALID");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(path, { cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error("GOVERNANCE_PUBLISHED_SNAPSHOT_MISSING");
    const sizeHeader = response.headers.get("content-length");
    if (sizeHeader && (!/^\d+$/.test(sizeHeader) || Number(sizeHeader) > maxBytes)) {
      throw new Error("GOVERNANCE_SNAPSHOT_TOO_LARGE");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("GOVERNANCE_SNAPSHOT_TOO_LARGE");
      }
      chunks.push(value);
    }
    return joinBytes(...chunks);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("GOVERNANCE_SNAPSHOT_FETCH_TIMEOUT");
    throw error;
  } finally { clearTimeout(timer); }
}

/** Verify the source file without decoding it or retaining its bytes in browser memory. */
export async function verifyGovernanceSourceArtifact(path: string, expectedSha256: string) {
  if (!/^\/governance\/proposals\/[1-9]\d*\/source\.json$/.test(path)
    || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("GOVERNANCE_SOURCE_PATH_INVALID");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(path, { cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error("GOVERNANCE_PUBLISHED_SOURCE_MISSING");
    const declaredSize = response.headers.get("content-length");
    if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_PUBLIC_SOURCE_BYTES)) {
      throw new Error("GOVERNANCE_SOURCE_TOO_LARGE");
    }
    const hash = streamingSha256.create();
    reader = response.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PUBLIC_SOURCE_BYTES) throw new Error("GOVERNANCE_SOURCE_TOO_LARGE");
      hash.update(value);
    }
    if (size === 0 || hex(hash.digest()) !== expectedSha256) {
      throw new Error("GOVERNANCE_SOURCE_CHECKSUM_MISMATCH");
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("GOVERNANCE_SOURCE_FETCH_TIMEOUT");
    throw error;
  } finally {
    await reader?.cancel().catch(() => undefined);
    clearTimeout(timer);
  }
}

export async function loadVerifiedGovernance(connection: Connection, config: GovernancePublicConfig, requestedId?: bigint): Promise<VerifiedGovernance | undefined> {
  if (config.network !== "solana-mainnet-beta" || !config.governanceProgram) return undefined;
  if (config.governanceAccountSchemaVersion !== ACCOUNT_SCHEMA_VERSION) throw new Error("GOVERNANCE_WEB_SCHEMA_UNSUPPORTED");
  if (!/^[a-f0-9]{64}$/.test(config.governanceProgramCodeSha256 ?? "")) throw new Error("GOVERNANCE_REVIEWED_PROGRAM_HASH_MISSING");
  if (config.mstrxMint !== OFFICIAL_MSTRX_MINT) throw new Error("GOVERNANCE_MSTRX_MINT_MISMATCH");
  const programId = exactKey(config.governanceProgram);
  if (programId.toBase58() === TEST_ONLY_PROGRAM) throw new Error("GOVERNANCE_TEST_PROGRAM_NOT_DEPLOYABLE");
  const [configAddress] = PublicKey.findProgramAddressSync([utf8("config")], programId);
  // An initial read supplies the dynamic proposal ID. No money/custody claim
  // is made from it: the program, config, both mints, vault, proposal, and any
  // lock record + escrow are fetched together from one finalized bank below.
  const initialConfig = await parseGovernanceConfig(requireAccount(
    await connection.getAccountInfo(configAddress, "finalized"), programId));
  const id = requestedId ?? (initialConfig.activeProposalId || initialConfig.lastProposalId);
  if (id < 0n || id > MAX_U64) throw new Error("GOVERNANCE_PROPOSAL_ID_INVALID");
  const mstrxMint = exactKey(config.mstrxMint);
  const capitalMintAddress = exactKey(config.projectMint);
  const canonicalVault = getAssociatedTokenAddressSync(mstrxMint, configAddress, true, TOKEN_2022_PROGRAM_ID);
  const proposalAddress = id ? governanceAddresses(programId, id).proposal : undefined;
  const lockAddresses = proposalAddress ? governanceLockAddresses(programId, proposalAddress, mstrxMint) : undefined;
  const receiptAddresses = proposalAddress ? governanceExecutionReceiptAddresses(programId, proposalAddress) : undefined;
  const addresses = [programId, configAddress, mstrxMint, capitalMintAddress, canonicalVault];
  if (proposalAddress && lockAddresses) addresses.push(proposalAddress, lockAddresses.record, lockAddresses.escrow);
  if (receiptAddresses) addresses.push(receiptAddresses.buyback, receiptAddresses.marketing);
  const snapshot = await connection.getMultipleAccountsInfoAndContext(addresses, "finalized");
  if (!Number.isSafeInteger(snapshot.context.slot) || snapshot.context.slot <= 0
    || snapshot.value.length !== addresses.length) throw new Error("GOVERNANCE_FINALIZED_SNAPSHOT_INVALID");
  const [program, configInfo, reserveMintInfo, capitalMintInfo, vaultInfo, proposalInfo, lockRecordInfo, lockEscrowInfo,
    buybackReceiptInfo, marketingReceiptInfo] = snapshot.value;
  if (!program || !program.executable || !program.owner.equals(LOADER)) throw new Error("GOVERNANCE_PROGRAM_NOT_VERIFIED");
  const programReader = new Reader(program.data);
  if (programReader.u32() !== 2) throw new Error("GOVERNANCE_PROGRAM_NOT_UPGRADEABLE");
  const programDataAddress = new PublicKey(programReader.take(32));
  const onchainConfig = await parseGovernanceConfig(requireAccount(configInfo, programId));
  if (onchainConfig.reserveVault !== canonicalVault.toBase58()
    || (!requestedId && id !== (onchainConfig.activeProposalId || onchainConfig.lastProposalId))) {
    throw new Error("GOVERNANCE_STATE_CHANGED_RELOAD");
  }
  // The code hash is checked against the same public reviewed digest used by
  // the server's reserve route. This full account read is deliberately lazy:
  // it happens only on the governance page, never on the landing page.
  const programData = requireAccount(await connection.getAccountInfo(programDataAddress, {
    commitment: "finalized", minContextSlot: snapshot.context.slot,
  }), LOADER);
  const programDataReader = new Reader(programData.data);
  if (programDataReader.u32() !== 3) throw new Error("GOVERNANCE_PROGRAM_DATA_INVALID");
  programDataReader.u64(); // Deployment slot
  const authorityOption = programDataReader.u8();
  if (authorityOption !== 0) throw new Error("GOVERNANCE_PROGRAM_NOT_IMMUTABLE");
  const upgradeAuthority = "IMMUTABLE";
  // BPFLoaderUpgradeab1e... reserves a fixed 45-byte ProgramData header,
  // including the now-unused authority bytes when the authority is None.
  if (programData.data.length <= 45) throw new Error("GOVERNANCE_PROGRAM_DATA_INVALID");
  const programCodeSha256 = hex(await sha256(programData.data.subarray(45)));
  if (programCodeSha256 !== config.governanceProgramCodeSha256) throw new Error("GOVERNANCE_PROGRAM_CODE_HASH_MISMATCH");
  if (onchainConfig.capitalMint !== config.projectMint || onchainConfig.reserveMint !== config.mstrxMint) {
    throw new Error("GOVERNANCE_CONFIG_MISMATCH");
  }
  if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(onchainConfig.capitalTokenProgram)
    || onchainConfig.launchedAt <= 0 || onchainConfig.launchSlot <= 0n
    || /^0+$/.test(onchainConfig.launchSignatureHex)) throw new Error("GOVERNANCE_CAPITAL_NOT_BOUND");
  const reserveVaultAddress = canonicalVault;
  if (!reserveMintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)
    || !capitalMintInfo || capitalMintInfo.owner.toBase58() !== onchainConfig.capitalTokenProgram) {
    throw new Error("GOVERNANCE_MINT_PROGRAM_MISMATCH");
  }
  const reserveMint = unpackMint(mstrxMint, reserveMintInfo, TOKEN_2022_PROGRAM_ID);
  if (!reserveMint.isInitialized || reserveMint.decimals !== 8) throw new Error("GOVERNANCE_MSTRX_UNITS_MISMATCH");
  const capitalMint = unpackMint(capitalMintAddress, capitalMintInfo,
    exactKey(onchainConfig.capitalTokenProgram));
  if (!capitalMint.isInitialized) throw new Error("GOVERNANCE_CAPITAL_MINT_INVALID");
  const vault = inspectGovernanceVault(configAddress, onchainConfig, mstrxMint, vaultInfo);
  const freeReserveRawMstrx = vault.free;
  // Keep the last completed vote visible when no proposal is currently active.
  // Explicit ?proposal=<id> links remain stable for every historic ballot.
  if (id === 0n) return undefined;
  if (id < 0n || id > onchainConfig.lastProposalId) throw new Error("GOVERNANCE_PROPOSAL_ID_INVALID");
  if (!proposalAddress) throw new Error("GOVERNANCE_PROPOSAL_ID_INVALID");
  const proposal = await parseGovernanceProposal(proposalAddress.toBase58(), requireAccount(proposalInfo, programId));
  if (proposal.config !== configAddress.toBase58() || proposal.capitalMint !== config.projectMint
    || proposal.reserveVault !== reserveVaultAddress.toBase58() || proposal.id !== id
    || proposal.frozenReserveRawMstrx <= 0n || proposal.leafCount <= 0n || proposal.totalAvailableWeight <= 0n
    || proposal.startsAt < onchainConfig.launchedAt || proposal.endsAt <= proposal.startsAt
    || proposal.executableAt !== proposal.endsAt + 300
    || proposal.windowStart !== Math.max(onchainConfig.launchedAt, proposal.windowEnd - 86_400)
    || proposal.windowEnd > proposal.startsAt || proposal.finalizedThroughSlot <= 0n
    || ([0, 1, 6, 7, 8].includes(proposal.status) && onchainConfig.activeProposalId !== id)) throw new Error("GOVERNANCE_PROPOSAL_MISMATCH");
  const custodyVerifiedForProposal = [0, 1, 6, 7, 8].includes(proposal.status)
    && onchainConfig.activeProposalId === id
    && onchainConfig.committedReserveRawMstrx === proposal.frozenReserveRawMstrx
    && vault.balance >= proposal.frozenReserveRawMstrx;
  if ([0, 1, 6, 7, 8].includes(proposal.status) && !custodyVerifiedForProposal) {
    throw new Error("GOVERNANCE_COMMITMENT_MISMATCH");
  }
  const emptyRecipient = SystemProgram.programId.toBase58();
  const allowedLockTerms = new Set([30, 90, 180, 365, 730, 1095, 1825].map((days) => days * 86_400));
  allowedLockTerms.add(0xffffffff);
  for (const option of proposal.options) {
    const hasSwapOutput = ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "MARKETING_SALE"].includes(option.action);
    if (option.reserveRawMstrx !== (option.action === "ACCUMULATE" ? 0n : proposal.frozenReserveRawMstrx)
      || (hasSwapOutput ? option.minOutputRaw === 0n : option.minOutputRaw !== 0n)
      || (option.action === "MARKETING_SALE" ? option.recipient !== onchainConfig.marketingWallet : option.recipient !== emptyRecipient)
      || (["BUYBACK_LOCK", "LOCK_MSTRX"].includes(option.action)
        ? !allowedLockTerms.has(option.lockDurationSeconds) : option.lockDurationSeconds !== 0)) {
      throw new Error("GOVERNANCE_OPTION_POLICY_MISMATCH");
    }
  }
  const chainTime = await connection.getBlockTime(snapshot.context.slot);
  if (chainTime === null || !Number.isSafeInteger(chainTime)) throw new Error("GOVERNANCE_CHAIN_TIME_UNKNOWN");
  const lock = proposal.status === 4 && proposal.options[proposal.winningOption].action === "LOCK_MSTRX"
    ? await inspectGovernanceLock(programId, configAddress, onchainConfig, proposalAddress, proposal,
      mstrxMint, lockRecordInfo ?? null, lockEscrowInfo ?? null, chainTime)
    : undefined;
  const executionReceipt = await inspectGovernanceExecutionReceipt(programId, configAddress, onchainConfig,
    proposalAddress, proposal, buybackReceiptInfo ?? null, marketingReceiptInfo ?? null, chainTime);
  const manifestBytes = await fetchBoundedPublicArtifact(`/governance/proposals/${id}/manifest.json`, MAX_PUBLIC_MANIFEST_BYTES);
  let manifestJson: unknown;
  try { manifestJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); }
  catch { throw new Error("GOVERNANCE_MANIFEST_JSON_INVALID"); }
  const manifest = assertManifest(manifestJson, proposal, id);
  await verifyGovernanceSnapshotArtifact(await fetchBoundedPublicArtifact(`/${manifest.snapshot}`, MAX_PUBLIC_SNAPSHOT_BYTES), manifest, proposal, programId);
  await verifyGovernanceSourceArtifact(`/${manifest.source}`, manifest.sourceSha256);
  if (BigInt(snapshot.context.slot) < proposal.finalizedThroughSlot) throw new Error("GOVERNANCE_SNAPSHOT_NOT_FINALIZED");
  if (proposal.finalizedThroughSlot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GOVERNANCE_SNAPSHOT_SLOT_INVALID");
  // getBlockSignatures omits maxSupportedTransactionVersion in web3.js 1.99.
  // A finalized block containing a v1 transaction otherwise fails wholesale.
  const finalizedBlock = await connection.getBlock(Number(proposal.finalizedThroughSlot), {
    commitment: "finalized", transactionDetails: "none", rewards: false,
    maxSupportedTransactionVersion: 1,
  });
  if (!finalizedBlock || finalizedBlock.blockhash !== proposal.finalizedBlockhash) throw new Error("GOVERNANCE_SNAPSHOT_BLOCK_MISMATCH");
  return { programId, configAddress, config: onchainConfig, proposalAddress, proposal, manifest, upgradeAuthority, programCodeSha256,
    vaultBalanceRawMstrx: vault.balance, committedReserveRawMstrx: onchainConfig.committedReserveRawMstrx,
    freeReserveRawMstrx, capitalDecimals: capitalMint.decimals, custodyVerifiedForProposal, lock, executionReceipt,
    accountSnapshotSlot: snapshot.context.slot, chainTime };
}

export async function verifyGovernanceProof(state: VerifiedGovernance, wallet: PublicKey, proof: GovernanceWalletProof) {
  const proposal = state.proposal;
  if (proof.version !== 1 || proof.proposalId !== proposal.id.toString() || proof.account !== wallet.toBase58()
    || proof.merkleRoot !== proposal.merkleRoot || !/^[1-9]\d*$/.test(proof.weight)
    || BigInt(proof.weight) > proposal.totalAvailableWeight || !Array.isArray(proof.proof) || proof.proof.length > 32) return false;
  try {
    let hash = await sha256(
      utf8(LEAF_DOMAIN), utf8(NETWORK_DOMAIN), state.programId.toBytes(), exactKey(proposal.capitalMint).toBytes(),
      uintLE(proposal.id, 8), uintLE(BigInt(proposal.windowStart), 8), uintLE(BigInt(proposal.windowEnd), 8),
      uintLE(proposal.finalizedThroughSlot, 8), exactKey(proposal.finalizedBlockhash).toBytes(),
      fromHex(proposal.exclusionsHash), wallet.toBytes(), uintLE(BigInt(proof.weight), 16),
    );
    for (const sibling of proof.proof) {
      const other = fromHex(sibling);
      hash = hex(hash) <= hex(other)
        ? await sha256(utf8(NODE_DOMAIN), hash, other)
        : await sha256(utf8(NODE_DOMAIN), other, hash);
    }
    const root = await sha256(utf8(ROOT_DOMAIN), uintLE(proposal.leafCount, 8), uintLE(proposal.totalAvailableWeight, 16), hash);
    return hex(root) === proposal.merkleRoot;
  } catch { return false; }
}

export async function loadWalletGovernance(connection: Connection, state: VerifiedGovernance, wallet: PublicKey) {
  const voteRecordAddress = governanceAddresses(state.programId, state.proposal.id, wallet).voteRecord!;
  const recordInfo = await connection.getAccountInfo(voteRecordAddress, "finalized");
  let voteRecord: GovernanceVoteRecord | undefined;
  if (recordInfo) {
    voteRecord = await parseGovernanceVoteRecord(requireAccount(recordInfo, state.programId));
    if (voteRecord.proposal !== state.proposalAddress.toBase58() || voteRecord.voter !== wallet.toBase58()
      || voteRecord.optionIndex >= state.proposal.options.length || voteRecord.weight <= 0n) throw new Error("GOVERNANCE_VOTE_RECORD_INVALID");
  }
  let proof: GovernanceWalletProof | undefined;
  if (!voteRecord) {
    const response = await fetch(`/governance/proposals/${state.proposal.id}/proofs/${wallet.toBase58()}.json`, { cache: "no-store" });
    if (response.ok) {
      const candidate = await response.json() as GovernanceWalletProof;
      if (!await verifyGovernanceProof(state, wallet, candidate)) throw new Error("GOVERNANCE_WALLET_PROOF_INVALID");
      proof = candidate;
    } else if (response.status !== 404) throw new Error("GOVERNANCE_WALLET_PROOF_UNAVAILABLE");
  }
  return { voteRecordAddress, voteRecord, proof };
}

export async function buildGovernanceVoteInstruction(state: VerifiedGovernance, wallet: PublicKey, optionIndex: number, proof: GovernanceWalletProof) {
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= state.proposal.options.length
    || !await verifyGovernanceProof(state, wallet, proof)) throw new Error("GOVERNANCE_VOTE_NOT_VERIFIED");
  const voteRecordAddress = governanceAddresses(state.programId, state.proposal.id, wallet).voteRecord!;
  const discriminator = (await sha256(utf8(CAST_VOTE))).subarray(0, 8);
  const proofHashes = proof.proof.map(fromHex);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, proofHashes.length, true);
  return new TransactionInstruction({
    programId: state.programId,
    keys: [
      { pubkey: state.proposalAddress, isSigner: false, isWritable: true },
      { pubkey: voteRecordAddress, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: true }, // payer
      { pubkey: wallet, isSigner: true, isWritable: false }, // voter
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: joinBytes(discriminator, Uint8Array.of(optionIndex), uintLE(BigInt(proof.weight), 16), length, ...proofHashes) as Buffer,
  });
}

export function canCastGovernanceVote(state: VerifiedGovernance | undefined, proof: GovernanceWalletProof | undefined, voted: boolean, released: boolean) {
  return Boolean(released && state && proof && !voted && [0, 6].includes(state.proposal.status)
    && state.proposal.options.every((option) => EXECUTOR_ACTIONS_RELEASED.has(option.action))
    && state.config.activeProposalId === state.proposal.id
    && state.chainTime >= state.proposal.startsAt && state.chainTime < state.proposal.endsAt);
}

export function governanceProposalIdFromUrl(search: string) {
  const value = new URLSearchParams(search).get("proposal");
  if (value === null) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("GOVERNANCE_PROPOSAL_ID_INVALID");
  const id = BigInt(value);
  if (id > MAX_U64) throw new Error("GOVERNANCE_PROPOSAL_ID_INVALID");
  return id;
}
