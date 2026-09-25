import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";

export interface OrderedTokenMovement {
  instructionIndex: number;
  from?: string;
  to?: string;
  rawAmount: string;
}

interface TokenAccountState {
  mint: string;
  owner: string;
  before?: bigint;
  after?: bigint;
  current: bigint;
  live: boolean;
  initialized: boolean;
  closed: boolean;
}

const tokenPrograms = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
const inertTokenInstructions = new Set([
  "approve", "approveChecked", "revoke", "freezeAccount", "thawAccount", "initializeImmutableOwner",
  "getAccountDataSize", "initializeMint", "initializeMint2", "initializeMultisig", "initializeMultisig2",
  "reallocate", "withdrawExcessLamports", "amountToUiAmount", "uiAmountToAmount", "createNativeMint",
  // Mint/extension setup changes configuration, not raw token-account units.
  // Unknown extensions remain blocked; a fee-bearing transfer must still
  // reconcile exactly against each affected token account below.
  "initializeMintCloseAuthority", "initializePermanentDelegate", "initializeNonTransferableMint",
  "initializeMetadataPointer", "initializeGroupPointer", "initializeGroupMemberPointer",
  "initializeTransferHook", "initializeTransferFeeConfig", "initializePausableConfig",
]);

function address(value: unknown, error: string) {
  if (typeof value !== "string") throw new Error(error);
  try { return new PublicKey(value).toBase58(); }
  catch { throw new Error(error); }
}

function rawAmount(value: unknown) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("ORDERED_TOKEN_AMOUNT_INVALID");
  const amount = BigInt(value);
  if (amount > 0xffff_ffff_ffff_ffffn) throw new Error("ORDERED_TOKEN_AMOUNT_INVALID");
  return amount;
}

function instructionAmount(info: Record<string, unknown>) {
  const tokenAmount = info.tokenAmount;
  if (tokenAmount !== undefined && (typeof tokenAmount !== "object" || tokenAmount === null)) {
    throw new Error("ORDERED_TOKEN_AMOUNT_INVALID");
  }
  return rawAmount(info.amount ?? (tokenAmount as Record<string, unknown> | undefined)?.amount);
}

/**
 * Reconstruct token movements in execution order, including CPI instructions.
 * Post/pre balance differences alone erase sell-and-rebuy round trips and can
 * silently preserve a holder's old acquisition lot after the sale.
 */
