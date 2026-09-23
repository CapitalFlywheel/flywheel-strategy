import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { assertSolanaWalletRoles, sharedAdminCreatorEnabled } from "./walletRoles";

const address = () => Keypair.generate().publicKey;

describe("Solana wallet roles", () => {
  const roles = () => ({
    owner: address(),
    creator: address(),
    operator: address(),
    holder: address(),
    reserve: address(),
    recovery: address(),
  });

  it("accepts one user-controlled admin, creator and recovery wallet when explicitly enabled", () => {
    const configured = roles();
    configured.creator = configured.owner;
    configured.recovery = configured.owner;
    expect(assertSolanaWalletRoles(configured, true)).toBe(true);
  });

  it("does not silently combine admin and creator without opt-in", () => {
    const configured = roles();
    configured.creator = configured.owner;
    expect(() => assertSolanaWalletRoles(configured, false)).toThrow("OPERATIONAL_ROLE_NOT_ISOLATED");
  });

  it("requires recovery to return to the user wallet in shared mode", () => {
    const configured = roles();
    configured.creator = configured.owner;
    expect(() => assertSolanaWalletRoles(configured, true)).toThrow("SHARED_ADMIN_RECOVERY_MISMATCH");
  });

  it("keeps reward inventory, reserve and gas payer apart from the shared wallet", () => {
    const configured = roles();
    configured.creator = configured.owner;
    configured.recovery = configured.owner;
    configured.holder = configured.owner;
    expect(() => assertSolanaWalletRoles(configured, true)).toThrow("OPERATIONAL_ROLE_NOT_ISOLATED");
  });

  it("keeps the service and reserve destinations distinct", () => {
    const configured = roles();
    configured.operator = configured.holder;
    expect(() => assertSolanaWalletRoles(configured, false)).toThrow("OPERATIONAL_ROLE_NOT_ISOLATED");
  });

  it("rejects an ambiguous opt-in flag", () => {
    expect(sharedAdminCreatorEnabled("true")).toBe(true);
    expect(sharedAdminCreatorEnabled("false")).toBe(false);
    expect(sharedAdminCreatorEnabled(undefined)).toBe(false);
    expect(() => sharedAdminCreatorEnabled("yes")).toThrow("SHARED_ADMIN_CREATOR_FLAG_INVALID");
  });
});
