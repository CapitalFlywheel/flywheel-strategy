# Solana operations

## Services

The planned production stack uses one constrained Solana control runner with separately reported service roles. These roles are not evidence of an active mainnet deployment

- `solana-fee-keeper` verifies and sweeps both Pump creator-fee sources and routes the received MSTRx 60/40
- `solana-reward-publisher` builds finalized holder state and commits a fully funded reward epoch
- `solana-distributor` sends idempotent MSTRx batches and finalizes exact conservation
- `solana-holder-indexer` discovers CAPITAL transfers by mint, verifies each newly seen finalized transaction against both RPC providers and prepares the holder journal
- `solana-launch-detector` verifies and activates the one exact Pump launch created after the signed arm timestamp

The unreleased governance prototype permits an admin to create a fresh holder re-vote as soon as a finalized spending decision reaches its `executable_at` and is still unexecuted. A failed re-vote can be replaced as soon as its own result is finalized at its `executable_at`. A replacement ballot opens immediately at creation, lasts the selected one to twelve hours, and is finalizable five minutes after closing. It carries the entire unchanged commitment; the admin cannot release it. Initial ballots retain a 24-hour review delay. The program does not try to prove a failed Solana execution transaction, since a rolled-back transaction cannot set durable failure state in the governance account

The control runner and holder indexer each acquire a Linux kernel `flock` under `SOLANA_STATE_ROOT/.locks` **before** touching durable state or signing. Each service has its own lock, so the indexer and control runner can run together, but a second copy of either service sharing the same local filesystem waits rather than processing the same state. The lock is held for the entire process lifetime and the kernel releases it on exit, crash or container kill. The lock file itself remains in place: never delete it to resolve contention, since deleting a live locked inode can create two independent locks. A waiting copy logs `SOLANA_SINGLETON_WAITING` every 20 seconds; inspect running containers and logs rather than forcing it through. The packaged Linux image installs `flock`, and Compose starts the guarded script directly with signal forwarding. Do not bypass it by invoking the TypeScript entry files directly while automation is running. This protection assumes all financial processes share one local host filesystem; it is not a distributed multi-host lease

