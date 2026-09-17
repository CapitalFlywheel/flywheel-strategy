<p align="center">
  <img src="assets/brand/final/x-banner-1500x500.png" alt="FLYWHEEL STRATEGY — Fees to MSTR to holders" width="100%">
</p>

<p align="center">
  <img src="assets/brand/final/x-avatar-400.png" alt="FLYWHEEL STRATEGY mark" width="104">
</p>

<h1 align="center">FLYWHEEL STRATEGY</h1>

<p align="center">
  <strong>HOLD CAPITAL&nbsp;&nbsp;·&nbsp;&nbsp;ACCUMULATE MSTR</strong><br>
  Trading fees continuously build MSTR rewards for passive holders and a separate holder-governed reserve<br>
  <strong>CAPITAL IN MOTION</strong>
</p>

<p align="center">
  <a href="https://flywheelstrategy.xyz"><strong>WEBSITE</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://x.com/capital_strg"><strong>X / TWITTER</strong></a>
</p>

---

## THE FLYWHEEL

| 01 — TRADE | 02 — ACCUMULATE | 03 — REWARD | 04 — DECIDE |
|:--|:--|:--|:--|
| PONS V2 trading generates fees | Automation converts the allocated fees into MSTR | Passive holders claim their share without staking | Holders vote on how the strategic reserve is used |

```text
TRADING FEES  ──►  MSTR  ──►  HOLDER REWARDS
                         └──►  STRATEGIC RESERVE
```

## FEE FLOW

PONS V2 trading uses a **3% total trade fee**

- **1%** — PONS protocol fee
- **2%** — creator fee routed into the FLYWHEEL STRATEGY system

The creator fee is divided automatically

| Allocation | Share of creator fee | Purpose |
|:--|--:|:--|
| Holder rewards | **50%** | MSTR claimable by eligible holders |
| Strategic reserve | **40%** | MSTR controlled through holder governance |
| Automation | **10%** | Onchain execution and operating gas |

## PASSIVE HOLDER REWARDS

Reward weight combines token balance with exact hold time measured by the hour

- Loyalty grows from the first hour and reaches its maximum after 30 days
- Partial sales use newest-lot-first accounting
- Rewards are available without staking or locking CAPITAL
- Each holder claims MSTR directly and pays their own claim gas
- Reward rounds adapt to market capitalization

| Market capitalization | Reward interval |
|:--|--:|
| Below $500K | 10 minutes |
| $500K to $1M | 20 minutes |
| $1M to $5M | 30 minutes |
| $5M and above | 60 minutes |

## GOVERNANCE

The team starts proposals and chooses the amount of reserve included in each vote

- Every eligible holder can vote
- Voting power follows the same balance-and-hold-time model used for rewards
- Quorum is **7%** of eligible voting weight
- Voting lasts from **1 to 12 hours**
- The winning valid action is executed automatically after a **5-minute delay**
- Proposal actions are limited to the fixed onchain allowlist

Governance can direct the selected reserve amount toward an approved action such as token buyback, buyback and burn, buyback and lock, reserve locking or marketing funding

## TRANSPARENCY

This repository publishes the contracts, reward calculations, governance rules, automation services, public website and tests

Final mainnet contract addresses and transaction links will be published after the branded launch

- [System architecture](docs/architecture.md)
- [Public technical specification](apps/web/public/technical-specification.md)
- [Operations overview](docs/operations.md)
- [Security policy](SECURITY.md)

## VERIFY LOCALLY

Requirements: Node.js 20+ and npm

```bash
npm ci
npm run security:secrets
npm run test:all
npm run web:build
```

Start the local website

```bash
npm run web:dev
```

Then open `http://127.0.0.1:5173`

## REPOSITORY MAP

| Path | Purpose |
|:--|:--|
| `contracts/` | Solidity contracts and approved execution adapters |
| `services/indexer/` | Hold-time accounting and reward calculations |
| `services/keeper/` | Launch, reward and governance automation |
| `services/api/` | Production web server and public status data |
| `apps/web/` | Holder website, documentation and governance |
| `test/` | Contract and system tests |
| `config/` | Public chain, protocol and route configuration |

## SECURITY

Secrets are not stored in this repository

Private keys, seed phrases, RPC credentials, server passwords, SSH private keys, hidden administration URLs and live bot state must remain outside Git

`npm run security:secrets` checks publishable files locally and the same check runs on every GitHub push and pull request

## CURRENT STATUS

The included contract, indexer and wallet tests pass and the system has been exercised with a small mainnet test deployment

The branded production deployment has not happened yet and the contracts have not completed an independent external audit

---

<p align="center">
  <img src="assets/brand/final/x-avatar-400.png" alt="FLYWHEEL STRATEGY mark" width="56"><br>
  <strong>CAPITAL IN MOTION</strong><br>
  FEES&nbsp;&nbsp;→&nbsp;&nbsp;MSTR&nbsp;&nbsp;→&nbsp;&nbsp;HOLDERS
</p>
