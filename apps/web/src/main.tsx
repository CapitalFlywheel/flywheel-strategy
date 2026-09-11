import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatUnits, type Address, type Hex } from "viem";
import "./styles.css";
import { claimMstr, readActiveProposal, readClaimed, readMstrBalance, readMstrMultiplier, readProposal, robinhoodChain, voteOnProposal, waitForClaimReceipt, type ActiveProposal } from "./chain";
import {
  connectInjectedWallet,
  connectMobileWallet,
  disconnectWallet,
  restoreWallet,
  watchConnectedWallet,
  watchInjectedWallets,
  type ConnectedWallet,
  type WalletProviderDetail,
} from "./wallets";

declare global {
  interface Window { __FLYWHEEL_ADMIN__?: boolean }
}

interface RewardSnapshotEntry {
  account: Address;
  cumulativeRewardRaw: string;
  proof: Hex[];
}

interface RewardSnapshot {
  status: string;
  epoch: number;
  windowEnd: number;
  rewardVault: Address;
  transactionHash: Hex;
  entries: RewardSnapshotEntry[];
}

interface MarketStatus {
  marketCapUsd: number;
  intervalSeconds: number;
  phase: string;
  cadence: { confirmedLevel: number; candidateLevel: number | null; candidateSince: number | null };
}

interface GovernanceWeightEntry { account: Address; weight: string; proof: Hex[] }
interface PreparedProposal { weightSnapshot: { entries: GovernanceWeightEntry[] } }
interface RewardHistoryEntry {
  epoch: number;
  windowEnd: number;
  mstrRewardRaw: string;
  merkleRoot: Hex;
  transactionHash?: Hex;
}
interface ServiceHeartbeat {
  service: string;
  ok: boolean;
  updatedAt: number;
  error?: string;
}
interface RuntimeConfig {
  projectToken: Address;
  mstr: Address;
  rewardVault: Address;
  reserveVault: Address;
  keeperVault: Address;
  feeRouter: Address;
  ponsFeeCollector: Address;
  governance: Address;
  restrictedExecutor: Address;
  projectHoldVault: Address;
  projectTokenLockVault: Address;
  marketingWallet: Address;
}

interface PublicLinks { x?: string; github?: string }

const governanceActions = [
  "Accumulate MSTR", "Buyback + hold", "Buyback + burn",
  "Buyback + lock", "Lock MSTR", "Marketing",
];

const cadence = [
  ["< $500K", "10 min"],
  ["$500K – $1M", "20 min"],
  ["$1M – $5M", "30 min"],
  ["$5M+", "60 min"]
];

const voteOptions = [
  ["Accumulate MSTR", "Keep building the reserve"],
  ["Buyback + hold", "Purchase the project token for reserve"],
  ["Buyback + burn", "Permanently reduce token supply"],
  ["Buyback + lock", "Lock purchased tokens for a selected term"],
  ["Lock MSTR", "Time-lock MSTR inside the reserve"],
  ["Marketing", "Send approved proceeds to the public wallet"]
];

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function FlywheelMark({ className = "" }: { className?: string }) {
  const blade = "M500 68 758 248 543 347 426 270Z";
  return (
    <svg className={className} viewBox="0 0 1000 1000" role="img" aria-label="FLYWHEEL STRATEGY">
      <g>
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <path key={angle} d={blade} transform={`rotate(${angle} 500 500)`} />
        ))}
      </g>
    </svg>
  );
}

