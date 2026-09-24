# FLYWHEEL STRATEGY

## Overview

FLYWHEEL STRATEGY is a Solana fee-funded system built around CAPITAL and the official MSTRx custom pair on Pump.fun

The configured 2% creator fee is paid in MSTRx. Actual project receipts are divided between automatic holder rewards and a separate strategic reserve

## Fee source

CAPITAL uses the Pump.fun custom-pair field `creator_fee_bps = 200`, equal to 2%

Creator fees accrue in two places

- The Pump bonding-curve creator vault before graduation
- The PumpSwap coin-creator vault after graduation

Both are swept in MSTRx to the same project-controlled creator address and reconciled from finalized Solana transactions

## Allocation

Every actual project creator-fee receipt is allocated exactly once

- 60% funds automatic holder MSTRx rewards
- 40% funds the strategic MSTRx reserve

RPC, rent, priority fees and other operating costs are funded separately

## Reward asset

Rewards use MicroStrategy xStock on Solana

- Symbol: `MSTRx`
- Mint: `XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ`
- Token program: Token-2022
- Raw decimals: 8

Accounting conserves raw token units. The current Token-2022 scaled UI multiplier is read from the mint and applied only for display

## Automatic distribution

Eligible holders receive funded MSTRx directly in their wallets

No claim page, website connection, holder signature or holder-paid gas is required

Each funded epoch follows this sequence

1. Confirm creator-fee receipts across two independent RPC providers
2. Allocate the raw MSTRx receipts 60/40 without losing a raw unit
3. Build holder weights from finalized CAPITAL transfer history
4. Fund the complete reward epoch before the first recipient transfer
5. Send bounded deterministic batches and persist every signature
6. Finalize only after every batch and raw MSTRx unit reconcile

An interrupted batch can resume without paying the same allocation twice

## Holder weight

Reward weight combines CAPITAL balance with exact hold time

- Holder weight: `balance × exact hold time × loyalty factor`
- Holder reward: `funded epoch × holder weight ÷ total eligible weight`

Partial sales consume newest lots first. The derived Pump curve and PumpSwap custody addresses, project service wallets and explicitly configured additional addresses are excluded

Raw-unit remainders are assigned deterministically by largest remainder. A wallet whose calculated share is zero raw MSTRx units receives no transfer in that epoch

## Strategic reserve

The strategic reserve is isolated from holder reward inventory

Potential reserve actions include accumulating MSTRx, CAPITAL buyback and hold, buyback and burn, buyback and lock, MSTRx lock or a disclosed marketing allocation

No Solana governance program has been deployed or independently reviewed. Public voting and automatic execution of reserve decisions are disabled. The reserve remains in a separately controlled wallet, not in an immutable holder-governed vault

The fee split does not give the owner access to completed holder payouts

## Operational custody

The owner and Pump creator share one user-controlled Solana wallet. A protected server-side copy of its keypair is required for automatic creator-fee collection and routing, while private control actions require an exact wallet signature. A server compromise could also compromise owner authority

The owner can pause future fee routing and recover uncommitted project-controlled receipts. Funded holder inventory is held by a separate server-controlled wallet and tracked by a durable allocation journal. This is an operational restriction, not an immutable on-chain holder vault

Completed holder transfers cannot be recalled

## Public verification

The site displays verified CAPITAL mint and project account addresses when available. Reward history links to finalized epoch files and payout signatures. Fee collection and routing are visible through the linked Solana accounts

No reward amount, transfer or governance decision is presented as completed without a corresponding record

The official project X account is `@capital_mstr`

## Economic limits

Rewards depend on actual fee receipts, holder eligibility and successful Token-2022 transfers. They are not fixed income or guaranteed returns. The reserve is a separately held project asset, not a redemption claim on CAPITAL
