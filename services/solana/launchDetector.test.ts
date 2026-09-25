import { Connection, Keypair } from "@solana/web3.js";
import { PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import { describe, expect, it, vi } from "vitest";
import { detectCreatorPumpLaunch, pumpProgramDataLogs, selectArmedLaunchCandidate, verifyAgreedPumpCreateCandidate, type PumpCreateCandidate } from "./launchDetector";

function candidate(creator: string, blockTime: number, mint = Keypair.generate().publicKey.toBase58()): PumpCreateCandidate {
  return {
    signature: "signature",
    slot: 10,
    blockTime,
    mint,
    creator,
    user: creator,
    quoteMint: Keypair.generate().publicKey.toBase58(),
    tokenProgram: Keypair.generate().publicKey.toBase58(),
    creatorFeeBps: 200n,
    isHolderReward: false,
  };
}

describe("armed Pump launch selection", () => {
  it("accepts CreateEvent data only while the official Pump program is executing", () => {
    const other = Keypair.generate().publicKey.toBase58();
    const pump = PUMP_PROGRAM_ID.toBase58();
    expect(pumpProgramDataLogs([
      `Program ${other} invoke [1]`,
      "Program data: spoofed",
      `Program ${other} success`,
      `Program ${pump} invoke [1]`,
      `Program ${other} invoke [2]`,
      "Program data: nested-spoof",
      `Program ${other} success`,
      "Program data: real-pump-event",
      `Program ${pump} success`,
    ])).toEqual(["real-pump-event"]);
  });

  it("rejects inconsistent program log nesting", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(() => pumpProgramDataLogs([`Program ${other} success`])).toThrow("PUMP_CREATE_LOG_STACK_INVALID");
  });

  it("ignores activity before arming and other creators", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const expected = candidate(creator, 20);
    expect(selectArmedLaunchCandidate({
      candidates: [candidate(creator, 9), candidate(Keypair.generate().publicKey.toBase58(), 21), expected],
      creator,
      armedAtMs: 10_000,
    })).toEqual(expected);
  });

  it("accepts a launch within the same block-time second as arming", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const launched = candidate(creator, 10);
    expect(selectArmedLaunchCandidate({ candidates: [launched], creator, armedAtMs: 10_800 })).toEqual(launched);
  });

  it("fails closed when the creator launches more than one coin after arming", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    expect(() => selectArmedLaunchCandidate({
      candidates: [candidate(creator, 20), candidate(creator, 21)],
      creator,
      armedAtMs: 10_000,
    })).toThrow("MULTIPLE_PUMP_LAUNCHES_AFTER_ARM");
  });

  it("paginates past the first page of creator activity after arming", async () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const pages = [
      [{ signature: "new-3", blockTime: 20, err: null }, { signature: "new-2", blockTime: 19, err: null }],
      [{ signature: "new-1", blockTime: 18, err: null }, { signature: "old", blockTime: 9, err: null }],
    ];
    const list = vi.spyOn(Connection.prototype, "getSignaturesForAddress").mockImplementation(async () => pages.shift() as never);
    const getTransaction = vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue({
      slot: 10, blockTime: 20, version: 1, meta: { err: null, logMessages: [] },
    } as never);
    try {
      await expect(detectCreatorPumpLaunch({ rpcUrl: "https://rpc.example", creator, armedAtMs: 10_000, limit: 2 })).resolves.toBeUndefined();
      expect(list).toHaveBeenCalledTimes(2);
      expect(getTransaction).toHaveBeenCalledTimes(3);
    } finally {
      list.mockRestore();
      getTransaction.mockRestore();
    }
  });

  it("checks the exact finalized Pump event and its containing block on both RPCs", async () => {
    const expected = candidate(Keypair.generate().publicKey.toBase58(), 100);
    const pump = PUMP_PROGRAM_ID.toBase58();
    const decode = vi.spyOn(PUMP_SDK, "decodeCreateEventBc").mockReturnValue({
      mint: { toBase58: () => expected.mint }, creator: { toBase58: () => expected.creator },
      user: { toBase58: () => expected.user }, quoteMint: { toBase58: () => expected.quoteMint },
      tokenProgram: { toBase58: () => expected.tokenProgram },
      creatorFeeBps: { toString: () => "200" }, isHolderReward: false,
    } as never);
    const transaction = vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue({
      slot: expected.slot, blockTime: expected.blockTime, version: 1, meta: { err: null, logMessages: [
        `Program ${pump} invoke [1]`, "Program data: AA==", `Program ${pump} success`,
      ] },
    } as never);
    const block = vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue({
      blockhash: "same-finalized-block", transactions: [{ version: 1, transaction: { signatures: [expected.signature] } }],
    } as never);
    try {
      await expect(verifyAgreedPumpCreateCandidate(["https://a.example", "https://b.example"], expected)).resolves.toEqual(expected);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(block).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenCalledWith(expected.signature, expect.objectContaining({ maxSupportedTransactionVersion: 1 }));
      expect(block).toHaveBeenCalledWith(expected.slot, expect.objectContaining({ maxSupportedTransactionVersion: 1 }));
      block.mockResolvedValueOnce({ blockhash: "fork-a", transactions: [{ version: 1, transaction: { signatures: [expected.signature] } }] } as never);
      block.mockResolvedValueOnce({ blockhash: "fork-b", transactions: [{ version: 1, transaction: { signatures: [expected.signature] } }] } as never);
      await expect(verifyAgreedPumpCreateCandidate(["https://a.example", "https://b.example"], expected))
        .rejects.toThrow("PUMP_CREATE_EVENT_RPC_DISAGREEMENT");
    } finally {
      decode.mockRestore(); transaction.mockRestore(); block.mockRestore();
    }
  });

  it("does not ignore an eligible creator transaction whose finalized details are missing", async () => {
    const creator = Keypair.generate().publicKey.toBase58();
    vi.spyOn(Connection.prototype, "getSignaturesForAddress").mockResolvedValue([
      { signature: "eligible", blockTime: 20, err: null },
    ] as never);
    vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue(null);
    await expect(detectCreatorPumpLaunch({ rpcUrl: "https://rpc.example", creator, armedAtMs: 10_000 }))
      .rejects.toThrow("PUMP_LAUNCH_TRANSACTION_UNAVAILABLE");
  });
});
