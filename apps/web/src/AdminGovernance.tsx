import React, { useEffect, useMemo, useState } from "react";
import { type Address, type Hex } from "viem";
import { publicClient } from "./chain";
import { ensureRobinhoodChain, type ConnectedWallet } from "./wallets";

const ACTIONS = [
  "ACCUMULATE", "BUYBACK_HOLD", "BUYBACK_BURN",
  "BUYBACK_LOCK", "LOCK_MSTR", "MARKETING_SALE",
] as const;
type Action = typeof ACTIONS[number];
type Lock = "1_MONTH" | "3_MONTHS" | "6_MONTHS" | "1_YEAR" | "2_YEARS" | "3_YEARS" | "5_YEARS" | "FOREVER";

const actionLabels: Record<Action, string> = {
  ACCUMULATE: "Оставить MSTR в резерве",
  BUYBACK_HOLD: "Выкупить токен и хранить",
  BUYBACK_BURN: "Выкупить токен и сжечь",
  BUYBACK_LOCK: "Выкупить токен и заблокировать",
  LOCK_MSTR: "Заблокировать MSTR",
  MARKETING_SALE: "Продать MSTR на маркетинг",
};
const actionByIndex = ACTIONS.reduce<Record<number, string>>((map, action, index) => ({ ...map, [index]: actionLabels[action] }), {});
const lockLabels: Record<Lock, string> = {
  "1_MONTH": "1 месяц", "3_MONTHS": "3 месяца", "6_MONTHS": "6 месяцев", "1_YEAR": "1 год",
  "2_YEARS": "2 года", "3_YEARS": "3 года", "5_YEARS": "5 лет", FOREVER: "Навсегда",
};
const durationChoices = [1, 2, 3, 4, 6, 8, 12];
const lockChoices = Object.keys(lockLabels) as Lock[];
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MAIN_MARKETING_WALLET = "0xdA1C7404241844B6A537EC2379376bE7397C6bb7" as Address;

interface DraftOption { action: Action; enabled: boolean; reservePercent?: number; lock?: Lock }
interface RuntimeGovernanceConfig { governance?: Address; marketingWallet?: Address; projectToken?: Address }
interface PreparedGovernance {
  status: "none" | "ready" | "failed";
  requestId?: string;
  expectedProposalId?: string;
  from?: Address;
  to?: Address;
  value?: Hex;
  data?: Hex;
  durationHours?: number;
  options?: Array<{ action: Action; reservePercent?: number; lock?: Lock }>;
  eligibleHolders?: number;
  snapshotBlock?: string;
  preparedAt?: number;
  expiresAt?: number;
  error?: string;
}
interface ChainProposal {
  id: bigint;
  active: boolean;
  startsAt: number;
  endsAt: number;
  executableAt: number;
  totalAvailableWeight: bigint;
  totalCastWeight: bigint;
  executed: boolean;
  passed: boolean;
  winningOption: number;
  options: Array<{ action: number; reserveBps: number; reserveAmount: bigint; lockDuration: number; votes: bigint }>;
}
interface Challenge { id: string; message: string }
interface LifecycleHeartbeat {
  ok?: boolean;
  updatedAt?: number;
  state?: string;
  ponsPhase?: number;
  ponsPhaseName?: string;
  error?: string;
}

