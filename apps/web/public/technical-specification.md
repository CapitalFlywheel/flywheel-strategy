# ProjectToken technical specification

## Core idea

The project token launches through PONS V2 on Robinhood Chain against native ETH. Holders keep the token in their own wallet and receive passive rewards in the official Robinhood MSTR Stock Token. No staking, token approval or custody transfer is required. The holder pays the gas only when claiming MSTR.

Rewards are funded by real creator fees from project-token trading. They are not a fixed yield and depend on volume.

## Trading fees

The user-facing buy/sell fee is 3%:

- 1% PONS base trading fee;
- 2% creator tax configured at launch.

With the live PONS fee policy verified on 9 September 2026, 30% of the 1% base fee goes to PONS and 70% goes to the creator recipient when PONS buyback is disabled. The project therefore receives 2.70% of trading volume and routes it as follows:

- 1.35% of volume: passive holder rewards (50% of project receipts);
- 1.08% of volume: strategic MSTR reserve (40%);
- 0.27% of volume: automation budget (10%);
- 0.30% of volume: PONS protocol.

These live PONS parameters must be rechecked immediately before the signed launch.

## Fee and MSTR flow

1. PONS credits native ETH creator fees to `PonsFeeCollector` in the shared PONS FeeEscrow.
2. Anyone can trigger collection into `FeeRouter`.
3. `FeeRouter` separates the ETH into reward, reserve and keeper accounting.
4. The automation service reads fresh on-chain quotes for the approved V4 and V3 routes.
5. The route returning more MSTR is used, with a minimum output 20% below the fresh quote.
6. Reward MSTR goes directly to `RewardVault`; reserve MSTR goes directly to `StrategicReserveVault`.
7. Automation ETH goes to the public `KeeperVault` and only reimburses approved bot transactions under a cap.

Primary route: native ETH → WETH → USDG → MSTR on Uniswap V4.

Fallback route: native ETH → WETH → MSTR on Uniswap V3.

One conversion is capped at 10 ETH. Larger balances are processed in multiple cycles. There is no rule that stops buying because MSTR rose or fell sharply; protection is based on execution quality and approved routes, not on market direction.

## Official assets and infrastructure

