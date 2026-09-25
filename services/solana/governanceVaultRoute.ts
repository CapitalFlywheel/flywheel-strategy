import { createHash } from "node:crypto";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { mstrxAta } from "./mstrxTransfers";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";

const CONFIG_SEED = Buffer.from("config");
const CONFIG_DISCRIMINATOR = createHash("sha256").update("account:Config").digest().subarray(0, 8);
const MSTRX_MINT = new PublicKey("XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ");
const NON_DEPLOYABLE_TEST_PROGRAM = new PublicKey("3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh");
const UPGRADEABLE_BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const UNBOUND_MINT = new PublicKey(new Uint8Array(32));
const CONFIG_LENGTH = 306;
const PROGRAM_ACCOUNT_LENGTH = 36;
const PROGRAMDATA_HEADER_LENGTH = 45;
const PROGRAM_ACCOUNT_TAG = 2;
const PROGRAMDATA_ACCOUNT_TAG = 3;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export interface GovernanceReserveRoute {
  governanceProgram: string;
  reserveAuthority: string;
  capitalMint: string;
  reserveMint: string;
  admin: string;
  // SHA-256 of the deployed ProgramData bytes after its 45-byte loader header.
  // Must come from an independently reviewed, finalized deployment artifact.
  expectedProgramCodeSha256: string;
}

export type GovernanceReserveSetup = Omit<GovernanceReserveRoute, "capitalMint">;

export function deriveGovernanceReserveRoute(governanceProgram: string, reserveMint: string) {
  const program = new PublicKey(governanceProgram);
  if (program.equals(NON_DEPLOYABLE_TEST_PROGRAM)) throw new Error("GOVERNANCE_PROGRAM_PLACEHOLDER");
  const mint = new PublicKey(reserveMint);
  if (!mint.equals(MSTRX_MINT)) throw new Error("GOVERNANCE_RESERVE_MINT_UNSUPPORTED");
  const [authority, bump] = PublicKey.findProgramAddressSync([CONFIG_SEED], program);
  const [programDataAddress] = PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE_BPF_LOADER);
  return { program, programDataAddress, authority, bump, ata: mstrxAta(authority, mint), mint };
}

type GovernanceAccounts = {
  program: AccountInfo<Buffer> | null;
  programData: AccountInfo<Buffer> | null;
  config: AccountInfo<Buffer> | null;
  vault: AccountInfo<Buffer> | null;
  capitalMint: AccountInfo<Buffer> | null;
};

