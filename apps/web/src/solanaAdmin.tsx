import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { BaseWalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { canCreateOwnerProposal, canExecuteOwnerBuyback, canExecuteOwnerMarketingSale,
  canExecuteOwnerMstrxLock, canFinalizeOwnerVote, canPublishOwnerSnapshot, canRequestOwnerLockRelease,
  hasRecentVerifiedReserve,
  matchesFinalizeOwnerChallenge, matchesProposalOwnerChallenge, matchesSnapshotOwnerChallenge,
  matchesMstrxLockOwnerChallenge, matchesBuybackOwnerChallenge, matchesMarketingSaleOwnerChallenge,
  matchesOwnerLockReleaseChallenge,
  normalizeOwnerProposalPreviewRequest, ownerActionDrafts, verifiedOwnerProposal,
  verifiedOwnerProposalPreview, type OwnerProposalPreview, type OwnerProposalPreviewMode,
  type OwnerProposalPreviewRequest,
  type OwnerProposalStatus, type ReserveOutcome } from "./governanceAdminClient";
import "./admin.css";

export { hasRecentVerifiedReserve } from "./governanceAdminClient";

interface SolanaAdminStatus {
  network: "solana-mainnet-beta";
  owner?: string;
  reserveWallet?: string;
  finalizeVoteReleased?: boolean;
  proposalControlReleased?: boolean;
  automationState: "running" | "stopped" | "unknown";
  launch: { configured: boolean; executionReleased?: boolean; armed: boolean; armedAt?: number; detectedMint?: string; governanceBindState?: "pending" | "bound"; activated: boolean };
  services: Record<string, { ok: boolean; updatedAt: number; detail?: string }>;
  balances: { creatorMstrxRaw?: string; holderMstrxRaw?: string; reserveMstrxRaw?: string };
  governance?: {
    program: string;
    programCodeSha256: string;
    reserveMint: string;
    capitalTokenProgram: string;
    withdrawalReleased: boolean;
    vaultTokenAccount: string;
    boundCapitalMint: string | null;
    vaultBalanceRaw: string;
    committedRaw: string;
    freeRaw: string;
    lastProposalId: string;
    activeProposalId: string;
    updatedAt: number;
  };
  governanceWithdrawal?: { requestId: string; amountRaw: string; signature: string; state: string; updatedAt: number };
  governanceFinalization?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceCreation?: { requestId: string; proposalId: string; mode: string; signature: string; state: string; updatedAt: number };
  governanceLockExecution?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceBuybackExecution?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceMarketingExecution?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceLockRelease?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceSnapshot?: { proposalId: string; merkleRoot: string; totalAvailableWeight: string;
    sourceSha256: string; snapshotSha256: string; publishedAtUnix: number; reused: boolean; updatedAt: number };
  governanceProposal?: OwnerProposalStatus;
  offchainBallot?: { id: string; startsAt: number; endsAt: number; reserveRawMstrx: string; updatedAt: number };
  updatedAt: number;
}

interface Challenge { id: string; action: string; message: string; expiresAt: number; owner: string }
interface PendingAction { requestId: string; action: string }
interface ActionOutcome { requestId: string; state: "queued" | "processed" | "failed" }

const pendingStorageKey = "flywheel-solana-pending-action";

function storedPendingAction(): PendingAction | undefined {
  try {
    const value = sessionStorage.getItem(pendingStorageKey);
    if (!value) return;
    const parsed = JSON.parse(value) as PendingAction;
    if (/^\d+-[a-f0-9]{16}$/.test(parsed.requestId) && typeof parsed.action === "string") return parsed;
  } catch {
    // An invalid browser-local progress record is not an authorization source
  }
}

function savePendingAction(value: PendingAction | undefined) {
  try {
    if (value) sessionStorage.setItem(pendingStorageKey, JSON.stringify(value));
    else sessionStorage.removeItem(pendingStorageKey);
  } catch {
    // Tracking remains live in React state when browser storage is unavailable
  }
}

// Binding reserve voting is not part of this owner-wallet launch route.
const optionalGovernanceEnabled = false;

const walletLabels = {
  "change-wallet": "Сменить кошелёк",
  connecting: "Подключение…",
  "copy-address": "Скопировать адрес",
  copied: "Скопировано",
  disconnect: "Отключить",
  "has-wallet": "Подключить",
  "no-wallet": "Выбрать кошелёк",
};

const serviceLabels: Record<string, string> = {
  "solana-launch-detector": "Детектор токена",
  "solana-fee-keeper": "Сбор и распределение комиссий",
  "solana-distributor": "Рассылка наград",
  "solana-owed-reward-retry": "Повторная отправка наград",
  "solana-public-snapshot": "Публичные данные",
};

function actionLabel(action: string) {
  for (const group of actionGroups) {
    for (const [key, label] of group.actions) {
      if (key === action) return label;
    }
  }
  return action;
}

const actionGroups = [
  {
    title: "Запуск токена",
    actions: [
      ["arm_launch_detection", "Проверить и включить детектор токена", "Одна подпись владельца проверяет настройки · После создания токена детектор найдёт его и включит автоматизацию"],
      ["disarm_launch_detection", "Выключить детектор", "Останавливает поиск токена, не меняя балансы"],
      ["activate_postlaunch", "Повторить активацию", "Проверяет создание токена через два RPC и повторяет активацию, если она прервалась"],
    ],
  },
  {
    title: "Комиссии",
    actions: [
      ["sweep_curve_fees", "Собрать комиссии Pump", "Собирает полученные MSTRx и направляет 60% холдерам, 40% в резерв"],
      ["sweep_pumpswap_fees", "Собрать комиссии PumpSwap", "После миграции применяет то же распределение 60/40"],
      ["pause_conversions", "Приостановить сбор комиссий", "Останавливает новые операции · Уже отправленные транзакции могут завершиться"],
      ["reconcile_fee_receipts", "Проверить незавершённую операцию", "Сверяет ранее отправленную транзакцию, не начиная новую"],
      ["resume_conversions", "Возобновить сбор комиссий", "Возобновляет работу после проверки конфигурации и RPC"],
      ["recover_uncommitted", "Вернуть нераспределённые MSTRx", "Возвращает только собранные MSTRx, ещё не отправленные холдерам или в резерв"],
    ],
  },
  {
    title: "Награды холдерам",
    actions: [
      ["prepare_reward_epoch", "Подготовить период наград", "Рассчитывает доли холдеров и сверяет доступные MSTRx"],
      ["distribute_reward_epoch", "Разослать награды", "Отправляет MSTRx холдерам без клейма на сайте"],
      ["finalize_reward_epoch", "Закрыть период наград", "Закрывает период только после сверки всех отправок и баланса"],
    ],
  },
  {
    title: "Голосование холдеров",
    actions: [
      ["start_offchain_ballot", "Открыть голосование", "Одна подпись публикует снимок холдеров и голосование · Холдеры подписывают выбор без транзакции"],
    ],
  },
] as const;

// Each released reserve action has its own exact server command. Unreviewed
// outcomes remain inert; no arbitrary transaction payload enters this UI.

const governanceBallotOptions = [
  ["ACCUMULATE", "No swap · A winning result releases the frozen MSTRx to free reserve at finalization"],
  ["BUYBACK_HOLD", "Spend all voted MSTRx on CAPITAL and place the purchased tokens in permanent public custody"],
  ["BUYBACK_BURN", "Spend all voted MSTRx on CAPITAL and burn the purchased tokens in the same transaction"],
  ["BUYBACK_LOCK", "Spend all voted MSTRx on CAPITAL and lock the purchased tokens for the voted term"],
  ["LOCK_MSTRX", "Lock the full voted MSTRx amount for the selected finite or permanent term"],
  ["MARKETING_SALE", "Sell all voted MSTRx for SOL and send actual proceeds to the fixed disclosed marketing address"],
] as const;

export function governanceProposalStatusLabel(status?: number): string {
  switch (status) {
    case 0: return "INITIAL BALLOT ACTIVE";
    case 1: return "PASSED · AWAITING EXECUTION";
    case 2: return "NO QUORUM · RELEASED";
    case 3: return "TIE · RELEASED";
    case 4: return "EXECUTED";
    case 5: return "SUPERSEDED BY RE-VOTE";
    case 6: return "RE-VOTE ACTIVE";
    case 7: return "RE-VOTE NO QUORUM · FROZEN";
    case 8: return "RE-VOTE TIE · FROZEN";
    default: return "UNVERIFIED";
  }
}

export function adminReadinessLabel(status?: SolanaAdminStatus): "LIVE" | "CONFIGURED" | "BLOCKED" {
  if (status?.launch.executionReleased !== true) return "BLOCKED";
  return status.launch.activated ? "LIVE" : status.launch.configured ? "CONFIGURED" : "BLOCKED";
}

export function governanceLifecycleReadout(status: SolanaAdminStatus | undefined, now: number) {
  const proposal = verifiedOwnerProposal(status, now);
  if (!proposal) return {
    proposal: "NO RECENT PROPOSAL STATUS",
    ballot: "UNVERIFIED",
    result: "UNVERIFIED",
    execution: "UNVERIFIED",
  };
  return {
    proposal: `#${proposal.id} · ${governanceProposalStatusLabel(proposal.status)}`,
    ballot: [0, 6].includes(proposal.status)
      ? now < proposal.startsAt * 1_000 ? "SCHEDULED · NOT OPEN"
        : now < proposal.endsAt * 1_000 ? "OPEN" : "CLOSED · AWAITING FINALIZATION"
      : "CLOSED",
    result: [0, 6].includes(proposal.status) ? "NOT FINALIZED" : "FINALIZED",
    execution: proposal.status === 4 ? "EXECUTED" : proposal.status === 1 ? "COMMITTED · NOT EXECUTED"
      : [7, 8].includes(proposal.status) ? "FROZEN · RE-VOTE REQUIRED"
        : proposal.status === 5 ? "SUPERSEDED" : "NO SPENDING EXECUTION",
  };
}

function short(value?: string) {
  return value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "НЕ УКАЗАН";
}

export function SolanaAdminPanel() {
  const wallet = useWallet();
  const [status, setStatus] = useState<SolanaAdminStatus>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState("Подключи кошелёк владельца, чтобы подписывать действия");
  const [pendingAction, setPendingAction] = useState<PendingAction | undefined>(storedPendingAction);
  const [withdrawAmountRaw, setWithdrawAmountRaw] = useState("");
  const [releaseProposalId, setReleaseProposalId] = useState("");
  const [offchainDurationHours, setOffchainDurationHours] = useState(3);
  const [proposalMode, setProposalMode] = useState<OwnerProposalPreviewMode>("initial");
  const [proposalDurationHours, setProposalDurationHours] = useState(1);
  const [proposalSelected, setProposalSelected] = useState<ReserveOutcome[]>(["ACCUMULATE"]);
  const [proposalMinimums, setProposalMinimums] = useState<Partial<Record<ReserveOutcome, string>>>({});
  const [proposalLockTerms, setProposalLockTerms] = useState<Partial<Record<ReserveOutcome, number>>>({
    BUYBACK_LOCK: 30 * 86_400, LOCK_MSTRX: 30 * 86_400,
  });
  const [proposalPreview, setProposalPreview] = useState<OwnerProposalPreview>();
  const [proposalPreviewRequest, setProposalPreviewRequest] = useState<OwnerProposalPreviewRequest>();
  const [proposalPreviewError, setProposalPreviewError] = useState<string>();
  const [proposalPreviewBusy, setProposalPreviewBusy] = useState(false);
  const apiRoot = window.__FLYWHEEL_ADMIN_API__;

  const refresh = useCallback(async () => {
    try {
      if (!apiRoot) throw new Error("ADMIN_API_UNAVAILABLE");
      const response = await fetch(`${apiRoot}/solana/status`, { cache: "no-store" });
      if (!response.ok) throw new Error("STATUS_UNAVAILABLE");
      const next = await response.json() as SolanaAdminStatus;
      if (next.network !== "solana-mainnet-beta" || !next.launch
        || typeof next.launch.configured !== "boolean" || typeof next.launch.activated !== "boolean"
        || typeof next.launch.armed !== "boolean" || !next.services || !next.balances) {
        throw new Error("STATUS_INVALID");
      }
      setStatus(next);
    } catch (error) {
      // A failed poll must not leave an old LIVE badge or reserve quote visible.
      setStatus(undefined);
      throw error;
    }
  }, [apiRoot]);

  useEffect(() => {
    void refresh().catch(() => setNotice("Сервис управления Solana недоступен"));
    const timer = window.setInterval(() => void refresh().catch(() => setNotice("Нет связи с сервисом управления · Действия заблокированы до восстановления связи")), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!apiRoot || !pendingAction) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${apiRoot}/solana/request/${pendingAction.requestId}`, { cache: "no-store" });
        if (!response.ok) throw new Error("REQUEST_STATUS_UNAVAILABLE");
        const outcome = await response.json() as ActionOutcome;
        if (cancelled || outcome.requestId !== pendingAction.requestId) return;
        if (outcome.state === "queued") {
          setNotice(`В очереди: ${actionLabel(pendingAction.action)} · ${pendingAction.requestId} · Ждём ответ сервера`);
          return;
        }
        savePendingAction(undefined);
        setPendingAction(undefined);
        setNotice(outcome.state === "processed"
          ? `Обработано: ${actionLabel(pendingAction.action)} · ${pendingAction.requestId} · Проверь статус: транзакция ещё может подтверждаться`
          : `Ошибка: ${actionLabel(pendingAction.action)} · ${pendingAction.requestId} · Проверь статус и транзакции перед повтором`);
        void refresh().catch(() => undefined);
      } catch {
        if (!cancelled) setNotice(`Проверяем: ${actionLabel(pendingAction.action)} · ${pendingAction.requestId} · Пока не отправляй повторно`);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [apiRoot, pendingAction, refresh]);

  const authorized = useMemo(() => Boolean(
    wallet.publicKey && status?.owner && wallet.publicKey.toBase58() === status.owner && wallet.signMessage,
  ), [wallet.publicKey, wallet.signMessage, status?.owner]);

  async function runAction(action: string) {
    if (!authorized || !wallet.publicKey || !wallet.signMessage) return;
    const finalizeProposal = action === "finalize_vote" && canFinalizeOwnerVote(status, Date.now())
      ? verifiedOwnerProposal(status, Date.now()) : undefined;
    if (action === "finalize_vote" && !finalizeProposal) {
      setNotice("FINALIZATION_NOT_RELEASED_OR_UNVERIFIED");
      return;
    }
    const isProposalCreation = action === "create_proposal" || action === "create_revote";
    if (isProposalCreation && (!canCreateOwnerProposal(status, proposalPreview, proposalPreviewRequest, Date.now())
      || proposalPreviewRequest?.mode !== (action === "create_proposal" ? "initial" : "revote"))) {
      setNotice("GOVERNANCE_PROPOSAL_NOT_RELEASED_OR_UNVERIFIED");
      return;
    }
    if (action === "publish_snapshot" && !canPublishOwnerSnapshot(status, Date.now())) {
      setNotice("GOVERNANCE_SNAPSHOT_NOT_RELEASED_OR_UNVERIFIED");
      return;
    }
    if (action === "execute_lock_mstrx" && !canExecuteOwnerMstrxLock(status, Date.now())) {
      setNotice("GOVERNANCE_LOCK_NOT_RELEASED_OR_UNVERIFIED");
      return;
    }
    if (action === "execute_buyback" && !canExecuteOwnerBuyback(status, Date.now())) {
      setNotice("GOVERNANCE_BUYBACK_NOT_RELEASED_OR_UNVERIFIED");
      return;
    }
    if (action === "execute_marketing_sale" && !canExecuteOwnerMarketingSale(status, Date.now())) {
      setNotice("GOVERNANCE_MARKETING_NOT_RELEASED_OR_UNVERIFIED");
      return;
    }
    if (action === "release_lock_mstrx" && !canRequestOwnerLockRelease(status, releaseProposalId, Date.now())) {
      setNotice("GOVERNANCE_LOCK_RELEASE_NOT_RELEASED_OR_UNVERIFIED");
      return;
    }
    setBusy(action);
    setNotice("Готовим точный запрос на подпись");
    try {
      if (!apiRoot) throw new Error("ADMIN_API_UNAVAILABLE");
      const challengeResponse = await fetch(`${apiRoot}/solana/challenge`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "withdraw_free_reserve" ? { action, amountRaw: withdrawAmountRaw }
          : isProposalCreation ? { action, proposalRequest: proposalPreviewRequest,
            previewHash: proposalPreview!.previewHash, previewAuditedAtUnix: proposalPreview!.auditedAtUnix }
            : action === "release_lock_mstrx" ? { action, releaseProposalId }
            : action === "start_offchain_ballot" ? { action, durationHours: offchainDurationHours }
            : { action }),
      });
      const challenge = await challengeResponse.json() as Challenge & { error?: string;
        offchainBallot?: { capitalMint: string; reserveWallet: string; reserveRawMstrx: string;
          durationHours: number; options: string[] } };
      if (!challengeResponse.ok) throw new Error(challenge.error || "CHALLENGE_FAILED");
      if (action === "withdraw_free_reserve" && !challenge.message.includes(`Exact raw MSTRx: ${withdrawAmountRaw}\n`)) {
        throw new Error("WITHDRAWAL_CHALLENGE_AMOUNT_MISMATCH");
      }
      if (action === "start_offchain_ballot" && (!challenge.offchainBallot || !status?.launch.detectedMint
        || challenge.offchainBallot.capitalMint !== status.launch.detectedMint
        || challenge.offchainBallot.reserveWallet !== status.reserveWallet
        || challenge.offchainBallot.reserveRawMstrx !== status.balances.reserveMstrxRaw
        || challenge.offchainBallot.durationHours !== offchainDurationHours
        || challenge.offchainBallot.options.join(",") !== governanceBallotOptions.map(([name]) => name).join(",")
        || !challenge.message.includes(`Reserve at proposal: ${challenge.offchainBallot.reserveRawMstrx} raw MSTRx\n`))) {
        throw new Error("OFFCHAIN_BALLOT_CHALLENGE_MISMATCH");
      }
      if (finalizeProposal && !matchesFinalizeOwnerChallenge(challenge.message, status, Date.now())) {
        throw new Error("GOVERNANCE_FINALIZE_CHALLENGE_MISMATCH");
      }
      if (isProposalCreation && !matchesProposalOwnerChallenge(challenge.message, status,
        proposalPreview, proposalPreviewRequest, Date.now())) {
        throw new Error("GOVERNANCE_PROPOSAL_CHALLENGE_MISMATCH");
      }
      if (action === "publish_snapshot" && !matchesSnapshotOwnerChallenge(challenge.message, status, Date.now())) {
        throw new Error("GOVERNANCE_SNAPSHOT_CHALLENGE_MISMATCH");
      }
      if (action === "execute_lock_mstrx" && !matchesMstrxLockOwnerChallenge(challenge.message, status, Date.now())) {
        throw new Error("GOVERNANCE_LOCK_CHALLENGE_MISMATCH");
      }
      if (action === "execute_buyback" && !matchesBuybackOwnerChallenge(challenge.message, status, Date.now())) {
        throw new Error("GOVERNANCE_BUYBACK_CHALLENGE_MISMATCH");
      }
      if (action === "execute_marketing_sale" && !matchesMarketingSaleOwnerChallenge(challenge.message, status, Date.now())) {
        throw new Error("GOVERNANCE_MARKETING_CHALLENGE_MISMATCH");
      }
      if (action === "release_lock_mstrx" && !matchesOwnerLockReleaseChallenge(challenge.message,
        status, releaseProposalId, Date.now())) {
        throw new Error("GOVERNANCE_LOCK_RELEASE_CHALLENGE_MISMATCH");
      }
      const signed = await wallet.signMessage(new TextEncoder().encode(challenge.message));
      const response = await fetch(`${apiRoot}/solana/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.id, signer: wallet.publicKey.toBase58(), signature: bs58.encode(signed) }),
      });
      const result = await response.json() as { requestId?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "ACTION_FAILED");
      if (!result.requestId || !/^\d+-[a-f0-9]{16}$/.test(result.requestId)) throw new Error("REQUEST_ID_INVALID");
      const pending = { requestId: result.requestId, action };
      savePendingAction(pending);
      setPendingAction(pending);
      if (isProposalCreation || action === "publish_snapshot") clearProposalPreview();
      setNotice(`В очереди: ${actionLabel(action)} · ${result.requestId} · Ждём ответ сервера`);
      await refresh();
    } catch (error) {
      setNotice(`Действие не выполнено · ${error instanceof Error ? error.message : "Неизвестная ошибка"}`);
    } finally {
      setBusy(undefined);
    }
  }

  async function previewProposal() {
    setProposalPreview(undefined);
    setProposalPreviewRequest(undefined);
    setProposalPreviewError(undefined);
    setProposalPreviewBusy(true);
    try {
      if (!apiRoot) throw new Error("ADMIN_API_UNAVAILABLE");
      const input = normalizeOwnerProposalPreviewRequest({
        mode: proposalMode, durationHours: proposalDurationHours,
        selected: proposalSelected, minimums: proposalMinimums, lockTerms: proposalLockTerms,
      });
      const response = await fetch(`${apiRoot}/solana/governance-proposal-preview`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json() as OwnerProposalPreview & { error?: string };
      if (!response.ok) throw new Error(body.error || "PROPOSAL_PREVIEW_UNAVAILABLE");
      const verified = verifiedOwnerProposalPreview(body, input);
      if (!verified) throw new Error("PROPOSAL_PREVIEW_RESPONSE_INVALID");
      setProposalPreview(verified);
      setProposalPreviewRequest(input);
    } catch (error) {
      setProposalPreviewError(error instanceof Error ? error.message : "PROPOSAL_PREVIEW_UNAVAILABLE");
    } finally {
      setProposalPreviewBusy(false);
    }
  }

  function clearProposalPreview() {
    setProposalPreview(undefined);
    setProposalPreviewRequest(undefined);
    setProposalPreviewError(undefined);
  }

  const now = Date.now();
  const services = Object.entries(status?.services ?? {});
  const executionReleased = status?.launch.executionReleased === true;
  const governance = status?.governance;
  const governanceFresh = hasRecentVerifiedReserve(status, now);
  const proposalReadout = governanceLifecycleReadout(status, now);
  const proposal = verifiedOwnerProposal(status, now);
  const ownerActions = ownerActionDrafts(status, now);
  const finalizeReady = canFinalizeOwnerVote(status, now);
  const lockExecutionReady = canExecuteOwnerMstrxLock(status, now);
  const buybackExecutionReady = canExecuteOwnerBuyback(status, now);
  const marketingExecutionReady = canExecuteOwnerMarketingSale(status, now);
  const lockReleaseRequestReady = canRequestOwnerLockRelease(status, releaseProposalId, now);
  const withdrawalPending = ["prepared", "pending", "unresolved"].includes(status?.governanceWithdrawal?.state ?? "");
  const withdrawalAmountValid = /^\d{1,20}$/.test(withdrawAmountRaw) && BigInt(withdrawAmountRaw || "0") > 0n
    && governanceFresh && /^\d+$/.test(governance?.freeRaw ?? "")
    && BigInt(withdrawAmountRaw || "0") <= BigInt(governance?.freeRaw ?? "0");
  const proposedFrozen = ownerActions.find((action) => action.key === proposalMode)?.exactRaw;
  const proposalCreateReady = canCreateOwnerProposal(status, proposalPreview, proposalPreviewRequest, now);
  const automationStateLabel = !executionReleased ? "ДЕЙСТВИЯ НЕДОСТУПНЫ"
    : status?.automationState === "running" ? "РАБОТАЕТ"
      : status?.automationState === "stopped" ? "ОСТАНОВЛЕНО" : "СТАТУС НЕИЗВЕСТЕН";
  const readinessLabel = {
    LIVE: "РАБОТАЕТ", CONFIGURED: "НАСТРОЕНО", BLOCKED: "НЕ ГОТОВО",
  }[adminReadinessLabel(status)];
  return <main className="admin-shell">
    <header className="admin-topbar">
      <a className="admin-brand" href="/"><span>FS</span><b>FLYWHEEL STRATEGY · УПРАВЛЕНИЕ SOLANA</b></a>
      <div className={`admin-system-state is-${executionReleased ? status?.automationState ?? "unknown" : "stopped"}`}><i />{automationStateLabel}</div>
      <BaseWalletMultiButton className="admin-wallet-button" labels={walletLabels} />
    </header>

    <section className="admin-heading">
      <div><span className="admin-kicker">ЗАКРЫТАЯ ПАНЕЛЬ ВЛАДЕЛЬЦА</span><h1>УПРАВЛЕНИЕ ПРОЕКТОМ</h1><p>Отдельная подпись для каждого действия · 60% холдерам · 40% в резерв</p></div>
      <div className={`admin-owner-card ${authorized ? "confirmed" : ""}`}><span>{authorized ? "КОШЕЛЁК ВЛАДЕЛЬЦА ПОДКЛЮЧЕН" : "КОШЕЛЁК ВЛАДЕЛЬЦА НЕ ПОДКЛЮЧЕН"}</span><b>{short(status?.owner)}</b><small>{wallet.publicKey ? short(wallet.publicKey.toBase58()) : "Подключи кошелёк владельца"}</small></div>
    </section>

    <section className="admin-grid">
      <article className="admin-primary-card">
        <div className="admin-card-head"><div><span>ТЕКУЩЕЕ СОСТОЯНИЕ</span><h2>Запуск и автоматизация</h2></div><b className={executionReleased && status?.launch.activated ? "green" : "amber"}>{!executionReleased ? "ДЕЙСТВИЯ НЕДОСТУПНЫ" : status?.launch.activated ? "АКТИВНО" : "НЕ АКТИВНО"}</b></div>
        <div className="admin-services">{services.length ? services.map(([name, service]) => <div key={name}><i className={service.ok ? "online" : "offline"} /><span><b>{serviceLabels[name] ?? name}</b><small>{service.updatedAt ? new Date(service.updatedAt).toLocaleString("ru-RU") : "Нет данных о работе"}</small></span></div>) : <div><i className="offline" /><span><b>Событий пока нет</b><small>Статус операций появится после включения детектора</small></span></div>}</div>
        <p className="admin-note">{notice}</p>
      </article>
      <aside className="admin-health-card"><span>ГОТОВНОСТЬ</span><strong>{readinessLabel}</strong><ul><li className={status?.launch.configured ? "done" : ""}>Конфигурация запуска</li><li className={status?.owner ? "done" : ""}>Адрес владельца</li><li className={status?.launch.armed ? "done" : ""}>Детектор включён</li><li className={status?.launch.detectedMint ? "done" : ""}>Токен Pump.fun найден</li><li className={status?.launch.activated ? "done" : ""}>Автоматизация включена</li></ul><small>Обновлено: {status?.updatedAt ? new Date(status.updatedAt).toLocaleString("ru-RU") : "ещё не обновлялось"}</small></aside>
    </section>

    <section className="admin-launch-flow" aria-label="Резерв под контролем владельца">
      <div className="admin-card-head"><div><span>СРЕДСТВА РЕЗЕРВА</span><h2>Стратегический резерв</h2></div><b className="green">КОШЕЛЁК ПОД ТВОИМ КОНТРОЛЕМ</b></div>
      <p className="admin-note">40% полученных комиссий в MSTRx поступают на отдельный кошелёк резерва · Распоряжается ими владелец этого кошелька</p>
      <div className="admin-addresses"><div><span>КОШЕЛЁК РЕЗЕРВА</span><b>{status?.reserveWallet ?? "НЕ УКАЗАН"}</b></div><div><span>MSTRx В РЕЗЕРВЕ · RAW</span><b>{status?.balances.reserveMstrxRaw ?? "0"}</b></div></div>
    </section>

    {optionalGovernanceEnabled && <>

    <section className="admin-launch-flow" aria-label="Governance reserve custody">
      <div className="admin-card-head"><div><span>ONCHAIN CUSTODY</span><h2>Strategic reserve</h2></div><b className={governanceFresh ? "green" : "amber"}>{governanceFresh ? "RECENTLY VERIFIED" : "NOT CURRENTLY VERIFIED"}</b></div>
      <p className="admin-note">The committed amount remains unavailable to the owner during a vote and after a passed vote until its approved action is executed · Only the free amount can be withdrawn</p>
      <div className="admin-addresses admin-governance-balances">
        <div><span>VAULT TOTAL · RAW MSTRx</span><b>{governanceFresh ? governance?.vaultBalanceRaw : "UNVERIFIED"}</b></div>
        <div><span>COMMITTED · RAW MSTRx</span><b>{governanceFresh ? governance?.committedRaw : "UNVERIFIED"}</b></div>
        <div><span>FREE · RAW MSTRx</span><b>{governanceFresh ? governance?.freeRaw : "UNVERIFIED"}</b></div>
        <div><span>ACTIVE PROPOSAL</span><b>{governanceFresh ? governance?.activeProposalId : "UNVERIFIED"}</b></div>
      </div>
      <div className="admin-addresses admin-governance-identities">
        <div><span>GOVERNANCE PROGRAM</span><b>{governance?.program ?? "NOT SET"}</b></div>
        <div><span>REVIEWED PROGRAM SHA-256</span><b>{governance?.programCodeSha256 ?? "NOT VERIFIED"}</b></div>
        <div><span>VAULT TOKEN ACCOUNT</span><b>{governance?.vaultTokenAccount ?? "NOT SET"}</b></div>
        <div><span>BOUND CAPITAL MINT</span><b>{governance?.boundCapitalMint ?? "NOT BOUND"}</b></div>
        <div><span>LAST VERIFICATION</span><b>{governance?.updatedAt ? new Date(governance.updatedAt).toLocaleString() : "NEVER"}</b></div>
      </div>
      <div className="admin-free-withdrawal">
        <div><b>Withdraw only free MSTRx to the owner wallet</b><small>Enter an exact raw-unit amount · The signed request fixes this amount, the reviewed program code, the vault, the mint and the owner's token account · A committed vote cannot be overridden</small></div>
        <label htmlFor="free-withdraw-raw">EXACT RAW MSTRx</label>
        <input id="free-withdraw-raw" type="text" inputMode="numeric" autoComplete="off" value={withdrawAmountRaw}
          onChange={(event) => setWithdrawAmountRaw(event.target.value)} placeholder="Exact raw-unit amount" />
        <button disabled={!authorized || !governance?.withdrawalReleased || !governanceFresh || !status?.launch.activated || !withdrawalAmountValid
          || Boolean(withdrawalPending) || Boolean(busy) || Boolean(pendingAction)}
          onClick={() => void runAction("withdraw_free_reserve")}>{busy === "withdraw_free_reserve" ? "SIGNING…" : "AUTHORIZE EXACT WITHDRAWAL"}</button>
        {!governance?.withdrawalReleased && <small>Action locked until the complete governance program, onchain executor and reviewed deployment are released</small>}
        {status?.governanceWithdrawal && <small>Last withdrawal · {status.governanceWithdrawal.amountRaw} raw MSTRx · {status.governanceWithdrawal.state.toUpperCase()} · {short(status.governanceWithdrawal.signature)} · {status.governanceWithdrawal.requestId}</small>}
        {status?.governanceWithdrawal?.state === "unresolved" && <small>Transaction history is inconclusive after blockhash expiry · No new withdrawal can be signed until independent reconciliation proves the result</small>}
      </div>
      <p className="admin-note">The reserve balance does not prove that a ballot was finalized or executed · See the separate proposal status below</p>
    </section>

    <section className="admin-launch-flow" aria-label="Governance ballot and execution">
      <div className="admin-card-head"><div><span>HOLDER DECISIONS</span><h2>Voting and execution</h2></div><b className="amber">{status?.finalizeVoteReleased ? "FINALIZER RELEASED · SPENDING LOCKED" : "NOT RELEASED"}</b></div>
      <p className="admin-note">The first ballot requires a 24-hour public snapshot review · A replacement ballot can open immediately after an unexecuted decision reaches its execution time · The full committed amount stays locked until its holder-approved outcome completes</p>
      <div className="admin-addresses admin-governance-balances">
        <div><span>PROPOSAL</span><b>{proposalReadout.proposal}</b></div>
        <div><span>BALLOT</span><b>{proposalReadout.ballot}</b></div>
        <div><span>RESULT</span><b>{proposalReadout.result}</b></div>
        <div><span>EXECUTION</span><b>{proposalReadout.execution}</b></div>
      </div>
      {proposal && <div className="admin-addresses admin-governance-identities">
        <div><span>EXACT FROZEN · RAW MSTRx</span><b>{proposal.frozenRaw}</b></div>
        <div><span>FIXED MARKETING RECIPIENT</span><b>{proposal.fixedMarketingWallet ?? "NOT IN VERIFIED BALLOT"}</b></div>
        <div><span>VOTING START</span><b>{new Date(proposal.startsAt * 1_000).toLocaleString()}</b></div>
        <div><span>VOTING END</span><b>{new Date(proposal.endsAt * 1_000).toLocaleString()}</b></div>
        <div><span>EXECUTABLE FROM</span><b>{new Date(proposal.executableAt * 1_000).toLocaleString()}</b></div>
        <div><span>WINNING ACTION</span><b>{proposal.winningAction ?? "NOT DECIDED"}</b></div>
        {proposal.executionReceipt && <div><span>FINALIZED EXECUTION RECEIPT</span><b><a href={`https://solscan.io/account/${proposal.executionReceipt.address}`} target="_blank" rel="noreferrer">{short(proposal.executionReceipt.address)} ↗</a> · {proposal.executionReceipt.actualOutputRaw} RAW OUTPUT</b></div>}
        {proposal.executionLock && <div><span>FINALIZED MSTRx LOCK</span><b><a href={`https://solscan.io/account/${proposal.executionLock.address}`} target="_blank" rel="noreferrer">{short(proposal.executionLock.address)} ↗</a> · {proposal.executionLock.state}</b></div>}
        <div><span>EXECUTION TX</span><b>{proposal.executionSignature ?? "NOT RECORDED"}</b></div>
      </div>}
      {governanceFresh && governance && /^\d+$/.test(governance.activeProposalId)
        && governance.activeProposalId !== "0" && <p className="admin-note"><a href={`/governance?proposal=${governance.activeProposalId}`} target="_blank" rel="noreferrer">Open active ballot in a separate tab →</a></p>}
      <div className="solana-action-grid">{ownerActions.map((action) =>
        <article key={action.key}><div><b>{action.label}</b><small>{action.state}</small>
          <small>EXACT AMOUNT · {action.exactRaw ?? "UNVERIFIED"} RAW MSTRx</small>
          {action.key === "finalize" && <><small>PROPOSAL · {proposal ? `#${proposal.id}` : "UNVERIFIED"}</small>
            <small>ONCHAIN STATUS · {proposal ? governanceProposalStatusLabel(proposal.status) : "UNVERIFIED"}</small>
            <small>EXACT PROPOSAL SHA-256 · {proposal?.proposalStateSha256 ?? "UNVERIFIED"}</small></>}</div>
          <button type="button" disabled={action.key !== "finalize" || !finalizeReady
            || !authorized || Boolean(busy) || Boolean(pendingAction)}
            title={action.key === "finalize" ? status?.finalizeVoteReleased ? "Finalize only this verified ballot" : "Finalization release gate is closed"
                : "No reviewed server command or complete executor is released"}
            onClick={action.key === "finalize" ? () => void runAction("finalize_vote") : undefined}>
            {action.key === "finalize" && finalizeReady
              ? busy === "finalize_vote" ? "SIGNING…" : "AUTHORIZE FINALIZATION" : action.button}
          </button></article>)}</div>
      <div className="solana-action-grid">
        <article><div><b>Execute voted MSTRx lock</b><small>Whole committed MSTRx amount · Voted term</small></div>
          <button type="button" disabled={!authorized || !lockExecutionReady || Boolean(busy) || Boolean(pendingAction)}
            onClick={() => void runAction("execute_lock_mstrx")}>{busy === "execute_lock_mstrx" ? "SIGNING…" : "AUTHORIZE MSTRx LOCK"}</button></article>
        <article><div><b>Execute voted CAPITAL buyback</b><small>{proposal?.winningAction?.startsWith("BUYBACK_") ? proposal.winningAction : "No buyback winner"} · Full committed MSTRx · Voted minimum CAPITAL</small></div>
          <button type="button" disabled={!authorized || !buybackExecutionReady || Boolean(busy) || Boolean(pendingAction)}
            onClick={() => void runAction("execute_buyback")}>{busy === "execute_buyback" ? "SIGNING…" : "AUTHORIZE VOTED BUYBACK"}</button></article>
        <article><div><b>Execute voted marketing sale</b><small>Full committed MSTRx → SOL · Fixed recipient · Voted minimum SOL</small></div>
          <button type="button" disabled={!authorized || !marketingExecutionReady || Boolean(busy) || Boolean(pendingAction)}
            onClick={() => void runAction("execute_marketing_sale")}>{busy === "execute_marketing_sale" ? "SIGNING…" : "AUTHORIZE MARKETING SALE"}</button></article>
      </div>
      <p className="admin-note">For buyback and sale the owner fixes a positive minimum before voting · The transaction fails atomically if the market delivers less · The minimum is the price protection, so review it carefully</p>
      {status?.governanceFinalization && <p className="admin-note">Last finalization · proposal #{status.governanceFinalization.proposalId} · {status.governanceFinalization.state.toUpperCase()} · {short(status.governanceFinalization.signature)} · {status.governanceFinalization.requestId}</p>}
      {status?.governanceLockExecution && <p className="admin-note">Last MSTRx lock execution · proposal #{status.governanceLockExecution.proposalId} · {status.governanceLockExecution.state.toUpperCase()} · {short(status.governanceLockExecution.signature)} · {status.governanceLockExecution.requestId}</p>}
      {status?.governanceBuybackExecution && <p className="admin-note">Last buyback · proposal #{status.governanceBuybackExecution.proposalId} · {status.governanceBuybackExecution.state.toUpperCase()} · {short(status.governanceBuybackExecution.signature)} · {status.governanceBuybackExecution.requestId}</p>}
      {status?.governanceMarketingExecution && <p className="admin-note">Last marketing sale · proposal #{status.governanceMarketingExecution.proposalId} · {status.governanceMarketingExecution.state.toUpperCase()} · {short(status.governanceMarketingExecution.signature)} · {status.governanceMarketingExecution.requestId}</p>}
      <div className="admin-free-withdrawal"><div><b>Return a matured MSTRx lock to the reserve</b><small>Enter the historical proposal ID · Finite locks only · The server verifies maturity and the canonical reserve destination on two RPCs</small></div>
        <label htmlFor="release-lock-proposal-id">LOCK PROPOSAL ID</label>
        <input id="release-lock-proposal-id" type="text" inputMode="numeric" autoComplete="off"
          value={releaseProposalId} onChange={(event) => setReleaseProposalId(event.target.value)} placeholder="Proposal ID" />
        <button type="button" disabled={!authorized || !lockReleaseRequestReady || Boolean(busy) || Boolean(pendingAction)}
          onClick={() => void runAction("release_lock_mstrx")}>{busy === "release_lock_mstrx" ? "SIGNING…" : "AUTHORIZE LOCK RELEASE"}</button>
        {status?.governanceLockRelease && <small>Last release · proposal #{status.governanceLockRelease.proposalId} · {status.governanceLockRelease.state.toUpperCase()} · {short(status.governanceLockRelease.signature)} · {status.governanceLockRelease.requestId}</small>}
      </div>
      <p className="admin-note">Finalization records the vote result but does not move reserve assets · Each spending outcome has its own owner authorization</p>
    </section>

    <section className="admin-launch-flow solana-proposal-preview" aria-label="Read-only governance proposal preview">
      <div className="admin-card-head"><div><span>BALLOT DESIGN</span><h2>Proposal audit preview</h2></div><b className="amber">NO SIGNING OR SEND</b></div>
      <p className="admin-note">Choose the exact outcomes and minimum swap outputs · The server audits a published holder snapshot and two finalized RPC views · Previewing never creates a ballot</p>
      <div className="solana-preview-controls">
        <label>MODE
          <select value={proposalMode} onChange={(event) => { setProposalMode(event.target.value as OwnerProposalPreviewMode); clearProposalPreview(); }}>
            <option value="initial">INITIAL BALLOT · 24-HOUR PUBLIC REVIEW</option>
            <option value="revote">IMMEDIATE RE-VOTE · SAME FROZEN AMOUNT</option>
          </select>
        </label>
        <label>VOTING DURATION
          <select value={proposalDurationHours} onChange={(event) => { setProposalDurationHours(Number(event.target.value)); clearProposalPreview(); }}>
            {Array.from({ length: 12 }, (_, index) => index + 1).map((hours) =>
              <option key={hours} value={hours}>{hours} {hours === 1 ? "HOUR" : "HOURS"}</option>)}
          </select>
        </label>
        <div><span>EXPECTED FROZEN RESERVE</span><strong>{proposedFrozen ?? "UNVERIFIED"} RAW MSTRx</strong></div>
      </div>
      <div className="solana-preview-options">{governanceBallotOptions.map(([action, detail]) => {
        const included = proposalSelected.includes(action);
        const needsMinimum = ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "MARKETING_SALE"].includes(action);
        const needsTerm = action === "BUYBACK_LOCK" || action === "LOCK_MSTRX";
        return <article key={action}>
          <label className="solana-preview-option-choice">
            <input type="checkbox" checked={included} disabled={action === "ACCUMULATE"}
              onChange={(event) => {
                setProposalSelected((current) => event.target.checked ? [...current, action] : current.filter((item) => item !== action));
                clearProposalPreview();
              }} />
            <span><b>{action}</b><small>{detail}</small></span>
          </label>
          {included && needsMinimum && <label>IMMUTABLE MINIMUM OUTPUT · {action === "MARKETING_SALE" ? "LAMPORTS" : "RAW CAPITAL"}
            <input type="text" inputMode="numeric" autoComplete="off" value={proposalMinimums[action] ?? ""}
              onChange={(event) => {
                setProposalMinimums((current) => ({ ...current, [action]: event.target.value }));
                clearProposalPreview();
              }} placeholder="Exact positive raw-unit floor" />
          </label>}
          {included && needsTerm && <label>LOCK TERM
            <select value={proposalLockTerms[action] ?? 30 * 86_400}
              onChange={(event) => {
                setProposalLockTerms((current) => ({ ...current, [action]: Number(event.target.value) }));
                clearProposalPreview();
              }}>
              {[30, 90, 180, 365, 730, 1095, 1825].map((days) =>
                <option key={days} value={days * 86_400}>{days} DAYS</option>)}
              <option value={0xffffffff}>PERMANENT</option>
            </select>
          </label>}
        </article>;
      })}</div>
      <div className="solana-preview-actions">
        <button type="button" disabled={!authorized || !canPublishOwnerSnapshot(status, now)
          || Boolean(busy) || Boolean(pendingAction)} onClick={() => void runAction("publish_snapshot")}>
          {busy === "publish_snapshot" ? "SIGNING…" : "AUDIT AND PUBLISH NEXT VOTING SNAPSHOT"}
        </button>
        <small>Two finalized RPCs verify holder history before public proofs are published · No onchain transaction · Create the ballot while the snapshot is fresh</small>
      </div>
      {status?.governanceSnapshot && <div className="admin-addresses admin-governance-identities">
        <div><span>LAST PUBLISHED SNAPSHOT</span><b>PROPOSAL #{status.governanceSnapshot.proposalId} · {new Date(status.governanceSnapshot.publishedAtUnix * 1_000).toLocaleString()}</b></div>
        <div><span>MERKLE ROOT</span><b>{status.governanceSnapshot.merkleRoot}</b></div>
        <div><span>SOURCE SHA-256</span><b>{status.governanceSnapshot.sourceSha256}</b></div>
        <div><span>SNAPSHOT SHA-256</span><b>{status.governanceSnapshot.snapshotSha256}</b></div>
        <div><span>VOTING WEIGHT</span><b>{status.governanceSnapshot.totalAvailableWeight}</b></div>
        <div><span>PUBLICATION AGE</span><b>{now - status.governanceSnapshot.publishedAtUnix * 1_000 > 25 * 60_000
          ? "STALE · REFRESH BEFORE CREATING BALLOT" : "WITHIN 25-MINUTE CREATE WINDOW"}</b></div>
      </div>}
      <div className="solana-preview-actions">
        <button type="button" disabled={!authorized || !governanceFresh || !proposedFrozen || proposalPreviewBusy}
          onClick={() => void previewProposal()}>{proposalPreviewBusy ? "AUDITING…" : "AUDIT PUBLISHED SNAPSHOT AND TERMS"}</button>
        <button type="button" disabled={!proposalCreateReady || !authorized || Boolean(busy) || Boolean(pendingAction)}
          title={proposalCreateReady ? "Sign only the exact audited proposal" : "Proposal creation and re-vote transactions are not released"}
          onClick={() => void runAction(proposalMode === "initial" ? "create_proposal" : "create_revote")}>
          {proposalCreateReady ? "AUTHORIZE EXACT BALLOT" : proposalMode === "initial" ? "CREATE BALLOT · LOCKED" : "OPEN RE-VOTE · LOCKED"}</button>
      </div>
      {proposalPreviewError && <p className="admin-note">Preview blocked · {proposalPreviewError}</p>}
      {status?.governanceCreation && <p className="admin-note">Last ballot creation · {status.governanceCreation.mode} #{status.governanceCreation.proposalId} · {status.governanceCreation.state.toUpperCase()} · {short(status.governanceCreation.signature)} · {status.governanceCreation.requestId}</p>}
      {proposalPreview && <div className="solana-preview-result">
        <div className="admin-card-head"><div><span>AUDIT-ONLY RESULT</span><h2>Exact frozen terms</h2></div><b className="amber">NOT A TRANSACTION</b></div>
        <div className="admin-addresses admin-governance-identities">
          <div><span>READ-ONLY PREVIEW SHA-256</span><b>{proposalPreview.previewHash}</b></div>
          <div><span>PROPOSAL</span><b>#{proposalPreview.draft.id} · {proposalPreview.draft.proposal}</b></div>
          <div><span>FROZEN RESERVE · RAW MSTRx</span><b>{proposalPreview.draft.frozenReserveRawMstrx}</b></div>
          <div><span>CONFIG PDA</span><b>{proposalPreview.draft.config}</b></div>
          <div><span>RESERVE VAULT</span><b>{proposalPreview.draft.reserveVault}</b></div>
          {proposalPreview.draft.previousProposal && <div><span>SUPERSEDED PROPOSAL</span><b>{proposalPreview.draft.previousProposal}</b></div>}
          <div><span>ESTIMATED OPEN</span><b>{new Date(proposalPreview.draft.estimatedStartsAt * 1_000).toLocaleString()}</b></div>
          <div><span>ESTIMATED CLOSE</span><b>{new Date(proposalPreview.draft.estimatedEndsAt * 1_000).toLocaleString()}</b></div>
          <div><span>ESTIMATED FINALIZATION</span><b>{new Date(proposalPreview.draft.estimatedExecutableAt * 1_000).toLocaleString()}</b></div>
          <div><span>PUBLISHED SNAPSHOT ROOT</span><b>{proposalPreview.publication.merkleRoot}</b></div>
          <div><span>FIXED MARKETING RECIPIENT</span><b>{proposalPreview.fixedMarketingRecipient}</b></div>
          <div><span>SNAPSHOT SHA-256</span><b>{proposalPreview.publication.snapshotSha256}</b></div>
          <div><span>SOURCE SHA-256</span><b>{proposalPreview.publication.sourceSha256}</b></div>
          <div><span>TOTAL VOTING WEIGHT</span><b>{proposalPreview.publication.totalAvailableWeight}</b></div>
          <div><span>SNAPSHOT PUBLISHED</span><b>{new Date(proposalPreview.publication.publishedAtUnix * 1_000).toLocaleString()}</b></div>
          <div><span>PREVIEW AUDITED</span><b>{new Date(proposalPreview.auditedAtUnix * 1_000).toLocaleString()}</b></div>
        </div>
        <div className="solana-preview-options">{proposalPreview.options.map((option) =>
          <article key={option.action}><b>{option.action}</b>
            <small>SPEND IF SELECTED · {option.reserveRaw} RAW MSTRx</small>
            <small>FIXED MINIMUM · {option.minOutputRaw} {option.action === "MARKETING_SALE" ? "LAMPORTS" : "RAW CAPITAL"}</small>
            <small>FIXED RECIPIENT · {option.action === "MARKETING_SALE" ? option.recipient : "NONE"}</small>
            <small>LOCK TERM · {option.lockDurationSeconds === 0xffffffff ? "PERMANENT" : option.lockDurationSeconds ? `${option.lockDurationSeconds / 86_400} DAYS` : "NONE"}</small>
          </article>)}</div>
        <p className="admin-note">{proposalCreateReady ? "Exact owner signature is available" : "Ballot creation remains locked"} · Executor review: {proposalPreview.draft.unreleasedExecutors.join(", ") || "no unreleased option listed"} · The preview itself never sends a transaction</p>
      </div>}
    </section>

    <section className="admin-launch-flow" aria-label="Restricted reserve vote options">
      <div className="admin-card-head"><div><span>FIXED OUTCOMES</span><h2>Reserve decision options</h2></div><b className="amber">BALLOT SETUP LOCKED</b></div>
      <p className="admin-note">Each ballot contains two to six distinct outcomes · Every spending outcome uses the exact amount frozen at ballot creation · A buyback or sale must fix a positive minimum output before voting</p>
      <div className="solana-action-grid">{governanceBallotOptions.map(([label, detail]) => {
        const optionIndex = proposal?.options.findIndex((entry) => entry.action === label) ?? -1;
        const option = optionIndex >= 0 ? proposal!.options[optionIndex] : undefined;
        const minimumUnit = label === "MARKETING_SALE" ? "LAMPORTS" : "RAW CAPITAL";
        const swapMinimum = label === "ACCUMULATE" || label === "LOCK_MSTRX"
          ? "NOT APPLICABLE" : option ? `${option.minOutputRaw} ${minimumUnit}` : "UNVERIFIED";
        const lockTerm = !option ? "UNVERIFIED" : label !== "BUYBACK_LOCK" && label !== "LOCK_MSTRX"
          ? "NOT APPLICABLE" : option.lockDurationSeconds === 0xffffffff
            ? "PERMANENT" : `${option.lockDurationSeconds / 86_400} DAYS`;
        return <article key={label}><div><b>{label}</b><small>{detail}</small>
          <small>{option ? `IMMUTABLE ONCHAIN OPTION #${optionIndex + 1}` : proposal ? "NOT IN VERIFIED BALLOT" : "NO VERIFIED BALLOT"}</small>
          <small>BALLOT COMMITMENT · {option ? proposal!.frozenRaw : "UNVERIFIED"} RAW MSTRx</small>
          <small>SPEND IF SELECTED · {option ? option.reserveRaw : "UNVERIFIED"} RAW MSTRx</small>
          <small>MINIMUM OUTPUT · {swapMinimum}</small>
          <small>EXTERNAL RECIPIENT · {option ? option.action === "MARKETING_SALE" ? option.recipient : "NONE" : "UNVERIFIED"}</small>
          <small>LOCK TERM · {lockTerm}</small>
        </div><button type="button" disabled title="Ballot construction and executor are not released">{option ? "ONCHAIN OPTION · LOCKED" : "DRAFT OPTION · LOCKED"}</button></article>;
      })}</div>
    </section>

    </>}

    <section className="admin-launch-flow">
      <div className="admin-card-head"><div><span>ГОЛОСОВАНИЕ</span><h2>Параметры бюллетеня</h2></div></div>
      <label>Продолжительность голосования
        <select value={offchainDurationHours} onChange={(event) => setOffchainDurationHours(Number(event.target.value))}>
          {[1, 3, 6, 12].map((hours) => <option key={hours} value={hours}>{hours} ч</option>)}
        </select>
      </label>
      <p className="admin-note">Публикуются шесть вариантов и проверенный снимок долей холдеров · Итог публичен, исполнение остаётся за владельцем резервного кошелька · При открытом голосовании не трать сумму, указанную в бюллетене</p>
      {status?.offchainBallot && <p className="admin-note">Бюллетень #{status.offchainBallot.id} · До {new Date(status.offchainBallot.endsAt * 1_000).toLocaleString()} · <a href={`/governance?proposal=${status.offchainBallot.id}`} target="_blank" rel="noreferrer">Открыть голосование ↗</a></p>}
    </section>
    {actionGroups.map((group) => <section className="admin-launch-flow" key={group.title}>
      <div className="admin-card-head"><div><span>ДЕЙСТВИЯ ВЛАДЕЛЬЦА</span><h2>{group.title}</h2></div><b>{!executionReleased ? "НЕДОСТУПНО" : authorized ? "МОЖНО ПОДПИСЫВАТЬ" : "ПОДКЛЮЧИ КОШЕЛЁК"}</b></div>
      <div className="solana-action-grid">{group.actions.map(([action, label, detail]) => <article key={action}><div><b>{label}</b><small>{detail}</small></div><button disabled={!authorized || Boolean(busy) || Boolean(pendingAction) || (!executionReleased && ["arm_launch_detection", "activate_postlaunch"].includes(action))} onClick={() => void runAction(action)}>{busy === action ? "ПОДПИСЫВАЕМ…" : "ПОДПИСАТЬ"}</button></article>)}</div>
    </section>)}

    <section className="admin-addresses">
      <div><span>ВЛАДЕЛЕЦ</span><b>{status?.owner ?? "НЕ УКАЗАН"}</b></div>
      <div><span>АДРЕС НАЙДЕННОГО ТОКЕНА</span><b>{status?.launch.detectedMint ?? "ЕЩЁ НЕ НАЙДЕН"}</b></div>
      <div><span>MSTRx У СОЗДАТЕЛЯ · RAW</span><b>{status?.balances.creatorMstrxRaw ?? "0"}</b></div>
      <div><span>MSTRx ДЛЯ ХОЛДЕРОВ · RAW</span><b>{status?.balances.holderMstrxRaw ?? "0"}</b></div>
      <div><span>MSTRx В РЕЗЕРВЕ · RAW</span><b>{status?.balances.reserveMstrxRaw ?? "0"}</b></div>
    </section>
  </main>;
}
