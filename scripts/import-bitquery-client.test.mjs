import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseDotenv } from "dotenv";
import { prepareBitqueryEnv } from "./lib/bitqueryImportEnv.mjs";

const oldContent = [
  "SOLANA_CLUSTER=mainnet-beta",
  'BITQUERY_CLIENT_ID="old-client-id"',
  'BITQUERY_CLIENT_SECRET="old-client-secret"',
  'BITQUERY_API_KEY="old-api-key"',
  "OTHER_SETTING=preserved",
  "",
].join("\n");

test("static API token clears OAuth credentials and preserves other environment values", () => {
  const apiKey = "static-test-token-123";
  const { nextContent, status } = prepareBitqueryEnv({ apiKey }, oldContent);
  const parsed = parseDotenv(nextContent);
  assert.equal(status, "BITQUERY_API_KEY_INSTALLED");
  assert.equal(parsed.BITQUERY_API_KEY, apiKey);
  assert.equal(parsed.BITQUERY_CLIENT_ID, "");
  assert.equal(parsed.BITQUERY_CLIENT_SECRET, "");
  assert.equal(parsed.SOLANA_CLUSTER, "mainnet-beta");
  assert.equal(parsed.OTHER_SETTING, "preserved");
  assert.equal((nextContent.match(/^BITQUERY_API_KEY=/gm) ?? []).length, 1);
});

test("OAuth credentials clear static API token", () => {
  const clientId = "new-client-id";
  const clientSecret = "new-client-secret";
  const { nextContent, status } = prepareBitqueryEnv({ clientId, clientSecret }, oldContent);
  const parsed = parseDotenv(nextContent);
  assert.equal(status, "BITQUERY_CREDENTIALS_INSTALLED");
  assert.equal(parsed.BITQUERY_CLIENT_ID, clientId);
  assert.equal(parsed.BITQUERY_CLIENT_SECRET, clientSecret);
  assert.equal(parsed.BITQUERY_API_KEY, "");
});

test("static token cannot be combined with OAuth fields", () => {
  assert.throws(
    () => prepareBitqueryEnv({ apiKey: "static-token", clientId: "client-id" }, oldContent),
    { message: "BITQUERY_API_KEY_INVALID" },
  );
});

test("short, empty and whitespace-bearing static tokens are rejected", () => {
  for (const apiKey of ["", "short", "token\nother", "token\rother", "Bearer token-value", " token-value"]) {
    assert.throws(() => prepareBitqueryEnv({ apiKey }, oldContent), { message: "BITQUERY_API_KEY_INVALID" });
  }
});
