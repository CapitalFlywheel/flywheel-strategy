import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import { Connection, Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { armDurableCreatorPumpLaunchScan, detectDurableAgreedCreatorPumpLaunch,
  resumeDurableCreatorPumpLaunchScan } from "./launchDetector";

const rpcUrls = ["https://first.example", "https://second.example"] as const;
const pump = PUMP_PROGRAM_ID.toBase58();
const row = (signature: string, slot: number) => ({ signature, slot, blockTime: 100 + slot, err: null });

let stateRoot: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
});

function mockHistory(history: ReturnType<typeof row>[], creator: string, mint: string, divergent = false) {
  const quoteMint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const decode = vi.spyOn(PUMP_SDK, "decodeCreateEventBc").mockReturnValue({
    mint: { toBase58: () => mint }, creator: { toBase58: () => creator },
    user: { toBase58: () => creator }, quoteMint,
    tokenProgram, creatorFeeBps: { toString: () => "200" }, isHolderReward: false,
  } as never);
  const signaturePages = vi.spyOn(Connection.prototype, "getSignaturesForAddress").mockImplementation(async function (_address, options) {
    const start = options?.before ? history.findIndex((entry) => entry.signature === options.before) + 1 : 0;
    return history.slice(start, start + (options?.limit ?? 1_000)) as never;
  });
  const transactions = vi.spyOn(Connection.prototype, "getTransaction").mockImplementation(async function (this: Connection, signature) {
    const entry = history.find((item) => item.signature === signature)!;
    const hasEvent = signature === "create" && !(divergent && this.rpcEndpoint === rpcUrls[1]);
    return {
      slot: entry.slot, blockTime: entry.blockTime, version: 1,
      meta: { err: null, logMessages: hasEvent
        ? [`Program ${pump} invoke [1]`, "Program data: AA==", `Program ${pump} success`] : [] },
    } as never;
  });
  const blocks = vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async function (slot) {
    return { blockhash: `block-${slot}`, transactions: [{ version: 1, transaction: { signatures: ["create"] } }] } as never;
  });
  return { decode, signaturePages, transactions, blocks };
}

