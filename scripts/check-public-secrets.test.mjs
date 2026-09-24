import assert from "node:assert/strict";
import test from "node:test";
import { rules } from "./lib/publicSecretPatterns.mjs";

const patternFor = (name) => {
  const rule = rules.find((item) => item.name === name);
  assert.ok(rule, `missing rule: ${name}`);
  return rule.pattern;
};

const sample = "a".repeat(24) + "9".repeat(16);

test("detects provider credentials without storing a credential in the test source", () => {
  const cases = [
    ["Bitquery credential assignment", "BITQUERY_API_KEY=" + sample],
    ["Bitquery credential assignment", 'BITQUERY_CLIENT_SECRET: "' + sample + '"'],
    ["Helius credential assignment", "HELIUS_API_KEY=" + sample],
    ["QuickNode credential URL", "https://example.quiknode.pro/" + sample + "/"],
    ["Alchemy credential URL", "https://solana-mainnet.g.alchemy.com/v2/" + sample],
    ["credential in URL query", "https://mainnet.helius-rpc.com/?api-key=" + sample],
    ["credential in URL authority", "https://operator:" + sample + "@rpc.example"],
  ];

  for (const [name, value] of cases) {
    assert.match(value, patternFor(name), name);
  }
});

test("detects JWT-shaped Bitquery bearer tokens", () => {
  const jwt = "eyJ" + "a".repeat(24) + "." + "eyJ" + "b".repeat(24) + "." + "c".repeat(24);
  assert.match(jwt, patternFor("JWT credential"));
});

test("does not flag placeholders or environment references", () => {
  const cases = [
    ["Bitquery credential assignment", "BITQUERY_API_KEY=process.env.BITQUERY_API_KEY"],
    ["Bitquery credential assignment", "BITQUERY_CLIENT_SECRET=YOUR_BITQUERY_CLIENT_SECRET"],
    ["Helius credential assignment", "HELIUS_API_KEY=YOUR_HELIUS_API_KEY"],
    ["QuickNode credential URL", "https://example.quiknode.pro/<credential>/"],
    ["Alchemy credential URL", "https://solana-mainnet.g.alchemy.com/v2/<credential>"],
    ["credential in URL query", "https://mainnet.helius-rpc.com/?api-key=<credential>"],
  ];

  for (const [name, value] of cases) {
    assert.doesNotMatch(value, patternFor(name), name);
  }
});
