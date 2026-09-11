# Operations runbook

## Separation of keys

Use three independent accounts:

1. Deployment/final admin: deploys, wires roles and is not stored on the automation server.
2. Automation: collects/splits fees, buys MSTR and executes due governance actions.
3. Root publisher: publishes deterministic reward roots and has no reserve permission.

Never commit `.env`. Production should inject secrets through the host's secret manager. The supplied Compose setup accepts separate optional files: `.env.web`, `.env.reward-keeper`, `.env.reward-publisher` and `.env.governance-keeper`. Put only the variables required by that service in each file. This prevents the public web process from receiving private keys.

Independent standby automation instances may use separate keys to avoid nonce collisions. Governance execution itself remains fixed by the contract result and is safe to retry after a failed transaction.

## Production data

Use Alchemy or another archive-capable Robinhood Chain RPC for Transfer history. Public RPC is a development fallback only. The indexer reads Alchemy's Transfers API, stores processed events under `/app/data` and refreshes only a small recent overlap. It no longer scans every block from launch on every reward epoch. Persist `/app/data` and back it up after every published epoch. Public reward snapshots and proposal snapshots live under `/app/data/public` and are served by the same web process.

Run `npm run setup:rpc` on the deployment machine. It checks chain ID `4663` and writes the primary/optional backup endpoints to ignored `.env` files. Never place an Alchemy key in frontend variables or committed files. Add an Alchemy IP allowlist only after the production server has a stable public IP.

## Start order

1. Build and test the exact source revision.
2. Run `verify:live` and save its output.
3. Deploy the pre-launch contracts.
4. Generate and independently decode the unsigned PONS launch transaction.
5. Sign the PONS launch from the owner wallet.
6. Record token address, curve address, launch block and launch timestamp.
7. Deploy and wire the post-launch governance contracts.
8. Publish all addresses and verified sources.
9. Start web/API, reward keeper, reward publisher and governance keeper. Add an independently keyed standby instance only after the primary is healthy.
10. Confirm health, first fee collection, first MSTR purchase, first reward root and a small claim before announcement.

## Testnet rehearsal

Run `npm run deploy:testnet` on Robinhood Chain testnet (`46630`) only after supplying a funded testnet deployment key. The rehearsal deploys the real project control, vault, reward and governance contracts, but uses mock PONS escrow, MSTR and exchange behavior. It validates deployment and permissions without pretending that mainnet liquidity exists on testnet.

Use `npm run test:fork` for the separate route test against a local copy of current mainnet state. No real transaction is broadcast by the fork test.

## Public health

Every keeper writes its latest result under `data/public/status/`. The web server exposes those JSON files without caching, and the interface marks a service stale after two minutes. Monitor the machine directly as well: a public heartbeat proves recent process activity, not that every external dependency is economically healthy.

## Monitoring alerts

Alert immediately when:

- a process has not reported health for two minutes;
- PONS fees remain uncollected for five minutes;
- an MSTR conversion fails three times;
- a reward epoch is late by more than one current interval;
- publisher state differs from the on-chain epoch/root;
- the archive RPC omits or rejects historical logs;
- the Alchemy Transfers API returns incomplete raw transfer data;
- a governance proposal is not executed within two minutes after its five-minute delay;
- MSTR `uiMultiplier()` or canonical address differs from the recorded configuration;
- any admin, publisher or automation role changes.

## Recovery rules

- Never edit a published snapshot.
- If a transaction published a root but the local process stopped before saving state, restart with the prepared epoch file intact; the publisher verifies and recovers it.
- If a quote/swap fails, do not loosen the 20% limit. Wait for the next cycle or use the already allowlisted fallback route.
- If the publisher and chain disagree without a matching prepared snapshot, stop publication and investigate. Do not guess state.
- A failed governance swap leaves the whole execution transaction reverted, so the automatic executor retries the same winning option and parameters.

## Backups

Back up the reward state, every epoch JSON, governance snapshots, deployment JSON, live verification output and transaction hashes. These contain no private keys and should be publicly mirrored after launch.
