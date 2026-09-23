# Solana staging isolation

This is an isolated **mainnet canary**, not the production FLYWHEEL launch. Use only disposable wallets and a separate test token. No transaction may be sent merely because the preview web service is online

## Boundaries

- Checkout: `/opt/mstr-system-staging`, never `/opt/mstr-system`
- Docker Compose project: `mstr-system-staging`, with a distinct image tag
- HTTP: `127.0.0.1:8788` on the server, accessed only by an SSH tunnel
- State: `/opt/mstr-system-staging/data`, never production `data`
- Protected environment: `.env.solana` inside the staging checkout, mode `0600`; do not copy production `.env.server` or any wallet key into staging
- Financial services have the `staging-automation` profile and remain stopped until test wallets, two independent RPCs, transfer history and a reviewed launch plan are installed
- The production website and old Robinhood automation are not staging test surfaces

## Preview-only startup

From the staging checkout, create empty mode-0600 `.env.web` and `.env.solana` files before the first Compose call. Start only the web service:

```sh
docker compose -p mstr-system-staging -f compose.yaml -f compose.staging.yaml up -d --build web
```

Check that `docker compose -p mstr-system-staging -f compose.yaml -f compose.staging.yaml ps` lists only `web` and that `curl -I http://127.0.0.1:8788/` returns HTTP 200. Do not start the automation profile at this stage

On Windows, use a local-only SSH tunnel:

```powershell
ssh -N -L 8788:127.0.0.1:8788 -i "$env:USERPROFILE\.ssh\mstr-system-deploy-ed25519" mstradmin@150.241.115.203
```

Open `http://127.0.0.1:8788/` in another browser window. This is a private preview, not the public project URL

## Provider and wallet setup

Install Alchemy Solana Mainnet as `SOLANA_RPC_PRIMARY_URL` and Helius Solana Mainnet as `SOLANA_RPC_FALLBACK_URL` only in the protected staging environment. Do not paste authenticated URLs into Git, a public site variable or chat. The existing paid Robinhood endpoint is not a Solana endpoint

Use six distinct disposable public roles: owner/admin, Pump creator, operator, holder settlement, reserve and recovery. The current automatic fee route requires a **test creator keypair** on the staging server. Owner, reserve and recovery keys stay off-server. Add several independent test holder wallets, including one without an MSTRx associated token account. Fund only the test operator and creator with the SOL needed for a bounded rehearsal

The current service is hard-pinned to `solana-mainnet-beta`; a devnet-only end-to-end run is not supported as-is. Unit and simulated tests can run without spending funds, but actual MSTRx transfer-hook behavior and Pump custom-pair receipts require a separately authorized mainnet canary with disposable identities and real transaction costs. Never use the final production creator for that canary

The test CAPITAL mint is learned from the confirmed Pump creation transaction. Before any test token creation, verify the custom MSTRx pair, 2% creator-fee setting, Creator recipient mode, two-RPC agreement, transfer-source coverage and exact expected creator identity

When staging is finished, archive its evidence separately. Production activation must start from a fresh checkout and state directory with no canary addresses, signatures, epochs, cursors or wallet keys
