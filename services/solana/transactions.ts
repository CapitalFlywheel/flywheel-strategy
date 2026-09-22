import { readFile } from "node:fs/promises";
import { Connection, Keypair, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

export async function loadKeypair(path: string) {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("KEYPAIR_FILE_INVALID");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export async function simulateAndSend(args: {
  connection: Connection;
  payer: Keypair;
  instructions: readonly TransactionInstruction[];
  additionalSigners?: readonly Keypair[];
}) {
  if (!args.instructions.length) throw new Error("TRANSACTION_EMPTY");
  const latest = await args.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: args.payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [...args.instructions],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([args.payer, ...(args.additionalSigners ?? [])]);
  const simulation = await args.connection.simulateTransaction(transaction, { commitment: "confirmed", sigVerify: true });
  if (simulation.value.err) throw new Error(`TRANSACTION_SIMULATION_FAILED:${JSON.stringify(simulation.value.err)}`);
  const signature = await args.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  const confirmation = await args.connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) throw new Error(`TRANSACTION_CONFIRMATION_FAILED:${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

export async function prepareSignedTransaction(args: {
  connection: Connection;
  payer: Keypair;
  instructions: readonly TransactionInstruction[];
  additionalSigners?: readonly Keypair[];
}) {
  if (!args.instructions.length) throw new Error("TRANSACTION_EMPTY");
  const latest = await args.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: args.payer.publicKey, recentBlockhash: latest.blockhash, instructions: [...args.instructions] }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([args.payer, ...(args.additionalSigners ?? [])]);
  const simulation = await args.connection.simulateTransaction(transaction, { commitment: "confirmed", sigVerify: true });
  if (simulation.value.err) throw new Error(`TRANSACTION_SIMULATION_FAILED:${JSON.stringify(simulation.value.err)}`);
  return {
    signature: bs58.encode(transaction.signatures[0]),
    transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

export async function broadcastPreparedTransaction(args: {
  connection: Connection;
  transactionBase64: string;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}) {
  const submitted = await args.connection.sendRawTransaction(Buffer.from(args.transactionBase64, "base64"), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  if (submitted !== args.signature) throw new Error("TRANSACTION_SIGNATURE_MISMATCH");
  const confirmation = await args.connection.confirmTransaction({ signature: args.signature, blockhash: args.blockhash, lastValidBlockHeight: args.lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) throw new Error(`TRANSACTION_CONFIRMATION_FAILED:${JSON.stringify(confirmation.value.err)}`);
  return args.signature;
}
