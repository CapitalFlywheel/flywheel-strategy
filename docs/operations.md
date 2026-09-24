# Solana operations

## Services

The current production stack uses one constrained Solana control runner with separately reported service roles

- `solana-fee-keeper` verifies and sweeps both Pump creator-fee sources and routes the received MSTRx 60/40
- `solana-reward-publisher` builds finalized holder state and commits a fully funded reward epoch
- `solana-distributor` sends idempotent MSTRx batches and finalizes exact conservation
- `solana-holder-indexer` discovers CAPITAL transfers by mint, verifies each newly seen finalized transaction against both RPC providers and prepares the holder journal
- `solana-launch-detector` binds and activates the one exact Pump launch created after the signed arm timestamp
- `solana-governance-keeper` remains disabled until a restricted governance program is reviewed and deployed

The approved single-wallet configuration uses the same user-controlled address for owner, Pump creator and recovery. Its protected creator keypair is installed on the server because automatic MSTRx fee routing requires that signature. A server compromise therefore compromises the owner key too; the panel's wallet-signature gate does not eliminate that risk. The operator and holder-settlement keys are separate service keys. The reserve wallet provides only a public address; its private key is not needed on the server. No keypair or authenticated RPC URL belongs in Git, chat, logs or the public web container

## Required secret environment

Production values stay outside Git

```text
SOLANA_RPC_PRIMARY_URL=
SOLANA_RPC_FALLBACK_URL=
SOLANA_ADMIN_OWNER=
SOLANA_CREATOR_PUBLIC_KEY=
SOLANA_SHARED_ADMIN_CREATOR=true
SOLANA_CREATOR_KEYPAIR_PATH=
SOLANA_OPERATOR_KEYPAIR_PATH=
SOLANA_OPERATOR_PUBLIC_KEY=
SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY=
SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH=
SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY=
SOLANA_HOLDER_JOURNAL_PATH=
SOLANA_RECOVERY_PUBLIC_KEY=
# Configure both OAuth fields for automatic refresh, or only BITQUERY_API_KEY
BITQUERY_CLIENT_ID=
BITQUERY_CLIENT_SECRET=
BITQUERY_API_KEY=
ADMIN_PANEL_PATH=
```

Keypair files must be readable only by their dedicated service account (mode `0600`), with a protected off-server backup and a tested replacement procedure. The public website receives only the public admin address and sanitized status files; `web` must not load `.env.solana`. Do not copy a production key into staging or send a seed phrase/private key in chat

Before deploying the narrowed Compose mounts, provision `data/public`, `data/control/solana-requests`, `data/control/solana-status-visible`, `data/control/solana-completed`, `data/control/solana-failed` and `data/solana` as uid/gid `1000:1000`. The web process has read-only mounts for public data and private control status/sanitized outcome markers, plus a writable request queue; raw completed/failed files, the runner's signed-action nonce ledger and fee/reward state are not mounted into web. The runner independently verifies the owner's exact Ed25519 action signature and durably consumes its nonce before dispatch. The panel polls a sanitized request state (`queued`, `processed`, `failed`) without returning stored signatures or raw exception messages. `processed` means the server action ran, not that a submitted onchain transaction has finalized. An interrupted authorized action may require a fresh owner signature; inspect chain/ledger state first and never delete nonce markers to retry it. A host administrator or compromised runner remains outside this boundary

`SOLANA_RPC_PRIMARY_URL` is intended for a private Solana Mainnet Alchemy app. `SOLANA_RPC_FALLBACK_URL` must come from an independent provider such as Helius, not another app at Alchemy. Keep both authenticated URLs server-side. The public vault balances and MSTRx multiplier are published as a dual-RPC-checked server snapshot every minute after activation; the browser never queries an authenticated RPC for these values and hides snapshots older than five minutes. The optional wallet adapter may still use the public Solana RPC for non-critical wallet connection

