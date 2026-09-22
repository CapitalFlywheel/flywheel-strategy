import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import "./admin.css";

interface SolanaAdminStatus {
  network: "solana-mainnet-beta";
  owner?: string;
  automationState: "running" | "stopped" | "unknown";
  launch: { configured: boolean; armed: boolean; armedAt?: number; detectedMint?: string; activated: boolean };
  services: Record<string, { ok: boolean; updatedAt: number; detail?: string }>;
  balances: { creatorMstrxRaw?: string; holderMstrxRaw?: string; reserveMstrxRaw?: string };
  updatedAt: number;
}

interface Challenge { id: string; action: string; message: string; expiresAt: number; owner: string }

const actionGroups = [
  {
    title: "Launch control",
    actions: [
      ["verify_launch_config", "Verify launch configuration", "Checks creator key, MSTRx custom pair, Token-2022 extensions and RPC consensus"],
      ["arm_launch_detection", "Arm automatic Pump.fun launch", "One pre-launch signature watches the approved creator, verifies one exact mint and activates it automatically"],
      ["disarm_launch_detection", "Disarm detection", "Stops launch discovery without changing any balances"],
      ["activate_postlaunch", "Emergency manual activation", "Fallback only when automatic activation was interrupted after the verified mint was detected"],
    ],
  },
  {
    title: "Fee custody",
    actions: [
      ["sweep_curve_fees", "Route bonding-curve fees", "Collects the fixed 2% MSTRx creator fee and allocates only the confirmed receipt delta 60/40"],
      ["sweep_pumpswap_fees", "Route PumpSwap fees", "Collects post-graduation MSTRx creator fees and applies the same exact 60/40 split"],
      ["pause_conversions", "Pause fee routing", "Stops new fee routing and new reward commitments immediately"],
      ["resume_conversions", "Resume fee routing", "Resumes only after configuration and RPC checks pass"],
      ["recover_uncommitted", "Recover uncommitted MSTRx", "Moves only MSTRx still held by the creator wallet and not assigned to an epoch"],
    ],
  },
  {
    title: "Rewards and reserve",
    actions: [
      ["prepare_reward_epoch", "Prepare reward epoch", "Calculates holders and proves exact funded conservation"],
      ["distribute_reward_epoch", "Distribute reward epoch", "Runs idempotent automatic MSTRx batches with no claim"],
      ["finalize_reward_epoch", "Finalize reward epoch", "Closes only after every batch and raw MSTRx unit reconcile"],
    ],
  },
] as const;

function short(value?: string) {
  return value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "NOT SET";
}

