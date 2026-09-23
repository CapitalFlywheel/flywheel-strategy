# Solana production handoff

## Current boundary

The repository is prepared for a Solana launch but is not authorized for mainnet activation

The CAPITAL mint, project Solana wallets, production RPC endpoints and new X account are intentionally absent

## Values required from the owner

- Solana owner public key
- Pump creator public key if different from the owner
- Separately funded operator, holder-settlement and reserve public keys
- A mint-wide finalized transfer-history provider and its protected server credential; the current adapter requires Bitquery access with sufficient realtime throughput and a historical backfill procedure
- Marketing public key if the governance module uses one
- Primary and independent fallback Solana RPC endpoints
- New X account URL

Only public keys enter public configuration. Secrets remain in protected server environment files or service-specific keypair paths

The current adapter refuses a Bitquery realtime gap longer than six hours. This is a fail-closed boundary, not an automatic historical repair. Confirm provider coverage and a paid or otherwise reliable backfill route before approving mainnet payouts

The reserve wallet supplies only a public address. Its private key must not be installed on the server. The owner wallet similarly signs only through the private panel and is never imported into a container

## Mandatory rehearsal

Use disposable devnet or isolated test identities. Do not use the production creator wallet for rehearsal

Evidence must cover

1. Exact launch configuration validation
2. Detection and automatic activation of only the intended creator mint after one pre-launch arm signature
3. Both Pump creator-fee sweep paths
4. Exact 60/40 receipt conservation
5. Exact MSTRx 60/40 routing with transfer-hook accounts
6. Fully funded holder epoch creation
7. Automatic payout to wallets with and without an existing MSTRx token account
8. Crash and restart during a batch without duplicate payout
9. RPC disagreement stopping accounting
10. Recovery limited to uncommitted balances
11. Creator-wallet pre-existing MSTRx remaining untouched while only the confirmed collection delta is routed
12. Public site, Solscan links and heartbeats matching runtime state
13. Holder transfer-source overlap, outage, and historical backfill without a missing wallet movement
14. Pump-to-PumpSwap migration with no fee-receipt duplication and no pool wallet receiving a holder payout

## Release checks

```bash
npm ci
npm run security:secrets
npm run test:solana
npm run test:web
npm run web:build
```

Any custom Solana custody or governance program requires an independent external review before public claims or mainnet funding

The current production dependency audit reports no critical advisories but does report high and moderate transitive advisories in the official Pump and Solana SDK tree. Do not force the suggested downgrade to Pump SDK 1.1 because it removes the V2 custom-pair interface required by this design. Review and pin an upstream-fixed release before final sign-off, or document a scoped security acceptance after independent review

## Go-live sign-off

Do not activate until all final public addresses are inserted, every service starts from empty Solana state, both RPC providers agree, Token-2022 transfer-hook transfers simulate successfully and public documentation matches deployed behavior

After activation, archive the signed manifest, verified public keys, build commit, test results, external review, server configuration checksum and first end-to-end receipt evidence in the protected handoff location
