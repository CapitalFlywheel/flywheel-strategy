import React, { useEffect, useMemo, useState } from "react";
import { getAddress, type Address, type Hex } from "viem";
import {
  completePostlaunch,
  completePrelaunch,
  deployPostlaunch,
  deployPrelaunch,
  loadWizardProgress,
  saveWizardProgress,
  type DeploymentInputs,
  type PostlaunchManifest,
  type PrelaunchManifest,
  type WizardProgress,
} from "./adminContracts";
import type { ConnectedWallet } from "./wallets";

interface LaunchState {
  prelaunchRegistered: boolean;
  creatorWallet?: Address;
  armed: boolean;
  detected?: {
    token: Address;
    curve: Address;
    transactionHash: Hex;
    blockNumber: string;
    launchTimestamp: number;
  };
  activated: boolean;
}

interface Challenge { id: string; message: string }

const DEFAULT_AUTOMATION = getAddress("0xe6a78122ea3904614d7d9d0b01c7143c814888ac");
const DEFAULT_PUBLISHER = getAddress("0xfd8a1e79a9e9c37e5704e61603a6213522d97677");
const DEFAULT_MARKETING = getAddress("0xdA1C7404241844B6A537EC2379376bE7397C6bb7");

const short = (address?: string) => address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "—";

async function fetchLaunchState(): Promise<LaunchState> {
  const response = await fetch("/admin/api/launch-state", { cache: "no-store" });
  if (!response.ok) throw new Error("Сервер не вернул состояние запуска");
  return response.json() as Promise<LaunchState>;
}