export function orderedTokenMovements(transaction: ParsedTransactionWithMeta, targetMint: string): OrderedTokenMovement[] {
  if (!transaction.meta || transaction.meta.err) throw new Error("TOKEN_TRANSACTION_FAILED");
  if (!Array.isArray(transaction.meta.preTokenBalances) || !Array.isArray(transaction.meta.postTokenBalances)
    || !Array.isArray(transaction.meta.innerInstructions)) throw new Error("ORDERED_TOKEN_METADATA_MISSING");
  const mint = address(targetMint, "ORDERED_TOKEN_MINT_INVALID");
  const keys = transaction.transaction.message.accountKeys.map((row) => row.pubkey.toBase58());
  const accounts = new Map<string, TokenAccountState>();
  for (const [rows, side] of [
    [transaction.meta.preTokenBalances, "before"], [transaction.meta.postTokenBalances, "after"],
  ] as const) {
    for (const row of rows) {
      const account = keys[row.accountIndex];
      if (!account) throw new Error("ORDERED_TOKEN_BALANCE_ACCOUNT_INVALID");
      const rowMint = address(row.mint, "ORDERED_TOKEN_BALANCE_MINT_INVALID");
      if (!row.owner) throw new Error("ORDERED_TOKEN_BALANCE_OWNER_MISSING");
      const owner = address(row.owner, "ORDERED_TOKEN_BALANCE_OWNER_INVALID");
      const amount = rawAmount(row.uiTokenAmount.amount);
      let state = accounts.get(account);
      if (!state) {
        state = { mint: rowMint, owner, current: 0n, live: false, initialized: false, closed: false };
        accounts.set(account, state);
      }
      if (state.mint !== rowMint || state.owner !== owner || state[side] !== undefined) {
        throw new Error("ORDERED_TOKEN_BALANCE_IDENTITY_CONFLICT");
      }
      state[side] = amount;
      if (side === "before") { state.current = amount; state.live = true; }
    }
  }

  const movements: OrderedTokenMovement[] = [];
  const append = (from: string | undefined, to: string | undefined, amount: bigint) => {
    if (amount > 0n) movements.push({ instructionIndex: movements.length, from, to, rawAmount: amount.toString() });
  };
  const accountState = (value: unknown) => accounts.get(address(value, "ORDERED_TOKEN_ACCOUNT_INVALID"));
  const liveAccount = (value: unknown) => {
    const state = accountState(value);
    if (!state || !state.live || state.closed) throw new Error("ORDERED_TOKEN_ACCOUNT_UNKNOWN");
    return state;
  };
  const checkMint = (state: TokenAccountState, expected: string) => {
    if (state.mint !== expected) throw new Error("ORDERED_TOKEN_MINT_MISMATCH");
  };
  const transfer = (info: Record<string, unknown>, checked: boolean) => {
    const sourceAddress = address(info.source, "ORDERED_TOKEN_ACCOUNT_INVALID");
    const destinationAddress = address(info.destination, "ORDERED_TOKEN_ACCOUNT_INVALID");
    const source = liveAccount(sourceAddress);
    const destination = liveAccount(destinationAddress);
    if (source.mint !== destination.mint) throw new Error("ORDERED_TOKEN_MINT_MISMATCH");
    if (checked) checkMint(source, address(info.mint, "ORDERED_TOKEN_MINT_INVALID"));
    if (source.mint !== mint) return;
    const amount = instructionAmount(info);
    if (source.current < amount) throw new Error("ORDERED_TOKEN_BALANCE_UNDERFLOW");
    if (sourceAddress !== destinationAddress) {
      source.current -= amount;
      destination.current += amount;
    }
    append(source.owner, destination.owner, amount);
  };
  const mintTo = (info: Record<string, unknown>) => {
    const instructionMint = address(info.mint, "ORDERED_TOKEN_MINT_INVALID");
    const destination = liveAccount(info.account);
    checkMint(destination, instructionMint);
    if (instructionMint !== mint) return;
    const amount = instructionAmount(info);
    destination.current += amount;
    append(undefined, destination.owner, amount);
  };
  const burn = (info: Record<string, unknown>) => {
    const instructionMint = address(info.mint, "ORDERED_TOKEN_MINT_INVALID");
    const source = liveAccount(info.account);
    checkMint(source, instructionMint);
    if (instructionMint !== mint) return;
    const amount = instructionAmount(info);
    if (source.current < amount) throw new Error("ORDERED_TOKEN_BALANCE_UNDERFLOW");
    source.current -= amount;
    append(source.owner, undefined, amount);
  };
  const initializeAccount = (info: Record<string, unknown>) => {
    const account = address(info.account, "ORDERED_TOKEN_ACCOUNT_INVALID");
    const rowMint = address(info.mint, "ORDERED_TOKEN_MINT_INVALID");
    const owner = address(info.owner, "ORDERED_TOKEN_OWNER_INVALID");
    let state = accounts.get(account);
    if (!state) {
      state = { mint: rowMint, owner, current: 0n, live: false, initialized: false, closed: false };
      accounts.set(account, state);
    }
    if (state.mint !== rowMint || state.owner !== owner || state.live || state.initialized || state.closed) {
      throw new Error("ORDERED_TOKEN_ACCOUNT_INITIALIZATION_CONFLICT");
    }
    state.live = true;
    state.initialized = true;
  };
  const processInstruction = (instruction: (typeof transaction.transaction.message.instructions)[number]) => {
    if (!tokenPrograms.has(instruction.programId.toBase58())) return;
    if (!("parsed" in instruction) || typeof instruction.parsed !== "object" || instruction.parsed === null) {
      throw new Error("ORDERED_TOKEN_INSTRUCTION_UNPARSED");
    }
    const parsed = instruction.parsed as { type?: unknown; info?: unknown };
    if (typeof parsed.type !== "string" || typeof parsed.info !== "object" || parsed.info === null) {
      throw new Error("ORDERED_TOKEN_INSTRUCTION_INVALID");
    }
    const info = parsed.info as Record<string, unknown>;
    switch (parsed.type) {
      case "initializeAccount": case "initializeAccount2": case "initializeAccount3": initializeAccount(info); break;
      case "transfer": transfer(info, false); break;
      case "transferChecked": transfer(info, true); break;
      case "mintTo": case "mintToChecked": mintTo(info); break;
      case "burn": case "burnChecked": burn(info); break;
      case "closeAccount": {
        const state = accountState(info.account);
        if (!state) break; // An unrelated account with no token-balance metadata.
        if (!state.live || state.closed) throw new Error("ORDERED_TOKEN_ACCOUNT_CLOSE_INVALID");
        if (state.mint === mint && state.current !== 0n) throw new Error("ORDERED_TOKEN_ACCOUNT_CLOSE_NONZERO");
        state.live = false;
        state.closed = true;
        break;
      }
      case "syncNative": {
        if (accountState(info.account)?.mint === mint) throw new Error("ORDERED_TOKEN_SYNC_NATIVE_TARGET");
        break;
      }
      case "setAuthority": {
        const value = info.account ?? info.mint;
        if (value === mint || accountState(value)?.mint === mint) throw new Error("ORDERED_TOKEN_TARGET_AUTHORITY_CHANGE");
        break;
      }
      default:
        if (!inertTokenInstructions.has(parsed.type)) throw new Error("ORDERED_TOKEN_INSTRUCTION_UNSUPPORTED");
    }
  };

  const innerByOuter = new Map<number, typeof transaction.meta.innerInstructions[number]["instructions"]>();
  const outer = transaction.transaction.message.instructions;
  for (const group of transaction.meta.innerInstructions) {
    if (!Number.isSafeInteger(group.index) || group.index < 0 || group.index >= outer.length || innerByOuter.has(group.index)) {
      throw new Error("ORDERED_TOKEN_INNER_GROUP_INVALID");
    }
    innerByOuter.set(group.index, group.instructions);
  }
  for (let index = 0; index < outer.length; index += 1) {
    const start = movements.length;
    processInstruction(outer[index]);
    const afterOuter = movements.length;
    for (const inner of innerByOuter.get(index) ?? []) processInstruction(inner);
    // A Token-2022 transfer hook can invoke another token transfer. Parsed
    // metadata does not locate the parent's balance mutation relative to its
    // CPI, so never invent an ordering between two target movements.
    if (afterOuter > start && movements.length > afterOuter) throw new Error("ORDERED_TOKEN_NESTED_ORDER_AMBIGUOUS");
  }
  for (const state of accounts.values()) {
    if (state.mint !== mint) continue;
    if (state.after !== undefined) {
      if (!state.live || state.current !== state.after) throw new Error("ORDERED_TOKEN_DELTA_MISMATCH");
    } else if (state.live || state.current !== 0n || !state.closed) {
      throw new Error("ORDERED_TOKEN_DELTA_MISMATCH");
    }
  }
  return movements;
}
