# Solana staging isolation

This is an isolated **mainnet canary**, not the production FLYWHEEL launch. Use only disposable wallets and a separate test token. No transaction may be sent merely because the preview web service is online

## Boundaries

- Checkout: `/opt/mstr-system-staging`, never `/opt/mstr-system`
- Docker Compose project: `mstr-system-staging`, with a distinct image tag
- HTTP preview: `127.0.0.1:8788` on the server, accessed by an SSH tunnel; only the exact hidden admin route and its API are also proxied through the main HTTPS domain
- State: `/opt/mstr-system-staging/data`, never production `data`
- Protected environment: `.env.solana` inside the staging checkout, mode `0600`; do not copy production `.env.server` or any wallet key into staging
- Financial services have the `staging-automation` profile and remain stopped until the complete governance executor, reviewed vault program, test wallets, two independent RPCs, transfer history and launch plan are ready
- If automation is later authorized, start it only through the guarded Compose services. Two copies pointed at the same local `SOLANA_STATE_ROOT` serialize on per-service kernel locks; a persistent `.locks` file is normal and must not be deleted. Never run an unguarded direct TypeScript entrypoint against a live state directory
- The production website and old Robinhood automation are not staging test surfaces

## Preview-only startup

From the staging checkout, create empty mode-0600 `.env.web` and `.env.solana` files before the first Compose call. Provision the narrow bind-mount directories with uid/gid `1000:1000` before starting containers; otherwise Docker may create root-owned directories that the web process cannot write:

```sh
sudo install -d -m 0750 -o 1000 -g 1000 data/public data/control/solana-requests data/control/solana-status-visible data/control/solana-completed data/control/solana-failed data/solana
```

The web container can read only public snapshots and the private control-status directory containing sanitized request outcome markers, both mounted read-only, and can write only the request queue. Raw completed/failed request files, the runner's nonce ledger and financial state are not mounted into web. Start only the web service:

```sh
docker compose -p mstr-system-staging -f compose.yaml -f compose.staging.yaml up -d --build web
```

Check that `docker compose -p mstr-system-staging -f compose.yaml -f compose.staging.yaml ps` lists only `web` and that `curl -I http://127.0.0.1:8788/` returns HTTP 200. Do not start the automation profile at this stage

On Windows, use a local-only SSH tunnel. Take the SSH user, host and private-key path from the private access handoff; do not publish them in this repository:

```powershell
ssh -N -L 8788:127.0.0.1:8788 -i "<local-private-key-path>" "<ssh-user>@<server-address>"
```

Open `http://127.0.0.1:8788/` in another browser window. This is a private preview, not the public project URL

## Provider and wallet setup

Install Alchemy Solana Mainnet as `SOLANA_RPC_PRIMARY_URL` and Helius Solana Mainnet as `SOLANA_RPC_FALLBACK_URL` only in the protected staging environment. Do not paste authenticated URLs into Git, a public site variable or chat. The existing paid Robinhood endpoint is not a Solana endpoint

Bitquery is not required to arm the launch detector or calculate holder rewards. The holder indexer instead reads each produced finalized block from **both** RPCs and rereads relevant transactions. This may consume substantial provider credits and bandwidth, particularly while catching up from the launch slot; confirm archival block access and watch both providers' usage/quota before the canary. A free fallback plan is not proof that the sustained scan will fit its limits

The browser uses the same-origin `/api/solana/rpc` read-only relay. Put a separate budgeted Solana Mainnet HTTPS upstream in `SOLANA_PUBLIC_RPC_UPSTREAM_URL` in the protected staging `.env.web`; never put an authenticated URL in a `VITE_` variable, Git or chat. The upstream remains server-side, but public reads still consume provider capacity. The relay's bounded method list, timeout and rate caps must be load-tested on desktop/mobile before release. It deliberately rejects `sendTransaction`. The dedicated `/api/solana/governance-vote` route accepts only an exact signed `cast_vote` transaction and is independently hard-disabled; the public vote flag also stays off. Its protected `.env.web` requires two independent private Solana RPC URLs plus the reviewed governance program ID/hash, CAPITAL mint and admin pubkey. This needs audit, final executor release, a verified immutable deployment and real-device wallet tests before either vote gate can change. The Solana WalletConnect/Reown Project ID is public configuration, not a server secret, and its site origins still need allowlisting

