import { PublicKey } from "@solana/web3.js";

export interface SolanaWalletRoles {
  owner: PublicKey;
  creator: PublicKey;
  operator: PublicKey;
  holder: PublicKey;
  reserve: PublicKey;
  recovery: PublicKey;
}

export function assertSolanaWalletRoles(roles: SolanaWalletRoles, sharedAdminCreator: boolean) {
  const { owner, creator, operator, holder, reserve, recovery } = roles;
  if (sharedAdminCreator) {
    if (!owner.equals(creator)) throw new Error("SHARED_ADMIN_CREATOR_MISMATCH");
    if (!owner.equals(recovery)) throw new Error("SHARED_ADMIN_RECOVERY_MISMATCH");
  } else if (owner.equals(creator)) {
    throw new Error("OPERATIONAL_ROLE_NOT_ISOLATED");
  }

  // Fee ingress, distribution inventory, gas funding and reserve custody
  // remain separate even when the user explicitly shares admin and creator.
  if ([operator, holder, reserve].some((key) => key.equals(owner))) throw new Error("OPERATIONAL_ROLE_NOT_ISOLATED");
  if ([operator, holder, reserve].some((key) => key.equals(creator))) throw new Error("OPERATIONAL_ROLE_NOT_ISOLATED");
  if (operator.equals(holder) || operator.equals(reserve) || holder.equals(reserve)) throw new Error("OPERATIONAL_ROLE_NOT_ISOLATED");
  if (holder.equals(recovery) || reserve.equals(recovery)) throw new Error("OPERATIONAL_DESTINATION_DUPLICATE");
  return true;
}

export function sharedAdminCreatorEnabled(value: string | undefined) {
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error("SHARED_ADMIN_CREATOR_FLAG_INVALID");
}
