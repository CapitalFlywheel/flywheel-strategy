import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it, vi } from "vitest";
import { verifyGovernanceProposalStatus } from "./governanceProposalStatus";

const rpc = vi.hoisted(() => ({
  accounts: {} as Record<string, Record<string, AccountInfo<Buffer> | null>>,
  contextSlot: 100,
}));

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: class {
      constructor(private readonly url: string) {}
      async getSlot() { return 100; }
      async getBlock() { return { blockhash: "shared-finalized-block" }; }
      async getBlockTime() { return 104_000; }
      async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) {
        const values = rpc.accounts[this.url];
        if (!values) throw new Error("RPC_FIXTURE_MISSING");
        return { context: { slot: rpc.contextSlot }, value: addresses.map((key) => values[key.toBase58()] ?? null) };
      }
    },
  };
});

const urls = ["https://rpc-a.example", "https://rpc-b.example"] as const;
const MSTRX = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";

function account(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, executable: false, lamports: 1_000_000, rentEpoch: 0 };
}

function proposalData(program: PublicKey, config: PublicKey, capital: PublicKey, vault: PublicKey,
  status: number, action: "LOCK_MSTRX" | "BUYBACK_BURN" | "MARKETING_SALE", marketing: PublicKey) {
  const bytes = Buffer.alloc(726);
  let offset = 0;
  function take(length: number) { const start = offset; offset += length; return start; }
  function u8(value: number) { bytes.writeUInt8(value, take(1)); }
  function u32(value: number) { bytes.writeUInt32LE(value, take(4)); }
  function u64(value: bigint) { bytes.writeBigUInt64LE(value, take(8)); }
  function i64(value: bigint) { bytes.writeBigInt64LE(value, take(8)); }
  function u128(value: bigint) { u64(value & ((1n << 64n) - 1n)); u64(value >> 64n); }
  function key(value: PublicKey) { value.toBuffer().copy(bytes, take(32)); }
  createHash("sha256").update("account:Proposal").digest().copy(bytes, take(8), 0, 8);
  u8(3);
  key(config); key(capital); key(vault);
  u64(7n); i64(100_000n); i64(103_600n); i64(103_900n);
  i64(13_600n); i64(100_000n); u64(50n);
  key(Keypair.generate().publicKey);
  Buffer.alloc(32, 1).copy(bytes, take(32));
  Buffer.alloc(32, 2).copy(bytes, take(32));
  u64(1n); u128(1_000n); u64(100n);
  u32(2);
  u8(0); u32(0); key(SystemProgram.programId); u64(0n); u64(0n);
  u8(action === "LOCK_MSTRX" ? 4 : action === "BUYBACK_BURN" ? 2 : 5);
  u32(action === "LOCK_MSTRX" ? 30 * 86_400 : 0);
  key(action === "MARKETING_SALE" ? marketing : SystemProgram.programId);
  u64(100n); u64(action === "LOCK_MSTRX" ? 0n : 25n);
  const winning = status === 1 || status === 4;
  for (let index = 0; index < 6; index += 1) u128(winning && index === 1 ? 100n : 0n);
  u128(winning ? 100n : 0n);
  u8(status); u8(winning ? 1 : 255);
  const idSeed = Buffer.alloc(8);
  idSeed.writeBigUInt64LE(7n);
  const [, bump] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idSeed], program);
  u8(bump);
  expect(offset).toBeLessThanOrEqual(bytes.length);
  return bytes;
}

