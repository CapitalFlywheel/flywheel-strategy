import React, { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import "./admin.css";
import { AdminGovernance } from "./AdminGovernance";
import { AdminReserveExit } from "./AdminReserveExit";
import { LaunchWizard } from "./LaunchWizard";
import {
  connectInjectedWallet,
  restoreWallet,
  watchConnectedWallet,
  watchInjectedWallets,
  type ConnectedWallet,
  type WalletProviderDetail,
} from "./wallets";

interface RuntimeConfig {
  projectToken: Address;
  ponsFeeCollector: Address;
  rewardVault: Address;
  reserveVault: Address;
  team: Address;
  governance?: Address;
  marketingWallet?: Address;
}

interface ControlStatus {
  automationState: "running" | "stopped" | "partial" | "unknown";
  services: Record<string, boolean>;
  updatedAt: number;
  owner?: Address;
  activated?: boolean;
  lastAction?: { action: string; result: string; completedAt: number };
}

interface Challenge {
  id: string;
  action: string;
  message: string;
  expiresAt: number;
  owner: Address;
}

const serviceLabels: Record<string, string> = {
  "reward-keeper": "Сбор комиссий и покупка MSTR",
  "reward-publisher": "Расчёт и публикация наград",
  "governance-keeper": "Исполнение голосований",
};

function shortAddress(address?: string) {
  return address ? `${address.slice(0, 7)}…${address.slice(-5)}` : "—";
}

function stateLabel(state: ControlStatus["automationState"]) {
  if (state === "running") return "Автоматизация включена";
  if (state === "stopped") return "Автоматизация остановлена";
  if (state === "partial") return "Работает не полностью";
  return "Проверяем состояние";
}

export function AdminPanel() {
  const [config, setConfig] = useState<RuntimeConfig>();
  const [status, setStatus] = useState<ControlStatus>({ automationState: "unknown", services: {}, updatedAt: 0 });
  const [wallets, setWallets] = useState<WalletProviderDetail[]>([]);
  const [connection, setConnection] = useState<ConnectedWallet>();
  const [walletPicker, setWalletPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Подключите кошелёк владельца для управления");

  const adminAddress = status.owner ?? config?.team;
  const isOwner = Boolean(connection && adminAddress && connection.account.toLowerCase() === adminAddress.toLowerCase());
  const allRunning = status.automationState === "running";
  const allStopped = status.automationState === "stopped";

  const statusAge = useMemo(() => status.updatedAt ? Date.now() - status.updatedAt : Infinity, [status.updatedAt]);

  async function refreshStatus() {
    const response = await fetch("/admin/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось получить состояние сервера");
    setStatus(await response.json() as ControlStatus);
  }

  useEffect(() => watchInjectedWallets(setWallets), []);

  useEffect(() => {
    const refreshConfig = () => fetch("/config.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<RuntimeConfig> : Promise.reject())
      .then(setConfig);
    void refreshConfig().catch(() => setMessage("Не удалось загрузить адреса проекта"));
    void refreshStatus().catch(() => setMessage("Панель управления пока не подключена к серверу"));
    const timer = window.setInterval(() => {
      void refreshStatus().catch(() => undefined);
      void refreshConfig().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void restoreWallet().then((restored) => {
      if (restored) setConnection(restored);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!connection) return;
    return watchConnectedWallet(
      connection.wallet,
      (accounts) => setConnection(accounts[0] ? { ...connection, account: accounts[0] } : undefined),
      () => setConnection(undefined),
    );
  }, [connection?.wallet]);

  useEffect(() => {
    if (!connection || !adminAddress) return;
    setMessage(isOwner
      ? "Кошелёк владельца подтверждён"
      : `Подключён другой кошелёк: ${shortAddress(connection.account)}`);
  }, [connection, adminAddress, isOwner]);

  async function connect(wallet: WalletProviderDetail) {
    setBusy(true);
    setMessage("Подтвердите подключение в кошельке");
    try {
      const connected = await connectInjectedWallet(wallet);
      setConnection(connected);
      setWalletPicker(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось подключить кошелёк");
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "start_automation" | "stop_automation") {
    if (!connection || !isOwner) return;
    setBusy(true);
    setMessage(action === "start_automation"
      ? "Подпишите включение автоматизации в кошельке"
      : "Подпишите остановку автоматизации в кошельке");
    try {
      const challengeResponse = await fetch(`/admin/api/challenge?action=${action}`, { cache: "no-store" });
      if (!challengeResponse.ok) throw new Error("Сервер не создал запрос на подпись");
      const challenge = await challengeResponse.json() as Challenge;
      const signature = await connection.wallet.provider.request({
        method: "personal_sign",
        params: [challenge.message, connection.account],
      }) as Hex;
      const requestedAt = Date.now();
      const actionResponse = await fetch("/admin/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.id, signature }),
      });
      if (!actionResponse.ok) throw new Error("Подпись не принята сервером");
      setMessage("Команда принята. Сервер выполняет её…");
      let completed: ControlStatus | undefined;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const response = await fetch("/admin/api/status", { cache: "no-store" });
        if (!response.ok) continue;
        const next = await response.json() as ControlStatus;
        setStatus(next);
        if (next.lastAction?.action === action && next.lastAction.completedAt >= requestedAt) {
          completed = next;
          break;
        }
      }
      if (!completed?.lastAction) throw new Error("Сервер не подтвердил выполнение команды");
      if (completed.lastAction.result !== "success") {
        throw new Error(action === "start_automation"
          ? "Автоматизация не запущена: сначала завершите активацию проекта"
          : "Сервер не смог остановить автоматизацию");
      }
      setMessage(action === "start_automation" ? "Автоматизация запущена" : "Автоматизация остановлена");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Команда не выполнена");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar">
        <a href="/" className="admin-brand"><span>FS</span><b>FLYWHEEL STRATEGY</b></a>
        <div className={`admin-system-state ${allRunning ? "is-running" : allStopped ? "is-stopped" : "is-warning"}`}>
          <i />{stateLabel(status.automationState)}
        </div>
        <button type="button" className="admin-wallet-button" onClick={() => setWalletPicker((open) => !open)}>
          {connection ? shortAddress(connection.account) : "Подключить владельца"}
        </button>
      </header>

      {walletPicker && (
        <section className="admin-wallet-picker">
          <div><b>Выберите кошелёк</b><small>Используйте кошелёк владельца проекта</small></div>
          {wallets.length ? wallets.map((wallet) => (
            <button type="button" key={`${wallet.info.rdns}:${wallet.info.uuid}`} disabled={busy} onClick={() => void connect(wallet)}>
              <span>{wallet.info.name.slice(0, 1)}</span>{wallet.info.name}<i>Подключить</i>
            </button>
          )) : <p>Кошелёк в браузере не найден. Откройте страницу в браузере с Zerion, Rabby или MetaMask.</p>}
        </section>
      )}

      <section className="admin-heading">
        <div>
          <span className="admin-kicker">ПАНЕЛЬ ЗАПУСКА · ROBINHOOD CHAIN</span>
          <h1>Управление запуском</h1>
          <p>Подготовка контрактов, запуск через PONS и включение стратегии — в одном месте</p>
        </div>
        <div className={`admin-owner-card ${isOwner ? "confirmed" : ""}`}>
          <span>{isOwner ? "ВЛАДЕЛЕЦ ПОДТВЕРЖДЁН" : "ТРЕБУЕТСЯ ВЛАДЕЛЕЦ"}</span>
          <b>{shortAddress(adminAddress)}</b>
          <small>{message}</small>
        </div>
      </section>

      <section className="admin-grid">
        <article className="admin-primary-card">
          <div className="admin-card-head">
            <div><span>ТЕКУЩАЯ СИСТЕМА</span><h2>Автоматизация</h2></div>
            <b className={allRunning ? "green" : "amber"}>{stateLabel(status.automationState)}</b>
          </div>

          <div className="admin-services">
            {Object.entries(serviceLabels).map(([service, label]) => (
              <div key={service}>
                <i className={status.services[service] ? "online" : "offline"} />
                <span><b>{label}</b><small>{status.services[service] ? "Работает" : "Остановлен"}</small></span>
              </div>
            ))}
          </div>

          <div className="admin-controls">
            <button type="button" className="admin-start" disabled={!isOwner || busy || allRunning || !status.activated} onClick={() => void control("start_automation")}>
              {busy ? "Подождите…" : "Включить автоматизацию"}
            </button>
            <button type="button" className="admin-stop" disabled={!isOwner || busy || allStopped} onClick={() => void control("stop_automation")}>
              Остановить
            </button>
          </div>
          <p className="admin-note">Каждое действие подтверждается подписью кошелька · Приватный ключ не покидает кошелёк</p>
        </article>

        <aside className="admin-health-card">
          <span>ГОТОВНОСТЬ</span>
          <strong>5 / 5</strong>
          <div className="admin-meter"><i style={{ width: "100%" }} /></div>
          <ul>
            <li className="done">Сервер работает</li>
            <li className="done">Alchemy Pay As You Go</li>
            <li className="done">Резервный RPC готов</li>
            <li className="done">Мастер основного запуска</li>
            <li className="done">Брендирование и домен</li>
          </ul>
          <small>Статус обновлён {statusAge < 15_000 ? "только что" : "с задержкой"}</small>
        </aside>
      </section>

      <LaunchWizard connection={connection} isOwner={isOwner} />

      <AdminGovernance
        connection={connection}
        isOwner={isOwner}
        config={config}
        keeperRunning={Boolean(status.services["governance-keeper"])}
      />

      <AdminReserveExit connection={connection} isOwner={isOwner} config={config} />

      <section className="admin-addresses">
        <div><span>PROJECT TOKEN</span><b>{shortAddress(config?.projectToken)}</b></div>
        <div><span>CREATOR WALLET</span><b>{shortAddress(config?.ponsFeeCollector)}</b></div>
        <div><span>REWARD VAULT</span><b>{shortAddress(config?.rewardVault)}</b></div>
        <div><span>RESERVE VAULT</span><b>{shortAddress(config?.reserveVault)}</b></div>
      </section>
    </main>
  );
}