describe("durable, bounded Pump launch detection", () => {
  it("does not replace an existing arm anchor after a crash or disarm", async () => {
    stateRoot = await mkdtemp(resolve(tmpdir(), "flywheel-launch-scan-"));
    const creator = Keypair.generate().publicKey.toBase58();
    const history = [row("old", 1)];
    mockHistory(history, creator, Keypair.generate().publicKey.toBase58());
    await armDurableCreatorPumpLaunchScan({ rpcUrls, creator, armedAtMs: 1_000, stateRoot });
    history.unshift(row("create", 3));
    await expect(armDurableCreatorPumpLaunchScan({ rpcUrls, creator, armedAtMs: 2_000, stateRoot }))
      .rejects.toThrow("PUMP_LAUNCH_SCAN_ALREADY_ARMED_OR_STALE");
    const saved = JSON.parse(await readFile(resolve(stateRoot, "launch-detector.json"), "utf8"));
    expect(saved).toMatchObject({ armedAtMs: 1_000, anchorSignature: "old" });
  });

  it("resumes the original boundary and still detects a token created while scanning was paused", async () => {
    stateRoot = await mkdtemp(resolve(tmpdir(), "flywheel-launch-scan-"));
    const creator = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const history = [row("old", 1)];
    mockHistory(history, creator, mint);
    await armDurableCreatorPumpLaunchScan({ rpcUrls, creator, armedAtMs: 1_000, stateRoot });
    history.unshift(row("create", 3));
    expect(await resumeDurableCreatorPumpLaunchScan({ creator, stateRoot, expectedArmedAtMs: 1_000 }))
      .toBe(1_000);
    expect((await detectDurableAgreedCreatorPumpLaunch({ rpcUrls, creator,
      armedAtMs: 1_000, stateRoot, pageSize: 2 }))?.mint).toBe(mint);
    await expect(resumeDurableCreatorPumpLaunchScan({ creator, stateRoot, expectedArmedAtMs: 2_000 }))
      .rejects.toThrow("PUMP_LAUNCH_SCAN_STATE_INVALID");
  });

  it("does not skip a CreateEvent behind more than one page of creator transactions", async () => {
    stateRoot = await mkdtemp(resolve(tmpdir(), "flywheel-launch-scan-"));
    const creator = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const history = [row("old", 1)];
    const mocks = mockHistory(history, creator, mint);
    await armDurableCreatorPumpLaunchScan({ rpcUrls, creator, armedAtMs: 1_000, stateRoot });
    history.unshift(row("trade-3", 6), row("trade-2", 5), row("trade-1", 4), row("create", 3));

    const scan = () => detectDurableAgreedCreatorPumpLaunch({
      rpcUrls, creator, armedAtMs: 1_000, stateRoot, pageSize: 2, maxPagesPerTick: 1,
    });
    expect(await scan()).toBeUndefined();
    expect(await scan()).toBeUndefined();
    const found = await scan();
    expect(found).toMatchObject({ signature: "create", mint, creator, slot: 3, creatorFeeBps: 200n });
    expect(mocks.blocks).toHaveBeenCalledTimes(2); // independent full-block identity check
    expect(mocks.transactions).toHaveBeenCalledTimes(10); // five fresh signatures on two RPCs
  });

  it("resumes after a failed page without advancing its durable cursor", async () => {
    stateRoot = await mkdtemp(resolve(tmpdir(), "flywheel-launch-scan-"));
    const creator = Keypair.generate().publicKey.toBase58();
    const history = [row("old", 1)];
    const mocks = mockHistory(history, creator, Keypair.generate().publicKey.toBase58());
    await armDurableCreatorPumpLaunchScan({ rpcUrls, creator, armedAtMs: 1_000, stateRoot });
    history.unshift(row("trade", 4), row("create", 3));
    const scan = () => detectDurableAgreedCreatorPumpLaunch({
      rpcUrls, creator, armedAtMs: 1_000, stateRoot, pageSize: 1, maxPagesPerTick: 1,
    });
    expect(await scan()).toBeUndefined();
    const saved = JSON.parse(await readFile(resolve(stateRoot, "launch-detector.json"), "utf8"));
    expect(saved.pending.before).toBe("trade");
    mocks.transactions.mockRejectedValueOnce(new Error("RPC_TEMPORARY_FAILURE"));
    await expect(scan()).rejects.toThrow("RPC_TEMPORARY_FAILURE");
    const unchanged = JSON.parse(await readFile(resolve(stateRoot, "launch-detector.json"), "utf8"));
    expect(unchanged.pending.before).toBe("trade");
    expect(await scan()).toBeUndefined(); // resumed create page after restart
    expect((await scan())?.signature).toBe("create"); // reached original arm anchor
  });

  it("rejects a creator event that differs between finalized providers", async () => {
    stateRoot = await mkdtemp(resolve(tmpdir(), "flywheel-launch-scan-"));
    const creator = Keypair.generate().publicKey.toBase58();
    const history = [row("old", 1)];
    mockHistory(history, creator, Keypair.generate().publicKey.toBase58(), true);
    await armDurableCreatorPumpLaunchScan({ rpcUrls, creator, armedAtMs: 1_000, stateRoot });
    history.unshift(row("create", 3));
    await expect(detectDurableAgreedCreatorPumpLaunch({
      rpcUrls, creator, armedAtMs: 1_000, stateRoot, pageSize: 2,
    })).rejects.toThrow("PUMP_CREATE_EVENT_RPC_DISAGREEMENT");
  });

  it("fails closed on a malformed persisted cursor", async () => {
    stateRoot = await mkdtemp(resolve(tmpdir(), "flywheel-launch-scan-"));
    const creator = Keypair.generate().publicKey.toBase58();
    mockHistory([row("old", 1)], creator, Keypair.generate().publicKey.toBase58());
    await armDurableCreatorPumpLaunchScan({ rpcUrls, creator, armedAtMs: 1_000, stateRoot });
    await writeFile(resolve(stateRoot, "launch-detector.json"), JSON.stringify({ version: 1, creator, armedAtMs: 1_000 }));
    await expect(detectDurableAgreedCreatorPumpLaunch({ rpcUrls, creator, armedAtMs: 1_000, stateRoot }))
      .rejects.toThrow("PUMP_LAUNCH_SCAN_STATE_INVALID");
  });
});
