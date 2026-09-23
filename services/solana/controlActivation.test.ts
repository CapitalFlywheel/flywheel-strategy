import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { completeLaunchActivation, distinctFeeOwners } from "./controlRunner";

type Status = Parameters<typeof completeLaunchActivation>[0];

function armedStatus(): Status {
  return {
    network: "solana-mainnet-beta",
    automationState: "stopped",
    launch: { configured: true, armed: true, armedAt: 123, activated: false },
    services: {},
    balances: {},
    conversionsPaused: false,
    updatedAt: 0,
  };
}

const launch = { mint: "test-mint", slot: 456, signature: "test-signature" };

describe("Solana launch activation", () => {
  it("creates one fee ATA per owner when creator and recovery are the same wallet", () => {
    const creator = Keypair.generate().publicKey;
    const holder = Keypair.generate().publicKey;
    const reserve = Keypair.generate().publicKey;
    expect(distinctFeeOwners([creator, holder, reserve, creator]).map((owner) => owner.toBase58())).toEqual([
      creator.toBase58(), holder.toBase58(), reserve.toBase58(),
    ]);
  });

  it.each(["atas", "runtime", "heartbeat"] as const)("keeps the detector armed and retries after %s fails", async (failure) => {
    const status = armedStatus();
    const original = structuredClone(status);
    const firstAttempt: string[] = [];
    await expect(completeLaunchActivation(status, launch, {
      ensureAtas: async () => {
        firstAttempt.push("atas");
        if (failure === "atas") throw new Error("ATA_FAILED");
      },
      publishConfig: async (pending, slot) => {
        firstAttempt.push("runtime");
        expect(pending.launch.detectedMint).toBe(launch.mint);
        expect(pending.launch.activated).toBe(false);
        expect(slot).toBe(launch.slot);
        if (failure === "runtime") throw new Error("RUNTIME_FAILED");
      },
      publishHeartbeat: async () => {
        firstAttempt.push("heartbeat");
        if (failure === "heartbeat") throw new Error("HEARTBEAT_FAILED");
      },
    })).rejects.toThrow();

    expect(status).toEqual(original);
    expect(firstAttempt).toEqual(["atas", "runtime", "heartbeat"].slice(0, firstAttempt.length));

    const retry: string[] = [];
    await completeLaunchActivation(status, launch, {
      ensureAtas: async () => { retry.push("atas"); },
      publishConfig: async () => { retry.push("runtime"); },
      publishHeartbeat: async () => { retry.push("heartbeat"); },
    });
    expect(retry).toEqual(["atas", "runtime", "heartbeat"]);
    expect(status.launch).toMatchObject({ armed: false, activated: true, detectedMint: launch.mint, detectedSignature: launch.signature });
    expect(status.automationState).toBe("running");
    expect(status.services["solana-launch-detector"]).toMatchObject({ ok: true, detail: `${launch.mint}:${launch.signature}` });
  });
});