- Robinhood Chain ID: `4663`.
- PONS V2 Factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.
- PONS FeeEscrow: `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`.
- PONS MemeHook: `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`.
- Official MSTR: `0xec262a75e413fAfD0dF80480274532C79D42da09`.
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Uniswap Universal Router: `0x8876789976decbfcbbbe364623c63652db8c0904`.
- Uniswap V4 PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`.
- Uniswap V4 Quoter: `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`.
- Uniswap V3 Quoter: `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`.

Project-specific addresses will be added after signed deployment. All balances and transactions will remain visible on the public explorer.

## Wallet support

The website detects browser wallets through EIP-6963. This prevents MetaMask, Rabby, Zerion and other installed extensions from overwriting each other: every detected wallet appears as a separate option and the user chooses which one signs transactions. Older EIP-1193 wallets remain available through a fallback connector.

The selected wallet provider is used for reward claims and governance votes. The website never requests or stores a seed phrase or private key. It requests only the connected public address, Robinhood Chain selection and transactions that the user confirms in the wallet.

Mobile wallets connect through WalletConnect. Public launch configuration requires a Reown Project ID in `VITE_REOWN_PROJECT_ID` and final site metadata whose URL matches the deployed domain. The Project ID is public application configuration; it is not a secret wallet key.

The site requests Robinhood Chain mainnet with chain ID `4663`, ETH as gas currency, the official public RPC and Blockscout explorer. Wallet-side network support remains a separate requirement. MetaMask and Zerion support custom EVM networks, and Rabby targets EVM chains. Phantom is discoverable as a wallet, but its currently documented EVM network list does not include Robinhood Chain; if Phantom rejects chain `4663`, the site explains that the user must choose Zerion, Rabby or MetaMask.

## Passive reward weight

Every incoming transfer creates a separate token lot. Its holding age starts at the transfer timestamp. A partial sale consumes the newest lots first, preserving the age of the holder's older core balance.

The loyalty coefficient is:

`1 + 0.5 × sqrt(min(completed holding hours, 720) / 720)`

It starts at 1.00x, changes every completed hour, reaches 1.50x after 30 days and never grows beyond that. Raw holding time inside each reward window is measured to the second.

The indexer integrates:

`lot amount × seconds held in the epoch × loyalty coefficient`

Each holder receives the epoch MSTR amount in proportion to their weight. Integer rounding dust is distributed deterministically by largest remainder, so every raw MSTR unit is allocated exactly once.

Excluded balances include the zero/dead address, the PONS curve, PoolManager, PONS hook, reward and reserve vaults, fee/automation contracts and project execution contracts.

## Reward publication and claims

The indexer rebuilds balances from ERC-20 `Transfer` events, publishes a JSON calculation and stores a cumulative Merkle root in `RewardVault`. It stores already processed transfers locally and refreshes only the newest confirmed overlap through Alchemy's Transfers API. This avoids repeatedly scanning millions of fast Robinhood Chain blocks. Cumulative roots keep old unclaimed balances claimable even when the holder has no new weight.

The user submits `claim(cumulativeAmount, proof)`. The contract subtracts the amount already claimed and transfers only the difference. This lets several reward epochs be claimed in one transaction.

All contract accounting uses raw MSTR token units. `uiMultiplier()` is applied once, only for human-readable display, so later Robinhood corporate-action scaling cannot be accidentally applied twice.

The root publisher is a disclosed operational trust point: a wrong root can misallocate the reward vault, but cannot access the separate strategic reserve. Public snapshot files and deterministic source let anyone recompute the allocation.

## Reward cadence by market capitalization

- below $500,000: every 10 minutes;
- $500,000 to below $1,000,000: every 20 minutes;
- $1,000,000 to below $5,000,000: every 30 minutes;
- $5,000,000 or more: every 60 minutes.

Before graduation, token/ETH price comes from the PONS curve reserves. After graduation, it comes from the PONS Uniswap V4 pool. ETH/USD comes from the WETH/USDG V4 pool.

A higher tier activates only after market cap is continuously observed above its threshold for one full hour. The service checks every 30 seconds. An observation gap over two minutes resets only the unconfirmed hour. Confirmed tiers never move backward after a later price drop.

Changing the interval changes the size and frequency of records, not the total MSTR accumulated from fees.

## Governance

Only the team role can create a proposal. Holders cannot submit on-chain proposals. A vote contains 2–6 unique options selected from the fixed list below, and may contain all six:

1. Accumulate MSTR.
2. Buy back project tokens and hold them permanently.
3. Buy back project tokens and burn them.
4. Buy back project tokens and lock them for a selected term.
5. Lock MSTR inside the strategic reserve.
6. Sell MSTR for ETH and send the ETH to the disclosed marketing wallet.

Each spending option fixes 0–100% of the currently available reserve when the vote starts. A non-accumulate option must use more than 0%. Lock choices are 1, 3, 6, 12, 24, 36 or 60 months, or forever.

Voting lasts 1–12 hours as selected by the team. Quorum is 7% of all available snapshot weight. The highest-weight option wins; a tie or missed quorum changes nothing. Five minutes after voting ends, automation submits execution. The team cannot cancel the vote or replace the winning option after it starts.

Voting weight uses at most the previous 24 hours of token-seconds and the same holding-age loyalty model. For a project younger than 24 hours, the window begins at launch. This gives every holder non-zero influence after holding for a measurable time while reducing last-second vote buying.

## Reserve execution

`RestrictedExecutor` can call only the six listed actions. Arbitrary calls are impossible through governance. The marketing wallet is stored as an immutable constructor value. A proposal that substitutes any other recipient is rejected before voting starts, so neither the team nor voters can redirect a winning marketing action.

Reserve buybacks use MSTR → WETH on the verified V3 pool and unwrap to native ETH. While PONS is in its curve phase, the adapter reads the live curve reserves and fees, applies the voted 20% maximum slippage and buys directly through the curve. After graduation it resolves the launch's fixed fee and tick spacing and buys through the PONS V4 pool.

The adapter resolves the PONS phase inside every execution. If a buy finishes the curve, PONS may partially fill it and refund unused ETH. The adapter accepts only refunds from the launch's verified curve, permissionlessly completes the swept-to-pool step, and spends the refund in the new V4 pool in the same transaction. If pool creation temporarily fails, the complete governance transaction reverts, so no MSTR can be left as a partially executed decision. The governance keeper retries the unchanged winning result every 15 seconds.

Burn output goes to the dead address. Hold output goes to `ProjectTokenHoldVault`, which has no withdrawal or admin function. Lock output goes to `ProjectTokenTimeLockVault`; after the exact term, release is permissionless and the keeper checks once per minute and moves it into permanent hold custody automatically. A forever tranche has no releasable timestamp.

`RewardVault` and `StrategicReserveVault` are isolated. Governance cannot spend holder reward MSTR.

## Administrative and operational powers

- The team role can start votes but cannot choose their result after launch.
- The reward publisher can publish funded cumulative reward roots.
- The automation role can execute approved MSTR conversions and claim capped gas reimbursement.
- PONS protocol governance retains the PONS-level powers documented by PONS, including its delayed creator-recipient recovery mechanism.
- The marketing wallet is a normal public founder-controlled wallet, not a Safe.

Private keys are never stored in the website or repository. Separate keys should be used for deployment/admin, reward publication and automation.

## Known risks

- Rewards depend on trading volume and are not guaranteed income.
- MSTR is a Robinhood Stock Token, not a share held in the user's brokerage account.
- Asset transfer restrictions, corporate actions, liquidity loss, router/pool failure and Robinhood/PONS administrative changes remain external risks.
- A public 20% slippage ceiling permits poor execution in extremely thin liquidity; fresh quotes and small chunks reduce but do not remove this risk.
- Off-chain reward and governance calculations require public monitoring and independent recomputation.
- Smart-contract audits reduce risk but cannot guarantee absence of bugs.
