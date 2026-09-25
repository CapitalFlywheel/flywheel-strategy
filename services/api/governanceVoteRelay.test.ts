import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  GOVERNANCE_VOTE_BROADCAST_RELEASED, GovernanceVoteLimiter, handleGovernanceVoteRpc, inspectActiveVoteProposal,
  inspectVoteConfigAndVault, precheckSignedCastVote, validateVoteRpcRequest, verifySignedCastVote,
  verifyDualVoteSnapshots,
} from "./governanceVoteRelay";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const program = Keypair.generate().publicKey;
const capitalMint = Keypair.generate().publicKey;
const reserveVault = Keypair.generate().publicKey;
const voter = Keypair.generate();
const blockhash = Keypair.generate().publicKey.toBase58();
const id = 7n;
const idBytes = Buffer.alloc(8);
idBytes.writeBigUInt64LE(id);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program);
const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idBytes], program);
const [record] = PublicKey.findProgramAddressSync([Buffer.from("vote"), proposal.toBuffer(), voter.publicKey.toBuffer()], program);
const route = { program, capitalMint, reserveVault, activeProposalId: id };
const discriminator = createHash("sha256").update("global:cast_vote").digest().subarray(0, 8);

function voteInstruction(changes: {
  program?: PublicKey; proposal?: PublicKey; record?: PublicKey; payer?: PublicKey;
  voter?: PublicKey; option?: number; weight?: bigint; proof?: Buffer[]; length?: number;
} = {}) {
  const proof = changes.proof ?? [];
  const data = Buffer.alloc(29 + proof.length * 32);
  discriminator.copy(data, 0);
  data[8] = changes.option ?? 1;
  const weight = changes.weight ?? 99n;
  data.writeBigUInt64LE(weight & ((1n << 64n) - 1n), 9);
  data.writeBigUInt64LE(weight >> 64n, 17);
  data.writeUInt32LE(changes.length ?? proof.length, 25);
  proof.forEach((hash, index) => hash.copy(data, 29 + index * 32));
  return new TransactionInstruction({ programId: changes.program ?? program,
    keys: [
      { pubkey: changes.proposal ?? proposal, isSigner: false, isWritable: true },
      { pubkey: changes.record ?? record, isSigner: false, isWritable: true },
      { pubkey: changes.payer ?? voter.publicKey, isSigner: true, isWritable: true },
      { pubkey: changes.voter ?? voter.publicKey, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data });
}

function signed(changes: Parameters<typeof voteInstruction>[0] = {}, other?: TransactionInstruction) {
  const tx = new Transaction({ feePayer: voter.publicKey, recentBlockhash: blockhash }).add(voteInstruction(changes));
  if (other) tx.add(other);
  tx.sign(voter);
  return tx.serialize();
}

function proposalBytes(optionCount = 2, status = 0) {
  const bytes = Buffer.alloc(726);
  createHash("sha256").update("account:Proposal").digest().copy(bytes, 0, 0, 8);
  bytes[8] = 3;
  config.toBuffer().copy(bytes, 9);
  capitalMint.toBuffer().copy(bytes, 41);
  reserveVault.toBuffer().copy(bytes, 73);
  bytes.writeBigUInt64LE(id, 105);
  bytes.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - 30), 113);
  bytes.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 3600), 121);
  bytes.writeBigUInt64LE(1n, 257);
  bytes.writeBigUInt64LE(1_000n, 265);
  bytes.writeBigUInt64LE(10n, 281);
  bytes.writeUInt32LE(optionCount, 289);
  if (optionCount >= 2) {
    bytes[293] = 0; // ACCUMULATE, zero spend and zero output
    bytes[346] = 2; // BUYBACK_BURN, full frozen spend and positive CAPITAL floor
    bytes.writeBigUInt64LE(10n, 383);
    bytes.writeBigUInt64LE(1n, 391);
  }
  if (optionCount >= 0 && optionCount <= 6) {
    const statusOffset = 293 + optionCount * 53 + 6 * 16 + 16;
    bytes[statusOffset] = status;
    bytes[statusOffset + 1] = 255;
    bytes[statusOffset + 2] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idBytes], program)[1];
  }
  return bytes;
}