function fixture(status = 0, action: "LOCK_MSTRX" | "BUYBACK_BURN" | "MARKETING_SALE" = "LOCK_MSTRX") {
  const program = Keypair.generate().publicKey;
  const admin = Keypair.generate().publicKey;
  const capital = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const marketing = Keypair.generate().publicKey;
  const [config, bump] = PublicKey.findProgramAddressSync([Buffer.from("config")], program);
  const idSeed = Buffer.alloc(8);
  idSeed.writeBigUInt64LE(7n);
  const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idSeed], program);
  const configData = Buffer.alloc(306);
  createHash("sha256").update("account:Config").digest().copy(configData, 0, 0, 8);
  configData[8] = 3;
  admin.toBuffer().copy(configData, 9);
  capital.toBuffer().copy(configData, 41);
  TOKEN_PROGRAM_ID.toBuffer().copy(configData, 73);
  new PublicKey(MSTRX).toBuffer().copy(configData, 105);
  vault.toBuffer().copy(configData, 137);
  marketing.toBuffer().copy(configData, 169);
  configData.writeBigInt64LE(1_000n, 201);
  configData.writeBigUInt64LE(20n, 209);
  configData[217] = 1;
  configData.writeBigUInt64LE(7n, 281);
  configData.writeBigUInt64LE(status === 4 ? 0n : 7n, 289);
  configData.writeBigUInt64LE(status === 4 ? 0n : 100n, 297);
  configData[305] = bump;
  const values = {
    [config.toBase58()]: account(program, configData),
    [proposal.toBase58()]: account(program, proposalData(program, config, capital, vault, status, action, marketing)),
  };
  if (status === 4 && action === "LOCK_MSTRX") {
    const [record, recordBump] = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], program);
    const escrow = getAssociatedTokenAddressSync(new PublicKey(MSTRX), record, true, TOKEN_2022_PROGRAM_ID);
    const recordData = Buffer.alloc(8 + 4 * 32 + 8 + 8 + 8 + 4 + 1 + 1);
    createHash("sha256").update("account:LockRecord").digest().copy(recordData, 0, 0, 8);
    proposal.toBuffer().copy(recordData, 8);
    config.toBuffer().copy(recordData, 40);
    vault.toBuffer().copy(recordData, 72);
    escrow.toBuffer().copy(recordData, 104);
    recordData.writeBigUInt64LE(100n, 136);
    recordData.writeBigInt64LE(103_900n, 144);
    recordData.writeBigInt64LE(BigInt(103_900 + 30 * 86_400), 152);
    recordData.writeUInt32LE(30 * 86_400, 160);
    recordData[164] = 0;
    recordData[165] = recordBump;
    const escrowData = Buffer.alloc(ACCOUNT_SIZE);
    new PublicKey(MSTRX).toBuffer().copy(escrowData, 0);
    record.toBuffer().copy(escrowData, 32);
    escrowData.writeBigUInt64LE(100n, 64);
    escrowData[108] = 1;
    Object.assign(values, { [record.toBase58()]: account(program, recordData),
      [escrow.toBase58()]: account(TOKEN_2022_PROGRAM_ID, escrowData) });
  }
  rpc.accounts[urls[0]] = values;
  rpc.accounts[urls[1]] = { ...values };
  rpc.contextSlot = 100;
  return {
    route: {
      program: program.toBase58(), admin: admin.toBase58(), capitalMint: capital.toBase58(),
      reserveMint: MSTRX, reserveVault: vault.toBase58(),
      activeProposalId: status === 4 ? 0n : 7n, committedRaw: status === 4 ? 0n : 100n,
    },
    config, proposal, marketing, capital, vault, program,
  };
}

function executedReceipt(kind: "BUYBACK_BURN" | "MARKETING_SALE") {
  const setup = fixture(4, kind);
  const { program, config, proposal, capital, vault, marketing } = setup;
  const seed = kind === "BUYBACK_BURN" ? "buyback-receipt" : "marketing-sale-receipt";
  const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from(seed), proposal.toBuffer()], program);
  const bytes = Buffer.alloc(kind === "BUYBACK_BURN" ? 335 : 251);
  if (kind === "BUYBACK_BURN") {
    createHash("sha256").update("account:BuybackExecutionReceipt").digest().copy(bytes, 0, 0, 8);
    bytes[8] = 3;
    proposal.toBuffer().copy(bytes, 9);
    config.toBuffer().copy(bytes, 41);
    capital.toBuffer().copy(bytes, 73);
    vault.toBuffer().copy(bytes, 105);
    PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], program)[0].toBuffer().copy(bytes, 137);
    const pump = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    pump.toBuffer().copy(bytes, 169);
    PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), capital.toBuffer()], pump)[0].toBuffer().copy(bytes, 201);
    SystemProgram.programId.toBuffer().copy(bytes, 233);
    bytes[265] = 2;
    bytes.writeBigUInt64LE(100n, 266);
    bytes.writeBigUInt64LE(25n, 274);
    bytes.writeBigUInt64LE(40n, 282);
    bytes.writeBigUInt64LE(1_000n, 290);
    bytes.writeBigUInt64LE(960n, 298);
    bytes.writeBigInt64LE(103_900n, 306);
    bytes[334] = bump;
  } else {
    createHash("sha256").update("account:MarketingSaleReceipt").digest().copy(bytes, 0, 0, 8);
    bytes[8] = 3;
    bytes[9] = 5;
    proposal.toBuffer().copy(bytes, 10);
    config.toBuffer().copy(bytes, 42);
    new PublicKey(MSTRX).toBuffer().copy(bytes, 74);
    vault.toBuffer().copy(bytes, 106);
    marketing.toBuffer().copy(bytes, 138);
    new PublicKey("2ngTuP7xA581dqX9uJkGRqxmKuehY3k4SDfPebeoRG2J").toBuffer().copy(bytes, 170);
    bytes.writeBigUInt64LE(100n, 202);
    bytes.writeBigUInt64LE(25n, 210);
    bytes.writeBigUInt64LE(30n, 218);
    bytes.writeBigUInt64LE(40n, 226);
    bytes.writeBigInt64LE(103_900n, 242);
    bytes[250] = bump;
  }
  rpc.accounts[urls[0]][address.toBase58()] = account(program, bytes);
  rpc.accounts[urls[1]][address.toBase58()] = account(program, Buffer.from(bytes));
  return { ...setup, address, bytes };
}

