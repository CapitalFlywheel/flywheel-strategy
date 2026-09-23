# Solana launch and operations panel

## Access

The private panel is served only at the unlisted path configured through `ADMIN_PANEL_PATH`

The public `/admin` path and the old `/admin/api/solana` surface return 404. The Solana control API is mounted beneath the same unlisted panel path. The unlisted path is not a substitute for wallet authentication

## Authorization

Every action requires a fresh Ed25519 signature from `SOLANA_ADMIN_OWNER`

The signed challenge contains the exact action, owner, network, 60/40 allocation, issue time, five-minute expiry and a random one-time nonce

In the approved single-wallet configuration, the owner, Pump creator and recovery address are the same. The user keeps that wallet in Phantom, Solflare, Backpack or another compatible wallet for panel signatures; a protected copy of its keypair is also installed outside Git on the server for automatic creator-fee routing. This materially increases the impact of a server compromise. The panel still requires an exact signed challenge and never accepts arbitrary browser-supplied transactions

## Launch actions

- Verify pre-launch wallet roles, RPC consensus, MSTRx asset properties and Bitquery transfer-history availability
- Arm detection for one coin created by the approved creator
- Disarm detection without changing balances
- Automatic activation of only the independently verified detected mint

The intended Pump.fun configuration is a custom pair with the official MSTRx quote mint, native Pump holder rewards disabled and a fixed creator fee of 200 basis points. The actual coin fields are verified only after Pump creates the mint; the pre-launch button cannot prove the future coin's settings

## Fee actions

- Sweep bonding-curve creator fees
- Sweep PumpSwap creator fees
- Pause fee collection and routing
- While paused, reconcile an already signed collection or route without creating a new fee transaction
- Resume after configuration and RPC consensus checks
- Recover only uncommitted project-controlled balances

When the dev wallet is also the recovery wallet, a paused recovery marks still-uncommitted creator receipts as already accessible there; it does not submit a self-transfer

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
3. Verify creator and operational wallet roles, official MSTRx mint and both RPC providers
   The shared owner/creator/recovery role is explicit; operator, holder inventory and reserve remain distinct
4. Arm detection immediately before the real launch
5. Create CAPITAL on Pump.fun with the MSTRx custom pair, `creatorFeeBps: 200`, `holderReward: false` and creator rewards sent to the configured dev wallet
6. Let the detector verify the actual MSTRx quote, fixed 2% fee and disabled native holder rewards, then activate only that mint without another owner signature
7. Review the detected mint and the live service status in the panel
8. Confirm the first real MSTRx creator-fee receipt through the complete sweep, 60/40 allocation and automatic payout path

No production wallet is used for test launches

Pump creator-fee vaults are keyed by creator address rather than CAPITAL mint. Do not use the same test or production creator for another MSTRx-paired Pump token, and verify that no older MSTRx creator fees remain before arming detection

## State protection

Solana production state uses separate directories and service names from the legacy Robinhood deployment

Activation starts from an empty Solana receipt ledger, holder cursor, epoch sequence and distribution journal. Legacy EVM addresses or cached epochs cannot be imported

Every request file records its exact signed action, owner, issue/expiry time and nonce. The constrained host runner independently verifies the signature, consumes the nonce in state unavailable to the web process, maps the allowlisted action to audited code and never executes browser-provided shell commands

The panel follows each request through `queued`, `processed` or `failed` using a sanitized status marker. `Processed` means the runner action completed, not that an onchain transaction finalized. Raw signed requests and exception records are not exposed through the web container
