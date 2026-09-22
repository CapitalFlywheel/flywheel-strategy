import { describe, expect, it } from "vitest";
import { isSolanaPublicKey, shortPublicKey } from "./wallets";

describe("Solana wallet helpers", () => {
  it("accepts valid Solana public keys", () => {
    expect(isSolanaPublicKey("So11111111111111111111111111111111111111112")).toBe(true);
  });

  it("rejects EVM and malformed addresses", () => {
    expect(isSolanaPublicKey("0xfB8199AA97913c0494A600B725C634527dD47fa4")).toBe(false);
    expect(isSolanaPublicKey("not-a-wallet")).toBe(false);
  });

  it("shortens a public key without changing its ends", () => {
    expect(shortPublicKey("XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ")).toBe("XsP7x…dxxyZ");
  });
});
