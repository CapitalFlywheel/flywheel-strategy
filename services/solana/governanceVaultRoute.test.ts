import { createHash } from "node:crypto";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it, vi } from "vitest";
import {
  assertGovernanceReserveAccounts, assertGovernanceReserveSetup, deriveGovernanceReserveRoute,
  verifyGovernanceReserveRoute,
} from "./governanceVaultRoute";

const rpc = vi.hoisted(() => ({
  accounts: {} as Record<string, Record<string, AccountInfo<Buffer> | null>>,
  requestedAddresses: {} as Record<string, string[]>,
}));

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: class {
      constructor(private readonly url: string) {}
      async getSlot() { return 100; }
      async getBlock() { return { blockhash: "finalized-block" }; }
      async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) {
        const keys = addresses.map((address) => address.toBase58());
        rpc.requestedAddresses[this.url] = keys;
        const values = rpc.accounts[this.url];
        if (!values) throw new Error("RPC_TEST_FIXTURE_MISSING");
        return { context: { slot: 100 }, value: keys.map((key) => values[key] ?? null) };
      }
    },
  };
});

const MSTRX = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const UPGRADEABLE_BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const pubkey = () => Keypair.generate().publicKey;
const account = (owner: PublicKey, data: Buffer, executable = false): AccountInfo<Buffer> => ({
  data, executable, lamports: 1_000_000, owner, rentEpoch: 0,
});

function fixture() {
  const program = pubkey();
  const admin = pubkey();
  const capital = pubkey();
  const binding = deriveGovernanceReserveRoute(program.toBase58(), MSTRX);
  const config = Buffer.alloc(306);
  createHash("sha256").update("account:Config").digest().copy(config, 0, 0, 8);
  config.writeUInt8(3, 8);
  admin.toBuffer().copy(config, 9);
  capital.toBuffer().copy(config, 41);
  TOKEN_PROGRAM_ID.toBuffer().copy(config, 73);
  new PublicKey(MSTRX).toBuffer().copy(config, 105);
  binding.ata.toBuffer().copy(config, 137);
  config.writeBigInt64LE(100n, 201);
  config.writeBigUInt64LE(20n, 209);
  config[217] = 1;
  config[305] = binding.bump;
  const capitalData = Buffer.alloc(82);
  capitalData[44] = 6;
  capitalData[45] = 1;
  const programData = Buffer.alloc(45 + 8);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(19n, 4);
  programData[12] = 0;
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]).copy(programData, 45);
  const programAccountData = Buffer.alloc(36);
  programAccountData.writeUInt32LE(2, 0);
  binding.programDataAddress.toBuffer().copy(programAccountData, 4);
  const vaultData = Buffer.alloc(165);
  new PublicKey(MSTRX).toBuffer().copy(vaultData, 0);
  binding.authority.toBuffer().copy(vaultData, 32);
  vaultData[108] = 1;
  const route = {
    governanceProgram: program.toBase58(), reserveAuthority: binding.authority.toBase58(),
    capitalMint: capital.toBase58(), reserveMint: MSTRX, admin: admin.toBase58(),
    expectedProgramCodeSha256: createHash("sha256").update(programData.subarray(45)).digest("hex"),
  };
  const accounts = {
    program: account(UPGRADEABLE_BPF_LOADER, programAccountData, true),
    programData: account(UPGRADEABLE_BPF_LOADER, programData) as AccountInfo<Buffer> | null,
    config: account(program, config),
    vault: account(TOKEN_2022_PROGRAM_ID, vaultData),
    capitalMint: account(TOKEN_PROGRAM_ID, capitalData),
  };
  return { route, accounts, binding };
}

