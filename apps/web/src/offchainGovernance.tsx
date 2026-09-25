import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";

type VoteOption = "ACCUMULATE" | "BUYBACK_HOLD" | "BUYBACK_BURN" | "BUYBACK_LOCK" | "LOCK_MSTRX" | "MARKETING_SALE";
interface Ballot {
  version: 1; network: "solana-mainnet-beta"; advisory: true; id: string; capitalMint: string;
  reserveWallet: string; reserveRawMstrx: string; startsAt: number; endsAt: number;
  snapshotSha256: string; merkleRoot: string; totalAvailableWeight: string; options: VoteOption[];
}
interface VoteReceipt { wallet: string; option: VoteOption; weight: string; acceptedAt: number }
interface BallotResponse { ballot: Ballot | null; totals?: Record<VoteOption, string>; count?: number;
  eligibility?: { weight: string; receipt?: VoteReceipt } | null; error?: string }

const optionCopy: Record<VoteOption, [string, string]> = {
  ACCUMULATE: ["KEEP ACCUMULATING", "Leave the reserve in MSTRx"],
  BUYBACK_HOLD: ["BUY BACK + HOLD", "Buy CAPITAL with the voted MSTRx and hold the acquired tokens"],
  BUYBACK_BURN: ["BUY BACK + BURN", "Buy CAPITAL with the voted MSTRx and burn the acquired tokens"],
  BUYBACK_LOCK: ["BUY BACK + LOCK", "Buy CAPITAL with the voted MSTRx and lock the acquired tokens"],
  LOCK_MSTRX: ["LOCK MSTRx", "Lock the voted MSTRx"],
  MARKETING_SALE: ["MARKETING", "Sell the voted MSTRx for SOL and send it to the disclosed marketing wallet"],
};