function activeSnapshot(vaultAmount = 10n, castWeight = 0n) {
  const configData = Buffer.alloc(306);
  createHash("sha256").update("account:Config").digest().copy(configData, 0, 0, 8);
  configData[8] = 3;
  voter.publicKey.toBuffer().copy(configData, 9);
  capitalMint.toBuffer().copy(configData, 41);
  TOKEN_PROGRAM_ID.toBuffer().copy(configData, 73);
  const reserveMint = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;
  reserveMint.toBuffer().copy(configData, 105);
  reserveVault.toBuffer().copy(configData, 137);
  configData.writeBigInt64LE(100n, 201);
  configData.writeBigUInt64LE(1n, 209);
  configData[217] = 1;
  configData.writeBigUInt64LE(id, 281);
  configData.writeBigUInt64LE(id, 289);
  configData.writeBigUInt64LE(10n, 297);
  configData[305] = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[1];
  const vaultData = Buffer.alloc(165);
  reserveMint.toBuffer().copy(vaultData, 0);
  config.toBuffer().copy(vaultData, 32);
  vaultData.writeBigUInt64LE(vaultAmount, 64);
  vaultData[108] = 1;
  const proposalData = proposalBytes();
  if (castWeight !== 0n) {
    const tallyOffset = 293 + 2 * 53;
    proposalData.writeBigUInt64LE(castWeight, tallyOffset);
    proposalData.writeBigUInt64LE(castWeight, tallyOffset + 6 * 16);
  }
  const account = (owner: PublicKey, data: Buffer) => ({ owner, data, executable: false, lamports: 1_000_000, rentEpoch: 0 });
  const snapshot = { config: account(program, configData),
    vault: account(TOKEN_2022_PROGRAM_ID, vaultData), proposal: account(program, proposalData), record: null };
  const expected = { program, capitalMint, reserveMint, reserveVault, admin: voter.publicKey,
    voter: voter.publicKey, proposal, record, optionIndex: 1 };
  return { snapshot, expected };
}

