# Solana operations

## Services

The current production stack uses one constrained Solana control runner with separately reported service roles

- `solana-fee-keeper` verifies and sweeps both Pump creator-fee sources and routes the received MSTRx 60/40
- `solana-reward-publisher` builds finalized holder state and commits a fully funded reward epoch
- `solana-distributor` sends idempotent MSTRx batches and finalizes exact conservation
- `solana-launch-detector` binds and activates the one exact Pump launch created after the signed arm timestamp
- `solana-governance-keeper` remains disabled until a restricted governance program is reviewed and deployed

No service stores the owner private key. The isolated creator, operator, holder-settlement and reserve service keys are installed outside Git with file-level access restrictions

## Required secret environment

Production values stay outside Git

```text
SOLANA_RPC_PRIMARY_URL=
SOLANA_RPC_FALLBACK_URL=
SOLANA_ADMIN_OWNER=
SOLANA_CREATOR_PUBLIC_KEY=
SOLANA_CREATOR_KEYPAIR_PATH=
SOLANA_OPERATOR_KEYPAIR_PATH=
SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY=
SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH=
SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY=
SOLANA_RESERVE_SETTLEMENT_KEYPAIR_PATH=
SOLANA_HOLDER_JOURNAL_PATH=
SOLANA_RECOVERY_PUBLIC_KEY=
ADMIN_PANEL_PATH=
```

Keypair files must be readable only by their dedicated service account. The public website receives only public addresses and sanitized status files

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
9. Public documentation matches deployed behavior
10. Secret scan, tests and web build pass

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
- Keep the public site online while automation is paused

## Incident response

The private panel provides separate controls to pause routing, sweep either fee source, inspect balances, resume routing and recover only uncommitted project-controlled MSTRx

If a provider, mint, creator, transfer hook or balance disagrees, the correct response is to stop and preserve state. The system must not silently switch assets or reinterpret a failed transaction as a receipt

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
