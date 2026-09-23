import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  SOLANA_CONTROL_CHALLENGE_MS, SOLANA_CONTROL_NETWORK,
  solanaControlMessage, verifySignedSolanaControlAction,
  type SignedSolanaControlAction,
} from "./controlAuth";

const owner = Keypair.generate();
const now = Date.now();

function signedAction(overrides: Partial<Omit<SignedSolanaControlAction, "signature">> = {}) {
  const unsigned = {
    network: SOLANA_CONTROL_NETWORK,
    action: "disarm_launch_detection",
    signer: owner.publicKey.toBase58(),
    issuedAt: now,
    expiresAt: now + SOLANA_CONTROL_CHALLENGE_MS,
    nonce: "a".repeat(40),
    ...overrides,
  };
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(solanaControlMessage(unsigned)), owner.secretKey));
  return { ...unsigned, signature };
}

describe("signed Solana control requests", () => {
  it("accepts only the owner's exact action and five-minute challenge", () => {
    const signed = signedAction();
    expect(verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now)).toBe(true);
    expect(() => verifySignedSolanaControlAction({ ...signed, action: "pause_conversions" }, owner.publicKey.toBase58(), now)).toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction({ ...signed, signer: Keypair.generate().publicKey.toBase58() }, owner.publicKey.toBase58(), now)).toThrow("SIGNER_NOT_OWNER");
    expect(() => verifySignedSolanaControlAction({ ...signed, signature: "forged" }, owner.publicKey.toBase58(), now)).toThrow("SIGNATURE_INVALID");
    expect(() => verifySignedSolanaControlAction(signed, owner.publicKey.toBase58(), now + SOLANA_CONTROL_CHALLENGE_MS + 1)).toThrow("CONTROL_CHALLENGE_EXPIRED");
  });

  describe("runner nonce ledger", () => {
    let temporary: string;
    let dispatch: typeof import("./controlRunner").dispatch;
    const prior = {
      owner: process.env.SOLANA_ADMIN_OWNER,
      state: process.env.SOLANA_STATE_ROOT,
      control: process.env.CONTROL_DATA_ROOT,
    };

    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), "flywheel-control-auth-"));
      process.env.SOLANA_ADMIN_OWNER = owner.publicKey.toBase58();
      process.env.SOLANA_STATE_ROOT = join(temporary, "solana");
      process.env.CONTROL_DATA_ROOT = join(temporary, "control");
      ({ dispatch } = await import("./controlRunner"));
    });

    afterAll(async () => {
      if (prior.owner === undefined) delete process.env.SOLANA_ADMIN_OWNER; else process.env.SOLANA_ADMIN_OWNER = prior.owner;
      if (prior.state === undefined) delete process.env.SOLANA_STATE_ROOT; else process.env.SOLANA_STATE_ROOT = prior.state;
      if (prior.control === undefined) delete process.env.CONTROL_DATA_ROOT; else process.env.CONTROL_DATA_ROOT = prior.control;
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });

    it("rejects forged queue files and consumes a valid nonce only once", async () => {
      const status = {
        network: SOLANA_CONTROL_NETWORK,
        automationState: "stopped" as const,
        launch: { configured: false, armed: false, activated: false },
        services: {}, balances: {}, conversionsPaused: false, updatedAt: 0,
      };
      const authorization = signedAction({ nonce: "b".repeat(40) });
      const request = { ...authorization, id: "test-request", requestedAt: now };
      await expect(dispatch({ ...request, signature: "not-a-signature" }, status)).rejects.toThrow("SIGNATURE_INVALID");
      await expect(dispatch(request, status)).resolves.toBeUndefined();
      await expect(dispatch(request, status)).rejects.toThrow("CONTROL_NONCE_REPLAY");
      const marker = JSON.parse(await readFile(join(temporary, "solana", "control-nonces", `${request.nonce}.json`), "utf8")) as { action: string };
      expect(marker.action).toBe("disarm_launch_detection");
    });
  });
});