const governanceAbi = [
  { type: "function", name: "activeProposalId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "proposalCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "proposals", stateMutability: "view", inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      { name: "startsAt", type: "uint64" }, { name: "endsAt", type: "uint64" },
      { name: "executableAt", type: "uint64" }, { name: "weightRoot", type: "bytes32" },
      { name: "totalAvailableWeight", type: "uint128" }, { name: "totalCastWeight", type: "uint128" },
      { name: "optionCount", type: "uint8" }, { name: "executed", type: "bool" },
      { name: "passed", type: "bool" }, { name: "winningOption", type: "uint8" },
    ],
  },
  {
    type: "function", name: "getOption", stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }, { name: "optionIndex", type: "uint8" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "action", type: "uint8" }, { name: "reserveBps", type: "uint16" },
      { name: "reserveAmount", type: "uint128" }, { name: "lockDuration", type: "uint32" },
      { name: "recipient", type: "address" },
    ] }],
  },
  {
    type: "function", name: "optionVotes", stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }, { name: "optionIndex", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const ponsAbi = [{
  type: "function", name: "getLaunchedToken", stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [{ name: "", type: "tuple", components: [
    { name: "token", type: "address" }, { name: "curve", type: "address" },
    { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" },
    { name: "pairToken", type: "address" }, { name: "graduationThreshold", type: "uint256" },
    { name: "poolFee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
    { name: "creatorTaxBps", type: "uint16" }, { name: "buybackEnabled", type: "bool" },
    { name: "phase", type: "uint8" }, { name: "sweptQuote", type: "uint256" },
    { name: "sweptTokens", type: "uint256" }, { name: "sweptAt", type: "uint256" },
    { name: "exists", type: "bool" },
  ] }],
}] as const;

const initialOptions: DraftOption[] = [
  { action: "ACCUMULATE", enabled: true },
  { action: "BUYBACK_HOLD", enabled: true, reservePercent: 25 },
  { action: "BUYBACK_BURN", enabled: true, reservePercent: 25 },
  { action: "BUYBACK_LOCK", enabled: true, reservePercent: 25, lock: "3_MONTHS" },
  { action: "LOCK_MSTR", enabled: true, reservePercent: 25, lock: "3_MONTHS" },
  { action: "MARKETING_SALE", enabled: true, reservePercent: 5 },
];

function short(address?: string) { return address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "—"; }
function dateTime(timestamp: number) { return new Date(timestamp * 1000).toLocaleString("ru-RU"); }
function percent(part: bigint, total: bigint) { return total ? Number(part * 10_000n / total) / 100 : 0; }

async function readProposal(governance: Address): Promise<ChainProposal | undefined> {
  const [activeId, count] = await Promise.all([
    publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "activeProposalId" }),
    publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "proposalCount" }),
  ]);
  const id = activeId || count;
  if (!id) return;
  const proposal = await publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "proposals", args: [id] });
  const options = await Promise.all(Array.from({ length: Number(proposal[6]) }, async (_, index) => {
    const [option, votes] = await Promise.all([
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "getOption", args: [id, index] }),
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "optionVotes", args: [id, index] }),
    ]);
    return { action: option.action, reserveBps: option.reserveBps, reserveAmount: option.reserveAmount, lockDuration: option.lockDuration, votes };
  }));
  return {
    id, active: activeId !== 0n, startsAt: Number(proposal[0]), endsAt: Number(proposal[1]),
    executableAt: Number(proposal[2]), totalAvailableWeight: proposal[4], totalCastWeight: proposal[5],
    executed: proposal[7], passed: proposal[8], winningOption: proposal[9], options,
  };
}

function preparationError(error?: string) {
  if (!error) return "Подготовка не выполнена";
  if (error.includes("NO_ELIGIBLE_HOLDERS")) return "Не найдено холдеров с правом голоса";
  if (error.includes("IS_STILL_ACTIVE")) return "Сначала должно завершиться текущее голосование";
  return "Сервер не смог подготовить голосование";
}

