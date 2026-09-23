# Solana production handoff

## Readiness snapshot · 23 September 2026

- Repository branch `solana-mstrx` contains the Solana web UI, private signed-action panel, two-RPC launch validation, durable fee settlement, mint-wide holder journal, restart-aware direct MSTRx payout code, and a dual-RPC-checked public vault snapshot
- Local TypeScript, Solana tests, web tests, web build and publishable-file secret scan pass
- The public domain responds, but this repository revision has not been installed on the VPS; the existing deploy SSH key is currently rejected by the server
- No Solana production wallet roles, authenticated RPC URLs, Bitquery credential, new X link, or CAPITAL mint have been configured
- No mainnet fee sweep, 60/40 transfer, holder payout, or PumpSwap migration has been verified end to end
- Solana reserve governance is not implemented or audited; the public voting interface is inactive
- The current upstream dependency audit reports 8 high and 4 moderate production advisories and no critical advisory. The suggested automated major downgrades are incompatible with the required Pump V2 path, so independent review or an upstream fix is still required

Do not describe the code as live automation or a completed mainnet launch from local test results

## Current boundary

The repository is prepared for a Solana launch but is not authorized for mainnet activation

The CAPITAL mint, project Solana wallets, production RPC endpoints and new X account are intentionally absent

## Values required from the owner

- Solana owner public key
- Pump creator public key if different from the owner
- Separately funded operator, holder-settlement, reserve and recovery public keys
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
