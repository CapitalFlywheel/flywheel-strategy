# Solana provider setup

The landing page can load without RPC credentials, but live wallet/governance reads require the protected web RPC upstream. Do not start the fee keeper or holder indexer until the two independent backend providers are configured and verified

## Primary RPC: existing Alchemy account

1. Sign in to the existing Alchemy account and open **Apps** → **Create new app**
2. Give it a project-specific name such as `FLYWHEEL Solana Mainnet`
3. Select **Solana** and **Mainnet**, with the Node API enabled
4. Open the new app's **Endpoints** tab and copy its HTTPS endpoint into the protected server file as `SOLANA_RPC_PRIMARY_URL`
5. Limit the key to the server's outbound public IP if the Alchemy Solana app offers an IP allowlist; confirm reads and transaction submission still work after it propagates
6. Set a usage alert and inspect the dashboard's CU method breakdown during rehearsal. The old Robinhood endpoint is not a Solana endpoint and must not be reused

Check the current rate, included usage and any account-specific billing terms in the Alchemy dashboard before accepting costs

## Independent fallback RPC

Use a provider other than Alchemy. Helius can be tried for setup, but check its current limits and upgrade if measured full-block scan traffic requires it

1. Create a Helius Solana Mainnet project
2. Copy its HTTPS RPC URL into the protected server file as `SOLANA_RPC_FALLBACK_URL`
3. Set separate usage alerts
4. Confirm both endpoints return the same finalized block and MSTRx mint state using the launch panel's **Verify configuration** action

The two RPC URLs must be HTTPS and have different provider hostnames. Neither belongs in Git, browser JavaScript, chat messages or a public `VITE_*` variable

## Complete holder-history source

The active holder indexer scans every produced finalized block from the CAPITAL launch slot using both independent RPC providers. Mint-filtered signature queries alone are insufficient because some token transfers do not mention the mint in the transaction's account keys. Each provider must therefore support historical `getBlocks` and full `getBlock` reads, including v1 transactions and token-balance metadata. The indexer stops on missing history or disagreement rather than distributing rewards from a partial snapshot

1. Verify both providers can return the same historical finalized blocks, not merely recent account balances
2. Estimate and monitor the credits and bandwidth for a two-provider full-block scan plus relevant transaction rereads; this is materially heavier than a mint-filtered query and a free fallback plan may not sustain it
3. During the authorized canary, prove the scan covers the Pump creation transaction, a regular holder-to-holder transfer and Pump-to-PumpSwap migration before allowing rewards
4. Keep enough archival access to repair long outages from the last verified checkpoint without advancing the holder cursor from incomplete history

Bitquery may be retained for optional diagnostics, but no Bitquery account or token is required to verify launch configuration, arm detection or calculate payable holder rewards

## Protected environment boundary

The Solana control runner and holder indexer read `.env.solana`; the public web container reads only `.env.web`. Reserve and recovery private keys stay off-server. Do not send keypairs, private keys, API keys or authenticated RPC URLs in chat

## Official references

- [Alchemy: create an app and find endpoint URLs](https://www.alchemy.com/docs/create-an-api-key)
- [Alchemy: current pricing](https://www.alchemy.com/pricing)
- [Helius: current plans](https://www.helius.dev/pricing)
- [Bitquery: Solana Transfers query](https://docs.bitquery.io/docs/blockchain/Solana/solana-transfers/)
- [Bitquery: generate an application access token](https://docs.bitquery.io/docs/authorization/how-to-generate/)
- [Bitquery: historical coverage and realtime retention](https://docs.bitquery.io/docs/blockchain/Solana/historical-aggregate-data/)
- [Bitquery: current plans](https://bitquery.io/pricing)