export function LaunchWizard({ connection, isOwner }: { connection?: ConnectedWallet; isOwner: boolean }) {
  const owner = connection?.account;
  const [progress, setProgress] = useState<WizardProgress>({});
  const [server, setServer] = useState<LaunchState>({ prelaunchRegistered: false, armed: false, activated: false });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Мастер готов к основному запуску");
  const [confirmDeploy, setConfirmDeploy] = useState("");
  const [confirmActivate, setConfirmActivate] = useState("");

  const prelaunch = useMemo(() => completePrelaunch(progress), [progress]);
  const postlaunch = useMemo(() => completePostlaunch(progress), [progress]);
  const inputs: DeploymentInputs | undefined = owner ? {
    owner,
    automation: DEFAULT_AUTOMATION,
    rootPublisher: DEFAULT_PUBLISHER,
    marketingWallet: DEFAULT_MARKETING,
  } : undefined;

  useEffect(() => {
    if (owner) setProgress(loadWizardProgress(owner));
  }, [owner]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await fetchLaunchState();
        if (!cancelled) setServer(next);
      } catch {
        if (!cancelled) setStatus("Не удалось обновить этап запуска");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const save = (next: WizardProgress, label: string) => {
    setProgress(next);
    if (owner) saveWizardProgress(owner, next);
    setStatus(label);
  };

  function exportProgress() {
    if (!owner) return;
    const blob = new Blob([JSON.stringify(progress, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `flywheel-launch-progress-${owner.toLowerCase()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("Резервная копия прогресса скачана");
  }

  async function importProgress(file?: File) {
    if (!file || !owner) return;
    try {
      const next = JSON.parse(await file.text()) as WizardProgress;
      const savedOwner = next.prelaunch?.owner;
      if (savedOwner && savedOwner.toLowerCase() !== owner.toLowerCase()) {
        throw new Error("Файл создан для другого кошелька владельца");
      }
      saveWizardProgress(owner, next);
      setProgress(next);
      setStatus("Прогресс восстановлен из резервной копии");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось импортировать прогресс");
    }
  }

  async function signedAction(action: string, payload?: PrelaunchManifest | PostlaunchManifest) {
    if (!connection || !isOwner) throw new Error("Подключите кошелёк владельца");
    const challengeResponse = await fetch("/admin/api/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
    if (!challengeResponse.ok) throw new Error("Сервер не создал запрос на подпись");
    const challenge = await challengeResponse.json() as Challenge;
    const signature = await connection.wallet.provider.request({
      method: "personal_sign",
      params: [challenge.message, connection.account],
    }) as Hex;
    const response = await fetch("/admin/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.id, signature }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ? `Сервер отклонил действие: ${body.error}` : "Сервер отклонил действие");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 3_000));
    setServer(await fetchLaunchState());
  }

  async function prepareContracts() {
    if (!connection || !inputs || !isOwner) return;
    if (!prelaunch && confirmDeploy !== "DEPLOY") return setStatus("Напишите DEPLOY в поле подтверждения");
    setBusy(true);
    try {
      let ready = prelaunch;
      if (!ready) {
        const next = await deployPrelaunch(connection.wallet.provider, inputs, progress, save);
        setProgress(next);
        saveWizardProgress(inputs.owner, next);
        ready = completePrelaunch(next);
      }
      if (!ready) throw new Error("Не все контракты подготовлены");
      setStatus("Подпишите регистрацию готовых контрактов");
      await signedAction("register_prelaunch", ready);
      setStatus("Контракты проверены сервером. Creator wallet готов");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Подготовка не завершена");
    } finally {
      setBusy(false);
    }
  }

  async function armWatcher() {
    setBusy(true);
    try {
      setStatus("Подпишите включение поиска запуска PONS");
      await signedAction("arm_launch_detection");
      setStatus("Поиск включён. Теперь запускайте токен на сайте PONS");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Поиск не включён");
    } finally { setBusy(false); }
  }

  async function cancelWatcher() {
    setBusy(true);
    try {
      await signedAction("cancel_launch_detection");
      setStatus("Поиск запуска остановлен");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Поиск не остановлен");
    } finally { setBusy(false); }
  }

  async function connectStrategy() {
    if (!connection || !inputs || !server.detected || !isOwner) return;
    setBusy(true);
    try {
      let ready = postlaunch;
      if (!ready) {
        const next = await deployPostlaunch(
          connection.wallet.provider, inputs, server.detected.token, server.detected.curve, progress, save,
        );
        setProgress(next);
        saveWizardProgress(inputs.owner, next);
        ready = completePostlaunch(next);
      }
      if (!ready) throw new Error("Не все контракты стратегии подключены");
      if (confirmActivate !== "ACTIVATE") {
        setStatus("Контракты готовы. Напишите ACTIVATE, чтобы переключить сайт и запустить ботов");
        return;
      }
      setStatus("Подпишите окончательное включение проекта");
      await signedAction("activate_postlaunch", ready);
      setStatus("Проект включён. Боты запускаются автоматически");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Стратегия не подключена");
    } finally { setBusy(false); }
  }

  const phase = server.activated ? 4 : server.detected ? 3 : server.prelaunchRegistered ? 2 : 1;

  return (
    <section className="admin-launch-flow launch-wizard">
      <div className="admin-card-head">
        <div><span>МАСТЕР ОСНОВНОГО ЗАПУСКА</span><h2>Без командной строки</h2></div>
        <b className={server.activated ? "green" : "amber"}>{server.activated ? "ГОТОВО" : `ЭТАП ${phase}/4`}</b>
      </div>
      <p className="wizard-status">{status}</p>

      <div className="admin-steps">
        <article className={phase > 1 ? "complete" : "active"}><span>01</span><b>Подготовить контракты</b><small>Несколько подтверждений в кошельке. Прогресс сохраняется.</small></article>
        <article className={phase > 2 ? "complete" : phase === 2 ? "active" : ""}><span>02</span><b>Запустить на PONS</b><small>Картинка, название и соцсети заполняются вручную.</small></article>
        <article className={phase > 3 ? "complete" : phase === 3 ? "active" : ""}><span>03</span><b>Подключить стратегию</b><small>Панель проверит токен и создаст оставшиеся контракты.</small></article>
        <article className={phase === 4 ? "complete" : ""}><span>04</span><b>Автоматическая работа</b><small>Сайт переключён, награды и голосования обслуживают боты.</small></article>
      </div>

      {!server.prelaunchRegistered && (
        <div className="wizard-action-box">
          <div><b>Этап 1. Контракты до запуска</b><small>Это реальные транзакции в Robinhood Chain. Средства списываются только на газ.</small></div>
          {!prelaunch && <input value={confirmDeploy} onChange={(event) => setConfirmDeploy(event.target.value.trim().toUpperCase())} placeholder="Напишите DEPLOY" />}
          <button type="button" disabled={!isOwner || busy || (!prelaunch && confirmDeploy !== "DEPLOY")} onClick={() => void prepareContracts()}>
            {busy ? "Выполняется…" : prelaunch ? "Проверить и зарегистрировать" : "Подготовить контракты"}
          </button>
        </div>
      )}

      {server.prelaunchRegistered && !server.detected && (
        <div className="wizard-action-box">
          <div>
            <b>Creator wallet: {short(server.creatorWallet)}</b>
            <small>На PONS: ETH pair · Creator fee 2% · buyback выключен · Creator wallet строго этот адрес.</small>
          </div>
          <a href="https://www.ponsfamily.com/launchpad" target="_blank" rel="noreferrer">Открыть PONS ↗</a>
          {server.armed
            ? <button type="button" className="danger" disabled={busy} onClick={() => void cancelWatcher()}>Остановить поиск</button>
            : <button type="button" disabled={!isOwner || busy} onClick={() => void armWatcher()}>Включить поиск запуска</button>}
        </div>
      )}

      {server.detected && !server.activated && (
        <div className="wizard-action-box detected">
          <div><b>Токен найден: {short(server.detected.token)}</b><small>PONS-настройки и Creator wallet проверены автоматически.</small></div>
          {postlaunch && <input value={confirmActivate} onChange={(event) => setConfirmActivate(event.target.value.trim().toUpperCase())} placeholder="Напишите ACTIVATE" />}
          <button type="button" disabled={!isOwner || busy || (Boolean(postlaunch) && confirmActivate !== "ACTIVATE")} onClick={() => void connectStrategy()}>
            {busy ? "Выполняется…" : postlaunch ? "Включить проект и ботов" : "Подключить стратегию"}
          </button>
        </div>
      )}

      {server.activated && <div className="wizard-complete"><b>Основной проект полностью активирован</b><small>Контракты проверены, публичная конфигурация опубликована, автоматизация включена</small></div>}

      <div className="wizard-wallet-map">
        <span>Автоматизация <b>{short(DEFAULT_AUTOMATION)}</b></span>
        <span>Публикация наград <b>{short(DEFAULT_PUBLISHER)}</b></span>
        <span>Маркетинг <b>{short(DEFAULT_MARKETING)}</b></span>
      </div>
      <div className="wizard-backup">
        <button type="button" disabled={!owner} onClick={exportProgress}>Скачать прогресс запуска</button>
        <label>
          Восстановить прогресс
          <input type="file" accept="application/json,.json" disabled={!owner || busy} onChange={(event) => void importProgress(event.target.files?.[0])} />
        </label>
        <small>Сохраните файл после каждого этапа и передайте его команде по защищённому каналу</small>
      </div>
    </section>
  );
}
