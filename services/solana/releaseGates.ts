// Source-controlled release gate. An immutable ProgramData hash alone does not
// prove that every voted reserve action is implemented and safe to execute.
// Keep launch detection and activation off until the complete governor,
// client routes, validator tests and independent review are finished.
export const SOLANA_GOVERNANCE_EXECUTION_RELEASED = false;

export function requireGovernanceExecutionReleased() {
  if (!SOLANA_GOVERNANCE_EXECUTION_RELEASED) throw new Error("GOVERNANCE_EXECUTION_NOT_RELEASED");
}