export function SolanaAdminPanel() {
  const wallet = useWallet();
  const [status, setStatus] = useState<SolanaAdminStatus>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState("Connect the configured owner wallet to authorize an action");

  const refresh = useCallback(async () => {
    const response = await fetch("/admin/api/solana/status", { cache: "no-store" });
    if (!response.ok) throw new Error("STATUS_UNAVAILABLE");
    setStatus(await response.json() as SolanaAdminStatus);
  }, []);

  useEffect(() => { void refresh().catch(() => setNotice("Solana control API is not configured on this environment")); }, [refresh]);

  const authorized = useMemo(() => Boolean(
    wallet.publicKey && status?.owner && wallet.publicKey.toBase58() === status.owner && wallet.signMessage,
  ), [wallet.publicKey, wallet.signMessage, status?.owner]);

  async function runAction(action: string) {
    if (!authorized || !wallet.publicKey || !wallet.signMessage) return;
    setBusy(action);
    setNotice("Preparing exact action challenge");
    try {
      const challengeResponse = await fetch("/admin/api/solana/challenge", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
      });
      const challenge = await challengeResponse.json() as Challenge & { error?: string };
      if (!challengeResponse.ok) throw new Error(challenge.error || "CHALLENGE_FAILED");
      const signed = await wallet.signMessage(new TextEncoder().encode(challenge.message));
      const response = await fetch("/admin/api/solana/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.id, signer: wallet.publicKey.toBase58(), signature: bs58.encode(signed) }),
      });
      const result = await response.json() as { requestId?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "ACTION_FAILED");
      setNotice(`Queued ${action} · ${result.requestId}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ACTION_FAILED");
    } finally {
      setBusy(undefined);
    }
  }

  const services = Object.entries(status?.services ?? {});
  return <main className="admin-shell">
    <header className="admin-topbar">
      <a className="admin-brand" href="/"><span>FS</span><b>FLYWHEEL STRATEGY · SOLANA CONTROL</b></a>
      <div className={`admin-system-state is-${status?.automationState ?? "unknown"}`}><i />{status?.automationState?.toUpperCase() ?? "UNKNOWN"}</div>
      <WalletMultiButton className="admin-wallet-button" />
    </header>

    <section className="admin-heading">
      <div><span className="admin-kicker">PRIVATE OWNER PANEL</span><h1>SOLANA OPERATIONS</h1><p>One explicit authorization per action · No arbitrary transactions · 60% holders · 40% reserve</p></div>
      <div className={`admin-owner-card ${authorized ? "confirmed" : ""}`}><span>{authorized ? "OWNER VERIFIED" : "OWNER NOT VERIFIED"}</span><b>{short(status?.owner)}</b><small>{wallet.publicKey ? short(wallet.publicKey.toBase58()) : "Connect the owner wallet"}</small></div>
    </section>

    <section className="admin-grid">
      <article className="admin-primary-card">
        <div className="admin-card-head"><div><span>LIVE CONTROL STATE</span><h2>Launch and automation</h2></div><b className={status?.launch.activated ? "green" : "amber"}>{status?.launch.activated ? "ACTIVE" : "PRE-LAUNCH"}</b></div>
        <div className="admin-services">{services.length ? services.map(([name, service]) => <div key={name}><i className={service.ok ? "online" : "offline"} /><span><b>{name}</b><small>{service.updatedAt ? new Date(service.updatedAt).toLocaleString() : "No heartbeat"}</small></span></div>) : <div><i className="offline" /><span><b>Services not started</b><small>Production credentials are not installed</small></span></div>}</div>
        <p className="admin-note">{notice}</p>
      </article>
      <aside className="admin-health-card"><span>READINESS</span><strong>{status?.launch.activated ? "LIVE" : status?.launch.configured ? "CONFIGURED" : "BLOCKED"}</strong><ul><li className={status?.launch.configured ? "done" : ""}>Launch configuration</li><li className={status?.owner ? "done" : ""}>Owner public key</li><li className={status?.launch.armed ? "done" : ""}>Automatic detector armed</li><li className={status?.launch.detectedMint ? "done" : ""}>Detected Pump.fun mint</li><li className={status?.launch.activated ? "done" : ""}>Automatic activation</li></ul><small>Updated {status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : "never"}</small></aside>
    </section>

    {actionGroups.map((group) => <section className="admin-launch-flow" key={group.title}>
      <div className="admin-card-head"><div><span>EXPLICIT ACTIONS</span><h2>{group.title}</h2></div><b>{authorized ? "OWNER READY" : "LOCKED"}</b></div>
      <div className="solana-action-grid">{group.actions.map(([action, label, detail]) => <article key={action}><div><b>{label}</b><small>{detail}</small></div><button disabled={!authorized || Boolean(busy)} onClick={() => void runAction(action)}>{busy === action ? "SIGNING…" : "AUTHORIZE"}</button></article>)}</div>
    </section>)}

    <section className="admin-addresses">
      <div><span>OWNER</span><b>{status?.owner ?? "NOT SET"}</b></div>
      <div><span>DETECTED MINT</span><b>{status?.launch.detectedMint ?? "NOT DETECTED"}</b></div>
      <div><span>CREATOR MSTRx RAW</span><b>{status?.balances.creatorMstrxRaw ?? "0"}</b></div>
      <div><span>HOLDER MSTRx RAW</span><b>{status?.balances.holderMstrxRaw ?? "0"}</b></div>
      <div><span>RESERVE MSTRx RAW</span><b>{status?.balances.reserveMstrxRaw ?? "0"}</b></div>
    </section>
  </main>;
}
