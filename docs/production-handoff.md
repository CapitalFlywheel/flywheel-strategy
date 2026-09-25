# Solana production handoff

## Verification standard

A working website, passing local tests or a read-only RPC check is **not** evidence of a live fee-to-holder payout cycle. Verify creator-fee collection, 60/40 routing, direct holder payouts and PumpSwap migration from finalized transactions before describing them as observed behavior

Public voting is not part of the owner-wallet launch route. The user-controlled reserve wallet cannot provide binding holder votes, so do not market reserve decisions as active on-chain governance

The public social account is [@capital_mstr](https://x.com/capital_mstr). The project website is [flywheelstrategy.xyz](https://flywheelstrategy.xyz). Both links must agree with the deployed site

## Identity and custody

- One user-controlled Solana wallet may serve as owner, Pump creator and recovery destination; this is the approved simple control model
- Automatic creator-fee collection requires a protected server-side copy of this wallet's keypair. A server compromise can therefore compromise owner authority even though the panel requires exact wallet signatures for user actions
- Operator and holder-settlement signing keys are separate internal service roles, not additional user-facing administrators
- The strategic-reserve destination is a separate user-controlled MSTRx wallet. The user keeps its key; the server verifies its token-account identity but cannot spend its balance
- The holder-inventory signer is server-held. Its commitment rules are currently software/accounting controls, not an immutable on-chain vault; this trust boundary must remain explicit in public materials
- Recovery is limited to identified, project-controlled **uncommitted** receipts. Completed holder transfers cannot be reversed. A published funded allocation must not be silently reclassified as owner funds

Public addresses may appear in audited configuration once final, but test identities, wallet secrets, authenticated RPC URLs, Bitquery credentials, hidden panel paths and live accounting files must never be committed or copied into a production image

## Production gates

| Gate | Required evidence |
|:--|:--|
| Exact Pump launch | Final creator, CAPITAL mint, MSTRx quote, `creator_fee_bps = 200`, native Pump holder mode off, finalized creation signature and two-RPC agreement |
| Fee custody | Creator-and-MSTRx vault begins with no unrelated uncollected MSTRx fees; both bonding-curve and PumpSwap collection paths proven |
| Fee accounting | Exact finalized receipt deltas, deterministic 60/40 raw-unit conservation and no sweep of unrelated creator-wallet MSTRx |
| MSTRx transfers | Official Token-2022 mint and extensions rechecked; destination ATA creation, transfer hook, pause behavior and simulation verified on the actual asset |
| Holder history | Mint-wide finalized CAPITAL transfer coverage including a verified backfill route beyond realtime retention; no missing launch or migration movement |
| Reward delivery | Fully funded epoch, direct payouts to wallets with and without an MSTRx ATA, bounded batches, restart recovery, no duplicate recipient and exact final conservation |
| Operations | Independent RPCs, provider credentials, alerts, SOL funding, backups, service heartbeats and reproducible recovery runbook |
| Public disclosure | Website, GitHub, X, final addresses and transaction links agree with deployed state; do not imply binding voting exists |
| Security | Dependency review and independent review of custody, offchain accounting and any custom Solana program used with real value |

Holder accounting requires two independent archival RPCs to agree on every finalized produced block from the launch slot, including any catch-up after an outage. The indexer stops on a coverage gap or provider disagreement; optional Bitquery diagnostics cannot authorize a reward epoch. No reward epoch should rely on guessed holder balances

The Pump creator-fee vault is scoped by creator and quote asset rather than by CAPITAL mint. The same creator must not operate another MSTRx-paired Pump coin unless the collection ledger is redesigned to attribute mixed receipts correctly

## Rehearsal boundary

Rehearse with disposable test identities and a separately created Pump token, never the production creator. The current MSTRx integration requires an authorized, bounded mainnet canary for genuine Pump custom-pair receipts and Token-2022 transfer-hook behavior; local tests do not replace this. Keep staging and production keys, state, signatures, epochs, provider limits and service processes isolated. See [Solana staging](solana-staging.md)

Rehearsal evidence must include interruption during collection, routing and payout; provider disagreement; a holder without a pre-existing MSTRx token account; and graduation from the Pump curve to PumpSwap. Archive every relevant transaction signature and the exact build commit in a protected handoff location

## Release checks

```bash
npm ci
npm run security:secrets
npm run test:solana
npm run test:web
npm run web:build
```

These checks prove only that the reviewed source passes its local gates. Before funding or activating production, verify the final provider configuration, live token/program identities, fee custody, transfer-history coverage, wallet roles and dependency advisories, then repeat the end-to-end canary. Do not force a Pump SDK downgrade that removes the required V2 custom-pair interface to make an audit warning disappear

Production sign-off must record the final configuration checksum, review approvals, funding limits, test results, transaction evidence, public disclosure snapshot and a named stop/recovery operator
