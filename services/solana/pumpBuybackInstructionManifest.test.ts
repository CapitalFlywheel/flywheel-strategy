import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import pumpIdl from "../../node_modules/@pump-fun/pump-sdk/src/idl/pump.json";
import pumpAmmIdl from "../../node_modules/@pump-fun/pump-sdk/src/idl/pump_amm.json";
import swapSdkIdl from "../../node_modules/@pump-fun/pump-swap-sdk/src/idl/pump_amm.json";
import { assertBuybackInstructionMatchesManifest, BUYBACK_QUOTE_MINT,
  createBuybackInstructionManifest, CURVE_BUY_ACCOUNT_LAYOUT, PUMPSWAP_BUY_ACCOUNT_LAYOUT,
  PUMP_BUYBACK_PROGRAM, PUMP_CURVE_BUY_DISCRIMINATOR, PUMPSWAP_BUYBACK_PROGRAM,
  PUMPSWAP_BUY_DISCRIMINATOR, PUMP_FEE_PROGRAM, type BuybackManifestRequest } from "./pumpBuybackInstructionManifest";

const address = (byte: number) => new PublicKey(Buffer.alloc(32, byte)).toBase58();
const capitalMint = address(7);
const trader = address(8);
const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(capitalMint).toBuffer()], PUMP_BUYBACK_PROGRAM)[0];
const poolAuthority = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), new PublicKey(capitalMint).toBuffer()], PUMP_BUYBACK_PROGRAM)[0];
const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.from([0, 0]),
  poolAuthority.toBuffer(), new PublicKey(capitalMint).toBuffer(), BUYBACK_QUOTE_MINT.toBuffer()], PUMPSWAP_BUYBACK_PROGRAM)[0];

const curveRequest = (): BuybackManifestRequest => ({
  phase: "curve", capitalMint, capitalTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), trader,
  committedQuoteRaw: 500n, votedMinOutputRaw: 10n, executionMinOutputRaw: 12n,
  venueState: {
    phase: "curve", bondingCurveAddress: curve.toBase58(), bondingCurveOwner: PUMP_BUYBACK_PROGRAM.toBase58(),
    complete: false, curveBaseMint: capitalMint, curveQuoteMint: BUYBACK_QUOTE_MINT.toBase58(),
    creator: address(9), feeRecipient: address(10), buybackFeeRecipient: address(11),
  },
});

const swapRequest = (): BuybackManifestRequest => ({
  ...curveRequest(), phase: "pumpSwap",
  venueState: {
    phase: "pumpSwap", bondingCurveComplete: true, poolAddress: pool.toBase58(),
    poolOwner: PUMPSWAP_BUYBACK_PROGRAM.toBase58(), poolIndex: 0,
    poolCreator: poolAuthority.toBase58(), poolBaseMint: capitalMint,
    poolQuoteMint: BUYBACK_QUOTE_MINT.toBase58(), coinCreator: address(12),
    protocolFeeRecipient: address(13),
  },
});

function candidate(request: BuybackManifestRequest): TransactionInstruction {
  const manifest = createBuybackInstructionManifest(request);
  return new TransactionInstruction({
    programId: new PublicKey(manifest.programId),
    keys: manifest.accounts.map((account) => ({
      pubkey: new PublicKey(account.address), isWritable: account.isWritable, isSigner: account.isSigner,
    })),
    data: Buffer.from(manifest.dataHex, "hex"),
  });
}