Run `npm run preflight:solana-web` on the staging host, or on a local machine while the SSH tunnel to `127.0.0.1:8788` is open. This read-only diagnostic sends one bounded finalized `getBlockHeight` request through the **running web container's** `/api/solana/rpc` route and a harmless GET to the vote route. It never reads or prints the protected upstream URL, signs or broadcasts. `readOnlyRpcReady: true` is required for the wallet/governance page's chain reads; `voteRelayReleased: false` and a nonzero command exit are expected while voting remains gated, and `voteEndToEndVerified` remains false until a real signed test vote finalizes. The backend `preflight:solana-test` uses `.env.solana` and does **not** verify the web container's `.env.web`. Run both diagnostics; neither substitutes for mobile-wallet or voting tests. After public deployment, use `npm run preflight:solana-web -- --public` to probe the canonical HTTPS site through its reverse proxy. If the API POST returns an HTML page, treat the public route as broken even if the homepage loads: inspect the active reverse-proxy configuration and deployed web image/route before touching governance release gates

For mobile WalletConnect, reuse the **public** 32-character Reown Project ID already configured for this site if its origin allowlist and Solana adapter pass real-device testing; the code does not require a new project. Compose accepts `VITE_SOLANA_WALLETCONNECT_PROJECT_ID` and falls back to the existing `VITE_REOWN_PROJECT_ID` when the new variable is empty. Keep this public value in the server checkout's ignored `.env` file or export it in the shell that runs `docker compose build web`; placing it only in `.env.web` is too late because Vite builds the bundle in the Dockerfile. Rebuild and restart the web service after changing it. If both are missing or malformed, WalletConnect stays disabled while Wallet Standard still discovers installed/injected Solana wallets; this does not block the read-only site or automatic holder rewards. No private key, server RPC URL or authenticated API key belongs in a `VITE_` variable. In the Reown project's allowlist, add the exact HTTPS origin actually serving the site (for example `https://flywheelstrategy.xyz`, and `https://www.flywheelstrategy.xyz` only if that hostname is served). Keep any preview origin separate from production and verify the reused ID connects on Solana before release

Before enabling wallet-signed voting, test on real iOS and Android devices: (1) an installed wallet's in-app browser, (2) an external mobile browser using WalletConnect deep link or QR handoff, and (3) desktop QR connection. Verify connect, wallet address and network, disconnect, account switching, return from the wallet app, and rejection of a signature. Then, with a disposable test identity and a reviewed deployed program only, verify a correctly signed vote and a finalized vote-record account. Never ask a holder to connect or sign merely to receive their automatic MSTRx reward. The current voting release flag remains off until the onchain executor and end-to-end checks pass

Use the disposable `9tiKUSwJrdJQzySro2pWJmWLw83NpdGwrvTCUesSP9NQ` address for test owner, Pump creator and recovery, with `SOLANA_SHARED_ADMIN_CREATOR=true`. Automatic creator-fee collection requires a protected copy of this test keypair on the server. Keep operator and holder-settlement service wallets distinct. Set `SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY` to the user-controlled test reserve `8VffEDVrevGdRgDZP1rEDjWiZ3UvR256993C1ugCS73r`; its key stays with the user and never enters the server. No governance program or PDA vault is part of the test launch. Add independent test holders, including one without an MSTRx associated token account. Fund only test wallets for bounded real transaction costs. Never copy the production key into staging or paste any secret into chat

The test marketing address may reuse the test owner, but marketing-sale voting is inactive in the current owner-wallet route

The current service is hard-pinned to `solana-mainnet-beta`; a devnet-only end-to-end run is not supported as-is. Unit and simulated tests can run without spending funds, but actual MSTRx transfer-hook behavior and Pump custom-pair receipts require a separately authorized mainnet canary with disposable identities and real transaction costs. Never use the final production creator for that canary

The test CAPITAL mint is learned from the finalized Pump creation transaction. Before creating it, run `npm run preflight:solana-test` inside the isolated test runtime with protected creator, operator and holder keypair files mounted. The read-only report checks identities and two RPCs without printing secrets. It does not require a governance program or voting release gates. If a production creator is already known, set its **public address only** as `SOLANA_PRODUCTION_DEPLOYER_PUBLIC_KEY` so overlap is rejected. The test creator must never be promoted to production. The user creates the token only after the one signed arm action. Actual fee collection, transfer-hook behavior, automatic payout and PumpSwap migration must be proven with the test token before the main launch

Use a fresh test creator with no other MSTRx-paired Pump coin and a zero prior MSTRx creator-fee balance. The creator-fee vault is creator-and-quote scoped, not token scoped; unrelated receipts cannot be assigned to the test CAPITAL mint

When staging is finished, archive its evidence separately. Production activation must start from a fresh checkout and state directory with no canary addresses, signatures, epochs, cursors or wallet keys
