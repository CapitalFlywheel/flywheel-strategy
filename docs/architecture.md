# Technical architecture — pre-launch

This document describes the first implementation, not a production launch approval.

## Money flow

1. PONS records the project's creator fee in its shared `FeeEscrow` for `PonsFeeCollector`.
2. Anyone can call `collect()`; the collector claims the ETH and forwards it to `FeeRouter`.
3. Anyone can call `allocate()`; the router splits the received ETH 50/40/10.
4. The automation bot buys MSTR for the 50% reward part and sends it directly to `RewardVault`.
5. The bot buys MSTR for the 40% strategic part and sends it directly to `StrategicReserveVault`.
6. The final 10% goes to `KeeperVault`, which reimburses approved automation jobs under a per-transaction cap.

The PONS protocol fee never enters these contracts. With the current economic model, 2.7% of trade volume reaches the project and is split into 1.35% rewards, 1.08% reserve and 0.27% automation. The remaining 0.30% is the PONS fee. These assumptions must be confirmed against the final PONS V2 launch transaction.

## Passive rewards

`services/indexer/holdingMath.ts` reconstructs token lots from transfers. Every second held adds weight, while the loyalty multiplier changes every full hour and reaches its cap after 720 hours. A partial sale consumes the newest lots first. A wallet-to-wallet transfer starts a new holding age for the recipient.

The indexer publishes cumulative allocations as a Merkle root. `RewardVault` verifies the proof and sends official MSTR to the holder. There is no staking and no token approval. The holder pays only the gas for `claim()`.

`distribution.ts` divides raw on-chain MSTR units by weight, assigns integer dust deterministically and produces the cumulative Merkle tree used by the contract. Tokenized-stock display multipliers must be applied only in the UI, never to these raw contract amounts.

Reward epochs use the irreversible market-cap schedule in `rewardCadence.ts`: 10, 20, 30 or 60 minutes. `marketCap.ts` reads the PONS curve before graduation and the PONS V4 pool afterward, combines the token/ETH price with the WETH/USDG V4 price, and requires a full continuously observed hour over the next threshold. Monitoring gaps longer than two minutes restart an unconfirmed hour.

## Wallet connection

The web application discovers browser extensions through EIP-6963, so MetaMask, Rabby, Zerion and other installed EVM wallets appear as separate choices even when several extensions are enabled. A legacy EIP-1193 fallback remains for older wallets. The selected provider is used for every claim and governance transaction; the application never requests or stores private keys.

Mobile wallets connect through WalletConnect. Before public launch, create a Reown Cloud project for the final website domain and set its public project identifier as `VITE_REOWN_PROJECT_ID`. The identifier is public frontend configuration, not a wallet secret. The final domain must match the metadata configured in Reown.

Robinhood Chain is added or selected automatically with chain ID `4663`, ETH gas, the official public RPC and Blockscout explorer. Compatibility still depends on the wallet application itself. Phantom is discoverable through EIP-6963, but its currently documented EVM network list does not include Robinhood Chain; the UI therefore gives a clear error and recommends Zerion, Rabby or MetaMask if Phantom rejects the network.

## Governance

Only the team can create a proposal. A proposal contains between two and six allowlisted actions, lasts 1–12 hours and becomes executable five minutes after voting ends.

Voting weights are calculated by the indexer from balance and holding time, with a maximum 24-hour governance lookback. The Merkle root and every holder weight must be published for public verification. Quorum is 7% of all available voting weight.

When a proposal starts, every percentage is converted into an exact MSTR amount and stored. That exact amount does not grow when more MSTR later enters the reserve. Only one proposal can be active, preventing two votes from reserving the same MSTR.

`RestrictedExecutor` supports exactly six actions:

- accumulate;
- buy back and hold;
- buy back and burn;
- buy back and lock;
- lock MSTR;
- sell MSTR for the public marketing wallet.

The winning action is executed automatically by keeper bots. The team has no cancel function and does not confirm the result again. Smart contracts cannot wake themselves, so the bot supplies the transaction that triggers the already-fixed contract result five minutes after voting ends.

`services/keeper/governanceKeeper.ts` checks every 15 seconds and submits all due proposals. Production should run at least two independent copies so one server failure does not delay execution. Completed automation transactions are reimbursed from `KeeperVault` under a per-transaction cap and cannot be reimbursed twice.

## Contracts

- `FeeRouter.sol` — receives and splits creator-fee ETH.
- `RewardVault.sol` — isolated MSTR rewards and cumulative claims.
- `StrategicReserveVault.sol` — isolated MSTR reserve and lock tranches.
- `KeeperVault.sol` — visible automation budget with reimbursement cap.
- `GovernanceController.sol` — proposals, weighted votes, quorum and delay.
- `RestrictedExecutor.sol` — fixed governance action allowlist and 20% maximum slippage instruction.
- `IMstrSwapAdapter.sol` — boundary for reward/reserve MSTR purchases.
- `IReserveActionAdapter.sol` — boundary for buybacks and marketing sales.
- `RobinhoodReserveActionAdapter.sol` — fixed MSTR/WETH and PONS V4 reserve routes.
- `ProjectTokenTimeLockVault.sol` — enforces voted buyback locks before permanent hold custody.
- `ProjectTokenHoldVault.sol` — permanent public custody with no withdrawal or admin path.

## Trust and launch blockers

Production swap adapters enforce the verified token/router addresses, fixed pool fee tiers, two-minute deadlines, maximum 20% slippage and a 10 ETH maximum chunk for fee conversion. The reserve buyback adapter only activates after the PONS V4 graduation pool exists; the brief graduation transition cannot be traded through governance.

The root publisher can affect holder allocations. Production needs two independent indexer instances, deterministic snapshot files, a public recomputation tool and a delayed root publication flow. Admin roles must move from the deployer to a clearly disclosed control setup after deployment.

Still required before real money:

1. Run the live configuration verifier again at the launch block.
2. Fill the final team, publisher, automation, admin and public marketing addresses.
3. Complete an external smart-contract audit and resolve its findings.
4. Rehearse the signed deployment and keeper setup with owner-controlled test keys.
5. Select branding, publish verified source and disclose every final address.