describe("binding Solana reserve fee destination", () => {
  it("requires the deployed Config PDA's canonical Token-2022 MSTRx vault", () => {
    const { route, accounts, binding } = fixture();
    expect(assertGovernanceReserveAccounts(route, accounts)).toMatchObject({
      authority: binding.authority.toBase58(), ata: binding.ata.toBase58(), program: binding.program.toBase58(),
    });
  });

  it("accepts only a fresh unbound and empty governance vault before token launch", () => {
    const { route, accounts, binding } = fixture();
    accounts.config.data.fill(0, 41, 105);
    accounts.config.data.fill(0, 201, 305);
    expect(assertGovernanceReserveSetup(route, accounts)).toEqual({
      authority: binding.authority.toBase58(), ata: binding.ata.toBase58(), program: binding.program.toBase58(),
      programDataAddress: binding.programDataAddress.toBase58(), programCodeSha256: route.expectedProgramCodeSha256,
      lastDeployedSlot: 19n, upgradeAuthority: null, immutable: true,
    });
    accounts.vault.data.writeBigUInt64LE(1n, 64);
    expect(() => assertGovernanceReserveSetup(route, accounts)).toThrow("GOVERNANCE_PRELAUNCH_STATE_NOT_EMPTY");
  });

  it("rejects an ordinary reserve wallet even if it owns an MSTRx ATA", () => {
    const { route, accounts } = fixture();
    route.reserveAuthority = pubkey().toBase58();
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_RESERVE_AUTHORITY_MISMATCH");
  });

  it("rejects the non-deployable placeholder program and a different loader owner", () => {
    const { route, accounts } = fixture();
    expect(() => deriveGovernanceReserveRoute("3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh", MSTRX))
      .toThrow("GOVERNANCE_PROGRAM_PLACEHOLDER");
    accounts.program.owner = pubkey();
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_NOT_DEPLOYED");
  });

  it("requires the loader Program state to link the exact derived ProgramData PDA", () => {
    const { route, accounts } = fixture();
    accounts.program.data.writeUInt32LE(0, 0);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_LAYOUT_INVALID");
    accounts.program.data.writeUInt32LE(2, 0);
    pubkey().toBuffer().copy(accounts.program.data, 4);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_LAYOUT_INVALID");
    accounts.program.data = Buffer.alloc(40);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_LAYOUT_INVALID");
  });

  it("rejects missing, foreign-owned, executable or malformed ProgramData", () => {
    const { route, accounts } = fixture();
    const restored = accounts.programData!;
    accounts.programData = null;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAMDATA_INVALID");
    accounts.programData = account(pubkey(), Buffer.alloc(49));
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAMDATA_INVALID");
    accounts.programData = account(UPGRADEABLE_BPF_LOADER, Buffer.alloc(49), true);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAMDATA_INVALID");
    accounts.programData = account(UPGRADEABLE_BPF_LOADER, Buffer.alloc(49));
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAMDATA_LAYOUT_INVALID");
    restored.data.writeBigUInt64LE(0n, 4);
    accounts.programData = restored;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAMDATA_LAYOUT_INVALID");
    restored.data.writeBigUInt64LE(19n, 4);
    restored.data[45] = 0;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAMDATA_LAYOUT_INVALID");
  });

  it("requires an immutable governance deployment before any reserve may be routed", () => {
    const { route, accounts } = fixture();
    accounts.programData!.data[12] = 1;
    new PublicKey(route.admin).toBuffer().copy(accounts.programData!.data, 13);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_MUTABLE");
    pubkey().toBuffer().copy(accounts.programData!.data, 13);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_UPGRADE_AUTHORITY_UNTRUSTED");
    accounts.programData!.data[12] = 0;
    expect(assertGovernanceReserveAccounts(route, accounts)).toMatchObject({ immutable: true, upgradeAuthority: null });
    accounts.programData!.data[12] = 2;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAMDATA_LAYOUT_INVALID");
  });

  it("requires a pinned reviewed program code hash and rejects changed bytecode", () => {
    const { route, accounts } = fixture();
    route.expectedProgramCodeSha256 = "";
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_REVIEWED_CODE_HASH_REQUIRED");
    route.expectedProgramCodeSha256 = "0".repeat(64);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_CODE_HASH_MISMATCH");
    route.expectedProgramCodeSha256 = createHash("sha256").update(accounts.programData!.data.subarray(45)).digest("hex");
    accounts.programData!.data[49] = 5;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_CODE_HASH_MISMATCH");
  });

  it("rejects missing program custody and unbound or wrong-mint Config accounts", () => {
    const { route, accounts } = fixture();
    accounts.program.executable = false;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_PROGRAM_NOT_DEPLOYED");
    accounts.program.executable = true;
    accounts.config.data.fill(0, 41, 73);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_CONFIG_IDENTITY_MISMATCH");
    new PublicKey(route.capitalMint).toBuffer().copy(accounts.config.data, 41);
    accounts.config.data.fill(0, 137, 169);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_CONFIG_IDENTITY_MISMATCH");
  });

  it("rejects a fake token account, incorrect token authority, or wrong Config version", () => {
    const { route, accounts } = fixture();
    accounts.vault.owner = TOKEN_PROGRAM_ID;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_VAULT_INVALID");
    accounts.vault.owner = TOKEN_2022_PROGRAM_ID;
    pubkey().toBuffer().copy(accounts.vault.data, 32);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_VAULT_IDENTITY_MISMATCH");
    accounts.config.data[8] = 1;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_CONFIG_VERSION_UNSUPPORTED");
  });

  it("rejects frozen, delegated, or closeable reserve token accounts", () => {
    const { route, accounts } = fixture();
    accounts.vault.data[108] = 2;
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_VAULT_IDENTITY_MISMATCH");
    accounts.vault.data[108] = 1;
    accounts.vault.data.writeUInt32LE(1, 72);
    pubkey().toBuffer().copy(accounts.vault.data, 76);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_VAULT_IDENTITY_MISMATCH");
    accounts.vault.data.writeUInt32LE(0, 72);
    accounts.vault.data.writeUInt32LE(1, 129);
    pubkey().toBuffer().copy(accounts.vault.data, 133);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_VAULT_IDENTITY_MISMATCH");
  });

  it("reports free versus vote-committed reserve and rejects an unfunded commitment", () => {
    const { route, accounts } = fixture();
    accounts.vault.data.writeBigUInt64LE(100n, 64);
    accounts.config.data.writeBigUInt64LE(40n, 297);
    accounts.config.data.writeBigUInt64LE(7n, 289);
    expect(assertGovernanceReserveAccounts(route, accounts)).toMatchObject({
      vaultBalanceRaw: 100n, committedRaw: 40n, freeRaw: 60n, activeProposalId: 7n,
    });
    accounts.config.data.writeBigUInt64LE(101n, 297);
    expect(() => assertGovernanceReserveAccounts(route, accounts)).toThrow("GOVERNANCE_COMMITMENT_EXCEEDS_VAULT");
  });

  it("reads Program and ProgramData from both finalized RPCs and blocks a code disagreement", async () => {
    const { route, accounts, binding } = fixture();
    const urls = ["https://rpc-a.example", "https://rpc-b.example"] as const;
    const values = {
      [route.governanceProgram]: accounts.program,
      [binding.programDataAddress.toBase58()]: accounts.programData,
      [binding.authority.toBase58()]: accounts.config,
      [binding.ata.toBase58()]: accounts.vault,
      [route.capitalMint]: accounts.capitalMint,
    };
    rpc.accounts[urls[0]] = values;
    rpc.accounts[urls[1]] = { ...values };
    const verified = await verifyGovernanceReserveRoute(urls, route);
    expect(verified.programDataAddress).toBe(binding.programDataAddress.toBase58());
    expect(verified.upgradeAuthority).toBeNull();
    expect(rpc.requestedAddresses[urls[0]]).toContain(binding.programDataAddress.toBase58());
    expect(rpc.requestedAddresses[urls[1]]).toContain(binding.programDataAddress.toBase58());

    const changed = Buffer.from(accounts.programData!.data);
    changed[49] ^= 1;
    rpc.accounts[urls[1]] = {
      ...values,
      [binding.programDataAddress.toBase58()]: account(UPGRADEABLE_BPF_LOADER, changed),
    };
    await expect(verifyGovernanceReserveRoute(urls, route)).rejects.toThrow("GOVERNANCE_VAULT_RPC_DISAGREEMENT");
  });

  it("accepts fee deposits between independent finalized snapshots but reports the lower free balance", async () => {
    const { route, accounts, binding } = fixture();
    const urls = ["https://rpc-c.example", "https://rpc-d.example"] as const;
    accounts.config.data.writeBigUInt64LE(40n, 297);
    accounts.vault.data.writeBigUInt64LE(100n, 64);
    const values = {
      [route.governanceProgram]: accounts.program,
      [binding.programDataAddress.toBase58()]: accounts.programData,
      [binding.authority.toBase58()]: accounts.config,
      [binding.ata.toBase58()]: accounts.vault,
      [route.capitalMint]: accounts.capitalMint,
    };
    rpc.accounts[urls[0]] = values;
    const later = Buffer.from(accounts.vault.data);
    later.writeBigUInt64LE(125n, 64);
    rpc.accounts[urls[1]] = { ...values, [binding.ata.toBase58()]: account(TOKEN_2022_PROGRAM_ID, later) };
    await expect(verifyGovernanceReserveRoute(urls, route)).resolves.toMatchObject({
      committedRaw: 40n, vaultBalanceRaw: 100n, freeRaw: 60n,
    });
    later.writeBigUInt64LE(39n, 64);
    await expect(verifyGovernanceReserveRoute(urls, route)).rejects.toThrow("GOVERNANCE_COMMITMENT_EXCEEDS_VAULT");
  });
});