function verifyUpgradeableProgram(
  route: GovernanceReserveSetup,
  programDataAddress: PublicKey,
  accounts: GovernanceAccounts,
) {
  const programAccount = accounts.program;
  if (!programAccount?.executable || !programAccount.owner.equals(UPGRADEABLE_BPF_LOADER)) {
    throw new Error("GOVERNANCE_PROGRAM_NOT_DEPLOYED");
  }
  const programBytes = programAccount.data;
  if (programBytes.length !== PROGRAM_ACCOUNT_LENGTH
    || programBytes.readUInt32LE(0) !== PROGRAM_ACCOUNT_TAG
    || !new PublicKey(programBytes.subarray(4, 36)).equals(programDataAddress)) {
    throw new Error("GOVERNANCE_PROGRAM_LAYOUT_INVALID");
  }

  const programDataAccount = accounts.programData;
  if (!programDataAccount
    || programDataAccount.executable
    || !programDataAccount.owner.equals(UPGRADEABLE_BPF_LOADER)) {
    throw new Error("GOVERNANCE_PROGRAMDATA_INVALID");
  }
  const bytes = programDataAccount.data;
  if (bytes.length < PROGRAMDATA_HEADER_LENGTH + ELF_MAGIC.length
    || bytes.readUInt32LE(0) !== PROGRAMDATA_ACCOUNT_TAG
    || (bytes[12] !== 0 && bytes[12] !== 1)
    || !bytes.subarray(PROGRAMDATA_HEADER_LENGTH, PROGRAMDATA_HEADER_LENGTH + ELF_MAGIC.length).equals(ELF_MAGIC)) {
    throw new Error("GOVERNANCE_PROGRAMDATA_LAYOUT_INVALID");
  }
  const lastDeployedSlot = bytes.readBigUInt64LE(4);
  if (lastDeployedSlot === 0n) throw new Error("GOVERNANCE_PROGRAMDATA_LAYOUT_INVALID");
  const upgradeAuthority = bytes[12] === 1 ? new PublicKey(bytes.subarray(13, 45)) : null;
  if (upgradeAuthority && !upgradeAuthority.equals(new PublicKey(route.admin))) {
    throw new Error("GOVERNANCE_UPGRADE_AUTHORITY_UNTRUSTED");
  }
  // A single administrator must retain free-reserve control, not an ability to
  // replace the program that enforces active-vote and pending-execution locks.
  // Staging rehearsal may use a different deployment, but no fee route can be
  // activated until that exact reviewed deployment is immutable.
  if (upgradeAuthority) throw new Error("GOVERNANCE_PROGRAM_MUTABLE");
  const expected = route.expectedProgramCodeSha256;
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("GOVERNANCE_REVIEWED_CODE_HASH_REQUIRED");
  const programCodeSha256 = createHash("sha256").update(bytes.subarray(PROGRAMDATA_HEADER_LENGTH)).digest("hex");
  if (programCodeSha256 !== expected) throw new Error("GOVERNANCE_PROGRAM_CODE_HASH_MISMATCH");
  return {
    programDataAddress: programDataAddress.toBase58(),
    programCodeSha256,
    lastDeployedSlot,
    upgradeAuthority: null,
    immutable: true,
  };
}

function accountFingerprint(account: AccountInfo<Buffer> | null) {
  if (!account) return null;
  return {
    owner: account.owner.toBase58(),
    executable: account.executable,
    data: createHash("sha256").update(account.data).digest("hex"),
  };
}

function vaultIdentityFingerprint(account: AccountInfo<Buffer> | null) {
  if (!account || account.data.length < 72) return accountFingerprint(account);
  // Token-account amount is the one field ordinary fee ingress changes.
  // Preserve comparison of all other bytes, including authority/extensions.
  const normalized = Buffer.from(account.data);
  normalized.fill(0, 64, 72);
  return accountFingerprint({ ...account, data: normalized });
}

