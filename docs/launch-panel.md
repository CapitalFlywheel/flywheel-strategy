# Launch control panel

The private launch surface is available only at the unlisted path configured through `ADMIN_PANEL_PATH`. The public `/admin` address returns 404.

## Main-launch addresses

- Owner and PONS launching wallet: `0xfB8199AA97913c0494A600B725C634527dD47fa4`.
- Public marketing wallet: `0xdA1C7404241844B6A537EC2379376bE7397C6bb7`.
- Automation wallet: `0xe6a78122ea3904614d7d9d0b01c7143c814888ac`.
- Reward publisher wallet: `0xfd8a1e79a9e9c37e5704e61603a6213522d97677`.

These addresses apply to the future main launch. They do not change ownership or routing inside the existing test contracts.

## Availability after launch

- The panel and public website start automatically with the server and remain available after a reboot.
- Normal reward and governance automation does not require the owner to keep the panel open.
- After launch, the panel remains the owner's surface for status checks, pausing or restarting bots, maintenance and governance controls.
- Holders use the public website and never receive the private panel address.

## Security model

- The owner private key is never uploaded to the website or server.
- An administrative action requires an EIP-191 message signature from the configured owner address.
- Every challenge contains the exact action, chain ID, owner, expiry time and a one-time random nonce.
- Challenges expire after five minutes and are deleted before an action is queued.
- The web container cannot access the Docker socket.
- A host-side runner accepts only an explicit allowlist of actions and cannot execute arbitrary commands received from the website.
- Bot private keys remain in separate mode-600 server environment files.

## Implemented controls

- Read the live state of reward collection, reward publication and governance execution.
- Start all three automation services after an owner signature.
- Stop all three automation services after an owner signature.
- Keep the public holder website online while automation is stopped.
- Deploy the pre-launch contract set from the connected owner wallet while saving progress after every confirmed transaction.
- Register a pre-launch manifest only after the server independently checks every contract, role and fixed address on-chain.
- Display the exact PONS creator-wallet address and arm a temporary launch detector.
- Detect the PONS `TokenLaunched` event for the configured owner and reject a launch with the wrong creator wallet, pair, creator tax or buyback setting.
- Deploy the token-specific strategy set after detection and save progress after every transaction.
- Activate the new public configuration, archive the previous test state and start all three bots after a final owner signature.
- Create governance proposals without a command line: choose 2–6 fixed actions, 1–100% of the reserve and a 1–12 hour voting period.
- Generate and publish the holder-weight snapshot after an owner signature, using every eligible holder's balance and hourly holding time.
- Send the final `createProposal` transaction from the connected owner wallet; the private key never reaches the server.
- Display current turnout, option results, quorum, voting end and automatic-execution time.
- Keep governance execution automatic. The panel deliberately has no manual winner override, cancellation or execution-confirmation control.
- Show the live PONS trading phase: bonding curve, migration or V4 pool.
- Buy the project token directly from the PONS curve before graduation and switch to the V4 pool automatically afterward.
- Keep the launch watcher alive after detection so it can submit both permissionless PONS graduation steps. A transient failure is retried every 15 seconds.
- Release matured project-token lock tranches automatically into the permanent hold vault. Forever locks are never released.

## Governance flow in the panel

1. The governance section unlocks automatically only after the main launch has been activated.
2. The team chooses between 2 and 6 actions from the fixed list. No custom action or recipient can be entered.
3. For every reserve action, the team chooses a whole percentage from 1% to 100%. `ACCUMULATE` always uses 0% because it leaves the reserve untouched.
4. `BUYBACK_LOCK` and `LOCK_MSTR` require one fixed lock period: 1, 3 or 6 months; 1, 2, 3 or 5 years; or forever.
5. The team chooses a voting time from 1 to 12 hours and signs snapshot preparation with the owner wallet. This step spends no ETH.
6. The server calculates every eligible holder's voting weight, publishes the Merkle proofs and prepares an exact transaction. The calculation is valid for 30 minutes.
7. The owner reviews the summary, types `VOTE` and confirms the transaction in the wallet. This transaction pays normal network gas.
8. Holders vote from the public website. A proposal needs at least 7% of total available weight; an exact tie is rejected.
9. Five minutes after voting ends, `governance-keeper` automatically submits the fixed winning action. The team cannot cancel the vote, change the winner or block execution.

For `BUYBACK_HOLD`, `BUYBACK_BURN` and `BUYBACK_LOCK`, the complete MSTR amount fixed when the proposal was created is released from the strategic reserve and converted into the project token. Before PONS graduation the purchase uses the bonding curve. If this purchase finishes the curve, the adapter accepts PONS's partial-fill ETH refund, completes pool creation and spends the refund in the new V4 pool inside the same atomic transaction. During an already-swept migration, failed pool creation leaves the vote unexecuted and the keeper retries; no partial reserve action is recorded.

When a finite `BUYBACK_LOCK` period expires, the automation wallet calls the permissionless release function. The tokens then move to the permanent public hold vault; they do not return to the team and cannot be withdrawn. The keeper scans locks once per minute and safely ignores a release already completed by another caller.

The marketing option can send proceeds only to the public marketing wallet embedded in the main-launch contracts. The panel cannot substitute another recipient.

## Main launch flow

1. Open the private panel address configured on the server and connect the owner wallet.
2. Type `DEPLOY` and press the preparation button. Confirm the requested transactions in the wallet. The page can be safely reloaded because every confirmed address is stored in the browser.
3. The server checks the complete pre-launch set. Copy the displayed Creator wallet into PONS V2.
4. Press the launch-detection button immediately before launching on PONS. Detection runs for at most six hours and may be cancelled from the panel.
5. Launch manually on PONS with native ETH pair, 2% creator fee, PONS buyback disabled and the exact displayed Creator wallet. Branding and social fields remain under the owner's control on PONS.
6. The detector finds the factory event and independently reads the PONS launch record. A wrong launch is ignored.
7. Press the strategy button and confirm the token-specific deployment transactions.
8. Type `ACTIVATE`, press activation and sign the final owner message. The server checks the complete system again, archives test state, switches the public configuration and starts the reward and governance bots. The migration watcher continues independently until the PONS V4 pool is confirmed ready.

The panel never sends transactions without a wallet confirmation. The owner key is not stored on the server. Automation and reward-publisher keys remain the only bot keys installed on the server.

## Launch settings accepted by the detector

- PONS factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.
- Launching wallet: the configured owner address.
- Pair token: native ETH (`0x0000000000000000000000000000000000000000`).
- Creator fee: exactly 2% (`200` basis points).
- Creator wallet: the newly deployed `PonsFeeCollector` shown by the panel.
- PONS buyback: disabled.

The name, ticker, image and social links are deliberately not fixed by the detector because they are chosen at the branding stage.

## State protection

- The current test token remains the public configuration until the final `ACTIVATE` signature.
- Activation moves the previous reward state, transfer cache, public snapshots, governance files, heartbeats and public config into a timestamped backup directory.
- New reward accounting starts empty for the new token; test rewards can never be mixed with main-launch rewards.
- The main-launch manifest is stored separately under `data/control/main-launch`.
- The launch detector is normally stopped and therefore does not consume paid RPC capacity before launch. Once deliberately armed, it keeps watching the detected token through graduation and exits only after the V4 pool is confirmed.
