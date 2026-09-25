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

The operational runner verifies the creator, coin mint, quote mint, fee phase and destination before simulating or signing a collection transaction. It saves each signed collection to a durable receipt ledger before broadcast, then allocates the exact finalized creator-account MSTRx balance delta instead of sweeping the wallet's unrelated MSTRx

The launch detector watches the approved creator only after the owner's one-time arm timestamp. It paginates transactions after arming on two independent RPC providers, decodes the Pump create event, fails closed on multiple launches and activates only after both providers agree on the creation event and the mint's MSTRx quote, Token-2022 program, fixed 200 bps fee and disabled native holder rewards

## Allocation and conversion

`services/solana/mstrxTransfers.ts` allocates exact finalized raw MSTRx receipts

- Holder share: floor(receipts × 6000 / 10000)
- Reserve share: receipts minus holder share
- Indivisible raw-unit dust therefore remains in the reserve share

This construction preserves every received raw MSTRx unit. No swap, price route or conversion slippage exists in the fee path

MSTRx uses Token-2022 transfer-hook extensions. Every routed or distributed transfer is built with the extension-aware SPL helper and simulated before signing

## Reward accounting

The exact hold-time model uses finalized CAPITAL balance changes and deterministic newest-lot-first reductions on a partial sale

`services/solana/holderIndexerRunner.ts` discovers mint-wide CAPITAL candidates by scanning every finalized produced block with two independent RPC providers, from launch and then across every new slot range. It verifies each candidate's ordered token movements and canonical transaction position against both providers, persists a versioned launch-to-target coverage marker and digest, and requires a one-slot overlap on extension. Reorged or merely confirmed state is not eligible. An incomplete bounded scan cannot advance the holder cursor or payout journal. The scan requires archival full-block coverage and may halt on provider limits; Bitquery-only transfer rows do not prove completeness and cannot authorize holder rewards. See `docs/solana-holder-backfill.md`

Every epoch records

- Finalized receipt range
- Exact funded raw MSTRx amount
- Time-weighted eligible holder movements and exclusions, including derived Pump curve and PumpSwap pool addresses
- Deterministic allocation file hash
- Deterministic batch identifiers
- Transfer signatures and processed totals
- Local exact-conservation evidence and public payout transaction links

## Automatic distribution

The distributor creates recipient Token-2022 associated token accounts when required and pays their rent from the separately funded operator wallet

Every batch is idempotent. Restarts load processed batch identifiers and confirmed signatures before building another transaction

The local version-4 reward plan binds one deterministic, separate Token-2022 owed-escrow account per epoch, owned by the existing holder-settlement authority. A proven failed packet is retried recipient by recipient. An allocation becomes owed only when its exact MSTRx amount is finalized in that escrow, never when a transfer merely fails or becomes invisible to an RPC. Private per-epoch debt receipts, public sanitized status and bounded escrow-only retries preserve `paid + escrowed = funded`; old escrow balances never fund new epochs. This recovery path still requires real MSTRx extension, transfer-hook and restart tests before release. It is not a deployed onchain commitment and a compromised holder-settlement signer could bypass the software restriction

The owner may pause future routing and recover only collected but uncommitted MSTRx recorded in the creator receipt ledger. Committed holder inventory, completed holder transfers and reserve inventory are not part of that recovery route

## Strategic reserve

Reserve inventory is held in a separate ordinary MSTRx token account owned by the user-controlled reserve wallet. The runner verifies that token account's mint and owner before routing its 40% share. No Solana reserve or governance program is deployed or required for launch

The wallet owner can transfer reserve funds directly. Holder voting uses a published balance-time snapshot and signed offchain choices, one per eligible wallet. The web service verifies signatures and stores receipts, while the runner publishes a snapshot after two-RPC finalized history checks. Votes are advisory: neither the ballot nor its outcome locks the owner wallet or executes a reserve action. The historical onchain governance prototype in this repository is not part of the active Solana product and its transaction routes remain disabled

## Control plane

The hidden panel requests a short-lived challenge for one allowlisted action. The owner signs the exact message in a Solana wallet. The server verifies Ed25519 ownership and writes a mode-600 request into a constrained queue

The browser cannot provide shell commands, executable paths or arbitrary serialized transactions

## Legacy isolation

Robinhood contracts, chain configuration, epochs, manifests and keepers remain in the repository only as legacy audit history

They are excluded from Solana production configuration and must never share state directories, service names, environment variables or deployment manifests with the Solana version
