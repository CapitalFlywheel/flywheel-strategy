import { afterEach, describe, expect, it, vi } from "vitest";
import { ammCreatorVaultPda, creatorVaultPda, OnlinePumpSdk, quoteAta } from "@pump-fun/pump-sdk";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { readCustomQuoteCreatorFeeBalances } from "./pumpFees";

const mint = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";

function tokenAccount(mintKey: PublicKey, authority: PublicKey, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mintKey.toBuffer().copy(data, 0);
  authority.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1; // initialized token account
  return { data, executable: false, lamports: 2_000_000, owner: TOKEN_2022_PROGRAM_ID, rentEpoch: 0 };
}

afterEach(() => vi.restoreAllMocks());

describe("fixed-quote creator fee vault balances", () => {
  it("reads both canonical MSTRx vault ATAs even when the SDK's supported-quote listing is empty", async () => {
    const creator = Keypair.generate().publicKey;
    const quoteMint = new PublicKey(mint);
    const curveAuthority = creatorVaultPda(creator);
    const ammAuthority = ammCreatorVaultPda(creator);
    const read = vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockResolvedValue([
      tokenAccount(quoteMint, curveAuthority, 123n),
      tokenAccount(quoteMint, ammAuthority, 456n),
    ]);
    const oldListedQuoteRead = vi.spyOn(OnlinePumpSdk.prototype, "getCreatorVaultQuoteBalances").mockResolvedValue([]);

    const result = await readCustomQuoteCreatorFeeBalances({
      rpcUrl: "https://rpc.example", creator: creator.toBase58(), quoteMint: mint,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    });

    expect(result).toEqual({ curveRaw: 123n, pumpSwapRaw: 456n, totalRaw: 579n });
    expect(read).toHaveBeenCalledWith([
      quoteAta(curveAuthority, quoteMint, TOKEN_2022_PROGRAM_ID),
      quoteAta(ammAuthority, quoteMint, TOKEN_2022_PROGRAM_ID),
    ], "finalized");
    expect(oldListedQuoteRead).not.toHaveBeenCalled();
  });

  it("treats absent canonical vault ATAs as zero", async () => {
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockResolvedValue([null, null]);
    const result = await readCustomQuoteCreatorFeeBalances({
      rpcUrl: "https://rpc.example", creator: Keypair.generate().publicKey.toBase58(), quoteMint: mint,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    });
    expect(result).toEqual({ curveRaw: 0n, pumpSwapRaw: 0n, totalRaw: 0n });
  });

  it("rejects a vault owned by a different token authority", async () => {
    const creator = Keypair.generate().publicKey;
    const quoteMint = new PublicKey(mint);
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockResolvedValue([
      tokenAccount(quoteMint, Keypair.generate().publicKey, 123n), null,
    ]);
    await expect(readCustomQuoteCreatorFeeBalances({
      rpcUrl: "https://rpc.example", creator: creator.toBase58(), quoteMint: mint,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    })).rejects.toThrow("PUMP_MSTRX_FEE_VAULT_INVALID");
  });
});