describe("exact governance-vote relay", () => {
  it("remains hard disabled regardless of environment variables", () => {
    expect(GOVERNANCE_VOTE_BROADCAST_RELEASED).toBe(false);
  });

  it("returns closed before reading any request body or contacting any provider", async () => {
    const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    await handleGovernanceVoteRpc({} as IncomingMessage, response);
    expect(response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(response.end).toHaveBeenCalledWith('{"error":"voting_unavailable"}');
  });

  it("accepts only the one-signer, exact-account cast_vote message", () => {
    expect(precheckSignedCastVote(signed(), program)).toMatchObject({ proposal, record, optionIndex: 1 });
    expect(verifySignedCastVote(signed(), route)).toMatchObject({
      proposal, record, config, optionIndex: 1, voter: voter.publicKey,
    });
  });

  it("rejects other programs, PDAs, extra instructions, a second signer and v0 transactions", () => {
    const other = Keypair.generate().publicKey;
    expect(() => verifySignedCastVote(signed({ program: other }), route)).toThrow();
    expect(() => verifySignedCastVote(signed({ proposal: other }), route)).toThrow();
    expect(() => verifySignedCastVote(signed({ record: other }), route)).toThrow();
    expect(() => verifySignedCastVote(signed(undefined, ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })), route)).toThrow();
    expect(() => verifySignedCastVote(signed(undefined, SystemProgram.transfer({ fromPubkey: voter.publicKey,
      toPubkey: other, lamports: 1 })), route)).toThrow();
    const secondSigner = Keypair.generate();
    const tx = new Transaction({ feePayer: voter.publicKey, recentBlockhash: blockhash }).add(
      voteInstruction({ payer: secondSigner.publicKey }));
    tx.sign(voter, secondSigner);
    expect(() => verifySignedCastVote(tx.serialize(), route)).toThrow();
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: voter.publicKey,
      recentBlockhash: blockhash, instructions: [voteInstruction()] }).compileToV0Message());
    v0.sign([voter]);
    expect(() => verifySignedCastVote(Buffer.from(v0.serialize()), route)).toThrow();
  });

  it("rejects an altered signature, malformed instruction data, no weight and overlong proof", () => {
    const corrupted = Buffer.from(signed());
    corrupted[10] ^= 1;
    expect(() => verifySignedCastVote(corrupted, route)).toThrow();
    expect(() => verifySignedCastVote(signed({ length: 1 }), route)).toThrow();
    expect(() => verifySignedCastVote(signed({ weight: 0n }), route)).toThrow();
    expect(() => verifySignedCastVote(signed({ option: 6 }), route)).toThrow();
    expect(() => verifySignedCastVote(signed({ proof: Array.from({ length: 33 }, () => Buffer.alloc(32)) }), route)).toThrow();
    expect(() => verifySignedCastVote(signed(), { ...route, activeProposalId: 8n })).toThrow();
  });

  it("checks dynamic config/vault without re-reading immutable ProgramData", () => {
    const { snapshot, expected } = activeSnapshot();
    const configData = snapshot.config.data;
    const vaultInfo = snapshot.vault;
    expect(inspectVoteConfigAndVault(configData, vaultInfo, expected).activeProposalId).toBe(id);
    expect(() => inspectVoteConfigAndVault(configData, vaultInfo, { ...expected, admin: Keypair.generate().publicKey })).toThrow();
    const overcommitted = Buffer.from(configData);
    overcommitted.writeBigUInt64LE(11n, 297);
    expect(() => inspectVoteConfigAndVault(overcommitted, vaultInfo, expected)).toThrow();
    expect(() => inspectVoteConfigAndVault(configData, { ...vaultInfo, owner: TOKEN_PROGRAM_ID }, expected)).toThrow();
  });

  it("accepts independent finalized views with a new free deposit and newer valid vote tally", () => {
    const first = activeSnapshot(10n, 0n);
    const second = activeSnapshot(25n, 21n);
    expect(verifyDualVoteSnapshots([first.snapshot, second.snapshot], first.expected)).toBe(id);
  });

  it("rejects an unfunded commitment, changed proposal identity or divergent commitment", () => {
    const first = activeSnapshot(10n, 0n);
    const underfunded = activeSnapshot(9n, 0n);
    expect(() => verifyDualVoteSnapshots([first.snapshot, underfunded.snapshot], first.expected)).toThrow();
    const changedRoot = activeSnapshot(10n, 2n);
    changedRoot.snapshot.proposal.data[225] = 1;
    expect(() => verifyDualVoteSnapshots([first.snapshot, changedRoot.snapshot], first.expected)).toThrow("VOTE_RPC_DISAGREEMENT");
    const changedCommitment = activeSnapshot(12n, 0n);
    changedCommitment.snapshot.config.data.writeBigUInt64LE(11n, 297);
    expect(() => verifyDualVoteSnapshots([first.snapshot, changedCommitment.snapshot], first.expected)).toThrow();
    const sameWrongCommitted = activeSnapshot(12n, 0n);
    first.snapshot.vault.data.writeBigUInt64LE(12n, 64);
    first.snapshot.config.data.writeBigUInt64LE(11n, 297);
    sameWrongCommitted.snapshot.config.data.writeBigUInt64LE(11n, 297);
    expect(() => verifyDualVoteSnapshots([first.snapshot, sameWrongCommitted.snapshot], first.expected)).toThrow("VOTE_COMMITMENT_MISMATCH");
    const invalidTally = activeSnapshot(10n, 2n);
    invalidTally.snapshot.proposal.data.writeBigUInt64LE(3n, 293 + 2 * 53 + 6 * 16);
    expect(() => verifyDualVoteSnapshots([activeSnapshot().snapshot, invalidTally.snapshot], first.expected)).toThrow("VOTE_PROPOSAL_TALLY_INVALID");
    const changedFloor = activeSnapshot();
    changedFloor.snapshot.proposal.data.writeBigUInt64LE(2n, 391);
    expect(() => verifyDualVoteSnapshots([activeSnapshot().snapshot, changedFloor.snapshot], first.expected))
      .toThrow("VOTE_RPC_DISAGREEMENT");
  });

  it("checks the finalized proposal identity, active status, option and vote window", () => {
    const expected = { program, proposal, id, config, capitalMint, reserveVault, optionIndex: 1 };
    expect(() => inspectActiveVoteProposal(proposalBytes(), expected)).not.toThrow();
    expect(() => inspectActiveVoteProposal(proposalBytes(2, 1), expected)).toThrow();
    expect(() => inspectActiveVoteProposal(proposalBytes(2, 6), expected)).not.toThrow();
    expect(() => inspectActiveVoteProposal(proposalBytes(2, 0), { ...expected, optionIndex: 2 })).toThrow();
    const wrongMint = proposalBytes();
    Keypair.generate().publicKey.toBuffer().copy(wrongMint, 41);
    expect(() => inspectActiveVoteProposal(wrongMint, expected)).toThrow();
    const future = proposalBytes();
    future.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 100), 113);
    expect(() => inspectActiveVoteProposal(future, expected)).toThrow();
  });

  it("does not permit a general transaction relay or preflight bypass", () => {
    const valid = { jsonrpc: "2.0", id: 1, method: "sendTransaction",
      params: [signed().toString("base64"), { encoding: "base64", skipPreflight: false,
        preflightCommitment: "finalized", maxRetries: 0 }] };
    expect(validateVoteRpcRequest(valid)).toBe(true);
    expect(validateVoteRpcRequest([valid])).toBe(false);
    expect(validateVoteRpcRequest({ ...valid, method: "simulateTransaction" })).toBe(false);
    expect(validateVoteRpcRequest({ ...valid, params: [valid.params[0], { encoding: "base64", skipPreflight: true }] })).toBe(false);
    expect(validateVoteRpcRequest({ ...valid, params: [valid.params[0], { encoding: "base58" }] })).toBe(false);
    expect(validateVoteRpcRequest({ ...valid, params: [valid.params[0], { encoding: "base64", maxRetries: 5 }] })).toBe(false);
    expect(validateVoteRpcRequest({ ...valid, params: [valid.params[0], { encoding: "base64", minContextSlot: 10 }] })).toBe(false);
  });

  it("bounds per-client and concurrent requests", () => {
    const limiter = new GovernanceVoteLimiter();
    const first = limiter.acquire("client", 1);
    const second = limiter.acquire("client", 1);
    expect(first && second).toBeTruthy();
    expect(limiter.acquire("client", 1)).toBeUndefined();
    first?.(); second?.();
    expect(limiter.acquire("client", 1)).toBeTypeOf("function");
    expect(limiter.acquire("client", 1)).toBeUndefined();
  });
});