The approved single-wallet configuration uses the same user-controlled address for owner, Pump creator and recovery. Its protected creator keypair is installed on the server because automatic MSTRx fee routing requires that signature. A server compromise therefore compromises the owner key too; the panel's wallet-signature gate does not eliminate that risk. The operator and holder-settlement keys are separate service keys. The reserve destination is a distinct user-controlled wallet; its key is not installed on the server. No keypair or authenticated RPC URL belongs in Git, chat, logs or the public web container

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
SOLANA_HOLDER_BACKFILL_SLOTS_PER_RUN=2048
SOLANA_HOLDER_BACKFILL_BLOCK_CONCURRENCY=4
SOLANA_RECOVERY_PUBLIC_KEY=
ADMIN_PANEL_PATH=
```

Keypair files must be readable only by their dedicated service account (mode `0600`), with a protected off-server backup and a tested replacement procedure. The public website receives only the public admin address and sanitized status files; `web` must not load `.env.solana`. Do not copy a production key into staging or send a seed phrase/private key in chat

Before deploying the narrowed Compose mounts, provision `data/public`, `data/control/solana-requests`, `data/control/solana-status-visible`, `data/control/solana-completed`, `data/control/solana-failed` and `data/solana` as uid/gid `1000:1000`. The web process has read-only mounts for public data and private control status/sanitized outcome markers, plus a writable request queue; raw completed/failed files, the runner's signed-action nonce ledger and fee/reward state are not mounted into web. The runner independently verifies the owner's exact Ed25519 action signature and durably consumes its nonce before dispatch. The panel polls a sanitized request state (`queued`, `processed`, `failed`) without returning stored signatures or raw exception messages. `processed` means the server action ran, not that a submitted onchain transaction has finalized. An interrupted authorized action may require a fresh owner signature; inspect chain/ledger state first and never delete nonce markers to retry it. A host administrator or compromised runner remains outside this boundary

`SOLANA_RPC_PRIMARY_URL` is intended for a private Solana Mainnet Alchemy app. `SOLANA_RPC_FALLBACK_URL` must come from an independent provider such as Helius, not another app at Alchemy. Keep both authenticated URLs server-side. The public vault balances and MSTRx multiplier are published as a dual-RPC-checked server snapshot every minute after activation; the browser never queries an authenticated RPC for these values and hides snapshots older than five minutes

The public wallet/governance page uses `/api/solana/rpc` on its own origin. Configure `SOLANA_PUBLIC_RPC_UPSTREAM_URL` only in the protected web-service `.env.web`, preferably to a separately budgeted HTTPS read provider. The web image no longer embeds `VITE_SOLANA_RPC_URL`. The route accepts only small single JSON-RPC requests for specific finalized reads; it rejects transaction broadcast, simulation, broad scans, subscriptions and batches. It has a bounded request/response size, upstream timeout, global/per-client rate cap and concurrency cap, and never returns provider error text or upstream URLs. This is an availability/cost guard, not a guarantee against distributed abuse

A separate `/api/solana/governance-vote` endpoint is built but **hard-disabled** by `GOVERNANCE_VOTE_BROADCAST_RELEASED=false`; the browser vote flag is also false. It accepts only one signed legacy `cast_vote` transaction for the exact configured governance program, active proposal PDA and voter-record PDA, with one payer/voter signer, one instruction, bounded proof, no address lookup table, no compute-budget instruction and no preflight bypass. The server rejects malformed or improperly signed transactions locally before any RPC call. The expensive immutable ProgramData SHA-256 and custody route are checked by two independent finalized RPCs once per server process/configuration, then cached only because the verified upgrade authority is revoked; every vote still rechecks the small live Config, vault, proposal and empty vote-record accounts against both providers. Each finalized provider's view is validated independently; immutable proposal/config identity and the exact active commitment must agree, while newer free reserve deposits and valid onchain vote tallies may differ between finalized slots. The separate vote limiter permits at most three requests per client and 30 globally per minute, with two concurrent requests. It sanitizes all upstream failures. To prepare this route in the protected `.env.web`, configure `SOLANA_CLUSTER`, `SOLANA_RPC_PRIMARY_URL`, `SOLANA_RPC_FALLBACK_URL`, `SOLANA_GOVERNANCE_PROGRAM`, `SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256`, `SOLANA_CAPITAL_MINT` and `SOLANA_ADMIN_OWNER`; do not put any authenticated URL in `VITE_` or Git. The endpoint is not a way to bypass an unavailable reserve executor, unreleased onchain governance or the required audit. Confirm vote finality over bounded HTTP status polling, since neither route has WebSocket subscriptions. Wallets lacking `signTransaction` fall back to their adapter's `sendTransaction` with the exact-vote endpoint; mobile-wallet behavior still requires real-device verification

Holder-reward discovery uses a mandatory two-RPC finalized full-block scan from launch, then extends that verified range on every cursor advance. It never authorizes a reward epoch from Bitquery-only transfer rows. Work is checkpointed in bounded 32-slot chunks and fetched at up to `SOLANA_HOLDER_BACKFILL_BLOCK_CONCURRENCY` produced slots concurrently (1–8, default 4). The runner checks every 15 seconds and allows up to 2048 slots per run by default; actual archival RPC capacity still controls catch-up time. This scans produced blocks on **both** providers and independently rereads relevant transactions, so it can consume substantial RPC credits and bandwidth; estimate and monitor provider quotas before arming, especially with a free fallback plan. An old vendor-only holder cache is rebuilt from launch before publishing a new journal. Until all chunks pass, the heartbeat is unhealthy and the holder cursor and reward journal do not advance. If either independent archival RPC lacks complete block or token metadata, rewards remain stopped rather than using a current balance snapshot. See [Solana holder coverage](solana-holder-backfill.md). Epoch preparation also requires a healthy recent indexer heartbeat, a fresh finalized journal with launch-to-target full-block provenance, and a strictly advancing epoch/window. Do not restart from an incomplete index or use `getSignaturesForAddress(mint)` as a substitute

The version-3 reward journal and version-4 reward plan must retain the exact two-RPC full-block coverage marker, including its final blockhash. The plan hash also binds the per-epoch deterministic Token-2022 owed-escrow account and its holder-settlement authority. Before any payout, the plan is bound to the independently published, verified launch configuration: mint, launch signature and the first covered slot must match. Older plans or journals, absent or inconsistent coverage, and a missing or changed launch configuration stop payouts. Never make a vendor-only cache payable by relabelling its version or manufacturing a coverage marker

Bitquery V2 is optional for separate provider diagnostics only. `verify_launch_config`, `arm_launch_detection`, holder indexing, rewards and governance no longer require it. If used, `BITQUERY_CLIENT_ID` and `BITQUERY_CLIENT_SECRET` enable bearer-token refresh; a protected `BITQUERY_API_KEY` static token is accepted only when both are unset. Keep optional credentials server-side and never put them in Git, browser configuration or logs. Bitquery transfer rows are never a holder-reward completeness authority; the two-RPC full-block scan remains mandatory

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
14. Both independent RPCs support finalized full-block reads, including historical blocks and v1 transactions, within the expected rate and credit budget; this does not replace the mint-specific holder-history check after token creation

## Runtime rules

- Read accounting state at `finalized`
- Stop on RPC slot, block, balance or history disagreement
- Never infer a receipt from expected trading volume
- Route only exact reconciled MSTRx creator-fee receipts
- Never sweep unrelated MSTRx already held by the creator wallet
- Preserve every raw MSTRx unit across the 60/40 split
- Fund a complete epoch before its first payout
- Persist signature and batch state before advancing
- Rebroadcast only the exact durably stored signed bytes while their blockhash is still valid
- Before signing an ATA or payout batch, compare the operator's finalized SOL balance and MSTRx ATA rent across both RPCs; require worst-case rent for every recipient ATA plus a 0.001 SOL fee buffer. Simulate the signed transaction with signature verification before storing or broadcasting it. A balance check is only a gate, not a guarantee against later operator spending
- Keep signed fee collections and routes in durable state; reconcile exact MSTRx token-account deltas before progressing
- If both RPCs lack a transaction after blockhash expiry, mark its outcome unresolved and stop; missing history is not proof of nonexecution, so do not sign a replacement fee route, recovery or holder payout until independently reconciled
- Keep the public site online while automation is paused

The local version-4 reward plan now has a per-epoch deterministic Token-2022 owed-escrow account controlled by the existing holder-settlement signer, not a new user-facing or admin wallet. Normal three-recipient packets stay atomic. Only matching `InstructionError` simulations from **both** independent RPC providers before broadcast, or an agreed finalized onchain failure, may split a failed packet into single-recipient attempts. Transport, blockhash, partial-RPC and expired-signature uncertainty stop the pipeline. A recipient is marked `owed` only after its exact raw MSTRx allocation is durably signed, transferred from the holder ATA to the separate escrow and proven finalized by both RPCs. If creating or funding escrow fails, the whole epoch pauses without declaring a debt

The private per-epoch owed ledger binds the plan hash, recipient, exact raw units, original failed stage, escrow transaction and retry state. A public sanitized owed snapshot at `/snapshots/solana-owed-epoch-N.json` omits signed transaction bytes and reports outstanding units, current owed/paid status and append-only finalized delivery events; the original epoch snapshot links to it but is never rewritten after a retry. Finalization independently re-reads each completed payout or escrow transaction from both providers and enforces `paid + escrowed = funded` plus `escrow balance >= outstanding owed`. Every later epoch rechecks all existing owed ledgers, delivered transaction facts and their separate escrow balances; its funding amount comes only from the holder ATA, never from escrow. A submitted old escrow-to-recipient payment must reconcile before another epoch starts. The single control runner retries already finalized escrow obligations every fifteen minutes only after launch activation, while automation is running and conversions are unpaused; retry failure has its own sanitized heartbeat and does not authorize a new payout. Retries are capped at eight proven attempts per recipient with 15-minute-to-six-hour backoff, run in at most twelve recipients per pass, use only that epoch's escrow and never sign a replacement for an unresolved prior transaction. Exhausted receipts remain owed and require manual investigation, not an admin sweep or silent reallocation

This code is **local and unreleased**, not evidence of live recipient recovery. `OWED_ESCROW_RELEASED` is hard-coded `false`: a failed normal packet stops before any isolated-recipient signing or new escrow creation while successful normal packets keep their existing path. Before changing that code gate, test deterministic account creation and rent, Token-2022 required extensions and the real MSTRx transfer hook, three-recipient failure isolation, restart at every persisted state, unknown-outcome recovery, SOL budget depletion and a retry that pays from escrow without touching a new epoch. The holder-settlement key still controls its escrow token accounts operationally; this is not an immutable onchain lock against server compromise. No admin recovery action may sweep outstanding holder obligations

## Incident response

The private panel provides separate controls to pause routing, reconcile an in-flight signed transaction while paused, sweep either fee source, inspect balances, resume routing and recover only uncommitted project-controlled MSTRx

With owner = creator = recovery, collected but uncommitted MSTRx is already in the user's dev wallet. The paused recovery action marks those exact receipts as recovered in the ledger without a meaningless self-transfer; it does not move or reclaim a completed holder payout

If a provider, mint, creator, transfer hook or balance disagrees, the correct response is to stop and preserve state. The system must not silently switch assets or reinterpret a failed transaction as a receipt

`disarm_launch_detection` pauses scans but preserves the original `SOLANA_STATE_ROOT/launch-detector.json` boundary. A later signed `arm_launch_detection` resumes that same cursor, including signatures that appeared while paused; it never silently picks a newer boundary. This also recovers if a process saved the anchor but crashed before saving armed status. `PUMP_LAUNCH_SCAN_ALREADY_ARMED_OR_STALE`, a missing cursor after a prior arm, a malformed cursor or a mismatched arm timestamp is a stop condition: preserve state and investigate, never delete it to make a button work. Only after both finalized RPCs prove that no matching CreateEvent occurred after the saved anchor, and the owner intentionally disarmed, may an operator archive that one cursor during a stopped-runner maintenance window to prepare an entirely new arm boundary

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