The current mint-wide transfer discovery adapter uses Bitquery V2 `Solana(dataset: realtime)`. For long-running operation, configure a Bitquery Application's `BITQUERY_CLIENT_ID` and `BITQUERY_CLIENT_SECRET` so the indexer obtains and refreshes its bearer token before expiry. A protected `BITQUERY_API_KEY` static bearer token is accepted only when both client credentials are unset. Incomplete client credentials or a failed OAuth refresh stop the scan; they do not silently fall back to the static token. Never put credentials in Git, browser configuration or logs. The adapter checks the transfer cube's actual oldest and newest timestamps before each scan, re-reads an overlapping hour, verifies newly discovered signatures against both RPCs, and fails if a previously indexed transfer disappears. If the creation transaction is absent from the Transfers cube, it is seeded only from a finalized transaction and agreed block-signature order. Bitquery's realtime transfer history has short retention; a gap longer than six hours, a missing source tail or an unavailable historical floor stops distribution and requires a verified historical backfill. Epoch preparation also requires a healthy recent indexer heartbeat, a fresh finalized journal and a strictly advancing epoch/window. Do not restart from an incomplete index, use `getSignaturesForAddress(mint)` as a substitute, or infer a reward epoch from a current holder snapshot

`verify_launch_config` and `arm_launch_detection` each perform a read-only Bitquery authentication and realtime coverage probe for the window from one hour ago through five minutes ago. A failed probe prevents arming. This global probe confirms source availability only; after launch, mint-specific transfer verification and complete holder-history checks still gate each reward epoch

## Funding

The 60/40 split applies to every actual creator-fee receipt

Operating SOL for RPC-related transactions, associated-token-account rent, priority fees and keeper execution is funded separately. Automation expenses do not reduce either holder or reserve allocation

## Start conditions

Automation must remain stopped until all checks pass

1. Two independent production RPC providers agree on finalized blocks
2. The owner, creator and operational public keys match the signed launch manifest
3. The Pump coin uses the official MSTRx quote, `creator_fee_bps: 200` and `holderReward: false`
4. Both creator-fee collection paths simulate to the configured creator MSTRx account
5. The MSTRx mint, Token-2022 program and transfer-hook extensions match public configuration
6. Extension-aware MSTRx transfers simulate to the isolated reward and reserve accounts
7. Reward and reserve custody are isolated
8. Recovery tests prove that committed holder inventory cannot be swept
   This is an operational software restriction while the holder-inventory signing key remains server-held, not a cryptographic guarantee against server compromise
9. Public documentation matches deployed behavior
10. Secret scan, tests and web build pass
11. Mint-wide transfer discovery covers the creation transaction and all transfers through the finalized checkpoint, with no retention gap
12. The reserve and recovery addresses are controlled by the project; no reserve private key is installed on the server
13. The creator's MSTRx fee vault is clean and this creator has no other MSTRx-paired Pump token: the fee vault is scoped by creator and quote asset, not by CAPITAL mint
14. Bitquery authentication and global realtime transfer coverage pass the initial provider probe; this does not replace the mint-specific holder-history check after token creation

## Runtime rules

- Read accounting state at `finalized`
- Stop on RPC slot, block, balance or history disagreement
- Never infer a receipt from expected trading volume
- Route only exact reconciled MSTRx creator-fee receipts
- Never sweep unrelated MSTRx already held by the creator wallet
- Preserve every raw MSTRx unit across the 60/40 split
- Fund a complete epoch before its first payout
- Persist signature and batch state before advancing
- Retry expired transactions with the same logical batch identifier
- Keep signed fee collections and routes in durable state; reconcile exact MSTRx token-account deltas before progressing
- Recheck both RPCs before retrying an expired transaction, and never repeat a finalized fee collection or holder payout
- Keep the public site online while automation is paused

## Incident response

The private panel provides separate controls to pause routing, reconcile an in-flight signed transaction while paused, sweep either fee source, inspect balances, resume routing and recover only uncommitted project-controlled MSTRx

With owner = creator = recovery, collected but uncommitted MSTRx is already in the user's dev wallet. The paused recovery action marks those exact receipts as recovered in the ledger without a meaningless self-transfer; it does not move or reclaim a completed holder payout

If a provider, mint, creator, transfer hook or balance disagrees, the correct response is to stop and preserve state. The system must not silently switch assets or reinterpret a failed transaction as a receipt

If the transfer source is unavailable or its realtime retention is exceeded, fee collection may continue, but holder epochs and payouts must remain stopped until a complete historical repair has been verified. Backup `data/solana`, `data/control`, and the protected service keypairs off-server before activation and after each finalized epoch

## Deployment verification

Run before every release

```bash
npm ci
npm run security:secrets
npm run test:solana
npm run test:web
npm run web:build
```

An external Solana program review, off-server backups and redundant production infrastructure remain required before mainnet activation