function formatMstrx(raw: string) {
  const value = BigInt(raw);
  const whole = (value / 100_000_000n).toLocaleString("en-US");
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function offchainVoteMessageClient(ballot: Ballot, wallet: string, option: VoteOption) {
  return [
    "FLYWHEEL STRATEGY OFFCHAIN VOTE V1",
    "Site: https://flywheelstrategy.xyz",
    "Network: Solana Mainnet Beta",
    `CAPITAL mint: ${ballot.capitalMint}`,
    `Proposal: ${ballot.id}`,
    `Snapshot SHA-256: ${ballot.snapshotSha256}`,
    `Wallet: ${wallet}`,
    `Choice: ${option}`,
    `Voting closes: ${new Date(ballot.endsAt * 1_000).toISOString()}`,
    "This is a signature, not a transaction or token approval",
  ].join("\n");
}

export function OffchainGovernancePage() {
  const { publicKey, signMessage } = useWallet();
  const [data, setData] = useState<BallotResponse>();
  const [selected, setSelected] = useState<VoteOption>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const wallet = publicKey?.toBase58();
  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (wallet) params.set("wallet", wallet);
    const requested = new URLSearchParams(window.location.search).get("proposal");
    if (requested) params.set("proposal", requested);
    const response = await fetch(`/api/solana/offchain-governance${params.size ? `?${params}` : ""}`,
      { cache: "no-store" });
    const next = await response.json() as BallotResponse;
    if (!response.ok) throw new Error(next.error || "Voting data unavailable");
    if (requested && next.ballot && requested !== next.ballot.id) throw new Error("This proposal is no longer active");
    setData(next);
    setLoading(false);
  }, [wallet]);

  useEffect(() => {
    let cancelled = false;
    const update = () => void refresh().catch((cause) => {
      if (!cancelled) { setError(cause instanceof Error ? cause.message : "Voting data unavailable"); setLoading(false); }
    });
    update();
    const timer = window.setInterval(update, 20_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [refresh]);

  const ballot = data?.ballot;
  const now = Date.now();
  const open = Boolean(ballot && now >= ballot.startsAt * 1_000 && now < ballot.endsAt * 1_000);
  const canVote = Boolean(open && wallet && signMessage && data?.eligibility && !data.eligibility.receipt);
  const link = ballot ? `${window.location.origin}/governance?proposal=${ballot.id}` : "";

  async function submit() {
    if (!ballot || !wallet || !signMessage || !selected || !canVote) return;
    setBusy(true);
    setError("");
    try {
      const signature = bs58.encode(await signMessage(new TextEncoder().encode(offchainVoteMessageClient(ballot, wallet, selected))));
      const response = await fetch("/api/solana/offchain-governance/vote", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: ballot.id, wallet, option: selected, signature }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Vote not accepted");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vote not accepted");
    } finally { setBusy(false); }
  }

  return <>
    <section className="subpage-hero governance-hero"><span>HOLDER DECISION</span><h1>RESERVE VOTE</h1>
      <p>Connect your Solana wallet · Sign your choice · No vote transaction or fee</p></section>
    <section className="panel governance governance-page-panel">
      <div className="panel-head"><div><span className="section-number">{ballot ? `PROPOSAL ${ballot.id}` : "NO ACTIVE VOTE"}</span>
        <h2>{ballot ? "Strategic reserve" : "No active proposal"}</h2></div>
        <span className="pill">{!ballot ? "AWAITING BALLOT" : open ? "VOTING OPEN" : now < ballot.startsAt * 1_000 ? "OPENS SOON" : "VOTING CLOSED"}</span></div>
      {loading ? <p className="governance-notice">Checking the published holder snapshot</p>
        : !ballot ? <p className="governance-notice">No holder vote is open · Rewards continue to be sent automatically without connecting a wallet</p>
          : <>
            <p className="governance-notice">Voting weight comes from a published balance × holding-time snapshot · One signed vote per eligible wallet · The result is public, but this offchain vote does not lock the owner-controlled reserve or execute a trade automatically</p>
            <div className="proposal-summary">
              <div><span>VOTING WINDOW</span><b>{new Date(ballot.startsAt * 1_000).toLocaleString()} → {new Date(ballot.endsAt * 1_000).toLocaleString()}</b></div>
              <div><span>RESERVE AT VOTE CREATION</span><b>{formatMstrx(ballot.reserveRawMstrx)} MSTRx</b><small>Snapshot only · Not held by a voting contract</small></div>
              <div><span>SNAPSHOT WEIGHT</span><b>{BigInt(ballot.totalAvailableWeight).toLocaleString("en-US")}</b><small>Finalized holder history, excluding project and pool wallets</small></div>
              <div><span>VOTES CAST</span><b>{data?.count ?? 0}</b></div>
            </div>
            <div className="share-vote-row"><code>{link}</code><button type="button" onClick={() => void navigator.clipboard.writeText(link).catch(() => setError("Could not copy link"))}>Copy link</button></div>
            <div className="governance-evidence"><a href={`/governance/proposals/${ballot.id}/manifest.json`} target="_blank" rel="noreferrer">Snapshot manifest ↗</a>
              <a href={`/governance/proposals/${ballot.id}/snapshot.json`} target="_blank" rel="noreferrer">Holder weights ↗</a>
              <a href={`/governance/proposals/${ballot.id}/source.json`} target="_blank" rel="noreferrer">Source records ↗</a>
              <a href={`/api/solana/offchain-governance?proposal=${ballot.id}&receipts=1`} target="_blank" rel="noreferrer">Signed vote receipts ↗</a></div>
            <div className="option-grid">{ballot.options.map((option, index) => {
              const total = BigInt(data?.totals?.[option] || "0");
              const cast = Object.values(data?.totals || {}).reduce((sum, item) => sum + BigInt(item), 0n);
              const share = cast ? Number(total * 10_000n / cast) / 100 : 0;
              return <button type="button" key={option} className={selected === option ? "governance-option-selected" : ""}
                disabled={!canVote || busy} onClick={() => setSelected(option)}><span>0{index + 1}</span>
                <b>{optionCopy[option][0]}</b><small>{optionCopy[option][1]}</small>
                <strong>{total.toLocaleString("en-US")} weight · {share.toFixed(2)}%</strong></button>;
            })}</div>
            <div className="governance-wallet-state">
              {!wallet ? <><p>Connect a wallet to check your voting weight · Connecting is never needed to receive rewards</p><WalletMultiButton className="governance-connect" /></>
                : data?.eligibility?.receipt ? <p>Your vote for {optionCopy[data.eligibility.receipt.option][0]} is recorded with {BigInt(data.eligibility.receipt.weight).toLocaleString("en-US")} weight</p>
                  : data?.eligibility ? <p>Eligible weight: {BigInt(data.eligibility.weight).toLocaleString("en-US")}</p>
                    : <p>This wallet has no voting weight in the published snapshot</p>}
              {wallet && data?.eligibility && <a href={`/governance/proposals/${ballot.id}/proofs/${wallet}.json`} target="_blank" rel="noreferrer">View your snapshot proof ↗</a>}
              {!signMessage && wallet && <p>This wallet does not support message signing · Choose a compatible Solana wallet</p>}
              {error && <p className="governance-error" role="alert">{error}</p>}
              <button className="governance-submit" type="button" disabled={!canVote || !selected || busy} onClick={() => void submit()}>
                {busy ? "CHECKING SIGNATURE…" : "SIGN YOUR VOTE"}</button>
              <small>Only a message signature is requested · No wallet transaction, approval, or SOL fee</small>
            </div>
            <footer><span>Holder rewards and the strategic reserve remain separate</span><span>Reserve execution is an owner action, not an automatic result of this vote</span></footer>
          </>}
      {error && !ballot && <p className="governance-error" role="alert">{error}</p>}
    </section>
  </>;
}