describe("read-only two-RPC Solana proposal status", () => {
  it("decodes current and completed v3 proposal state without inventing an execution transaction", async () => {
    const active = fixture(1);
    await expect(verifyGovernanceProposalStatus(urls, active.route)).resolves.toMatchObject({
      id: "7", status: 1, frozenRaw: "100", startsAt: 100_000, endsAt: 103_600,
      executableAt: 103_900, winningAction: "LOCK_MSTRX",
      options: [
        { action: "ACCUMULATE", reserveRaw: "0", minOutputRaw: "0", recipient: SystemProgram.programId.toBase58(), lockDurationSeconds: 0 },
        { action: "LOCK_MSTRX", reserveRaw: "100", minOutputRaw: "0", recipient: SystemProgram.programId.toBase58(), lockDurationSeconds: 30 * 86_400 },
      ],
    });
    expect((await verifyGovernanceProposalStatus(urls, active.route))?.fixedMarketingWallet).toBe(active.marketing.toBase58());
    expect((await verifyGovernanceProposalStatus(urls, active.route))?.executionSignature).toBeUndefined();
    const closed = fixture(4);
    await expect(verifyGovernanceProposalStatus(urls, closed.route)).resolves.toMatchObject({
      id: "7", status: 4, frozenRaw: "100", winningAction: "LOCK_MSTRX",
      executionLock: { amountRawMstrx: "100", state: "ACTIVE" },
    });
    const failedRevote = fixture(7);
    await expect(verifyGovernanceProposalStatus(urls, failedRevote.route)).resolves.toMatchObject({
      id: "7", status: 7, frozenRaw: "100",
    });
  });

  it("requires matching finalized config and proposal bytes from independent providers", async () => {
    const { route, proposal } = fixture();
    const modified = Buffer.from(rpc.accounts[urls[1]][proposal.toBase58()]!.data);
    modified[modified.length - 1] = 1;
    rpc.accounts[urls[1]][proposal.toBase58()] = account(new PublicKey(route.program), modified);
    await expect(verifyGovernanceProposalStatus(urls, route)).rejects.toThrow();
  });

  it("fails closed for a missing proposal, mismatched commitment, or stale provider context", async () => {
    const { route, proposal } = fixture();
    rpc.accounts[urls[1]][proposal.toBase58()] = null;
    await expect(verifyGovernanceProposalStatus(urls, route)).rejects.toThrow("GOVERNANCE_STATUS_ACCOUNT_INVALID");
    fixture();
    const mismatch = fixture();
    await expect(verifyGovernanceProposalStatus(urls, { ...mismatch.route, committedRaw: 99n }))
      .rejects.toThrow("GOVERNANCE_STATUS_CONFIG_MISMATCH");
    rpc.contextSlot = 99;
    await expect(verifyGovernanceProposalStatus(urls, mismatch.route)).rejects.toThrow("GOVERNANCE_STATUS_RPC_STALE");
  });

  it("returns no status before the first proposal instead of inventing a ballot from reserve balance", async () => {
    const { route, config } = fixture();
    for (const url of urls) {
      const current = rpc.accounts[url][config.toBase58()]!;
      const data = Buffer.from(current.data);
      data.writeBigUInt64LE(0n, 281);
      data.writeBigUInt64LE(0n, 289);
      data.writeBigUInt64LE(0n, 297);
      rpc.accounts[url] = { ...rpc.accounts[url], [config.toBase58()]: account(new PublicKey(route.program), data) };
    }
    await expect(verifyGovernanceProposalStatus(urls, {
      ...route, activeProposalId: 0n, committedRaw: 0n,
    })).resolves.toBeUndefined();
  });

  it("accepts only durable buyback and marketing receipts independently read from both finalized providers", async () => {
    for (const kind of ["BUYBACK_BURN", "MARKETING_SALE"] as const) {
      const { route, address, bytes, program } = executedReceipt(kind);
      await expect(verifyGovernanceProposalStatus(urls, route)).resolves.toMatchObject({
        status: 4, winningAction: kind,
        executionReceipt: { address: address.toBase58(), action: kind, inputRawMstrx: "100",
          votedMinOutputRaw: "25", actualOutputRaw: "40", executedAt: 103_900 },
      });
      rpc.accounts[urls[1]][address.toBase58()] = null;
      await expect(verifyGovernanceProposalStatus(urls, route)).rejects.toThrow("GOVERNANCE_EXECUTION_RECEIPT_STATE_MISMATCH");
      rpc.accounts[urls[1]][address.toBase58()] = account(program, Buffer.from(bytes));
      const tampered = Buffer.from(bytes);
      tampered[kind === "BUYBACK_BURN" ? 282 : 226] = 1;
      rpc.accounts[urls[1]][address.toBase58()] = account(program, tampered);
      await expect(verifyGovernanceProposalStatus(urls, route)).rejects.toThrow();
    }
  });

  it("never treats status=4 LOCK_MSTRX as executed when either lock account is absent or divergent", async () => {
    const { route, proposal } = fixture(4);
    const [record] = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()],
      new PublicKey(route.program));
    rpc.accounts[urls[1]][record.toBase58()] = null;
    await expect(verifyGovernanceProposalStatus(urls, route)).rejects.toThrow("GOVERNANCE_STATUS_LOCK_STATE_MISMATCH");
    const fresh = fixture(4);
    const [freshRecord] = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), fresh.proposal.toBuffer()],
      new PublicKey(fresh.route.program));
    const freshEscrow = getAssociatedTokenAddressSync(new PublicKey(MSTRX), freshRecord, true, TOKEN_2022_PROGRAM_ID);
    const tampered = Buffer.from(rpc.accounts[urls[1]][freshEscrow.toBase58()]!.data);
    tampered.writeBigUInt64LE(99n, 64);
    rpc.accounts[urls[1]][freshEscrow.toBase58()] = account(TOKEN_2022_PROGRAM_ID, tampered);
    await expect(verifyGovernanceProposalStatus(urls, fresh.route)).rejects.toThrow("GOVERNANCE_LOCK_ESCROW_INVALID");
  });

  it("keeps a passed lock executable when its canonical ATA was pre-created and funded", async () => {
    const { route, proposal } = fixture(1);
    const [record] = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()],
      new PublicKey(route.program));
    const escrow = getAssociatedTokenAddressSync(new PublicKey(MSTRX), record, true, TOKEN_2022_PROGRAM_ID);
    const donated = Buffer.alloc(ACCOUNT_SIZE);
    new PublicKey(MSTRX).toBuffer().copy(donated, 0);
    record.toBuffer().copy(donated, 32);
    donated.writeBigUInt64LE(17n, 64);
    donated[108] = 1;
    for (const url of urls) rpc.accounts[url][escrow.toBase58()] = account(TOKEN_2022_PROGRAM_ID, Buffer.from(donated));
    await expect(verifyGovernanceProposalStatus(urls, route)).resolves.toMatchObject({
      status: 1, winningAction: "LOCK_MSTRX",
    });
    const invalid = Buffer.from(donated);
    Keypair.generate().publicKey.toBuffer().copy(invalid, 32);
    rpc.accounts[urls[1]][escrow.toBase58()] = account(TOKEN_2022_PROGRAM_ID, invalid);
    await expect(verifyGovernanceProposalStatus(urls, route))
      .rejects.toThrow("GOVERNANCE_STATUS_PRECREATED_LOCK_ATA_INVALID");
  });
});