function XLogoIcon() {
  return (
    <svg className="x-logo-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function GithubLogoIcon() {
  return (
    <svg className="github-logo-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.95 10.95 0 0 1 12 6.12c.98 0 1.95.13 2.86.38 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.15v3.26c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function GithubProjectLink({ href }: { href?: string }) {
  if (!href) return null;
  return (
    <a className="topbar-social social-icon-link" href={href} target="_blank" rel="noreferrer" aria-label="FLYWHEEL STRATEGY on GitHub" title="View project source on GitHub">
      <GithubLogoIcon />
    </a>
  );
}

function XProjectLink({ href, footer = false }: { href?: string; footer?: boolean }) {
  const className = footer ? "footer-x social-x-link" : "topbar-social social-x-link";
  if (!href) {
    return (
      <span className={`${className} social-link-pending`} aria-disabled="true" aria-label="FLYWHEEL STRATEGY on X" title="Project X link is being prepared">
        <XLogoIcon />
      </span>
    );
  }
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer" aria-label="FLYWHEEL STRATEGY on X">
      <XLogoIcon />
    </a>
  );
}

function approvedPublicLink(value: unknown, host: "x.com" | "github.com") {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === host || url.hostname === `www.${host}`) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function usePublicLinks() {
  const [links, setLinks] = useState<PublicLinks>({});
  useEffect(() => {
    void fetch("/site-links.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<PublicLinks> : Promise.reject())
      .then((value) => setLinks({
        x: approvedPublicLink(value.x, "x.com"),
        github: approvedPublicLink(value.github, "github.com"),
      }))
      .catch(() => setLinks({}));
  }, []);
  return links;
}

function StaticHeader({ links }: { links: PublicLinks }) {
  return (
    <header className="topbar">
      <a className="brand-lockup" href="/" aria-label="FLYWHEEL STRATEGY home">
        <FlywheelMark className="topbar-mark" />
        <span><b>FLYWHEEL STRATEGY</b><small>CAPITAL IN MOTION</small></span>
      </a>
      <nav aria-label="Primary navigation">
        <a href="/">Home</a>
        <a href="/governance" target="_blank" rel="noreferrer">Governance</a>
        <a href="/docs" aria-current="page">Documentation</a>
      </nav>
      <div className="topbar-action">
        <GithubProjectLink href={links.github} />
        <XProjectLink href={links.x} />
        <a className="topbar-return" href="/">Back to site</a>
      </div>
    </header>
  );
}

function PublicFooter({ links }: { links: PublicLinks }) {
  return (
    <footer className="public-footer">
      <div className="footer-brand"><FlywheelMark className="footer-mark" /><span><b>FLYWHEEL STRATEGY</b><small>CAPITAL IN MOTION</small></span></div>
      <div className="footer-links">
        <a href="/docs" target="_blank" rel="noreferrer">Documentation ↗</a>
        <a href="/governance" target="_blank" rel="noreferrer">Governance ↗</a>
        {links.github && <a href={links.github} target="_blank" rel="noreferrer">GitHub ↗</a>}
        <XProjectLink href={links.x} footer />
      </div>
    </footer>
  );
}

function plainText(text: string) {
  return text.trim().replace(/\.$/, "");
}

function inlineMarkdown(text: string) {
  return plainText(text).split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`")
      ? <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>
      : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
  );
}

function headingId(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderDocumentation(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = plainText(heading[2]);
      const id = headingId(text);
      blocks.push(level === 1
        ? <h1 id={id} key={`${id}-${index}`}>{text}</h1>
        : level === 2
          ? <h2 id={id} key={`${id}-${index}`}>{text}</h2>
          : <h3 id={id} key={`${id}-${index}`}>{text}</h3>);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || /^(#{1,3})\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+\.\s+/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdown(paragraph.join(" "))}</p>);
  }
  return blocks;
}

function DocumentationPage() {
  const links = usePublicLinks();
  const [markdown, setMarkdown] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    document.title = "DOCUMENTATION — FLYWHEEL STRATEGY";
    void fetch("/technical-specification.md", { cache: "no-store" })
      .then((response) => response.ok ? response.text() : Promise.reject())
      .then(setMarkdown)
      .catch(() => setLoadFailed(true));
  }, []);

  const headings = markdown.split(/\r?\n/)
    .map((line) => /^##\s+(.+)$/.exec(line.trim())?.[1])
    .filter((heading): heading is string => Boolean(heading));

  return (
    <main className="docs-page">
      <StaticHeader links={links} />
      <section className="subpage-hero docs-hero">
        <span>PUBLIC DOCUMENTATION</span>
        <h1>HOW THE FLYWHEEL WORKS</h1>
        <p>Fees, MSTR rewards, holder weight, automation, governance and every important project rule in one place</p>
      </section>
      <div className="docs-layout">
        <aside>
          <b>CONTENTS</b>
          {headings.map((heading) => <a href={`#${headingId(heading)}`} key={heading}>{plainText(heading)}</a>)}
        </aside>
        <article className="documentation-body">
          {loadFailed ? <p>Documentation is temporarily unavailable</p> : markdown ? renderDocumentation(markdown) : <p>Loading documentation</p>}
        </article>
      </div>
      <PublicFooter links={links} />
    </main>
  );
}

function GovernancePage({
  proposal,
  account,
  voteStatus,
  voteTx,
  onConnect,
  onVote,
}: {
  proposal: ActiveProposal | null | undefined;
  account?: Address;
  voteStatus: string;
  voteTx?: Hex;
  onConnect: () => void;
  onVote: (index: number) => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const now = Math.floor(Date.now() / 1000);
  const voteOpen = Boolean(proposal && now >= proposal.startsAt && now < proposal.endsAt && !proposal.executed);
  const quorumPercent = proposal && proposal.totalAvailableWeight > 0n
    ? Number(proposal.totalCastWeight * 10_000n / proposal.totalAvailableWeight) / 100
    : 0;
  const proposalStatus = !proposal ? "NO ACTIVE VOTE" : proposal.executed ? "EXECUTED" : voteOpen ? "VOTING OPEN" : now < proposal.startsAt ? "UPCOMING" : "VOTING CLOSED";

  useEffect(() => {
    document.title = proposal ? `VOTE #${proposal.id.toString()} — FLYWHEEL STRATEGY` : "GOVERNANCE — FLYWHEEL STRATEGY";
  }, [proposal?.id]);

  async function copyLink() {
    if (!proposal) return;
    const url = `${window.location.origin}/governance/${proposal.id.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("LINK COPIED");
    } catch {
      setCopyStatus(url);
    }
  }

  return (
    <>
      <section className="subpage-hero governance-hero">
        <span>HOLDER GOVERNANCE</span>
        <h1>THE RESERVE MOVES BY VOTE</h1>
        <p>The team starts a vote and holders choose one of the allowed reserve actions</p>
      </section>
      <section className="panel governance governance-page-panel">
        <div className="panel-head">
          <div><span className="section-number">LIVE GOVERNANCE</span><h2>{proposal ? `Vote #${proposal.id.toString()}` : "No vote right now"}</h2></div>
          <span className="pill">{proposalStatus}</span>
        </div>
        {proposal ? (
          <>
            <div className="proposal-summary">
              <div><span>ENDS</span><b>{new Date(proposal.endsAt * 1000).toLocaleString()}</b></div>
              <div><span>QUORUM</span><b>{quorumPercent.toFixed(2)}% / 7%</b></div>
              <div><span>EXECUTION</span><b>{proposal.executed ? "COMPLETED" : new Date(proposal.executableAt * 1000).toLocaleString()}</b></div>
            </div>
            <div className="share-vote-row">
              <code>{`${window.location.origin}/governance/${proposal.id.toString()}`}</code>
              <button type="button" onClick={() => void copyLink()}>{copyStatus || "COPY VOTE LINK"}</button>
            </div>
            <div className="option-grid live-options">
              {proposal.options.map((option, index) => (
                <button type="button" key={index} onClick={() => onVote(index)} disabled={!account || !voteOpen} className={proposal.executed && proposal.winningOption === index ? "winning-option" : ""}>
                  <span>0{index + 1}</span>
                  <b>{governanceActions[option.action]}</b>
                  <small>{option.reserveBps / 100}% of reserve · {option.votes.toString()} weight</small>
                </button>
              ))}
            </div>
            {!account && voteOpen && <button className="governance-connect" type="button" onClick={onConnect}>Connect wallet to vote</button>}
            <div className="vote-status">{voteStatus || (voteOpen ? "Select one option — your weight is fixed by the vote snapshot" : "This vote is not accepting new votes")}</div>
            {voteTx && <a className="tx-link" href={`${robinhoodChain.explorer}/tx/${voteTx}`} target="_blank" rel="noreferrer">View vote transaction ↗</a>}
          </>
        ) : (
          <>
            <p className="lead">There is no active proposal — the team will publish the next vote link when it starts</p>
            <div className="option-grid">
              {voteOptions.map(([title, text], index) => <div key={title}><span>0{index + 1}</span><b>{title}</b><small>{text}</small></div>)}
            </div>
          </>
        )}
        <footer><span>Vote duration: 1–12 hours</span><span>Automatic execution: +5 minutes</span><span>Quorum: 7%</span><span>Reserve usage: 0–100%</span></footer>
      </section>
    </>
  );
}

function safeWalletIcon(icon?: string): string | undefined {
  return icon && /^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i.test(icon) ? icon : undefined;
}

function WalletModal({
  wallets,
  connected,
  connecting,
  error,
  mobileEnabled,
  onConnect,
  onConnectMobile,
  onDisconnect,
  onClose,
}: {
  wallets: WalletProviderDetail[];
  connected?: ConnectedWallet;
  connecting: string;
  error: string;
  mobileEnabled: boolean;
  onConnect: (wallet: WalletProviderDetail) => void;
  onConnectMobile: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  return (
    <div className="wallet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
        <div className="wallet-modal-head">
          <div>
            <span>ROBINHOOD CHAIN</span>
            <h2 id="wallet-title">Choose a wallet</h2>
          </div>
          <button type="button" className="wallet-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {connected && (
          <div className="connected-wallet-row">
            <div>
              <small>CONNECTED WITH {connected.wallet.info.name}</small>
              <b>{connected.account.slice(0, 8)}…{connected.account.slice(-6)}</b>
            </div>
            <button type="button" onClick={onDisconnect}>Disconnect</button>
          </div>
        )}
        {error && <div className="wallet-modal-error">{error}</div>}

        <div className="wallet-list">
          {wallets.map((wallet) => {
            const icon = safeWalletIcon(wallet.info.icon);
            const phantom = `${wallet.info.name} ${wallet.info.rdns}`.toLowerCase().includes("phantom");
            return (
              <button
                type="button"
                className="wallet-choice"
                key={`${wallet.info.rdns}:${wallet.info.uuid}`}
                onClick={() => onConnect(wallet)}
                disabled={Boolean(connecting)}
              >
                {icon ? <img src={icon} alt="" /> : <span className="wallet-fallback">{wallet.info.name.slice(0, 1)}</span>}
                <span>
                  <b>{wallet.info.name}</b>
                  <small>{phantom ? "Installed · Robinhood Chain may be unsupported" : "Installed in this browser"}</small>
                </span>
                <i>{connecting === wallet.info.uuid ? "Connecting…" : "Connect"}</i>
              </button>
            );
          })}
          {!wallets.length && <p className="no-wallets">No browser wallet was found — use the mobile option below or install an EVM wallet</p>}
        </div>

        <button type="button" className="mobile-wallet-choice" onClick={onConnectMobile} disabled={Boolean(connecting)}>
          <span className="qr-mark">QR</span>
          <span><b>Mobile wallet / WalletConnect</b><small>Zerion, MetaMask, Rabby and other compatible wallets</small></span>
          <i>{connecting === "walletconnect" ? "Opening…" : mobileEnabled ? "Open QR" : "Setup needed"}</i>
        </button>

        <p className="wallet-safety">The site never receives your seed phrase or private key — every claim and vote is confirmed inside your wallet</p>
        <div className="wallet-supported">MetaMask <i>·</i> Rabby <i>·</i> Zerion <i>·</i> WalletConnect <i>·</i> other EVM wallets</div>
      </section>
    </div>
  );
}

function App() {
  const publicLinks = usePublicLinks();
  const governanceRoute = /^\/governance(?:\/(\d+))?\/?$/.exec(window.location.pathname);
  const requestedProposalId = governanceRoute?.[1];
  const isGovernancePage = Boolean(governanceRoute);
  const [account, setAccount] = useState<Address>();
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWallet>();
  const [availableWallets, setAvailableWallets] = useState<WalletProviderDetail[]>([]);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [connectingWallet, setConnectingWallet] = useState("");
  const [walletError, setWalletError] = useState("");
  const [rewardBalance, setRewardBalance] = useState("—");
  const [reserveBalance, setReserveBalance] = useState("—");
  const [snapshot, setSnapshot] = useState<RewardSnapshot>();
  const [claimable, setClaimable] = useState<bigint>(0n);
  const [claimStatus, setClaimStatus] = useState("Connect your wallet to check rewards");
  const [claimTx, setClaimTx] = useState<Hex>();
  const [claimPending, setClaimPending] = useState(false);
  const claimInFlight = useRef(false);
  const [marketStatus, setMarketStatus] = useState<MarketStatus>();
  const [mstrMultiplier, setMstrMultiplier] = useState(10n ** 18n);
  const [activeProposal, setActiveProposal] = useState<ActiveProposal | null>();
  const [governanceWeights, setGovernanceWeights] = useState<GovernanceWeightEntry[]>([]);
  const [voteStatus, setVoteStatus] = useState("");
  const [voteTx, setVoteTx] = useState<Hex>();
  const [rewardHistory, setRewardHistory] = useState<RewardHistoryEntry[]>([]);
  const [serviceHeartbeats, setServiceHeartbeats] = useState<Record<string, ServiceHeartbeat | undefined>>({});
  const [heartbeatCheckedAt, setHeartbeatCheckedAt] = useState(Date.now());
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>();
  const mstr = runtimeConfig?.mstr ?? (import.meta.env.VITE_MSTR_ADDRESS as Address | undefined)
    ?? "0xec262a75e413fAfD0dF80480274532C79D42da09";
  const rewardVault = runtimeConfig?.rewardVault ?? import.meta.env.VITE_REWARD_VAULT_ADDRESS as Address | undefined;
  const reserveVault = runtimeConfig?.reserveVault ?? import.meta.env.VITE_RESERVE_VAULT_ADDRESS as Address | undefined;
  const governance = runtimeConfig?.governance ?? import.meta.env.VITE_GOVERNANCE_ADDRESS as Address | undefined;
  const reownProjectId = (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined) ?? "";

  useEffect(() => watchInjectedWallets(setAvailableWallets), []);

  useEffect(() => {
    claimInFlight.current = false;
    setClaimPending(false);
    setClaimTx(undefined);
  }, [account]);

  useEffect(() => {
    void restoreWallet().then((connection) => {
      if (!connection) return;
      setConnectedWallet(connection);
      setAccount(connection.account);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!connectedWallet) return;
    return watchConnectedWallet(
      connectedWallet.wallet,
      (accounts) => {
        if (accounts[0]) {
          setAccount(accounts[0]);
          setConnectedWallet((current) => current ? { ...current, account: accounts[0] } : current);
        } else {
          setAccount(undefined);
          setConnectedWallet(undefined);
        }
      },
      () => {
        setAccount(undefined);
        setConnectedWallet(undefined);
      },
    );
  }, [connectedWallet?.wallet]);

  useEffect(() => {
    if (!walletModalOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setWalletModalOpen(false);
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [walletModalOpen]);

  useEffect(() => {
    void fetch("/config.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<RuntimeConfig> : Promise.reject())
      .then(setRuntimeConfig)
      .catch(() => setRuntimeConfig(undefined));
  }, []);

  useEffect(() => {
    if (!mstr) return;
    void readMstrMultiplier(mstr).then(setMstrMultiplier);
    void Promise.all([
      readMstrBalance(mstr, rewardVault),
      readMstrBalance(mstr, reserveVault),
    ]).then(([reward, reserve]) => {
      setRewardBalance(reward);
      setReserveBalance(reserve);
    }).catch(() => setWalletError("Contract data is temporarily unavailable"));
  }, [mstr, rewardVault, reserveVault]);

  useEffect(() => {
    void fetch("/snapshots/latest.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("NO_SNAPSHOT");
        return response.json() as Promise<RewardSnapshot>;
      })
      .then(setSnapshot)
      .catch(() => setSnapshot(undefined));
  }, []);

  useEffect(() => {
    void fetch("/snapshots/history.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<RewardHistoryEntry[]> : Promise.reject())
      .then((history) => setRewardHistory(history.slice(0, 10)))
      .catch(() => setRewardHistory([]));
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    const services = ["reward-keeper", "reward-publisher", "governance-keeper"];
    const refresh = async () => {
      const results = await Promise.all(services.map(async (service) => {
        try {
          const response = await fetch(`/status/${service}.json`, { cache: "no-store" });
          if (!response.ok) return [service, undefined] as const;
          return [service, await response.json() as ServiceHeartbeat] as const;
        } catch {
          return [service, undefined] as const;
        }
      }));
      if (!cancelled) {
        setServiceHeartbeats(Object.fromEntries(results));
        setHeartbeatCheckedAt(Date.now());
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!governance) {
      setActiveProposal(undefined);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const proposal = requestedProposalId
          ? await readProposal(governance, BigInt(requestedProposalId))
          : await readActiveProposal(governance);
        if (cancelled) return;
        setActiveProposal(proposal);
        if (!proposal) return setGovernanceWeights([]);
        const prepared = await fetch(`/governance/proposal-${proposal.id}.json`, { cache: "no-store" })
          .then((response) => response.ok ? response.json() as Promise<PreparedProposal> : Promise.reject());
        if (!cancelled) setGovernanceWeights(prepared.weightSnapshot.entries);
      } catch {
        if (!cancelled) setVoteStatus("Governance data is temporarily unavailable");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [governance, voteTx, requestedProposalId]);

  useEffect(() => {
    void fetch("/snapshots/market-status.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<MarketStatus> : Promise.reject())
      .then(setMarketStatus)
      .catch(() => setMarketStatus(undefined));
  }, []);

  useEffect(() => {
    if (!account) {
      setClaimable(0n);
      setClaimStatus("Connect your wallet to check rewards");
      return;
    }
    if (!rewardVault || !snapshot) {
      setClaimable(0n);
      setClaimStatus("Rewards will appear after the first live epoch");
      return;
    }
    const entry = snapshot.entries.find((item) => item.account.toLowerCase() === account.toLowerCase());
    if (!entry) {
      setClaimable(0n);
      setClaimStatus("No allocated MSTR in the latest epoch yet");
      return;
    }
    void readClaimed(rewardVault, account).then((alreadyClaimed) => {
      const cumulative = BigInt(entry.cumulativeRewardRaw);
      setClaimable(cumulative > alreadyClaimed ? cumulative - alreadyClaimed : 0n);
      setClaimStatus(cumulative > alreadyClaimed ? "Ready to claim" : "Everything is claimed");
    }).catch(() => setClaimStatus("Could not read your claim status"));
  }, [account, rewardVault, snapshot]);

  async function connect(wallet: WalletProviderDetail) {
    setWalletError("");
    setConnectingWallet(wallet.info.uuid);
    try {
      const connection = await connectInjectedWallet(wallet);
      setConnectedWallet(connection);
      setAccount(connection.account);
      setWalletModalOpen(false);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Wallet connection failed");
    } finally {
      setConnectingWallet("");
    }
  }

  async function connectMobile() {
    setWalletError("");
    setConnectingWallet("walletconnect");
    try {
      const connection = await connectMobileWallet(reownProjectId);
      setConnectedWallet(connection);
      setAccount(connection.account);
      setWalletModalOpen(false);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Mobile wallet connection failed");
    } finally {
      setConnectingWallet("");
    }
  }

  async function disconnect() {
    await disconnectWallet().catch(() => undefined);
    setAccount(undefined);
    setConnectedWallet(undefined);
    setWalletModalOpen(false);
  }

  async function claim() {
    if (!account || !rewardVault || !snapshot || claimInFlight.current) return;
    const entry = snapshot.entries.find((item) => item.account.toLowerCase() === account.toLowerCase());
    if (!entry || claimable === 0n) return;
    claimInFlight.current = true;
    setClaimPending(true);
    setWalletError("");
    setClaimStatus("Confirm the transaction in your wallet");
    try {
      const hash = await claimMstr(rewardVault, account, BigInt(entry.cumulativeRewardRaw), entry.proof);
      setClaimTx(hash);
      setClaimable(0n);
      setClaimStatus("Claim submitted — waiting for confirmation");
      await waitForClaimReceipt(hash);
      const alreadyClaimed = await readClaimed(rewardVault, account);
      const cumulative = BigInt(entry.cumulativeRewardRaw);
      setClaimable(cumulative > alreadyClaimed ? cumulative - alreadyClaimed : 0n);
      setClaimStatus(cumulative > alreadyClaimed ? "New rewards are ready" : "Everything is claimed");
    } catch (error) {
      const alreadyClaimed = await readClaimed(rewardVault, account).catch(() => 0n);
      const cumulative = BigInt(entry.cumulativeRewardRaw);
      setClaimable(cumulative > alreadyClaimed ? cumulative - alreadyClaimed : 0n);
      setClaimStatus("Claim was not completed");
      setWalletError(error instanceof Error ? error.message : "Claim failed");
    } finally {
      claimInFlight.current = false;
      setClaimPending(false);
    }
  }

  async function vote(optionIndex: number) {
    if (!governance || !account || !activeProposal) return;
    const entry = governanceWeights.find((item) => item.account.toLowerCase() === account.toLowerCase());
    if (!entry) return setVoteStatus("This wallet has no weight in the vote snapshot");
    setWalletError("");
    setVoteStatus("Confirm your vote in the wallet");
    try {
      const hash = await voteOnProposal(governance, account, activeProposal.id, optionIndex, BigInt(entry.weight), entry.proof);
      setVoteTx(hash);
      setVoteStatus("Vote transaction sent");
    } catch (error) {
      setVoteStatus("Vote was not sent");
      setWalletError(error instanceof Error ? error.message : "Vote failed");
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand-lockup" href="/" aria-label="FLYWHEEL STRATEGY home">
          <FlywheelMark className="topbar-mark" />
          <span>
            <b>FLYWHEEL STRATEGY</b>
            <small>CAPITAL IN MOTION</small>
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="/#mechanics">How it works</a>
          <a href="/#rewards">Rewards</a>
          <a href={activeProposal ? `/governance/${activeProposal.id.toString()}` : "/governance"} target="_blank" rel="noreferrer">Governance</a>
          <a href="/docs" target="_blank" rel="noreferrer">Documentation</a>
        </nav>
        <GithubProjectLink href={publicLinks.github} />
        <XProjectLink href={publicLinks.x} />
        <div className="topbar-action">
          <button type="button" onClick={() => setWalletModalOpen(true)}>
            {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}
          </button>
        </div>
      </header>
      {walletError && <div className="wallet-error">{walletError}</div>}
      {walletModalOpen && (
        <WalletModal
          wallets={availableWallets}
          connected={connectedWallet}
          connecting={connectingWallet}
          error={walletError}
          mobileEnabled={Boolean(reownProjectId)}
          onConnect={(wallet) => void connect(wallet)}
          onConnectMobile={() => void connectMobile()}
          onDisconnect={() => void disconnect()}
          onClose={() => setWalletModalOpen(false)}
        />
      )}

      {isGovernancePage ? (
        <>
          <GovernancePage
            proposal={activeProposal}
            account={account}
            voteStatus={voteStatus}
            voteTx={voteTx}
            onConnect={() => setWalletModalOpen(true)}
            onVote={(index) => void vote(index)}
          />
          <PublicFooter links={publicLinks} />
        </>
      ) : <>

      <section className="story-hero" id="top">
        <div className="hero-copy">
          <h1>HOLD CAPITAL<br /><span>ACCUMULATE MSTR</span></h1>
          <p>Trading fees continuously build MSTR rewards for passive holders and a separate holder-governed reserve</p>
          <div className="hero-actions">
            <button type="button" className="primary" onClick={() => setWalletModalOpen(true)}>Connect wallet</button>
            <a href="#mechanics">See how it works ↓</a>
          </div>
        </div>
        <div className="hero-symbol" aria-hidden="true">
          <FlywheelMark className="hero-mark" />
          <span>CAPITAL IN MOTION</span>
        </div>
        <div className="hero-mechanics" id="mechanics">
          <div className="mechanics-intro">
            <span>HOW IT WORKS</span>
            <p>ONE LOOP · THREE MOVES</p>
          </div>
          <div><b>01</b><strong>TRADE</strong><span>Each buy and sell creates project fees</span></div>
          <div><b>02</b><strong>CONVERT</strong><span>Automation uses those fees to buy MSTR</span></div>
          <div><b>03</b><strong>CLAIM</strong><span>MSTR is shared by balance and exact hold time</span></div>
        </div>
      </section>

      <section className="claim-panel first-action" id="rewards">
        <div>
          <span className="section-number">YOUR PASSIVE REWARDS</span>
          <h2>{Number(formatUnits(claimable * mstrMultiplier / 10n ** 18n, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} MSTR</h2>
          <p>{claimStatus} · No staking or token lock is required</p>
          {snapshot && <small>Latest published epoch: {snapshot.epoch}</small>}
        </div>
        <div className="claim-actions">
          <button type="button" disabled={!account || claimable === 0n || claimPending} onClick={claim}>
            {claimPending ? "Claiming $MSTR…" : claimTx && claimable === 0n ? "$MSTR claimed" : "Claim $MSTR"}
          </button>
          {claimTx && <a href={`${robinhoodChain.explorer}/tx/${claimTx}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
        </div>
      </section>

      <section className="stats-grid">
        <Stat label="Reward vault" value={`${rewardBalance} MSTR`} detail="Holder funds only" />
        <Stat label="Strategic reserve" value={`${reserveBalance} MSTR`} detail="Governed separately" />
        <Stat label="Reward interval" value={`${(marketStatus?.intervalSeconds ?? 600) / 60} min`} detail={marketStatus ? `$${Math.round(marketStatus.marketCapUsd).toLocaleString()} market cap` : "Starts at 10 minutes"} />
        <Stat label="Market phase" value={marketStatus?.phase === "uniswap-v4" ? "V4 pool" : marketStatus?.phase === "bonding-curve" ? "PONS curve" : "Pre-launch"} detail="Claim gas paid by holder" />
      </section>

      <section className="split">
        <article className="panel">
          <div className="panel-head">
            <div>
              <span className="section-number">01</span>
              <h2>Fee flow</h2>
            </div>
            <span className="pill">3% trading fee</span>
          </div>
          <div className="flow">
            <div><b>1.35%</b><span>Passive MSTR rewards</span></div>
            <div><b>1.08%</b><span>Strategic MSTR reserve</span></div>
            <div><b>0.27%</b><span>Automation</span></div>
            <div><b>0.30%</b><span>PONS protocol</span></div>
          </div>
          <div className="route">ETH <i>→</i> WETH <i>→</i> USDG <i>→</i> MSTR</div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <span className="section-number">02</span>
              <h2>Holder weight</h2>
            </div>
            <span className="pill">No staking</span>
          </div>
          <div className="formula">balance × exact hold time × loyalty</div>
          <div className="progress-row"><span>1 hour</span><div><i style={{ width: "4%" }} /></div><b>1.019×</b></div>
          <div className="progress-row"><span>24 hours</span><div><i style={{ width: "18%" }} /></div><b>1.091×</b></div>
          <div className="progress-row"><span>7 days</span><div><i style={{ width: "48%" }} /></div><b>1.242×</b></div>
          <div className="progress-row"><span>30 days</span><div><i style={{ width: "100%" }} /></div><b>1.500×</b></div>
        </article>
      </section>

      <section className="panel cadence-panel">
        <div className="panel-head">
          <div><span className="section-number">03</span><h2>Market-cap cadence</h2></div>
          <span className="pill">60m confirmation</span>
        </div>
        <div className="cadence-grid">
          {cadence.map(([cap, interval], index) => (
            <div className={(marketStatus?.cadence.confirmedLevel ?? 0) === index ? "active" : ""} key={cap}>
              <span>{cap}</span><strong>{interval}</strong><small>{(marketStatus?.cadence.confirmedLevel ?? 0) === index ? "Current" : "Locks after confirmation"}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="panel reward-history">
        <div className="panel-head">
          <div><span className="section-number">04</span><h2>Reward history</h2></div>
          <span className="pill">Last 10 epochs · total distribution</span>
        </div>
        {rewardHistory.length ? (
          <div className="history-table">
            {rewardHistory.map((epoch) => (
              <div key={epoch.epoch}>
                <b>Epoch {epoch.epoch}</b>
                <span>{new Date(epoch.windowEnd * 1000).toLocaleString()}</span>
                <strong>{Number(formatUnits(BigInt(epoch.mstrRewardRaw) * mstrMultiplier / 10n ** 18n, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} $MSTR total</strong>
                <a href={`/snapshots/epoch-${epoch.epoch}.json`} target="_blank" rel="noreferrer">JSON ↗</a>
                {epoch.transactionHash && <a href={`${robinhoodChain.explorer}/tx/${epoch.transactionHash}`} target="_blank" rel="noreferrer">TX ↗</a>}
              </div>
            ))}
          </div>
        ) : <p className="lead">Epoch files will appear automatically after the token launches</p>}
      </section>

      <section className="panel operations">
        <div className="panel-head">
          <div><span className="section-number">05</span><h2>Automation status</h2></div>
          <span className="pill">Public heartbeat</span>
        </div>
        <div className="operations-grid">
          {[
            ["reward-keeper", "Fee collection + MSTR purchase"],
            ["reward-publisher", "Reward calculation + publication"],
            ["governance-keeper", "Automatic vote execution"],
          ].map(([service, label]) => {
            const heartbeat = serviceHeartbeats[service];
            const fresh = Boolean(heartbeat && heartbeatCheckedAt - heartbeat.updatedAt < 120_000);
            const healthy = Boolean(heartbeat?.ok && fresh);
            return (
              <div key={service} className={healthy ? "healthy" : "offline"}>
                <span>{healthy ? "ONLINE" : heartbeat ? "STALE / ERROR" : "NOT STARTED"}</span>
                <b>{label}</b>
                <small>{heartbeat ? `Last signal: ${new Date(heartbeat.updatedAt).toLocaleString()}` : "Starts after deployment"}</small>
                {heartbeat?.error && <small className="service-error">{heartbeat.error}</small>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="governance-callout">
        <div>
          <span>06 · HOLDER GOVERNANCE</span>
          <h2>THE RESERVE MOVES BY VOTE</h2>
          <p>The team starts a vote and every holder chooses with balance and hold-time weight</p>
        </div>
        <a href={activeProposal ? `/governance/${activeProposal.id.toString()}` : "/governance"} target="_blank" rel="noreferrer">
          {activeProposal ? `Open vote #${activeProposal.id.toString()} ↗` : "Open governance ↗"}
        </a>
      </section>

      <section className="transparency" id="transparency">
        <span>PUBLIC BY DEFAULT</span>
        <h2>Every reserve movement, reward root, vote and execution stays visible</h2>
        <p>{runtimeConfig ? "Every mainnet address links directly to the public explorer" : "Mainnet contract addresses and transaction links will appear here after launch"}</p>
        <div className="project-contract-card">
          <span>PROJECT TOKEN CONTRACT</span>
          {runtimeConfig
            ? <a href={`${robinhoodChain.explorer}/address/${runtimeConfig.projectToken}`} target="_blank" rel="noreferrer">{runtimeConfig.projectToken} ↗</a>
            : <b>PUBLISHED HERE AFTER MAINNET LAUNCH</b>}
        </div>
        {runtimeConfig && (
          <div className="address-grid">
            {[
              ["Reward vault", runtimeConfig.rewardVault],
              ["Strategic reserve", runtimeConfig.reserveVault], ["Governance", runtimeConfig.governance],
              ["Fee router", runtimeConfig.feeRouter], ["Marketing wallet", runtimeConfig.marketingWallet],
            ].map(([label, address]) => (
              <a key={label} href={`${robinhoodChain.explorer}/address/${address}`} target="_blank" rel="noreferrer">
                <b>{label}</b><span>{address.slice(0, 8)}…{address.slice(-6)} ↗</span>
              </a>
            ))}
          </div>
        )}
        <a className="docs-link" href="/docs" target="_blank" rel="noreferrer">Open full documentation ↗</a>
      </section>
      <PublicFooter links={publicLinks} />
      </>}
    </main>
  );
}

const AdminPanel = lazy(() => import("./admin").then((module) => ({ default: module.AdminPanel })));

createRoot(document.getElementById("root")!).render(
  window.__FLYWHEEL_ADMIN__ === true
    ? <Suspense fallback={<main style={{ padding: 32 }}>Загрузка панели…</main>}><AdminPanel /></Suspense>
    : window.location.pathname.startsWith("/docs")
      ? <DocumentationPage />
      : <App />,
);