export function AdminGovernance({
  connection, isOwner, config, keeperRunning,
}: {
  connection?: ConnectedWallet;
  isOwner: boolean;
  config?: RuntimeGovernanceConfig;
  keeperRunning: boolean;
}) {
  const [activated, setActivated] = useState(false);
  const [durationHours, setDurationHours] = useState(6);
  const [options, setOptions] = useState<DraftOption[]>(initialOptions);
  const [prepared, setPrepared] = useState<PreparedGovernance>();
  const [proposal, setProposal] = useState<ChainProposal>();
  const [marketPhase, setMarketPhase] = useState<number>();
  const [lifecycle, setLifecycle] = useState<LifecycleHeartbeat>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("Настройте варианты будущего голосования");
  const [txHash, setTxHash] = useState<Hex>();
  const selected = useMemo(() => options.filter((option) => option.enabled), [options]);
  const draft = useMemo(() => ({
    durationHours,
    options: selected.map(({ action, reservePercent, lock }) => ({
      action,
      ...(action === "ACCUMULATE" ? {} : { reservePercent }),
      ...(lock ? { lock } : {}),
    })),
  }), [durationHours, selected]);
  const preparedMatchesDraft = prepared?.status === "ready"
    && JSON.stringify({ durationHours: prepared.durationHours, options: prepared.options }) === JSON.stringify(draft);

  async function refresh() {
    const [launchResponse, preparedResponse, governanceHeartbeat, launchHeartbeat] = await Promise.all([
      fetch("/admin/api/launch-state", { cache: "no-store" }),
      fetch("/admin/api/governance-prepared", { cache: "no-store" }),
      fetch("/status/governance-keeper.json", { cache: "no-store" }),
      fetch("/status/launch-watcher.json", { cache: "no-store" }),
    ]);
    if (launchResponse.ok) setActivated(Boolean((await launchResponse.json() as { activated?: boolean }).activated));
    if (preparedResponse.ok) setPrepared(await preparedResponse.json() as PreparedGovernance);
    const heartbeats = await Promise.all([
      governanceHeartbeat.ok ? governanceHeartbeat.json() as Promise<LifecycleHeartbeat> : Promise.resolve(undefined),
      launchHeartbeat.ok ? launchHeartbeat.json() as Promise<LifecycleHeartbeat> : Promise.resolve(undefined),
    ]);
    setLifecycle(heartbeats.filter(Boolean).sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0))[0]);
    if (config?.governance) setProposal(await readProposal(config.governance));
    if (config?.projectToken) {
      const launch = await publicClient.readContract({
        address: PONS_FACTORY,
        abi: ponsAbi,
        functionName: "getLaunchedToken",
        args: [config.projectToken],
      });
      setMarketPhase(Number(launch.phase));
    }
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 8_000);
    return () => window.clearInterval(timer);
  }, [config?.governance, config?.projectToken]);

  function updateOption(action: Action, change: Partial<DraftOption>) {
    setOptions((current) => current.map((option) => option.action === action ? { ...option, ...change } : option));
    setPrepared(undefined);
  }

  async function signedPrepare() {
    if (!connection || !isOwner || !activated || selected.length < 2) return;
    setBusy(true);
    setMessage("Подпишите подготовку голосования в кошельке");
    try {
      const challengeResponse = await fetch("/admin/api/challenge", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "prepare_governance", payload: draft }),
      });
      if (!challengeResponse.ok) throw new Error("Сервер не создал запрос на подпись");
      const challenge = await challengeResponse.json() as Challenge;
      const signature = await connection.wallet.provider.request({
        method: "personal_sign", params: [challenge.message, connection.account],
      }) as Hex;
      const actionResponse = await fetch("/admin/api/action", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.id, signature }),
      });
      if (!actionResponse.ok) throw new Error("Подпись не принята сервером");
      const queued = await actionResponse.json() as { requestId: string };
      setMessage("Сервер считает вес каждого холдера. Обычно это занимает до пары минут…");
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const response = await fetch("/admin/api/governance-prepared", { cache: "no-store" });
        const result = await response.json() as PreparedGovernance;
        if (result.requestId !== queued.requestId) continue;
        setPrepared(result);
        if (result.status === "failed") throw new Error(preparationError(result.error));
        if (result.status === "ready") {
          setMessage(`Готово: учтено ${result.eligibleHolders} холдеров. Теперь проверьте всё и запустите голосование.`);
          return;
        }
      }
      throw new Error("Подготовка занимает больше обычного. Состояние сохранено — обновите страницу через минуту.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Подготовка не выполнена");
    } finally { setBusy(false); }
  }

  async function launchVote() {
    if (!connection || !isOwner || !preparedMatchesDraft || !prepared?.to || !prepared.data) return;
    if (confirm !== "VOTE") return setMessage("Напишите VOTE в поле подтверждения");
    if ((prepared.expiresAt || 0) < Date.now()) return setMessage("Расчёт устарел. Подготовьте голосование заново.");
    if (prepared.from?.toLowerCase() !== connection.account.toLowerCase()) return setMessage("Подключён не тот основной кошелёк");
    setBusy(true);
    try {
      await ensureRobinhoodChain(connection.wallet.provider, connection.wallet);
      setMessage("Подтвердите запуск голосования и оплату комиссии сети в кошельке");
      const hash = await connection.wallet.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: connection.account, to: prepared.to, data: prepared.data, value: prepared.value || "0x0" }],
      }) as Hex;
      setTxHash(hash);
      setMessage("Транзакция отправлена. Ждём подтверждение сети…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Сеть отклонила запуск голосования");
      setConfirm("");
      await refresh();
      setMessage("Голосование запущено. После завершения бот сам исполнит результат через 5 минут.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Голосование не запущено");
    } finally { setBusy(false); }
  }

  const now = Math.floor(Date.now() / 1000);
  const proposalState = proposal?.executed
    ? (proposal.passed ? "Исполнено" : "Завершено без исполнения")
    : proposal?.active && now < proposal.endsAt ? "Идёт голосование"
      : proposal?.active ? "Ожидает автоматического исполнения" : "Нет активного голосования";
  const marketLabel = marketPhase === 0 ? "Кривая PONS" : marketPhase === 1 ? "Миграция" : marketPhase === 2 ? "V4-пул" : "Проверка";
  const marketHelp = lifecycle?.state === "migration_retry" ? "временная ошибка · повтор через 15 сек"
    : marketPhase === 0 ? "выкуп работает до миграции"
    : marketPhase === 1 ? "бот создаёт пул и повторяет"
      : marketPhase === 2 ? "маршрут переключён автоматически" : "ожидаем данные сети";

  return (
    <section className="admin-governance">
      <div className="admin-card-head">
        <div><span>УПРАВЛЕНИЕ РЕЗЕРВОМ</span><h2>Голосования</h2></div>
        <b className={proposal?.active ? "green" : "amber"}>{proposalState}</b>
      </div>

      <div className="governance-summary">
        <div><span>Кворум</span><b>7%</b><small>от общего веса холдеров</small></div>
        <div><span>Срок</span><b>1–12 ч</b><small>задаёт команда</small></div>
        <div><span>Исполнение</span><b>+5 мин</b><small>{keeperRunning ? "бот включён" : "бот сейчас остановлен"}</small></div>
        <div><span>Рынок</span><b>{marketLabel}</b><small>{marketHelp}</small></div>
        <div><span>Маркетинг</span><b>{short(activated ? config?.marketingWallet : MAIN_MARKETING_WALLET)}</b><small>фиксированный публичный кошелёк</small></div>
      </div>

      {proposal && (
        <div className="governance-live">
          <div className="governance-live-head">
            <div><span>ПОСЛЕДНЕЕ ГОЛОСОВАНИЕ #{proposal.id.toString()}</span><b>{proposalState}</b></div>
            <small>{proposal.executed ? `Завершено · ${proposal.passed ? "победитель исполнен" : "кворум не набран или ничья"}`
              : `Голосование до ${dateTime(proposal.endsAt)} · исполнение после ${dateTime(proposal.executableAt)}`}</small>
          </div>
          <div className="governance-live-options">
            {proposal.options.map((option, index) => (
              <div key={index} className={proposal.executed && proposal.passed && proposal.winningOption === index ? "winner" : ""}>
                <span>{index + 1}</span>
                <b>{actionByIndex[option.action] || `Вариант ${index + 1}`}</b>
                <small>{option.reserveBps ? `${option.reserveBps / 100}% резерва · ` : ""}{percent(option.votes, proposal.totalAvailableWeight)}% голосов</small>
              </div>
            ))}
          </div>
          <div className="governance-quorum"><i style={{ width: `${Math.min(100, percent(proposal.totalCastWeight, proposal.totalAvailableWeight))}%` }} /><span>Участие: {percent(proposal.totalCastWeight, proposal.totalAvailableWeight)}% из необходимых 7%</span></div>
        </div>
      )}

      <div className={`governance-builder ${!activated ? "locked" : ""}`}>
        <div className="governance-builder-head">
          <div><b>Создать новое голосование</b><small>Выберите от 2 до 6 вариантов. Холдеры сами определят победителя.</small></div>
          <label>Продолжительность
            <select value={durationHours} disabled={!activated || busy} onChange={(event) => { setDurationHours(Number(event.target.value)); setPrepared(undefined); }}>
              {durationChoices.map((hours) => <option value={hours} key={hours}>{hours} ч</option>)}
            </select>
          </label>
        </div>
        {!activated && <p className="governance-locked-note">Раздел полностью готов. Создание станет доступно автоматически после запуска основного токена.</p>}
        <div className="governance-option-list">
          {options.map((option) => {
            const usesReserve = option.action !== "ACCUMULATE";
            const usesLock = option.action === "BUYBACK_LOCK" || option.action === "LOCK_MSTR";
            return (
              <article key={option.action} className={option.enabled ? "selected" : ""}>
                <label className="governance-check">
                  <input type="checkbox" checked={option.enabled} disabled={!activated || busy}
                    onChange={(event) => updateOption(option.action, { enabled: event.target.checked })} />
                  <span>{actionLabels[option.action]}</span>
                </label>
                {usesReserve && <label>Доля резерва
                  <span className="governance-percent"><input type="number" min="1" max="100" step="1" value={option.reservePercent}
                    disabled={!activated || busy || !option.enabled}
                    onChange={(event) => updateOption(option.action, { reservePercent: Math.max(1, Math.min(100, Number(event.target.value))) })} /><i>%</i></span>
                </label>}
                {usesLock && <label>Срок блокировки
                  <select value={option.lock} disabled={!activated || busy || !option.enabled}
                    onChange={(event) => updateOption(option.action, { lock: event.target.value as Lock })}>
                    {lockChoices.map((lock) => <option value={lock} key={lock}>{lockLabels[lock]}</option>)}
                  </select>
                </label>}
              </article>
            );
          })}
        </div>

        <div className="governance-actions">
          <button type="button" disabled={!activated || !isOwner || busy || selected.length < 2 || Boolean(proposal?.active)} onClick={() => void signedPrepare()}>
            {busy ? "Подождите…" : "1. Рассчитать веса холдеров"}
          </button>
          <div><span>{message}</span>{prepared?.status === "ready" && <small>Расчёт действителен 30 минут · голосование #{prepared.expectedProposalId}</small>}</div>
        </div>

        {prepared?.status === "ready" && preparedMatchesDraft && (
          <div className="governance-launch-box">
            <div><b>Последняя проверка</b><small>{prepared.eligibleHolders} холдеров · {prepared.options?.length} вариантов · {prepared.durationHours} ч · блок {prepared.snapshotBlock}</small></div>
            <input aria-label="Подтверждение запуска голосования" value={confirm} onChange={(event) => setConfirm(event.target.value.toUpperCase())} placeholder="Напишите VOTE" />
            <button type="button" disabled={!isOwner || busy || confirm !== "VOTE" || Boolean(proposal?.active)} onClick={() => void launchVote()}>2. Запустить голосование</button>
          </div>
        )}
        {txHash && <p className="governance-tx">Транзакция: {short(txHash)}</p>}
        <p className="admin-note">Отменить запущенное голосование нельзя. Победитель определяется контрактом, а бот исполняет результат автоматически.</p>
      </div>
    </section>
  );
}
