import type { Commitment, Connection, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

export const MSTRX_DECIMALS = 8;

export function mstrxAta(owner: PublicKey, mint: PublicKey) {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
}
export function createMstrxAtaInstruction(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    mstrxAta(owner, mint),
    owner,
    mint,
    TOKEN_2022_PROGRAM_ID,
  );
}

export async function createMstrxTransfer(args: {
  connection: Connection;
  sourceOwner: PublicKey;
  destinationOwner: PublicKey;
  mint: PublicKey;
  rawAmount: bigint;
  commitment?: Commitment;
}) {
  if (args.rawAmount <= 0n) throw new Error("TRANSFER_AMOUNT_EMPTY");
  return createTransferCheckedWithTransferHookInstruction(
    args.connection,
    mstrxAta(args.sourceOwner, args.mint),
    args.mint,
    mstrxAta(args.destinationOwner, args.mint),
    args.sourceOwner,
    args.rawAmount,
    MSTRX_DECIMALS,
    [],
    args.commitment ?? "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
}

export function splitMstrx60_40(rawAmount: bigint) {
  if (rawAmount <= 0n) throw new Error("EMPTY_CREATOR_FEE_BALANCE");
  const holderRaw = rawAmount * 6_000n / 10_000n;
  const reserveRaw = rawAmount - holderRaw;
  if (holderRaw + reserveRaw !== rawAmount) throw new Error("SPLIT_NOT_CONSERVED");
  return { grossRaw: rawAmount, holderRaw, reserveRaw };
}
