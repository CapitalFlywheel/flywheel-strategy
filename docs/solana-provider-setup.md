# Solana provider setup

The website can stay online without private RPC credentials. Do not start the fee keeper or holder indexer until the production providers are configured and verified

## Primary RPC: existing Alchemy account

1. Sign in to the existing Alchemy account and open **Apps** → **Create new app**
2. Give it a project-specific name such as `FLYWHEEL Solana Mainnet`
3. Select **Solana** and **Mainnet**, with the Node API enabled
4. Open the new app's **Endpoints** tab and copy its HTTPS endpoint into the protected server file as `SOLANA_RPC_PRIMARY_URL`
5. Limit the key to the server's outbound public IP if the Alchemy Solana app offers an IP allowlist; confirm reads and transaction submission still work after it propagates
6. Set a usage alert and inspect the dashboard's CU method breakdown during rehearsal. The old Robinhood endpoint is not a Solana endpoint and must not be reused

Creating the Solana app under the same account uses the account's current Pay As You Go billing. Alchemy's current public pricing page lists $0.525 per million CUs for Pay As You Go and no included PAYG base CUs. Confirm the rate and any account-specific terms in the dashboard before accepting costs

## Independent fallback RPC

Use a provider other than Alchemy. Helius can be tried on its Free plan for setup; its published free tier includes 1M credits per month and 10 RPC requests per second. The Developer tier is currently listed at $49/month with 10M credits and 50 requests per second. Upgrade only if actual load requires it

1. Create a Helius Solana Mainnet project
2. Copy its HTTPS RPC URL into the protected server file as `SOLANA_RPC_FALLBACK_URL`
3. Set separate usage alerts
4. Confirm both endpoints return the same finalized block and MSTRx mint state using the launch panel's **Verify configuration** action

The two RPC URLs must be HTTPS and have different provider hostnames. Neither belongs in Git, browser JavaScript, chat messages or a public `VITE_*` variable

## Mint-wide holder-history source

RPC endpoints alone do not reliably list every CAPITAL transfer by mint, because some SPL transfer transactions do not mention the mint address. The current indexer uses Bitquery's mint-filtered Solana Transfers API to discover signatures and then verifies every new transaction against both independent RPCs

1. Create a Bitquery account and verify that the plan allows the Solana realtime Transfers query by mint
2. In Bitquery, open **Authorization → Applications → Tokens** for the application and generate a manual API V2 access token. If the application displays `Client Secret: N/A`, this token route does not require the secret. Do not use the temporary token shown by IDE code generation
3. Store the raw token (without the `Bearer` prefix) only as `BITQUERY_API_KEY` in the protected server environment. Record its expiry and rotate it before then; a static token cannot refresh itself. When a working Client ID and Client Secret are available, the runner can instead use both OAuth fields for automatic refresh
4. Before mainnet payouts, prove that the source includes the Pump creation transaction, a regular holder-to-holder transfer and the Pump-to-PumpSwap migration; otherwise the indexer stops
5. Confirm a historical backfill arrangement for an outage longer than six hours. The current realtime adapter deliberately stops rather than paying from a partial history

Bitquery currently lists its Solana token transfers/balances pack at approximately $500/month ($400/month on annual billing). Do not purchase it solely on this document: confirm the exact current product, coverage and cost with Bitquery and compare it with alternative indexing arrangements before approving production spend

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