function commonGovernanceAccounts(route: GovernanceReserveSetup, accounts: GovernanceAccounts) {
  const { program, programDataAddress, authority, bump, ata, mint } = deriveGovernanceReserveRoute(route.governanceProgram, route.reserveMint);
  if (authority.toBase58() !== route.reserveAuthority) throw new Error("GOVERNANCE_RESERVE_AUTHORITY_MISMATCH");
  const programSecurity = verifyUpgradeableProgram(route, programDataAddress, accounts);
  if (!accounts.config || !accounts.config.owner.equals(program)) throw new Error("GOVERNANCE_CONFIG_INVALID");
  if (!accounts.vault || !accounts.vault.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("GOVERNANCE_VAULT_INVALID");
  const data = accounts.config.data;
  if (data.length < 8 || !data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) throw new Error("GOVERNANCE_CONFIG_INVALID");
  const config = decodeGovernanceConfig(data);
  if (config.schemaVersion !== 3) throw new Error("GOVERNANCE_CONFIG_VERSION_UNSUPPORTED");
  if (!config.admin.equals(new PublicKey(route.admin))
    || !config.reserveMint.equals(mint)
    || !config.reserveVault.equals(ata)
    || config.bump !== bump) throw new Error("GOVERNANCE_CONFIG_IDENTITY_MISMATCH");

  let vault;
  try { vault = unpackAccount(ata, accounts.vault, TOKEN_2022_PROGRAM_ID); }
  catch { throw new Error("GOVERNANCE_VAULT_INVALID"); }
  if (!vault.isInitialized || vault.isFrozen || !vault.owner.equals(authority) || !vault.mint.equals(mint)
    || vault.delegate !== null || vault.closeAuthority !== null) {
    throw new Error("GOVERNANCE_VAULT_IDENTITY_MISMATCH");
  }
  return { authority: authority.toBase58(), ata: ata.toBase58(), program: program.toBase58(), config, vault, ...programSecurity };
}

export function assertGovernanceReserveSetup(route: GovernanceReserveSetup, accounts: GovernanceAccounts) {
  const result = commonGovernanceAccounts(route, accounts);
  const { config, vault } = result;
  if (!config.capitalMint.equals(UNBOUND_MINT)
    || !config.capitalTokenProgram.equals(UNBOUND_MINT)
    || config.launchedAt !== 0n
    || config.launchSlot !== 0n
    || config.launchSignature.some((byte) => byte !== 0)
    || config.lastProposalId !== 0n
    || config.activeProposalId !== 0n
    || config.committedReserveRaw !== 0n
    || vault.amount !== 0n) throw new Error("GOVERNANCE_PRELAUNCH_STATE_NOT_EMPTY");
  return {
    authority: result.authority, ata: result.ata, program: result.program,
    programDataAddress: result.programDataAddress, programCodeSha256: result.programCodeSha256,
    lastDeployedSlot: result.lastDeployedSlot, upgradeAuthority: result.upgradeAuthority, immutable: result.immutable,
  };
}

export function assertGovernanceReserveAccounts(route: GovernanceReserveRoute, accounts: GovernanceAccounts) {
  const result = commonGovernanceAccounts(route, accounts);
  const { config } = result;
  if (!accounts.capitalMint || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((id) => accounts.capitalMint!.owner.equals(id))) {
    throw new Error("GOVERNANCE_CAPITAL_MINT_INVALID");
  }
  if (!config.capitalMint.equals(new PublicKey(route.capitalMint))
    || !config.capitalTokenProgram.equals(accounts.capitalMint.owner)
    || config.capitalMint.equals(UNBOUND_MINT)
    || config.launchedAt <= 0n
    || config.launchSlot === 0n
    || config.launchSignature.every((byte) => byte === 0)) throw new Error("GOVERNANCE_CONFIG_IDENTITY_MISMATCH");
  try { unpackMint(new PublicKey(route.capitalMint), accounts.capitalMint, accounts.capitalMint.owner); }
  catch { throw new Error("GOVERNANCE_CAPITAL_MINT_INVALID"); }
  if (config.committedReserveRaw > result.vault.amount) throw new Error("GOVERNANCE_COMMITMENT_EXCEEDS_VAULT");
  return {
    authority: result.authority, ata: result.ata, program: result.program,
    programDataAddress: result.programDataAddress, programCodeSha256: result.programCodeSha256,
    lastDeployedSlot: result.lastDeployedSlot, upgradeAuthority: result.upgradeAuthority, immutable: result.immutable,
    launchSlot: config.launchSlot, launchedAt: config.launchedAt, launchSignature: config.launchSignature,
    boundMint: config.capitalMint.toBase58(), capitalTokenProgram: config.capitalTokenProgram.toBase58(),
    vaultBalanceRaw: result.vault.amount,
    committedRaw: config.committedReserveRaw, freeRaw: result.vault.amount - config.committedReserveRaw,
    lastProposalId: config.lastProposalId,
    activeProposalId: config.activeProposalId,
  };
}

function decodeGovernanceConfig(data: Buffer): {
  admin: PublicKey;
  capitalMint: PublicKey;
  capitalTokenProgram: PublicKey;
  reserveMint: PublicKey;
  reserveVault: PublicKey;
  bump: number;
  schemaVersion: number;
  launchedAt: bigint;
  launchSlot: bigint;
  launchSignature: Buffer;
  lastProposalId: bigint;
  activeProposalId: bigint;
  committedReserveRaw: bigint;
} {
  // Anchor Config v3 layout, mirrored from programs/solana-governance/src/lib.rs.
  if (data.length !== CONFIG_LENGTH) throw new Error("GOVERNANCE_CONFIG_LAYOUT_UNVERIFIED");
  return {
    schemaVersion: data.readUInt8(8),
    admin: new PublicKey(data.subarray(9, 41)),
    capitalMint: new PublicKey(data.subarray(41, 73)),
    capitalTokenProgram: new PublicKey(data.subarray(73, 105)),
    reserveMint: new PublicKey(data.subarray(105, 137)),
    reserveVault: new PublicKey(data.subarray(137, 169)),
    launchedAt: data.readBigInt64LE(201),
    launchSlot: data.readBigUInt64LE(209),
    launchSignature: data.subarray(217, 281),
    lastProposalId: data.readBigUInt64LE(281),
    activeProposalId: data.readBigUInt64LE(289),
    committedReserveRaw: data.readBigUInt64LE(297),
    bump: data.readUInt8(305),
  };
}

async function readGovernanceAccounts(rpcUrls: readonly [string, string], route: GovernanceReserveSetup, capitalMint?: string) {
  const { program, programDataAddress, authority, ata } = deriveGovernanceReserveRoute(route.governanceProgram, route.reserveMint);
  if (authority.toBase58() !== route.reserveAuthority) throw new Error("GOVERNANCE_RESERVE_AUTHORITY_MISMATCH");
  const agreed = await finalizedConsensus(rpcUrls);
  const snapshots = await Promise.all(rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const addresses = [program, programDataAddress, authority, ata, ...(capitalMint ? [new PublicKey(capitalMint)] : [])];
    const response = await connection.getMultipleAccountsInfoAndContext(addresses, {
      commitment: "finalized", minContextSlot: agreed.slot,
    });
    if (response.context.slot < agreed.slot) throw new Error("GOVERNANCE_RPC_CONTEXT_STALE");
    const [programAccount, programDataAccount, configAccount, vaultAccount, capitalMintAccount] = response.value;
    return {
      slot: response.context.slot,
      fingerprint: [programAccount, programDataAccount, configAccount, capitalMintAccount].map(accountFingerprint)
        .concat(vaultIdentityFingerprint(vaultAccount)),
      accounts: {
        program: programAccount, programData: programDataAccount, config: configAccount,
        vault: vaultAccount, capitalMint: capitalMintAccount ?? null,
      },
    };
  }));
  requireMatchingValues(snapshots.map((snapshot) => snapshot.fingerprint), "GOVERNANCE_VAULT_RPC_DISAGREEMENT");
  return snapshots.map((snapshot) => snapshot.accounts);
}

