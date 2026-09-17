# Production handoff

This runbook is the non-secret source of truth for transferring FLYWHEEL STRATEGY to the launch team. Passwords, private keys, authenticated RPC URLs, the unlisted panel path and personal SSH private keys must be transferred separately through an encrypted password manager.

## Fixed production identity

- Network: Robinhood Chain mainnet, chain ID `4663`
- Token name: `FLYWHEEL STRATEGY`
- Ticker: `CAPITAL`
- PONS pair: native ETH
- PONS creator tax: exactly `200` basis points
- PONS buyback: disabled
- Owner and PONS deployer: `0xfB8199AA97913c0494A600B725C634527dD47fa4`
- Marketing: `0xdA1C7404241844B6A537EC2379376bE7397C6bb7`
- Automation: `0xe6a78122ea3904614d7d9d0b01c7143c814888ac`
- Reward publisher: `0xfd8a1e79a9e9c37e5704e61603a6213522d97677`

Do not replace these values during launch without a separate review of every constructor, role, environment file and public document.

## Current readiness evidence

As of 2026-09-17:

- Solidity, service and wallet tests pass
- The mainnet fork covers the primary MSTR route, V3 fallback and governed reserve actions without broadcasting real transactions
- Live configuration verification passes against Robinhood Chain mainnet
- The PONS factory reports that the configured owner can launch
- The hidden panel and public web service are online, while public `/admin` returns 404
- The control runner, firewall and fail2ban are active
- The production deployer private key is not installed on the server
- Bot keys are isolated in mode-600 files and match the configured automation/publisher addresses
- No main-launch manifests, token address, cached epoch or test deployment are active in production data
- Automation is deliberately stopped before activation
- Daily backups have been manually repaired and verified

This evidence does not replace an external smart-contract audit. No external audit report is currently recorded in the repository.

## Access handoff

1. Every operator generates an individual Ed25519 SSH key. Never share one private key between the team.
2. Add only each operator's public key to the production user's `authorized_keys` file.
3. Confirm every operator can sign in before removing the previous maintainer's key.
4. Keep root login and password authentication disabled.
5. Give the unlisted panel path only to operators who need launch/admin access.
6. Transfer bot secret files and authenticated RPC URLs through an encrypted secret manager, never GitHub or chat.
7. Record who controls the owner wallet and require a hardware-wallet or equivalent out-of-band confirmation for every deployment transaction.

Transfer and verify access to each of these systems:

- GitHub organization and repository administration
- VPS provider account and the production host
- Individual `mstradmin` SSH public-key access for every operator
- Domain registrar and DNS management
- Alchemy billing, project, spending limit and IP allowlist
- Reown project and the approved production domain
- Project X account and recovery methods
- Owner/deployer wallet signing process
- Marketing wallet custody
- Encrypted recovery copies of the automation and reward-publisher keys
- The unlisted launch-panel URL
- Backup location and restoration procedure

Use least privilege where the service supports it. One person should not need the domain registrar, VPS root-equivalent access, owner wallet and social recovery methods for routine operation.

## Launch workstation

- Use one dedicated, updated browser profile with the owner wallet installed
- Disable unrelated wallet extensions to avoid provider confusion
- Open the panel only from a trusted machine and network
- Export the launch-progress JSON after pre-launch and again after post-launch contracts
- Keep the wallet open on Robinhood Chain and verify every address/value before signing
- Never import the owner seed or private key into the server

## Launch-day sequence

1. Record the exact Git commit deployed to the server
2. Run the full test suite, web build, secret scan, live verifier and mainnet fork suite from the production IP
3. Confirm web health, control-runner health, fresh backup success, available disk/RAM and stopped automation
4. Fund the owner only for the planned PONS launch and deployment gas, with a safety margin
5. Connect the exact owner wallet to the hidden panel
6. Type `DEPLOY`, approve the nine pre-launch steps and download the progress JSON
7. Wait for the server to accept and independently verify the pre-launch manifest
8. Copy the Creator wallet displayed by the panel; compare it character-for-character on PONS
9. Arm detection immediately before launch
10. Launch on PONS using native ETH, creator fee 2%, buyback disabled and the displayed Creator wallet
11. Wait until the panel shows the detected token and transaction hash; independently compare them with the explorer
12. Approve the ten post-launch steps and download a new progress JSON
13. Type `ACTIVATE` and sign the final action
14. Confirm the public config contains the final token/contracts and all three automation services are healthy
15. Confirm migration tracking remains healthy until PONS V4 readiness
16. Observe the first creator-fee collection, MSTR conversion, published reward epoch and a small holder claim before the public announcement
17. Publish verified contract source, final addresses and transaction links

## Stop conditions

Stop signing and investigate if any of the following occurs:

- the panel displays an owner, Creator wallet, token or curve different from the independently verified value
- PONS shows a non-ETH pair, creator fee other than 2% or enabled buyback
- the launch detector reports repeated RPC errors without recovery
- the browser asks to submit a new transaction while the panel says a previous transaction is still pending
- any manifest verification fails
- the launch watcher, control runner or web health check is not healthy
- a bot starts before post-launch activation
- public configuration contains any rehearsal/test address

## Recovery

- Reloading the panel resumes the stored pending transaction hash; do not approve a duplicate transaction
- Import the latest progress JSON when moving to the designated backup workstation
- A watcher restart resumes from its persisted scan cursor
- After detection, a watcher restart resumes the recorded token's PONS migration lifecycle
- Stopping automation does not take the public website offline
- Do not manually edit published reward or governance snapshots

## Evidence to retain

Archive the launch commit, test outputs, live verifier output, progress JSON files, manifests, deployment receipts, launch/migration transaction hashes, final public config and first successful reward-cycle evidence. None of these artifacts should contain private keys or authenticated RPC URLs.
