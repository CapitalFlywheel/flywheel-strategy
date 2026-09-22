# Solana launch and operations panel

## Access

The private panel is served only at the unlisted path configured through `ADMIN_PANEL_PATH`

The public `/admin` path and the old `/admin/api/solana` surface return 404. The Solana control API is mounted beneath the same unlisted panel path. The unlisted path is not a substitute for wallet authentication

## Authorization

Every action requires a fresh Ed25519 signature from `SOLANA_ADMIN_OWNER`

The signed challenge contains the exact action, owner, network, 60/40 allocation, issue time, five-minute expiry and a random one-time nonce

The owner private key stays in Phantom, Solflare, Backpack or another Solana Wallet Standard compatible wallet. It is never uploaded to the server

## Launch actions

- Verify the exact Pump.fun launch configuration
- Arm detection for one coin created by the approved creator
- Disarm detection without changing balances
- Automatic activation of only the independently verified detected mint

The intended Pump.fun configuration is a custom pair with the official MSTRx quote mint, native Pump holder rewards disabled and a fixed creator fee of 200 basis points

## Fee actions

- Sweep bonding-curve creator fees
- Sweep PumpSwap creator fees
- Pause new fee routing and commitments
- Resume after configuration and RPC consensus checks
- Recover only uncommitted project-controlled balances

The panel does not accept arbitrary instructions or arbitrary destinations

## Reward and reserve actions

- Route the exact holder 60% MSTRx allocation into isolated reward inventory
- Route the exact reserve 40% MSTRx allocation into isolated reserve inventory
- Prepare a fully funded reward epoch
- Distribute deterministic automatic MSTRx batches
- Finalize only after all raw units reconcile

Each action has its own button and progress record. A generic multi-step signature loop is not used

## Launch sequence

1. Install production RPC and service secrets outside Git
2. Connect the configured owner wallet to the private panel
3. Verify creator, official MSTRx quote, fixed 2% fee, Pump programs and both RPC providers
4. Arm detection immediately before the real launch
5. Create CAPITAL on Pump.fun with the MSTRx custom pair, `creatorFeeBps: 200`, `holderReward: false` and creator rewards sent to the configured dev wallet
6. Let the detector bind, verify and activate the one mint created by the approved creator without another owner signature
7. Review the detected mint and the live service status in the panel
8. Confirm the first real MSTRx creator-fee receipt through the complete sweep, 60/40 allocation and automatic payout path

No production wallet is used for test launches

## State protection

Solana production state uses separate directories and service names from the legacy Robinhood deployment

Activation starts from an empty Solana receipt ledger, holder cursor, epoch sequence and distribution journal. Legacy EVM addresses or cached epochs cannot be imported

Every request file records its action, signer and timestamp. The constrained host runner maps the allowlisted action to audited code and never executes browser-provided shell commands