describe("Pump exact-quote-in buyback instruction manifest", () => {
  it("pins both official installed IDLs: program, discriminator, exact account order/privileges and arguments", () => {
    const pairs = [
      [pumpIdl, "buy_exact_quote_in_v2", PUMP_BUYBACK_PROGRAM, PUMP_CURVE_BUY_DISCRIMINATOR,
        CURVE_BUY_ACCOUNT_LAYOUT, ["spendable_quote_in", "min_tokens_out"]],
      [pumpAmmIdl, "buy_exact_quote_in", PUMPSWAP_BUYBACK_PROGRAM, PUMPSWAP_BUY_DISCRIMINATOR,
        PUMPSWAP_BUY_ACCOUNT_LAYOUT, ["spendable_quote_in", "min_base_amount_out", "track_volume"]],
    ] as const;
    for (const [idl, instructionName, program, discriminator, layout, args] of pairs) {
      const instruction = idl.instructions.find((entry) => entry.name === instructionName);
      expect(idl.address).toBe(program.toBase58());
      expect(instruction).toBeDefined();
      expect(Buffer.from(instruction!.discriminator).toString("hex")).toBe(discriminator);
      expect(instruction!.accounts.map((account) => {
        const entry = account as { name: string; writable?: boolean; signer?: boolean };
        return [entry.name, entry.writable ?? false, entry.signer ?? false];
      }))
        .toEqual(layout);
      expect(instruction!.args.map((arg) => arg.name)).toEqual(args);
      expect(instruction!.args.slice(0, 2).map((arg) => arg.type)).toEqual(["u64", "u64"]);
      expect(instruction!.accounts.find((account) => account.name === "user")).toMatchObject({ writable: true, signer: true });
      const manifest = createBuybackInstructionManifest(instructionName === "buy_exact_quote_in_v2"
        ? curveRequest() : swapRequest());
      for (const fixed of instruction!.accounts as ReadonlyArray<{ name: string; address?: string }>) {
        if (fixed.address) {
          expect(manifest.accounts.find((account) => account.name === fixed.name)?.address).toBe(fixed.address);
        }
      }
    }
    expect(pumpAmmIdl.types.find((type) => type.name === "OptionBool")?.type)
      .toEqual({ kind: "struct", fields: ["bool"] });
    const fromSwapSdk = swapSdkIdl.instructions.find((entry) => entry.name === "buy_exact_quote_in");
    const fromPumpSdk = pumpAmmIdl.instructions.find((entry) => entry.name === "buy_exact_quote_in");
    expect(fromSwapSdk?.discriminator).toEqual(fromPumpSdk?.discriminator);
    expect(fromSwapSdk?.accounts.map((entry) => [entry.name, "writable" in entry && entry.writable === true,
      "signer" in entry && entry.signer === true]))
      .toEqual(fromPumpSdk?.accounts.map((entry) => [entry.name, "writable" in entry && entry.writable === true,
        "signer" in entry && entry.signer === true]));
    expect(fromSwapSdk?.args).toEqual(fromPumpSdk?.args);
  });

  it("pins critical official IDL derivation seeds as well as the account positions", () => {
    type Seed = { kind: string; path?: string; value?: number[] };
    type Derivation = { seeds: Seed[]; program?: { kind: string; value?: number[]; path?: string } };
    const derivation = (idl: typeof pumpIdl | typeof pumpAmmIdl, instructionName: string, accountName: string) =>
      idl.instructions.find((instruction) => instruction.name === instructionName)!.accounts
        .find((account) => account.name === accountName) as unknown as { pda: Derivation };
    const curve = "buy_exact_quote_in_v2";
    const swap = "buy_exact_quote_in";
    expect(derivation(pumpIdl, curve, "bonding_curve").pda.seeds)
      .toEqual([{ kind: "const", value: [...Buffer.from("bonding-curve")] }, { kind: "account", path: "base_mint" }]);
    const sharing = derivation(pumpIdl, curve, "sharing_config").pda;
    expect(sharing.seeds).toEqual([
      { kind: "const", value: [...Buffer.from("sharing-config")] }, { kind: "account", path: "base_mint" },
    ]);
    expect(sharing.program).toEqual({ kind: "const", value: [...PUMP_FEE_PROGRAM.toBytes()] });
    for (const [idl, instructionName, venue] of [
      [pumpIdl, curve, PUMP_BUYBACK_PROGRAM], [pumpAmmIdl, swap, PUMPSWAP_BUYBACK_PROGRAM],
    ] as const) {
      const fee = derivation(idl, instructionName, "fee_config").pda;
      expect(fee.seeds).toEqual([
        { kind: "const", value: [...Buffer.from("fee_config")] },
        { kind: "const", value: [...venue.toBytes()] },
      ]);
      expect(fee.program).toEqual({ kind: "account", path: "fee_program" });
    }
    expect(derivation(pumpAmmIdl, swap, "coin_creator_vault_authority").pda.seeds).toEqual([
      { kind: "const", value: [...Buffer.from("creator_vault")] },
      { kind: "account", path: "pool.coin_creator", account: "Pool" },
    ]);
  });

  it("accepts only exact account order, keys, privileges and payload in each phase", () => {
    for (const request of [curveRequest(), swapRequest()]) {
      const instruction = candidate(request);
      const manifest = assertBuybackInstructionMatchesManifest(instruction, request);
      expect(manifest.spendableQuoteInRaw).toBe("500");
      expect(manifest.minBaseOutputRaw).toBe("12");
      expect(instruction.data.readBigUInt64LE(8)).toBe(500n);
      expect(instruction.data.readBigUInt64LE(16)).toBe(12n);
      expect(instruction.data.length).toBe(request.phase === "curve" ? 24 : 25);
      if (request.phase === "pumpSwap") expect(instruction.data[24]).toBe(0);
    }
  });

  it("rejects a substituted account, wrong program, changed order, extra account and signer escalation", () => {
    const request = curveRequest();
    const substituted = candidate(request);
    substituted.keys[6].pubkey = new PublicKey(address(25));
    expect(() => assertBuybackInstructionMatchesManifest(substituted, request))
      .toThrow("BUYBACK_ACCOUNT_MISMATCH:fee_recipient");
    const wrongProgram = candidate(request);
    wrongProgram.programId = PUMPSWAP_BUYBACK_PROGRAM;
    expect(() => assertBuybackInstructionMatchesManifest(wrongProgram, request)).toThrow("BUYBACK_PROGRAM_MISMATCH");
    const reordered = candidate(request);
    [reordered.keys[0], reordered.keys[1]] = [reordered.keys[1], reordered.keys[0]];
    expect(() => assertBuybackInstructionMatchesManifest(reordered, request)).toThrow("BUYBACK_ACCOUNT_MISMATCH");
    const extra = candidate(request);
    extra.keys.push({ pubkey: new PublicKey(address(26)), isWritable: false, isSigner: false });
    expect(() => assertBuybackInstructionMatchesManifest(extra, request)).toThrow("BUYBACK_ACCOUNT_COUNT_MISMATCH");
    const escalated = candidate(request);
    escalated.keys[0].isSigner = true;
    expect(() => assertBuybackInstructionMatchesManifest(escalated, request)).toThrow("BUYBACK_ACCOUNT_MISMATCH:global");
  });

  it("rejects a phase mismatch, noncanonical curve/pool, zero or lowered output floor", () => {
    const curveInput = curveRequest();
    expect(() => createBuybackInstructionManifest({ ...curveInput, phase: "pumpSwap" })).toThrow("BUYBACK_PHASE_MISMATCH");
    expect(() => createBuybackInstructionManifest({ ...curveInput,
      venueState: { ...curveInput.venueState, bondingCurveAddress: address(21) },
    } as BuybackManifestRequest)).toThrow("BUYBACK_CURVE_IDENTITY_INVALID");
    expect(() => createBuybackInstructionManifest({ ...curveInput,
      venueState: { ...curveInput.venueState, curveQuoteMint: address(21) },
    } as BuybackManifestRequest)).toThrow("BUYBACK_CURVE_IDENTITY_INVALID");
    expect(() => createBuybackInstructionManifest({ ...curveInput,
      venueState: { ...curveInput.venueState, complete: true },
    } as unknown as BuybackManifestRequest)).toThrow("BUYBACK_CURVE_PHASE_INVALID");
    const swapInput = swapRequest();
    expect(() => createBuybackInstructionManifest({ ...swapInput,
      venueState: { ...swapInput.venueState, poolAddress: address(22) },
    } as BuybackManifestRequest)).toThrow("BUYBACK_POOL_IDENTITY_INVALID");
    expect(() => createBuybackInstructionManifest({ ...curveInput, executionMinOutputRaw: 0n }))
      .toThrow("BUYBACK_MIN_OUTPUT_INVALID");
    expect(() => createBuybackInstructionManifest({ ...curveInput, executionMinOutputRaw: 9n }))
      .toThrow("BUYBACK_MIN_OUTPUT_INVALID");
    expect(() => createBuybackInstructionManifest({ ...curveInput, committedQuoteRaw: 0n }))
      .toThrow("BUYBACK_COMMITMENT_INVALID");
  });

  it("rejects arbitrary CPI payload, even with a correct selector and account list", () => {
    const request = swapRequest();
    const arbitrary = candidate(request);
    arbitrary.data[8] = 0xff;
    expect(() => assertBuybackInstructionMatchesManifest(arbitrary, request)).toThrow("BUYBACK_PAYLOAD_MISMATCH");
    const volume = candidate(request);
    volume.data[24] = 1;
    expect(() => assertBuybackInstructionMatchesManifest(volume, request)).toThrow("BUYBACK_PAYLOAD_MISMATCH");
    const trailing = candidate(request);
    trailing.data = Buffer.concat([trailing.data, Buffer.from([0])]);
    expect(() => assertBuybackInstructionMatchesManifest(trailing, request)).toThrow("BUYBACK_PAYLOAD_MISMATCH");
  });
});
