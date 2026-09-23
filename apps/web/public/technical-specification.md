# FLYWHEEL STRATEGY

## Overview

CAPITAL is being rebuilt as a Pump.fun token paired with the official Solana MSTRx asset

Pump.fun collects a fixed 2% creator fee in MSTRx. Actual creator-fee receipts are divided between automatic holder rewards and a separate strategic reserve

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

```text
holder weight = balance × exact hold time × loyalty factor
holder reward = funded epoch × holder weight ÷ total eligible weight
```

Partial sales consume newest lots first. Pump curve custody, PumpSwap custody, vaults, program accounts, burn accounts and project operational wallets are excluded

Raw-unit remainders are assigned deterministically by largest remainder. A wallet whose calculated share is zero raw MSTRx units receives no transfer in that epoch

## Strategic reserve

The strategic reserve is isolated from holder reward inventory

Its restricted Solana governance program may support only published actions such as accumulating MSTRx, CAPITAL buyback and hold, buyback and burn, buyback and lock, MSTRx lock or a disclosed marketing allocation

Arbitrary calls and arbitrary recipients are not accepted by the control plane

Public voting stays unavailable until the Solana governance program is audited and deployed

## Owner controls

The private panel uses a Solana wallet signature for one exact action at a time

It exposes separate controls for configuration verification, launch detection, both Pump fee routes, routing pause, epoch preparation, automatic distribution, finalization and recovery of uncommitted balances

One pre-launch arm signature authorizes the detector window. The exact mint is verified, published and activated automatically after finalized detection, without a second post-launch owner signature

The owner and Pump creator are the same user-controlled wallet. A protected server-side copy of that keypair is required for automatic creator-fee routing, while panel actions still require an exact wallet signature. This means a server compromise could also compromise owner authority. The server never accepts arbitrary browser-supplied transaction instructions

The current distributor commits and tracks funded holder allocations in its durable journal, and its permitted recovery path excludes that committed inventory. This is an operational software restriction, not an immutable on-chain vault: the holder-inventory signing key is server-held. Completed transfers cannot be recalled

## Public verification

After launch the site will publish the CAPITAL mint, project-controlled creator address, reward vault, reserve vault, fee collection and 60/40 routing signatures, payout batches and finalized epoch files

The X link remains intentionally unpublished until the new Solana account is supplied

## Current status

The Solana version is not deployed yet

The CAPITAL mint and final program addresses will appear only after the verified Pump.fun launch and production checks
