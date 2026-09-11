# FLYWHEEL STRATEGY

FLYWHEEL STRATEGY is a Robinhood Chain system for passive MSTR rewards and a separately governed MSTR reserve

The project token ticker is `CAPITAL`

## How the system works

1. PONS V2 trading collects a 2% creator fee alongside the 1% PONS protocol fee
2. The creator fee is split between passive holder rewards, the strategic reserve and automation costs
3. Automation converts the reward and reserve portions into MSTR
4. Holders claim MSTR without staking or locking the project token
5. The team can start a vote, and holders decide how an explicitly reserved amount may be used

The internal creator-fee split is 50% holder rewards, 40% strategic reserve and 10% automation

## Holder rewards

- Reward weight uses token balance, exact hold time measured by the hour and a loyalty multiplier
- The loyalty multiplier reaches its cap after 30 days
- Partial sales use newest-lot-first accounting
- Reward cadence changes with market capitalization: 10, 20, 30 or 60 minutes
- Reward claims are initiated by the holder, who pays the claim gas

## Governance

- Only the team starts proposals
- Every holder can vote and voting power follows the reward-weight model
- Quorum is 7% of eligible voting weight
- The team chooses a voting duration from one to twelve hours
- A successful result is executed automatically after a five-minute delay
- Proposal actions are restricted to the fixed allowlist implemented by the contracts

## Transparency

This repository is intended to publish the contracts, reward calculations, governance rules, automation services, public website and tests

Final mainnet contract addresses and transaction links will be added after launch

Useful technical documents:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/operations.md`](docs/operations.md)
- [`apps/web/public/technical-specification.md`](apps/web/public/technical-specification.md)
- [`SECURITY.md`](SECURITY.md)

## Local verification

Requirements: Node.js 20+ and npm

```bash
npm ci
npm run security:secrets
npm run test:all
npm run web:build
```

For local development:

```bash
npm run web:dev
```

The public preview is available at `http://127.0.0.1:5173`

## Repository map

- `contracts/` — Solidity contracts and adapters
- `services/indexer/` — holding-time and reward calculations
- `services/keeper/` — launch, reward and governance automation
- `services/api/` — production web server and public status data
- `apps/web/` — holder website, documentation, governance and private operations interface
- `test/` — contract tests
- `config/` — public chain, protocol and route configuration

## Security

Secrets are not stored in this repository

Private keys, seed phrases, RPC credentials, server passwords, SSH private keys, private admin URLs and live bot state must remain outside Git

`npm run security:secrets` checks publishable files locally, and the same check runs on every GitHub push and pull request

## Current status

The system has passed the included local contract, indexer and wallet tests and was exercised with a small mainnet test deployment

The branded production deployment has not happened yet and the contracts have not completed an independent external audit
