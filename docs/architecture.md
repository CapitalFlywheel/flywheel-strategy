# Solana architecture

## Boundaries

FLYWHEEL STRATEGY is split into independent custody, accounting and execution boundaries

```text
Pump curve creator vault ─┐
                         ├─► controlled creator MSTRx ATA ─► finalized receipt ledger
PumpSwap creator vault ──┘                              │
                                                       ├─► 60% MSTRx reward inventory
                                                       └─► 40% MSTRx reserve inventory

finalized CAPITAL history ─► deterministic holder weights ─► funded epoch ─► push batches
```

## Public configuration

`config/solana-mainnet.json` fixes the public network, Pump programs, official MSTRx quote mint, fixed 200 bps creator fee and 60/40 allocation

Live wallet and program addresses are absent until verified. No placeholder address may be promoted into production

## Fee ingress

`services/solana/pumpFees.ts` uses the official Pump SDK V2 creator-fee instructions for a non-SOL quote, spanning the bonding-curve and PumpSwap paths

The operational runner must independently verify the creator, coin mint, quote mint, fee phase and destination before simulating or signing a collection transaction. Allocation uses the confirmed creator-account balance delta from that collection rather than sweeping the wallet's unrelated MSTRx

The launch detector watches the approved creator only after the owner's one-time arm timestamp. It decodes the Pump create event, fails closed on multiple launches and activates only after two-provider verification of the mint, MSTRx quote, Token-2022 program, fixed 200 bps fee and disabled native holder rewards

## Allocation and conversion

`services/solana/mstrxTransfers.ts` allocates exact finalized raw MSTRx receipts

- Holder share: floor(receipts × 6000 / 10000)
- Reserve share: receipts minus holder share
- Indivisible raw-unit dust therefore remains in the reserve share

This construction preserves every received raw MSTRx unit. No swap, price route or conversion slippage exists in the fee path

MSTRx uses Token-2022 transfer-hook extensions. Every routed or distributed transfer is built with the extension-aware SPL helper and simulated before signing

## Reward accounting

The existing exact hold-time model is ported to finalized Solana token history

The indexer must checkpoint slot, block identity and signature cursor and must not advance if providers disagree. Reorged or merely confirmed state is not eligible

Every epoch records

- Finalized receipt range
- Exact funded raw MSTRx amount
- Eligible holder snapshot and exclusions
- Deterministic allocation file hash
- Deterministic batch identifiers
- Transfer signatures and processed totals
- Final conservation proof

## Automatic distribution

The distributor creates recipient Token-2022 associated token accounts when required and pays their rent from the separately funded operator wallet

Every batch is idempotent. Restarts load processed batch identifiers and confirmed signatures before building another transaction

The owner may pause future routing and commitments and recover only the MSTRx still present in the creator address or another explicitly uncommitted account. A completed holder transfer is not recoverable

## Strategic reserve

Reserve inventory is held separately from the reward vault. Governance is a new Solana execution layer and does not reuse Solidity contracts

Only fixed action variants are valid. Arbitrary instructions, arbitrary recipients and browser-supplied transaction data are rejected

## Control plane

The hidden panel requests a short-lived challenge for one allowlisted action. The owner signs the exact message in a Solana wallet. The server verifies Ed25519 ownership and writes a mode-600 request into a constrained queue

The browser cannot provide shell commands, executable paths or arbitrary serialized transactions

## Legacy isolation

Robinhood contracts, chain configuration, epochs, manifests and keepers remain in the repository only as legacy audit history

They are excluded from Solana production configuration and must never share state directories, service names, environment variables or deployment manifests with the Solana version
