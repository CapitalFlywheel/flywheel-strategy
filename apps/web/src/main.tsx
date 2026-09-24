import React, { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import "./redesign.css";
import { formatMstrxRaw } from "./chain";
import { solanaMainnet, solscanAccount, solscanToken, solscanTransaction } from "./network";
import { isSolanaPublicKey, shortPublicKey } from "./wallets";

declare global {
  interface Window { __FLYWHEEL_ADMIN__?: boolean; __FLYWHEEL_ADMIN_API__?: string }
}

interface PublicLinks { x?: string; github?: string }

interface RuntimeConfig {
  network: "solana-mainnet-beta";
  projectMint: string;
  mstrxMint: string;
  creatorFeeRecipient: string;
  rewardVaultTokenAccount: string;
  reserveVaultTokenAccount: string;
  strategyProgram?: string;
  governanceProgram?: string;
  marketingWallet?: string;
  launchedAtSlot?: number;
}

interface RewardHistoryEntry {
  epoch: number;
  windowEnd: number;
  mstrxRewardRaw: string;
  signature?: string;
  recipientCount?: number;
}

interface ServiceHeartbeat {
  service: string;
  ok: boolean;
  updatedAt: number;
  error?: string;
}

interface VaultSnapshot {
  holderDisplay: string;
  reserveDisplay: string;
  multiplier: number;
  updatedAt: number;
}

interface MarketStatus {
  marketCapUsd: number;
  intervalSeconds: number;
  phase: "pump-curve" | "pumpswap" | "pre-launch";
  cadence: { confirmedLevel: number };
}

const cadence = [
  ["< $500K", "10 min"],
  ["$500K – $1M", "20 min"],
  ["$1M – $5M", "30 min"],
  ["$5M+", "60 min"],
];

const governanceActions = [
  ["ACCUMULATE MSTRx", "Keep building the strategic reserve"],
  ["BUYBACK + HOLD", "Purchase CAPITAL for permanent public custody"],
  ["BUYBACK + BURN", "Purchase CAPITAL and remove it from circulation"],
  ["BUYBACK + LOCK", "Purchase CAPITAL and lock it for a selected term"],
  ["LOCK MSTRx", "Time-lock MSTRx inside the strategic reserve"],
  ["MARKETING", "Use the voted reserve amount for the disclosed wallet"],
];

function FlywheelMark({ className = "" }: { className?: string }) {
  return <img className={className} src="/visuals/logo-rotation.gif" alt="FLYWHEEL STRATEGY" />;
}

function SectionIcon({ kind }: { kind: "flow" | "weight" | "cadence" | "history" | "automation" | "trade" | "convert" | "claim" }) {
  const paths = {
    flow: "M4 9 20 2l16 7-16 8L4 9Zm0 10 16 8 16-8M4 29l16 8 16-8",
    weight: "M20 3v34M4 12h32M9 12 3 26h12L9 12Zm22 0-6 14h12l-6-14ZM12 37h16",
    cadence: "M5 34V23h6v11H5Zm12 0V14h6v20h-6Zm12 0V4h6v30h-6",
    history: "M5 18a15 15 0 1 1 2 11M5 6v12h12M20 10v11l7 4",
    automation: "M20 3 35 12v17l-15 8L5 29V12L20 3Zm0 9 8 8-8 8-8-8 8-8Z",
    trade: "M4 14h31l-7-7M36 27H5l7 7",
    convert: "M6 17a14 14 0 0 1 25-7l4 5M35 5v10H25M34 24A14 14 0 0 1 9 31l-4-5M5 36V26h10",
    claim: "M3 24h7v12H3V24Zm7 3 6-7h7c5 0 5 7 0 7h-5m6 0 9-7c3-2 6 2 3 5L24 35H10",
  };
  return <svg className="section-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

function XLogoIcon() {
  return <svg className="x-logo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
}

function GithubLogoIcon() {
  return <svg className="github-logo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.95 10.95 0 0 1 12 6.12c.98 0 1.95.13 2.86.38 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.15v3.26c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" /></svg>;
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

function SocialLinks({ links }: { links: PublicLinks }) {
  return <>
    {links.github && <a className="topbar-social social-icon-link" href={links.github} target="_blank" rel="noreferrer" aria-label="GitHub"><GithubLogoIcon /></a>}
    {links.x
      ? <a className="topbar-social social-x-link" href={links.x} target="_blank" rel="noreferrer" aria-label="X"><XLogoIcon /></a>
      : <span className="topbar-social social-x-link social-link-pending" title="X link temporarily unavailable"><XLogoIcon /></span>}
  </>;
}

function Header({ links, docs = false }: { links: PublicLinks; docs?: boolean }) {
  return <header className="topbar">
    <a className="brand-lockup" href="/" aria-label="FLYWHEEL STRATEGY home">
      <FlywheelMark className="topbar-mark" />
      <span><b>FLYWHEEL STRATEGY</b><small>CAPITAL IN MOTION</small></span>
    </a>
    <nav aria-label="Primary navigation">
      <a href="/#mechanics">How it works</a>
      <a href="/#rewards">Rewards</a>
      <a href="/governance" target="_blank" rel="noreferrer">Governance</a>
      <a href="/docs" target={docs ? undefined : "_blank"} rel="noreferrer">Documentation</a>
    </nav>
    <SocialLinks links={links} />
    <div className="topbar-action">{docs ? <a className="topbar-return" href="/">Back to site</a> : <WalletMultiButton />}</div>
  </header>;
}

function Footer({ links }: { links: PublicLinks }) {
  return <footer className="public-footer">
    <div className="footer-brand"><FlywheelMark className="footer-mark" /><span><b>FLYWHEEL STRATEGY</b><small>CAPITAL IN MOTION</small></span></div>
    <div className="footer-links">
      <a href="/docs" target="_blank" rel="noreferrer">Documentation ↗</a>
      <a href="/governance" target="_blank" rel="noreferrer">Governance ↗</a>
      {links.github && <a href={links.github} target="_blank" rel="noreferrer">GitHub ↗</a>}
      {links.x && <a href={links.x} target="_blank" rel="noreferrer">X ↗</a>}
    </div>
  </footer>;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function scrollToPublicSection(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  const headerHeight = document.querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 0;
  const top = window.scrollY + target.getBoundingClientRect().top - headerHeight - 20;
  window.history.pushState(null, "", `#${id}`);
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function validRuntimeConfig(value: unknown): value is RuntimeConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<RuntimeConfig>;
  return config.network === "solana-mainnet-beta"
    && typeof config.projectMint === "string"
    && typeof config.mstrxMint === "string"
    && config.mstrxMint === solanaMainnet.mstrxMint
    && isSolanaPublicKey(config.projectMint)
    && isSolanaPublicKey(config.mstrxMint);
}

function useRuntimeData() {
  const [config, setConfig] = useState<RuntimeConfig>();
  const [history, setHistory] = useState<RewardHistoryEntry[]>([]);
  const [market, setMarket] = useState<MarketStatus>();
  const [heartbeats, setHeartbeats] = useState<Record<string, ServiceHeartbeat | undefined>>({});
  const [checkedAt, setCheckedAt] = useState(Date.now());

  useEffect(() => {
    void fetch("/config.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((value) => { if (validRuntimeConfig(value)) setConfig(value); })
      .catch(() => undefined);
    void fetch("/snapshots/history.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<RewardHistoryEntry[]> : Promise.reject())
      .then((value) => setHistory(value.slice(0, 10)))
      .catch(() => setHistory([]));
    void fetch("/status/market.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<MarketStatus> : Promise.reject())
      .then(setMarket)
      .catch(() => undefined);

    const services = ["solana-fee-keeper", "solana-holder-indexer", "solana-reward-publisher", "solana-distributor", "solana-governance-keeper"];
    void Promise.all(services.map(async (service) => {
      try {
        const response = await fetch(`/status/${service}.json`, { cache: "no-store" });
        return [service, response.ok ? await response.json() as ServiceHeartbeat : undefined] as const;
      } catch {
        return [service, undefined] as const;
      }
    })).then((entries) => { setHeartbeats(Object.fromEntries(entries)); setCheckedAt(Date.now()); });
  }, []);

  return { config, history, market, heartbeats, checkedAt };
}

function App() {
  const links = usePublicLinks();
  const { config, history, market, heartbeats, checkedAt } = useRuntimeData();
  const [rewardBalance, setRewardBalance] = useState("—");
  const [reserveBalance, setReserveBalance] = useState("—");
  const [mstrxMultiplier, setMstrxMultiplier] = useState(1);

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    const refresh = async () => {
      const hideBalances = () => {
        if (cancelled) return;
        setRewardBalance("—");
        setReserveBalance("—");
      };
      try {
        const response = await fetch("/snapshots/solana-vaults.json", { cache: "no-store" });
        if (!response.ok) { hideBalances(); return; }
        const snapshot = await response.json() as VaultSnapshot;
        if (cancelled) return;
        if (!Number.isFinite(snapshot.updatedAt) || Date.now() - snapshot.updatedAt > 300_000
          || !Number.isFinite(snapshot.multiplier) || snapshot.multiplier <= 0
          || typeof snapshot.holderDisplay !== "string" || typeof snapshot.reserveDisplay !== "string") {
          hideBalances();
          return;
        }
        setRewardBalance(snapshot.holderDisplay);
        setReserveBalance(snapshot.reserveDisplay);
        setMstrxMultiplier(snapshot.multiplier);
      } catch { hideBalances(); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [config]);

  const phase = market?.phase === "pumpswap" ? "PumpSwap" : market?.phase === "pump-curve" ? "Pump curve" : "Pre-launch";

  return <main>
    <Header links={links} />
    <section className="story-hero" id="top">
      <div className="hero-copy">
        <h1 className="hero-brand-title">FLYWHEEL<br /><span>STRATEGY</span></h1>
        <p className="hero-slogan">HOLD CAPITAL<br />ACCUMULATE MSTRx</p>
        <p className="hero-description">Pump.fun creator fees continuously build automatic MSTRx rewards for holders and a separate strategic reserve on Solana</p>
        <div className="hero-actions">
          <WalletMultiButton />
          <a href="#mechanics" onClick={(event) => scrollToPublicSection(event, "mechanics")}>See how it works ↓</a>
        </div>
      </div>
      <div className="hero-symbol" aria-hidden="true">
        <video className="bearing-visual" autoPlay muted loop playsInline preload="auto" poster="/visuals/header-3-wide-poster.webp">
          <source src="/visuals/header-3-wide.webm" type="video/webm" />
          <source src="/visuals/header-3-wide.mp4" type="video/mp4" />
        </video>
        <span>CAPITAL IN MOTION</span>
      </div>
      <div className="hero-mechanics" id="mechanics">
        <div className="mechanics-intro"><span>HOW IT WORKS</span><p>ONE LOOP · THREE MOVES</p></div>
        <div><SectionIcon kind="trade" /><b>01</b><strong>TRADE</strong><span>CAPITAL trades through Pump.fun and PumpSwap</span></div>
        <div><SectionIcon kind="convert" /><b>02</b><strong>ROUTE</strong><span>The fixed 2% creator fee arrives directly in MSTRx and splits 60/40</span></div>
        <div><SectionIcon kind="claim" /><b>03</b><strong>RECEIVE</strong><span>MSTRx is sent automatically by balance and exact hold time</span></div>
      </div>
    </section>

    <section className="claim-panel first-action" id="rewards">
      <div>
        <span className="section-number">YOUR PASSIVE REWARDS</span>
        <h2>AUTOMATIC MSTRx AIRDROPS</h2>
        <p>Eligible wallets receive funded MSTRx rewards directly · No claim and no wallet connection required</p>
      </div>
      <div className="claim-actions"><a href={solscanToken(solanaMainnet.mstrxMint)} target="_blank" rel="noreferrer">Official MSTRx ↗</a></div>
    </section>

    <section className="stats-grid">
      <Stat label="Reward vault" value={`${rewardBalance} MSTRx`} detail="Holder inventory only" />
      <Stat label="Strategic reserve" value={`${reserveBalance} MSTRx`} detail="Isolated from rewards" />
      <Stat label="Reward interval" value={`${(market?.intervalSeconds ?? 600) / 60} min`} detail={market ? `$${Math.round(market.marketCapUsd).toLocaleString()} market cap` : "Starts after launch"} />
      <Stat label="Market phase" value={phase} detail="Solana network fees funded separately" />
    </section>

    <section className="split">
      <article className="panel">
        <div className="panel-head"><div><span className="section-number">01</span><SectionIcon kind="flow" /><h2>Fee flow</h2></div><span className="pill">Actual project receipts</span></div>
        <div className="flow two-way-flow">
          <div><b>60%</b><span>Automatic holder MSTRx rewards</span></div>
          <div><b>40%</b><span>Strategic MSTRx reserve</span></div>
        </div>
        <div className="route">2% CREATOR FEE IN MSTRx <i>→</i> 60% HOLDERS <i>→</i> 40% RESERVE</div>
        <p className="lead">CAPITAL uses the official Pump.fun MSTRx custom pair · Native Pump holder rewards stay disabled so the project can route actual MSTRx receipts through its published 60/40 system</p>
      </article>

      <article className="panel">
        <div className="panel-head"><div><span className="section-number">02</span><SectionIcon kind="weight" /><h2>Holder weight</h2></div><span className="pill">No staking</span></div>
        <div className="formula">balance × exact hold time × loyalty</div>
        <div className="progress-row"><span>1 hour</span><div><i style={{ width: "4%" }} /></div><b>1.019×</b></div>
        <div className="progress-row"><span>24 hours</span><div><i style={{ width: "18%" }} /></div><b>1.091×</b></div>
        <div className="progress-row"><span>7 days</span><div><i style={{ width: "48%" }} /></div><b>1.242×</b></div>
        <div className="progress-row"><span>30 days</span><div><i style={{ width: "100%" }} /></div><b>1.500×</b></div>
      </article>
    </section>

    <section className="panel cadence-panel">
      <div className="panel-head"><div><span className="section-number">03</span><SectionIcon kind="cadence" /><h2>Market-cap cadence</h2></div><span className="pill">60m confirmation</span></div>
      <div className="cadence-grid">{cadence.map(([cap, interval], index) => <div className={(market?.cadence.confirmedLevel ?? 0) === index ? "active" : ""} key={cap}><span>{cap}</span><strong>{interval}</strong><small>{(market?.cadence.confirmedLevel ?? 0) === index ? "Current" : "Locks after confirmation"}</small></div>)}</div>
    </section>

    <section className="panel reward-history">
      <div className="panel-head"><div><span className="section-number">04</span><SectionIcon kind="history" /><h2>Reward history</h2></div><span className="pill">Last 10 finalized epochs</span></div>
      {history.length ? <div className="history-table">{history.map((epoch) => <div key={epoch.epoch}>
        <b>Epoch {epoch.epoch}</b>
        <span>{new Date(epoch.windowEnd * 1000).toLocaleString()}</span>
        <strong>{formatMstrxRaw(epoch.mstrxRewardRaw, mstrxMultiplier)} MSTRx total</strong>
        <a href={`/snapshots/epoch-${epoch.epoch}.json`} target="_blank" rel="noreferrer">JSON ↗</a>
        {epoch.signature && <a href={solscanTransaction(epoch.signature)} target="_blank" rel="noreferrer">TX ↗</a>}
      </div>)}</div> : <p className="lead">Verified epoch records will appear here after the Solana launch</p>}
    </section>

    <section className="panel operations">
      <div className="panel-head"><div><span className="section-number">05</span><SectionIcon kind="automation" /><h2>Automation status</h2></div><span className="pill">Public heartbeat</span></div>
      <div className="operations-grid">{[
        ["solana-fee-keeper", "Pump.fun MSTRx collection + exact 60/40 routing"],
        ["solana-reward-publisher", "Holder calculation + funded epoch"],
        ["solana-distributor", "Automatic MSTRx transfers"],
        ["solana-governance-keeper", "Automatic reserve execution"],
      ].map(([service, label]) => {
        const heartbeat = heartbeats[service];
        const healthy = Boolean(heartbeat?.ok && checkedAt - heartbeat.updatedAt < 120_000);
        return <div key={service} className={healthy ? "healthy" : "offline"}><span>{healthy ? "ONLINE" : heartbeat ? "STALE / ERROR" : "NOT STARTED"}</span><b>{label}</b><small>{heartbeat ? `Last signal: ${new Date(heartbeat.updatedAt).toLocaleString()}` : "Starts after deployment"}</small>{heartbeat?.error && <small className="service-error">{heartbeat.error}</small>}</div>;
      })}</div>
    </section>

    <section className="governance-callout">
      <div><span>06 · HOLDER GOVERNANCE</span><h2>RESERVE GOVERNANCE</h2><p>Voting is not active yet · Any reserve vote will require a reviewed Solana program and published rules</p></div>
      <a href="/governance" target="_blank" rel="noreferrer">Open governance ↗</a>
    </section>

    <section className="transparency" id="transparency">
      <span>PUBLIC BY DEFAULT</span>
      <h2>MSTRx fee sweeps, 60/40 allocations and payout batches will be publicly traceable after launch</h2>
      <p>{config ? "Every live Solana address links directly to the public explorer" : "The final mint and program addresses will appear here after the verified Pump.fun launch"}</p>
      <div className="project-contract-card"><span>CAPITAL TOKEN MINT</span>{config ? <a href={solscanToken(config.projectMint)} target="_blank" rel="noreferrer">{config.projectMint} ↗</a> : <b>PUBLISHED HERE AFTER MAINNET LAUNCH</b>}</div>
      {config && <div className="address-grid">{[
        ["Creator-fee recipient", config.creatorFeeRecipient],
        ["Reward vault", config.rewardVaultTokenAccount],
        ["Strategic reserve", config.reserveVaultTokenAccount],
        ["Strategy program", config.strategyProgram],
        ["Governance program", config.governanceProgram],
        ["Marketing wallet", config.marketingWallet],
      ].filter((entry): entry is [string, string] => Boolean(entry[1])).map(([label, address]) => <a key={label} href={solscanAccount(address)} target="_blank" rel="noreferrer"><b>{label}</b><span>{shortPublicKey(address)} ↗</span></a>)}</div>}
      <a className="docs-link" href="/docs" target="_blank" rel="noreferrer">Open full documentation ↗</a>
    </section>
    <Footer links={links} />
  </main>;
}

function plainText(text: string) {
  return text.trim().replace(/\.$/, "");
}

function headingId(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function inlineMarkdown(text: string) {
  return plainText(text).split(/(`[^`]+`)/g).map((part, index) => part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : <React.Fragment key={index}>{part}</React.Fragment>);
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
      const text = plainText(heading[2]);
      const id = headingId(text);
      blocks.push(heading[1].length === 1 ? <h1 id={id} key={index}>{text}</h1> : heading[1].length === 2 ? <h2 id={id} key={index}>{text}</h2> : <h3 id={id} key={index}>{text}</h3>);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) { items.push(lines[index].trim().replace(/^[-*]\s+/, "")); index += 1; }
      blocks.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) { items.push(lines[index].trim().replace(/^\d+\.\s+/, "")); index += 1; }
      blocks.push(<ol key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || /^(#{1,3})\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+\.\s+/.test(next)) break;
      paragraph.push(next); index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{inlineMarkdown(paragraph.join(" "))}</p>);
  }
  return blocks;
}

function DocumentationPage() {
  const links = usePublicLinks();
  const [markdown, setMarkdown] = useState("");
  useEffect(() => {
    document.title = "DOCUMENTATION — FLYWHEEL STRATEGY";
    void fetch("/technical-specification.md", { cache: "no-store" }).then((response) => response.ok ? response.text() : Promise.reject()).then(setMarkdown).catch(() => setMarkdown("# Documentation unavailable"));
  }, []);
  const headings = markdown.split(/\r?\n/).map((line) => /^##\s+(.+)$/.exec(line.trim())?.[1]).filter((heading): heading is string => Boolean(heading));
  return <main className="docs-page"><Header links={links} docs /><section className="subpage-hero docs-hero"><span>PUBLIC DOCUMENTATION</span><h1>HOW THE SOLANA FLYWHEEL WORKS</h1><p>Pump.fun fees, MSTRx rewards, holder weight, governance and every important rule in one place</p></section><div className="docs-layout"><aside><b>CONTENTS</b>{headings.map((heading) => <a href={`#${headingId(heading)}`} key={heading}>{plainText(heading)}</a>)}</aside><article className="documentation-body">{markdown ? renderDocumentation(markdown) : <p>Loading documentation</p>}</article></div><Footer links={links} /></main>;
}

function GovernancePage() {
  const links = usePublicLinks();
  return <main><Header links={links} /><section className="subpage-hero governance-hero"><span>SOLANA HOLDER GOVERNANCE</span><h1>RESERVE GOVERNANCE</h1><p>Voting is not active · Rules and the restricted execution program will be published after independent review</p></section><section className="panel governance governance-page-panel"><div className="panel-head"><div><span className="section-number">NOT ACTIVE</span><h2>No active proposal</h2></div><span className="pill">NOT STARTED</span></div><div className="option-grid">{governanceActions.map(([title, detail], index) => <div key={title}><span>0{index + 1}</span><b>{title}</b><small>{detail}</small></div>)}</div><footer><span>Illustrative reserve actions only</span><span>Voting and execution remain disabled until the reviewed program is deployed</span></footer></section><Footer links={links} /></main>;
}

const SolanaAdminPanel = lazy(() => import("./solanaAdmin").then((module) => ({ default: module.SolanaAdminPanel })));

function Root() {
  const endpoint = useMemo(() => solanaMainnet.rpcUrl, []);
  const content = window.__FLYWHEEL_ADMIN__ === true
    ? <Suspense fallback={<main style={{ padding: 32 }}>Загрузка панели…</main>}><SolanaAdminPanel /></Suspense>
    : window.location.pathname.startsWith("/docs")
      ? <DocumentationPage />
      : window.location.pathname.startsWith("/governance")
        ? <GovernancePage />
        : <App />;
  return <ConnectionProvider endpoint={endpoint}><WalletProvider wallets={[]} autoConnect><WalletModalProvider>{content}</WalletModalProvider></WalletProvider></ConnectionProvider>;
}

createRoot(document.getElementById("root")!).render(<Root />);