export async function verifyGovernanceReserveSetup(rpcUrls: readonly [string, string], route: GovernanceReserveSetup) {
  const snapshots = await readGovernanceAccounts(rpcUrls, route);
  return requireMatchingValues(snapshots.map((accounts) => assertGovernanceReserveSetup(route, accounts)),
    "GOVERNANCE_VAULT_RPC_DISAGREEMENT");
}

export async function verifyGovernanceReserveRoute(rpcUrls: readonly [string, string], route: GovernanceReserveRoute) {
  const snapshots = await readGovernanceAccounts(rpcUrls, route, route.capitalMint);
  const verified = snapshots.map((accounts) => assertGovernanceReserveAccounts(route, accounts));
  // Even at distinct finalized slots, both providers must agree on identity,
  // commitment and proposal. Expose only the lower observed free balance.
  const stable = verified.map(({ vaultBalanceRaw: _balance, freeRaw: _free, ...identity }) => identity);
  requireMatchingValues(stable, "GOVERNANCE_VAULT_RPC_DISAGREEMENT");
  const vaultBalanceRaw = verified.reduce((minimum, state) => state.vaultBalanceRaw < minimum
    ? state.vaultBalanceRaw : minimum, verified[0].vaultBalanceRaw);
  return { ...verified[0], vaultBalanceRaw, freeRaw: vaultBalanceRaw - verified[0].committedRaw };
}
