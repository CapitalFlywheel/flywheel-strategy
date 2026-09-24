<p align="center">
  <img src="assets/brand/final/x-banner-1500x500.png" alt="FLYWHEEL STRATEGY — fees to MSTR to holders" width="100%">
</p>

<h1 align="center">FLYWHEEL STRATEGY</h1>

<p align="center">
  <strong>HOLD CAPITAL · ACCUMULATE MSTRx</strong><br>
  A Solana fee-funded reward system designed around direct holder payouts and a separate strategic reserve<br>
  <strong>CAPITAL IN MOTION</strong>
</p>

<p align="center">
  <a href="https://flywheelstrategy.xyz">Website</a> ·
  <a href="https://x.com/capital_mstr">X</a> ·
  <a href="apps/web/public/technical-specification.md">Technical specification</a> ·
  <a href="SECURITY.md">Security</a>
</p>

> **Status — pre-launch Solana build**
>
> The CAPITAL mint has not been published for this build, and the automated fee-to-holder route has not yet passed a live end-to-end mainnet rehearsal. Do not interpret source code or a staging preview as proof of active rewards. The previous Robinhood Chain system remains in this repository as legacy history, not as the Solana launch configuration

## How the flywheel is designed to work

| Trade | Collect | Separate | Deliver |
|:--|:--|:--|:--|
| CAPITAL trades against the official Solana MSTRx custom pair on Pump.fun | A configured 2% creator fee accrues in MSTRx across the Pump curve and PumpSwap phases | **Actual collected receipts**, not projected volume, are accounted 60% to holder rewards and 40% to the reserve | Funded MSTRx rewards are sent directly to eligible wallets in bounded batches |

```text
CAPITAL / MSTRx trades
        ↓
project-controlled Pump creator-fee receipts in MSTRx
        ├── 60% → funded holder inventory → automatic MSTRx payouts
        └── 40% → separate MSTRx strategic reserve
```

The 2% setting is the **creator fee**, not a claim about every fee a trader pays. The 60/40 split applies to MSTRx actually collected by the project. SOL for transactions, rent and operations is funded separately. Rewards depend on trading activity and successful operation; they are not guaranteed

Pump's [supported-pair list](https://pump.fun/docs/custom-pairs) identifies the MSTRx mint and explains that paired-asset fees are paid in the quote asset. Pair eligibility, issuer restrictions and platform terms must be checked again before launch

## Holder experience

- Reward weight combines CAPITAL balance and exact hold time, with newest lots consumed first on partial sales
- Eligible wallets are intended to receive MSTRx without connecting to this website, signing a claim or paying payout fees
- A complete epoch must be funded before distribution; batches are recorded for restart-safe, duplicate-resistant delivery
- Finalized holder history and fee receipts are checked against independent RPC providers; uncertain data stops progression instead of estimating payouts

The reward asset is MicroStrategy xStock (`MSTRx`) on Solana, Token-2022 mint `XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ`. Its raw units and transfer-hook behavior are handled explicitly in the [technical specification](apps/web/public/technical-specification.md)

## Reserve and trust boundaries

The reserve is accounted separately from holder payout inventory. A restricted Solana governance program has **not** been deployed or audited, so public reserve voting and execution are disabled. The reserve must not be described as redeemable backing or a guaranteed holder claim

The owner and Pump creator can be one wallet. Automatic creator-fee collection requires a protected server-side copy of that wallet's key; a server compromise could therefore compromise owner authority. The holder inventory is also controlled by an operational signing key, and its current commitment rules are enforced by software and accounting rather than an immutable on-chain vault. Completed payouts cannot be recalled, while the documented recovery path is limited to uncommitted project-controlled receipts. See the [architecture](docs/architecture.md) and [Solana plan](docs/solana-mstrx-plan.md) for the exact boundaries

## Verify the implementation

Requirements: Node.js 20+ and npm

```bash
npm ci
npm run security:secrets
npm run test:solana
npm run test:web
npm run web:build
```

| Location | What it contains |
|:--|:--|
| [`services/solana/`](services/solana/) | Pump launch verification, fee collection, 60/40 accounting, holder indexing and direct payouts |
| [`services/api/`](services/api/) | Public data server and wallet-signed private control requests |
| [`apps/web/`](apps/web/) | Solana website and read-only holder information |
| [`config/solana-mainnet.json`](config/solana-mainnet.json) | Public Solana asset, program and target economics configuration |
| [`assets/brand/final/`](assets/brand/final/) | Approved avatar, banner and visual identity sources |
| [`contracts/`](contracts/) and [`services/keeper/`](services/keeper/) | Legacy Robinhood Chain implementation, excluded from the Solana runtime |

The [production handoff](docs/production-handoff.md) lists the evidence required before real-value operation. Public addresses, transactions and payout records should be checked against deployed state when available

## Repository safety

Private keys, seed phrases, authenticated RPC URLs, API credentials, server access data, hidden administration paths and live state do **not** belong in Git. The publishable-file secret check runs locally with `npm run security:secrets` and in GitHub Actions. Report suspected exposure privately under the [security policy](SECURITY.md)

FLYWHEEL STRATEGY is an independent project and is not affiliated with Strategy Inc, the MSTRx issuer or Pump.fun

<p align="center">
  <img src="assets/brand/final/x-avatar-400.png" alt="Faceted orange FLYWHEEL STRATEGY mark" width="64"><br>
  <strong>CAPITAL IN MOTION</strong><br>
  <a href="https://flywheelstrategy.xyz">flywheelstrategy.xyz</a> · <a href="https://x.com/capital_mstr">@capital_mstr</a>
</p>
