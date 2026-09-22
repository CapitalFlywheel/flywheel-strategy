<p align="center">
  <img src="assets/brand/final/x-banner-1500x500.png" alt="FLYWHEEL STRATEGY" width="100%">
</p>

<p align="center">
  <img src="assets/brand/final/x-avatar-400.png" alt="FLYWHEEL STRATEGY mark" width="104">
</p>

<h1 align="center">FLYWHEEL STRATEGY</h1>

<p align="center">
  <strong>HOLD CAPITAL&nbsp;&nbsp;·&nbsp;&nbsp;ACCUMULATE MSTRx</strong><br>
  Real Pump.fun creator-fee receipts build automatic MSTRx rewards and a separate strategic reserve on Solana<br>
  <strong>CAPITAL IN MOTION</strong>
</p>

<p align="center">
  <a href="https://flywheelstrategy.xyz"><strong>WEBSITE</strong></a>
</p>

---

## THE SOLANA FLYWHEEL

| 01 — TRADE | 02 — COLLECT | 03 — ROUTE | 04 — DISTRIBUTE |
|:--|:--|:--|:--|
| CAPITAL trades against the official MSTRx custom pair | Fixed 2% creator fees are collected from both Pump phases | Actual MSTRx receipts split exactly 60/40 | Funded rewards are sent automatically to eligible holders |

```text
PUMP.FUN 2% CREATOR FEE IN MSTRx
             ├── 60% HOLDER REWARDS
             └── 40% STRATEGIC RESERVE
```

## FEE FLOW

CAPITAL uses Pump.fun's supported MSTRx custom pair with a fixed `creator_fee_bps` of `200`, equal to 2% of each trade in the quote asset

Every finalized creator-fee receipt controlled by the project is split exactly as follows

| Allocation | Share of actual project receipts | Purpose |
|:--|--:|:--|
| Holder rewards | **60%** | MSTRx sent automatically to eligible holders |
| Strategic reserve | **40%** | Isolated MSTRx governed through the restricted reserve system |

RPC, rent, priority fees and all other operating costs are funded separately and are never deducted from the 60/40 allocation

## AUTOMATIC HOLDER REWARDS

Reward weight combines CAPITAL balance with exact hold time

- No claim page, wallet connection, signature or holder-paid gas is required
- The complete epoch is funded before the first payout batch
- Partial sales consume newest lots first
- Recipient batches are deterministic and idempotent
- Every raw MSTRx unit must reconcile before an epoch can finalize
- Two independent RPC providers must agree on finalized state before accounting advances

The reward asset is the official Solana MicroStrategy xStock token

- Symbol: `MSTRx`
- Mint: `XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ`
- Program: Token-2022

## PUMP.FUN INTEGRATION

The standard launch configuration is

- Quote asset: official Solana MSTRx
- Pair: CAPITAL / MSTRx
- Creator fee: fixed 2%
- Pump native holder rewards: disabled
- Project creator fees: collected from both the bonding curve and PumpSwap creator vault
- Token creation and first buy: one wallet-approved Pump.fun transaction when supported by the final launch interface

The CAPITAL mint does not exist until the real Pump.fun launch. No production deployer is used for rehearsals

## GOVERNANCE AND CUSTODY

Holder reward inventory, strategic reserve inventory, operating SOL and marketing funds remain separate

Governance can execute only published reserve actions through a restricted Solana program. Public governance claims remain disabled until the program has been audited and deployed

The owner panel exposes separate signed actions for launch verification, launch detection, both fee routes, routing pause, epoch preparation, automatic distribution, finalization and recovery of uncommitted balances. One pre-launch arm signature is enough for the detector to verify, publish and activate the exact Pump mint

Committed holder rewards cannot be recovered by the owner

## CURRENT STATUS

The repository contains the Solana public site, wallet layer, fixed 2% custom-pair validation, one-signature launch detector, exact 60/40 allocation, both Pump fee collection paths, Token-2022 transfer-hook support, crash-safe automatic payout batches, RPC-consensus guards and private control surface

The old Robinhood Chain implementation is retained only as legacy audit history. Its addresses, manifests, cached epochs and bot state are not valid Solana production configuration

No mainnet CAPITAL mint, strategy program or governance program is published yet

## VERIFY LOCALLY

Requirements: Node.js 20+ and npm

```bash
npm ci
npm run security:secrets
npm run test:solana
npm run test:web
npm run web:build
```

Start the local site

```bash
npm run web:dev
```

## REPOSITORY MAP

| Path | Purpose |
|:--|:--|
| `services/solana/` | Fixed 2% launch validation, finalized RPC consensus, Pump MSTRx collection, 60/40 routing and automatic transfer accounting |
| `services/indexer/` | Deterministic hold-time and reward accounting primitives being ported to Solana history |
| `services/api/` | Public site server and wallet-signed private control queue |
| `apps/web/` | Solana holder website, documentation, governance preview and owner panel |
| `config/solana-mainnet.json` | Public Solana programs, assets and approved economics |
| `contracts/`, `services/keeper/` | Legacy Robinhood implementation retained for audit history, not Solana deployment |

## SECURITY

Secrets are not stored in this repository

Private keys, seed phrases, RPC credentials, server passwords, SSH keys, hidden administration URLs and live operational state must remain outside Git

`npm run security:secrets` scans every publishable file before a public push

---

<p align="center">
  <img src="assets/brand/final/x-avatar-400.png" alt="FLYWHEEL STRATEGY mark" width="56"><br>
  <strong>CAPITAL IN MOTION</strong><br>
  FEES&nbsp;&nbsp;→&nbsp;&nbsp;MSTRx&nbsp;&nbsp;→&nbsp;&nbsp;HOLDERS
</p>
