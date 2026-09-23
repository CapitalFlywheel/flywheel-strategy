import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const SOLANA_CONTROL_NETWORK = "solana-mainnet-beta" as const;
export const SOLANA_CONTROL_CHALLENGE_MS = 5 * 60_000;

export const SOLANA_CONTROL_ACTIONS = new Set([
  "verify_launch_config", "arm_launch_detection", "disarm_launch_detection", "activate_postlaunch",
  "sweep_curve_fees", "sweep_pumpswap_fees", "pause_conversions", "resume_conversions",
  "recover_uncommitted", "reconcile_fee_receipts",
  "prepare_reward_epoch", "distribute_reward_epoch", "finalize_reward_epoch",
]);

export interface SignedSolanaControlAction {
  network: string;
  action: string;
  signer: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
}

export function solanaControlMessage(input: Omit<SignedSolanaControlAction, "signature">) {
  return [
    "FLYWHEEL STRATEGY SOLANA CONTROL",
    `Action: ${input.action}`,
    `Owner: ${input.signer}`,
    "Network: Solana Mainnet Beta",
    "Allocation: 60% holders / 40% strategic reserve",
    `Issued: ${new Date(input.issuedAt).toISOString()}`,
    `Expires: ${new Date(input.expiresAt).toISOString()}`,
    `Nonce: ${input.nonce}`,
  ].join("\n");
}

export function verifySignedSolanaControlAction(
  input: SignedSolanaControlAction,
  expectedOwner: string,
  now = Date.now(),
) {
  if (input.network !== SOLANA_CONTROL_NETWORK || !SOLANA_CONTROL_ACTIONS.has(input.action)) {
    throw new Error("CONTROL_ACTION_INVALID");
  }
  let signer: PublicKey;
  try { signer = new PublicKey(input.signer); } catch { throw new Error("SIGNER_NOT_OWNER"); }
  if (signer.toBase58() !== input.signer || signer.toBase58() !== new PublicKey(expectedOwner).toBase58()) {
    throw new Error("SIGNER_NOT_OWNER");
  }
  if (!Number.isSafeInteger(input.issuedAt) || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt !== input.issuedAt + SOLANA_CONTROL_CHALLENGE_MS
    || input.issuedAt > now + 30_000 || input.expiresAt < now) {
    throw new Error("CONTROL_CHALLENGE_EXPIRED");
  }
  if (!/^[a-f0-9]{40}$/.test(input.nonce)) throw new Error("CONTROL_NONCE_INVALID");
  let signature: Uint8Array;
  try { signature = bs58.decode(input.signature); } catch { throw new Error("SIGNATURE_INVALID"); }
  if (signature.length !== 64 || !nacl.sign.detached.verify(
    new TextEncoder().encode(solanaControlMessage(input)), signature, signer.toBytes(),
  )) throw new Error("SIGNATURE_INVALID");
  return true;
}
