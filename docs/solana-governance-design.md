# Historical design only — not the active Solana launch route

The current owner-wallet launch does not deploy a governance program. Its strategic MSTRx reserve is sent to a separate user-controlled wallet. The proposal below is retained as historical research and must not be treated as a release requirement or a description of live custody

# Solana reserve governance design and release gate

Status: implementation in progress, not a live voting or reserve-execution service

This document is an internal engineering specification. The public site must not show an active vote until the deployed state, vote receipts and execution route have been independently checked

## Selected custody boundary

The existing 40% reserve destination is an ordinary project wallet. The owner selected binding on-chain governance for the replacement system:

- Route the reserve into a program-controlled vault, not an ordinary owner wallet
- At proposal creation, commit the exact then-available balance; later deposits remain free
- Keep a passed proposal's committed amount unavailable to the admin until the winning decision is executed
- Permit the admin to withdraw only the free, uncommitted balance through a fixed allowlisted route

A connected wallet and a valid vote receipt do not make this binding without the deployed custody and executor. Until those are implemented, verified and disclosed, the UI must not offer a live vote or claim reserve execution

## Product rules carried forward

- Only the configured project admin can create a proposal
- One proposal can be active at a time, with two to six distinct allowlisted options and an `ACCUMULATE` no-action option
- A vote lasts from one to twelve hours; execution begins no earlier than five minutes after it closes
- Initial proposal creation publishes the root, snapshot metadata, options and exact commitment onchain, then voting opens no earlier than 24 hours later. A replacement ballot opens at its onchain creation time. The complete source bundle is an operator-published audit artifact and is not proved by the program itself
- Quorum is 7% of all snapshot voting weight; ties and missed quorum in an initial ballot make no token transfer and release the commitment. A failed re-vote leaves an earlier passed commitment frozen
- Each eligible wallet can vote once per proposal using its own Solana signature and a proof of its snapshot weight
- Voting weight uses CAPITAL balance-time and the published capped loyalty factor over the last 24 hours, or the shorter project age
- The operator publishes the complete holder-source bundle, exclusions, voting snapshot, proofs and SHA-256 manifest before creating the onchain proposal. The voter-weight window ends at this frozen snapshot, not the later voting start; subsequent buys and transfers cannot change that ballot
- A spending option receives the **entire exact raw MSTRx reserve balance committed when the proposal is created**; later deposits are not part of that proposal
- Each proposed buyback fixes a positive minimum raw CAPITAL output before voting; the fixed marketing sale fixes a positive minimum SOL output in lamports. These thresholds are stored in the immutable voted option alongside the exact MSTRx input. `ACCUMULATE` and `LOCK_MSTRX` require zero output floor because they do not swap. An executor may require a stricter fresh minimum, but may never lower the holder-approved floor. The owner selected this fixed minimum as the sole onchain price barrier; it is not an oracle or a guarantee against price manipulation within the disclosed range
- Funded holder rewards are not accessible to governance, the reserve executor or an emergency reserve operation
- As soon as a finalized spending winner reaches its own `executable_at` and remains unexecuted, the admin can open a new holder ballot over exactly that still-committed amount using a fresh snapshot. Holder voting on the replacement ballot begins at its onchain creation time, lasts the selected one to twelve hours, and its result can be finalized only five minutes after closing. The previous decision becomes superseded, but no MSTRx is released or spent by this step. Deposits received after the first proposal stay free and outside the re-vote. A failed Solana transaction is not a durable onchain condition for this rule
- If that re-vote misses quorum or ties, its commitment stays frozen and another re-vote can be opened as soon as that ballot's own `executable_at` has passed and its failed result is finalized. Only an explicit winning `ACCUMULATE` releases it into free reserve; another spending winner retains it for the newly selected action. There is no admin-only escape hatch for a committed amount

The pure policy implementation is `services/solana/governancePolicy.ts`. The deterministic snapshot/proof implementation is `services/solana/governanceSnapshot.ts`. Neither module alone authorizes a vote or controls custody

The snapshot is **operator-published and publicly auditable, not trustless**. The owner signs the exact next proposal ID, reviewed program identity and bound mint, but no onchain transaction or signing key is needed for publication. The publisher recomputes cached token movements against two finalized RPCs, checks the full-block journal and writes a proposal directory with `source.json`, `snapshot.json`, per-wallet proofs and a v2 `manifest.json`. The manifest declares the active version's publication time, exact source/snapshot SHA-256 checksums, root and total. If 25 minutes pass without creating the ballot, the owner may refresh that ID only while both RPCs show no proposal account and no owner-control create transaction is prepared, pending or unresolved. The former complete bundle is retained in the public archive, and the current path may briefly return 404 during the fail-closed directory swap. Once the ballot is created, the fixed proposal path is frozen. On the voting page, the browser rejects a root/total mismatch, a changed source or snapshot checksum, a source file above its 64 MiB read limit, or a review interval shorter than 24 hours for an active initial ballot. For an immediate replacement ballot, the files must be available by its voting start, without a mandatory review interval. Anyone may re-run the published source through the open snapshot algorithm and challenge omissions; the program only verifies submitted Merkle proofs against the operator-provided root and cannot prove offchain history completeness. The declared manifest timestamp itself is operator-controlled; the initial proposal's onchain creation and delayed start enforce its minimum review window. A credible initial-ballot release also needs independent monitoring that the bundle was continuously available during that window

