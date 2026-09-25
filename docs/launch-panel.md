# Solana launch and operations panel

## Access and authorization

The private panel is served only at the unlisted path configured by `ADMIN_PANEL_PATH`. The public `/admin` route is unavailable. The unlisted path is not authentication: every operation requires a fresh Ed25519 signature by `SOLANA_ADMIN_OWNER`

The isolated test panel is reachable from the main HTTPS domain through an exact reverse-proxy route to the staging web service. The path and its API are not linked from public pages; public website routes remain on the production web service. A local SSH tunnel remains available as an operational fallback, not the normal owner workflow. Never commit the actual panel path or weaken the owner-signature check

The owner, Pump creator and creator-fee recovery address are the same wallet in the approved single-wallet setup. Its protected server keypair lets the service collect creator fees automatically; a compromised server could therefore control that wallet. The user retains the wallet and signs panel actions directly. The panel never accepts arbitrary transaction instructions or destinations

## One-signature launch flow

1. Connect the configured owner wallet in the private panel
2. Select **Check and arm token detection** and sign once before creating the token. The runner verifies wallet roles, the official MSTRx mint, the two RPCs and the absence of older MSTRx creator-fee receipts, then durably arms discovery
3. The user creates CAPITAL on Pump.fun with the MSTRx custom pair, a 2% creator fee, native Pump holder rewards disabled and creator rewards sent to the configured dev wallet
4. The detector independently verifies the created mint and Pump settings against finalized RPC data, then activates fee collection, holder accounting and automatic MSTRx payouts without another owner signature

The owner creates the token. The system never creates it and never uses the production creator for test launches. A separate governance program or reserve-vault deployment is not part of this flow

Pump creator-fee vaults are keyed by creator and quote mint, not by CAPITAL mint. Do not create another MSTRx-paired Pump token with this same creator while this project is active; older receipts must be cleared before arming

## Fee routing and reserve

The runner collects creator fees from both the bonding curve and PumpSwap after migration. Only actual finalized MSTRx receipts are split: 60% to the separate holder-distribution wallet, 40% to the reserve MSTRx token account owned by `SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY`

The reserve is an ordinary wallet controlled by the user. The server does not require its private key. The private panel displays its address and observed MSTRx balance. A token transfer out of reserve is made directly by that wallet's owner, not by a program or a governance button

Fee controls have separate actions to sweep, pause, reconcile, resume and recover only collected but unrouted creator funds. Recovery cannot take funds already routed to holders or the reserve

Holder rewards are pushed automatically in funded, idempotent batches. A holder does not connect a wallet or sign a claim transaction to receive an earned allocation

## State and verification

Solana runtime state is separate from the retired Robinhood deployment. No legacy EVM receipt, holder cursor or epoch can be imported. The panel shows queued, processed or failed requests; **processed** means the runner completed the action, not that every onchain transaction finalized

Before a real launch, verify a user-created test token end to end: detection, creator-fee collection, 60/40 transfer, automatic holder payout and continuity after PumpSwap migration. Do not describe any of these as live-proven before that test
