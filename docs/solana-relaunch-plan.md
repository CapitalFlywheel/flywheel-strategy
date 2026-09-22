# FLYWHEEL STRATEGY Solana relaunch plan

Status: architecture preparation. This document does not authorize a mainnet launch or replace live configuration

Verified: 22 September 2026

## Product decision

- CAPITAL launches through Pump.fun against the official supported MSTRx custom pair
- The Pump create instruction uses `creator_fee_bps = 200`, equal to a fixed 2% creator fee
- Creator rewards are sent to one project-controlled dev wallet
- Pump native holder rewards stay disabled because CAPITAL uses its own external MSTRx reward weighting
- Actual MSTRx receipts split 60% to holder rewards and 40% to the strategic reserve
- Eligible holders receive MSTRx automatically with no claim or website connection
- Operating SOL is funded separately and never deducted from 60/40

The Robinhood deployment, contracts, addresses, epochs and cached state are legacy data. They remain disabled and namespaced and are never imported into Solana production state

## Verified Pump.fun custom-pair facts

Pump.fun documents `creator_fee_bps` for custom quote pairs other than SOL or USDC. The official supported-pair list currently includes MSTRx

- Symbol: `MSTRx`
- Mint: `XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ`
- Token program: Token-2022
- Raw decimals: `8`
- Creator fee: `200` basis points
- Holder reward mode: `false`

Pump.fun states that trading fees and creator fees are collected and paid in the asset used as the pair. Therefore no SOL-to-MSTRx swap or Jupiter route is part of this design

Primary references

- [Pump.fun coin creation and custom creator fee](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md)
- [Pump.fun supported custom pairs and MSTRx mint](https://pump.fun/docs/custom-pairs)

The supported-pair list can change. Launch verification must re-check the official list and the actual finalized bonding-curve fields immediately before activation

## Fee flow

Creator fees accrue in two locations

1. Pump bonding-curve creator vault before graduation
2. PumpSwap coin-creator vault after graduation

The official V2 collection instructions move both sources into the configured creator's MSTRx associated token account. The service measures the exact balance increase produced by that confirmed collection and routes only that receipt, never the creator wallet's unrelated MSTRx balance

```text
CAPITAL / MSTRx trade
→ fixed 2% creator fee in MSTRx
→ controlled creator MSTRx account
→ 60% isolated holder inventory
→ 40% isolated strategic reserve
```

Indivisible raw-unit dust is assigned to the reserve share so that the split always conserves the gross receipt exactly

## Token-2022 handling

MSTRx uses Token-2022 extensions including a transfer hook, permanent delegate, default account state, scaled UI amount and pausable configuration

Every MSTRx transfer must

- use the Token-2022 program
- resolve transfer-hook accounts through the extension-aware SPL helper
- create destination associated token accounts idempotently when required
- simulate successfully before signing
- conserve raw units rather than UI-scaled display values
- stop when the mint is paused or extension state differs across RPC providers

## Automatic holder rewards

The default reward path is push distribution with no claim

```text
finalized MSTRx fee receipts
→ exact 60/40 allocation
→ fully funded holder epoch
→ deterministic CAPITAL holder weights
→ bounded idempotent MSTRx transfer batches
→ exact conservation finalization
```

Reward weight combines CAPITAL balance, exact hold time and the published loyalty factor. Partial sales consume newest lots first

Holders do not connect to the website, sign messages, submit claims or pay transaction fees to receive an earned allocation

Before production the history source must prove finalized CAPITAL transfers without gaps. Pump custody, PumpSwap custody, project wallets, vaults, program accounts and burn addresses must be excluded

## Custody and recovery

- The dev creator wallet owns the fee destination and remains under project control
- The operator wallet pays SOL transaction fees only
- The holder inventory wallet contains only MSTRx committed for holder distribution
- The reserve wallet contains only the strategic 40% allocation
- Marketing funds remain separate
- The private panel can pause routing and recover only uncommitted MSTRx still present in project-controlled staging accounts to the configured recovery wallet, which may be the owner wallet
- Completed holder transfers are never reclaimed

The creator service key is installed outside Git in a protected keypair file because routing transfers require its Token-2022 signature. The public owner key never enters the server

## Owner control plane

The private panel provides one explicit signed action per intention

- verify creator, custom quote, fixed 2% and MSTRx extensions
- arm or disarm exact Pump mint detection
- publish and activate only the verified creator mint automatically after finalized detection
- route bonding-curve creator fees
- route PumpSwap creator fees
- pause or resume fee routing
- prepare, distribute and finalize an automatic reward epoch
- inspect creator, holder and reserve balances
- recover only uncommitted project-controlled MSTRx
- export operational evidence

The server maps these allowlisted actions to fixed code. It never accepts browser-supplied transaction instructions or shell commands

## One-signature launch target

All wallets, associated token accounts, RPC providers and services are prepared before launch. The owner signs one pre-launch `ARM` challenge. Pump coin creation and the optional first buy are then performed through the real Pump.fun launch flow

No post-launch owner signature is required for activation, normal fee collection, routing or automatic payout. The separately authorized service keys execute those routines immediately after finalized launch detection

## Website migration

The Solana build contains no Robinhood Chain, PONS, ETH, WETH, Uniswap, Blockscout or EVM wallet language

Public copy uses

- Pump.fun and PumpSwap
- CAPITAL / MSTRx
- fixed 2% creator fee
- exact 60/40 MSTRx allocation
- Solscan links
- automatic MSTRx airdrops with no claim

Wallet connection remains unnecessary for receiving rewards

## Remaining production blockers

- final Solana owner, creator, operator, holder-inventory, reserve, recovery and marketing public keys
- protected server paths for creator, operator, holder and reserve keypairs
- new X account URL
- production primary and independent fallback Solana RPC providers
- a finalized CAPITAL transfer-history provider with gap detection
- final CAPITAL mint created through the verified Pump.fun MSTRx custom-pair flow
- end-to-end rehearsal proving transfer-hook routing and airdrop delivery
- independent review of custody, automation and any governance program used at launch
- resolution or explicit security acceptance of the current upstream Solana/Pump SDK dependency advisories