Before the vote opens, the holder can compare `sourceSha256` and `snapshotSha256` with downloaded files, then recompute the Merkle root, total and individual proof from the recorded window, finalized block identity and exclusions. Do not claim independent attestations or a trustless snapshot until those are actually added

For a downloaded proposal directory containing `manifest.json`, `source.json` and `snapshot.json`, run `npx tsx scripts/verify-governance-publication.ts <proposal-directory>` from the repository root. This checks exact file SHA-256, the V3 journal digest, metadata consistency and a fresh deterministic root/weight calculation. It does **not** independently rescan every finalized Solana block or prove when the mutable web host first served the files; those remain the operator/source-availability trust boundary. Compare the printed root and weight against the onchain proposal separately

## Required custody and execution boundary

Binding execution requires the 40% fee destination to be a Token-2022 MSTRx account controlled by a governance-program PDA, not an ordinary reserve wallet or an SPL delegate approval. The program must freeze an exact amount for the active proposal, reject any attempt to spend it through a different instruction, and permit only its voted action after the delay. New fee receipts remain separately accounted

An upgradeable program with the admin as unrestricted upgrade authority is not an absolute freeze: the admin could replace the code. The owner selected permanent removal of the governance program's upgrade authority after independent review, accepting reduced emergency repair capacity. The prototype `CreateProposal` account constraints require the associated loader-v3 ProgramData to have no upgrade authority before a vote can begin. This has host-level compilation but not validator-level or deployment evidence

The undeployed account schema is v3 and stores each option's minimum output alongside its frozen spend. Re-votes use the same layout and may choose new floors for the new holder decision without altering the old ballot. They use additional status values 5 (`SUPERSEDED`), 6 (`ACTIVE_REVOTE`), 7 (`REVOTE_NO_QUORUM`) and 8 (`REVOTE_TIE`), with an onchain creation event linking the previous/new proposal IDs. There is no immutable account field recording that lineage; the UI must not invent a source ID without the event/transaction. Before release, validator tests must prove old executors reject superseded proposals, new executors accept only the active ID, and repeated failed ballots never unlock the commitment. Each spending executor must either complete the entire decision in one transaction or leave the full commitment unchanged

MSTRx's Token-2022 issuer extensions include a permanent delegate and pausable/transfer-hook controls. Program custody can restrict the project's own keys, but cannot override powers held by the MSTRx issuer. Public text must not describe an MSTRx lock as absolutely immutable against issuer-level powers

The six action families to port are `ACCUMULATE`, `BUYBACK_HOLD`, `BUYBACK_BURN`, `BUYBACK_LOCK`, `LOCK_MSTRX` and fixed-recipient `MARKETING_SALE`. A winning `ACCUMULATE` spends nothing and releases its frozen MSTRx to the free reserve when `finalize` runs after the result delay. `BUYBACK_HOLD` must use disclosed permanent public custody. Burn and lock must use the actual CAPITAL token program and verified destination accounts. The owner chose to sell the complete frozen MSTRx marketing allocation into SOL and forward actual proceeds to one fixed, publicly disclosed recipient; this route remains unimplemented until a specific venue and price guard are reviewed. No proposal may supply an arbitrary wallet. The old Robinhood percentage selector and ETH conversion are not part of this Solana design

Buyback execution must select the verified Pump bonding-curve or PumpSwap custom-pair route from live finalized mint state, consume the voted amount in one atomic transaction, enforce a fresh quote/minimum CAPITAL output, and fail without partial accounting if the route is unavailable or the Token-2022 transfer hook rejects the transfer. A keeper can retry the exact decision but cannot substitute another action, recipient or amount

## Public wallet and data flow

The public header may offer Solana wallet connection because voting requires it. Reward delivery remains automatic and requires no connection. The voting page must show the exact proposal ID, start/end time, snapshot slot and blockhash, frozen reserve amount, quorum, option totals, the connected wallet's weight/proof, a one-vote status and finalized transaction links. Public proposal URLs must remain stable

Before an actual vote button appears, the browser must build a transaction only for the verified governance program/account addresses from public configuration. The site must reject a missing program, stale snapshot, mismatched CAPITAL mint, wrong cluster, invalid proof or concluded proposal. The backend cannot turn an arbitrary browser payload into a reserve instruction

## No-launch gate

Do not create a Pump test token or arm the exact-creator detector until all of the following are demonstrated

1. Governance program compiles, passes local-validator tests, is independently reviewed and deployed with a verified program ID and permanently revoked upgrade authority before the first binding proposal
2. The 40% fee route reaches the program-controlled MSTRx vault and cannot be spent by the ordinary reserve wallet
3. The finalized mint-wide CAPITAL history produces a reproducible voter-weight root, with holder exclusions and two-RPC agreement. Complete source/snapshot/checksums remain publicly reviewable for at least 24 hours before an initial ballot opens; for a replacement ballot they must be available no later than voting start
4. Desktop and mobile wallets can connect, sign one vote transaction and receive a finalized receipt; duplicate, ineligible, late and replayed votes fail
5. The chosen action executes from the program vault using exact frozen funds on both Pump curve and PumpSwap phases; no-quorum and tie leave funds untouched
6. Buyback, burn, permanent hold, term lock, MSTRx lock and marketing paths have bounded allowlisted accounts, tested failure behavior and public evidence
7. Public site and documentation agree with the deployed custody and admin powers; no inactive action is advertised as live

No mainnet program or token deployment is implied by local tests in this repository
