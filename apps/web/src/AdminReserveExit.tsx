import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatEther,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEther,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "./chain";
import { ensureRobinhoodChain, type ConnectedWallet } from "./wallets";

const INFRA = {
  mstr: getAddress("0xec262a75e413fAfD0dF80480274532C79D42da09"),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  universalRouter: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  ponsFactory: getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  v3Quoter: getAddress("0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7"),
} as const;

const EXECUTOR_ROLE = keccak256(toBytes("EXECUTOR_ROLE"));
const V3_FEE = 10_000;
const V3_SWAP_EXACT_IN = "0x00" as Hex;

const reserveAbi = parseAbi([
  "function availableBalance() view returns (uint256)",
  "function lockedBalance() view returns (uint256)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function grantRole(bytes32 role,address account)",
  "function revokeRole(bytes32 role,address account)",
  "function releaseMstr(address recipient,uint256 amount)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const permit2Abi = parseAbi([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const routerAbi = parseAbi([
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);
const wethAbi = parseAbi([
  "function withdraw(uint256 amount)",
]);
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
]);
const curveAbi = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address account) view returns (uint256)",
  "function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)",
]);

interface RuntimeReserveConfig {
  projectToken: Address;
  reserveVault: Address;
  team: Address;
}

interface Props {
  connection?: ConnectedWallet;
  isOwner: boolean;
  config?: RuntimeReserveConfig;
}

interface ReserveState {
  available: bigint;
  locked: bigint;
  walletMstr: bigint;
  walletWeth: bigint;
  walletCapital: bigint;
  walletEth: bigint;
  hasExecutorRole: boolean;
  tokenAllowance: bigint;
  permitAllowance: bigint;
  permitExpiration: number;
  curve?: Address;
  phase?: number;
}

interface Quotes {
  wethOut: bigint;
  capitalOut: bigint;
  amountIn: bigint;
  verified: boolean;
  source?: "reserve" | "admin_wallet";
  blockNumber?: bigint;
  reason?: string;
}

type ProgressKey = "access" | "release" | "revoke" | "tokenApproval" | "permitApproval" | "sell" | "unwrap" | "buy";
const SELL_TARGET_KEY = "flywheel.reserveExit.sellTarget";

const emptyState: ReserveState = {
  available: 0n,
  locked: 0n,
  walletMstr: 0n,
  walletWeth: 0n,
  walletCapital: 0n,
  walletEth: 0n,
  hasExecutorRole: false,
  tokenAllowance: 0n,
  permitAllowance: 0n,
  permitExpiration: 0,
};

function display(value: bigint, digits = 6) {
  return Number(formatUnits(value, 18)).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function slippageBps(value: string): bigint {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 10) throw new Error("Проскальзывание должно быть от 0.5% до 10%");
  return BigInt(Math.round(parsed * 100));
}

export function AdminReserveExit({ connection, isOwner, config }: Props) {
  const [state, setState] = useState<ReserveState>(emptyState);
  const [quotes, setQuotes] = useState<Quotes>({ wethOut: 0n, capitalOut: 0n, amountIn: 0n, verified: false });
  const [slippage, setSlippage] = useState("5");
  const [buyEth, setBuyEth] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Подключите admin-кошелёк и проверьте суммы");
  const [lastTx, setLastTx] = useState<Hex>();
  const [completed, setCompleted] = useState<Partial<Record<ProgressKey, boolean>>>({});
  const [sellTarget, setSellTarget] = useState(0n);
  const account = connection?.account;
  const confirmed = confirmation.trim().toUpperCase() === "RESERVE EXIT";

  useEffect(() => {
    if (!account) return setSellTarget(0n);
    try {
      const stored = window.localStorage.getItem(`${SELL_TARGET_KEY}.${account.toLowerCase()}`);
      setSellTarget(stored && /^\d+$/.test(stored) ? BigInt(stored) : 0n);
    } catch {
      setSellTarget(0n);
    }
  }, [account]);

  const quoteCapital = useCallback(async (curve: Address, ethIn: bigint, owner: Address): Promise<bigint> => {
    if (ethIn === 0n) return 0n;
    const [reserves, sellable, fee, creatorFee, snipeFee] = await Promise.all([
      publicClient.readContract({ address: curve, abi: curveAbi, functionName: "getReserves" }),
      publicClient.readContract({ address: curve, abi: curveAbi, functionName: "sellableTokens" }),
      publicClient.readContract({ address: curve, abi: curveAbi, functionName: "feeBps" }),
      publicClient.readContract({ address: curve, abi: curveAbi, functionName: "creatorTaxBps" }),
      publicClient.readContract({ address: curve, abi: curveAbi, functionName: "currentSnipeTaxBps", args: [owner] }),
    ]);
    const totalFee = fee + creatorFee + snipeFee;
    if (totalFee >= 10_000n || reserves[0] === 0n || reserves[1] === 0n) throw new Error("PONS curve не может дать котировку");
    const netInput = ethIn * (10_000n - totalFee) / 10_000n;
    const quoted = netInput * reserves[1] / (reserves[0] + netInput);
    return quoted > sellable ? sellable : quoted;
  }, []);

  const refresh = useCallback(async () => {
    if (!config?.reserveVault || !config.projectToken || !config.team) return;
    const owner = account ?? config.team;
    const launch = await publicClient.readContract({
      address: INFRA.ponsFactory,
      abi: factoryAbi,
      functionName: "getLaunchedToken",
      args: [config.projectToken],
    });
    const curve = getAddress(launch.curve);
    const [available, locked, walletMstr, walletWeth, walletCapital, walletEth, hasExecutorRole, tokenAllowance, permitAllowance] = await Promise.all([
      publicClient.readContract({ address: config.reserveVault, abi: reserveAbi, functionName: "availableBalance" }),
      publicClient.readContract({ address: config.reserveVault, abi: reserveAbi, functionName: "lockedBalance" }),
      publicClient.readContract({ address: INFRA.mstr, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      publicClient.readContract({ address: INFRA.weth, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      publicClient.readContract({ address: config.projectToken, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      publicClient.getBalance({ address: owner }),
      publicClient.readContract({ address: config.reserveVault, abi: reserveAbi, functionName: "hasRole", args: [EXECUTOR_ROLE, owner] }),
      publicClient.readContract({ address: INFRA.mstr, abi: erc20Abi, functionName: "allowance", args: [owner, INFRA.permit2] }),
      publicClient.readContract({ address: INFRA.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, INFRA.mstr, INFRA.universalRouter] }),
    ]);
    const next: ReserveState = {
      available,
      locked,
      walletMstr,
      walletWeth,
      walletCapital,
      walletEth,
      hasExecutorRole,
      tokenAllowance,
      permitAllowance: permitAllowance[0],
      permitExpiration: Number(permitAllowance[1]),
      curve,
      phase: Number(launch.phase),
    };
    setState(next);
    let verifiedQuote: Quotes = { wethOut: 0n, capitalOut: 0n, amountIn: 0n, verified: false };
    try {
      const quoteAmount = available > 0n ? available : sellTarget;
      const response = await fetch(`/admin/api/reserve-quote${quoteAmount > 0n ? `?amount=${quoteAmount}` : ""}`, { cache: "no-store" });
      const body = await response.json() as {
        ok?: boolean; amountIn?: string; amountOut?: string; source?: "reserve" | "admin_wallet";
        blockNumber?: string; reason?: string;
      };
      if (!response.ok || !body.ok || !body.amountIn || !body.amountOut) {
        verifiedQuote.reason = body.reason || "quote_verification_failed";
      } else {
        verifiedQuote = {
          ...verifiedQuote,
          amountIn: BigInt(body.amountIn),
          wethOut: BigInt(body.amountOut),
          source: body.source,
          blockNumber: body.blockNumber ? BigInt(body.blockNumber) : undefined,
          verified: true,
        };
      }
    } catch {
      verifiedQuote.reason = "quote_verification_failed";
    }
    const wethOut = verifiedQuote.wethOut;
    const capitalOut = launch.phase === 0 && curve && wethOut
      ? await quoteCapital(curve, wethOut, owner).catch(() => 0n)
      : 0n;
    setQuotes({ ...verifiedQuote, capitalOut });
  }, [account, config?.projectToken, config?.reserveVault, config?.team, quoteCapital, sellTarget]);

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "Не удалось прочитать резерв"));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function send(label: string, to: Address, data: Hex, value?: bigint): Promise<Hex> {
    if (!connection || !isOwner || !confirmed) throw new Error("Подтвердите admin-кошелёк и введите RESERVE EXIT");
    await ensureRobinhoodChain(connection.wallet.provider, connection.wallet);
    setMessage(`${label}: подтвердите транзакцию в кошельке`);
    const hash = await connection.wallet.provider.request({
      method: "eth_sendTransaction",
      params: [{ from: connection.account, to, data, ...(value !== undefined ? { value: toHex(value) } : {}) }],
    }) as Hex;
    setLastTx(hash);
    setMessage(`${label}: ожидаем подтверждение`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`${label}: транзакция завершилась с ошибкой`);
    setMessage(`${label}: выполнено`);
    await refresh();
    return hash;
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Операция не выполнена");
    } finally {
      setBusy(false);
    }
  }

  async function grantAccess() {
    if (!config || !account) return;
    const data = encodeFunctionData({ abi: reserveAbi, functionName: "grantRole", args: [EXECUTOR_ROLE, account] });
    await send("Доступ к резерву", config.reserveVault, data);
    setCompleted((current) => ({ ...current, access: true }));
  }

  async function releaseReserve() {
    if (!config || !account || state.available === 0n) return;
    const amount = state.available;
    window.localStorage.setItem(`${SELL_TARGET_KEY}.${account.toLowerCase()}`, amount.toString());
    setSellTarget(amount);
    const data = encodeFunctionData({ abi: reserveAbi, functionName: "releaseMstr", args: [account, amount] });
    await send(`Вывод ${display(amount)} MSTR`, config.reserveVault, data);
    setCompleted((current) => ({ ...current, release: true }));
  }

  async function revokeAccess() {
    if (!config || !account) return;
    const data = encodeFunctionData({ abi: reserveAbi, functionName: "revokeRole", args: [EXECUTOR_ROLE, account] });
    await send("Отзыв временного доступа", config.reserveVault, data);
    setCompleted((current) => ({ ...current, revoke: true }));
  }

  async function approveToken() {
    if (sellTarget === 0n || state.walletMstr < sellTarget) return;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [INFRA.permit2, sellTarget] });
    await send("Разрешение MSTR для Permit2", INFRA.mstr, data);
    setCompleted((current) => ({ ...current, tokenApproval: true }));
  }

  async function approvePermit2() {
    if (sellTarget === 0n || state.walletMstr < sellTarget) return;
    const expiration = Math.floor(Date.now() / 1000) + 3600;
    const data = encodeFunctionData({
      abi: permit2Abi,
      functionName: "approve",
      args: [INFRA.mstr, INFRA.universalRouter, sellTarget, expiration],
    });
    await send("Часовой лимит Universal Router", INFRA.permit2, data);
    setCompleted((current) => ({ ...current, permitApproval: true }));
  }

  async function sellMstr() {
    if (!account || sellTarget === 0n || state.walletMstr < sellTarget) return;
    const bps = slippageBps(slippage);
    if (!quotes.verified || quotes.source !== "admin_wallet" || quotes.amountIn !== sellTarget || quotes.wethOut === 0n) {
      throw new Error("Продажа заблокирована: два RPC ещё не подтвердили одинаковую котировку для MSTR на admin-кошельке");
    }
    const quoted = quotes.wethOut;
    const minimum = quoted * (10_000n - bps) / 10_000n;
    const path = encodePacked(["address", "uint24", "address"], [INFRA.mstr, V3_FEE, INFRA.weth]);
    const input = encodeAbiParameters(
      parseAbiParameters("address,uint256,uint256,bytes,bool,uint256[]"),
      [account, sellTarget, minimum, path, true, []],
    );
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "execute",
      args: [V3_SWAP_EXACT_IN, [input], BigInt(Math.floor(Date.now() / 1000) + 120)],
    });
    const wethBefore = state.walletWeth;
    await send(`Продажа MSTR · минимум ${display(minimum)} WETH`, INFRA.universalRouter, data);
    const wethAfter = await publicClient.readContract({ address: INFRA.weth, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    const received = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
    if (received > 0n) setBuyEth(formatEther(received));
    window.localStorage.removeItem(`${SELL_TARGET_KEY}.${account.toLowerCase()}`);
    setSellTarget(0n);
    setCompleted((current) => ({ ...current, sell: true }));
  }

  async function unwrapWeth() {
    if (state.walletWeth === 0n) return;
    setBuyEth(formatEther(state.walletWeth));
    const data = encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [state.walletWeth] });
    await send(`WETH → ${display(state.walletWeth)} ETH`, INFRA.weth, data);
    setCompleted((current) => ({ ...current, unwrap: true }));
  }

  async function buyCapital() {
    if (!account || !config || !state.curve) return;
    if (state.phase !== 0) throw new Error("Токен уже покинул curve — требуется V4-маршрут");
    const ethIn = parseEther(buyEth.trim());
    if (ethIn <= 0n) throw new Error("Укажите сумму ETH для buyback");
    const bps = slippageBps(slippage);
    const quoted = await quoteCapital(state.curve, ethIn, account);
    const minimum = quoted * (10_000n - bps) / 10_000n;
    const data = encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [ethIn, minimum, account] });
    await send(`Buyback · минимум ${display(minimum, 2)} CAPITAL`, state.curve, data, ethIn);
    setCompleted((current) => ({ ...current, buy: true }));
  }

  const permitFresh = sellTarget > 0n && state.permitAllowance >= sellTarget && state.permitExpiration > Math.floor(Date.now() / 1000) + 120;
  const canSell = state.available === 0n && sellTarget > 0n && state.walletMstr >= sellTarget && state.tokenAllowance >= sellTarget && permitFresh
    && quotes.verified && quotes.source === "admin_wallet" && quotes.amountIn === sellTarget && quotes.wethOut > 0n;
  const buyAmount = useMemo(() => {
    try { return buyEth.trim() ? parseEther(buyEth.trim()) : 0n; } catch { return 0n; }
  }, [buyEth]);

  return (
    <section className="admin-reserve-exit">
      <div className="admin-card-head">
        <div><span>РУЧНОЕ ДЕЙСТВИЕ · ADMIN WALLET</span><h2>Резерв → ETH → buyback</h2></div>
        <b className="amber">Каждая операция подписывается отдельно</b>
      </div>

      <div className="reserve-exit-summary">
        <div><span>ДОСТУПНО В РЕЗЕРВЕ</span><b>{display(state.available)} MSTR</b><small>Locked: {display(state.locked)} MSTR</small></div>
        <div><span>В ADMIN WALLET</span><b>{display(state.walletMstr)} MSTR</b><small>{display(state.walletEth)} ETH · {display(state.walletWeth)} WETH</small></div>
        <div><span>ПРОВЕРЕННАЯ КОТИРОВКА</span><b>{quotes.verified ? `≈ ${display(quotes.wethOut)} ETH` : "ЗАБЛОКИРОВАНО"}</b><small>{quotes.verified ? `${display(quotes.amountIn)} MSTR · 2 RPC · block ${quotes.blockNumber ?? "—"}` : "Ожидаем совпадение двух RPC"}</small></div>
        <div><span>КУПЛЕНО НА ADMIN</span><b>{display(state.walletCapital, 0)} CAPITAL</b><small>PONS phase: {state.phase ?? "—"}</small></div>
      </div>

      <div className="reserve-exit-settings">
        <label>Максимальное проскальзывание
          <span><input type="number" min="0.5" max="10" step="0.5" value={slippage} onChange={(event) => setSlippage(event.target.value)} /><i>%</i></span>
        </label>
        <label>ETH для buyback
          <input value={buyEth} onChange={(event) => setBuyEth(event.target.value)} placeholder="Появится после обмена MSTR" />
        </label>
        <label>Контрольная фраза
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="RESERVE EXIT" />
        </label>
      </div>

      <div className="reserve-exit-progress" aria-label="Прогресс операций">
        {[
          ["access", "Доступ"], ["release", "MSTR получен"], ["revoke", "Доступ отозван"],
          ["tokenApproval", "Permit2"], ["permitApproval", "Router"], ["sell", "MSTR продан"],
          ["unwrap", "ETH получен"], ["buy", "CAPITAL куплен"],
        ].map(([key, label], index) => (
          <div className={completed[key as ProgressKey] ? "done" : ""} key={key}>
            <i>{completed[key as ProgressKey] ? "✓" : index + 1}</i><span>{label}</span>
          </div>
        ))}
      </div>

      <div className="reserve-exit-steps">
        <article>
          <span>01 · ДОСТУП</span><b>Получить MSTR из резерва</b>
          <small>Временная роль выдаётся admin-кошельку и отзывается сразу после перевода</small>
          <div>
            <button disabled={!isOwner || !confirmed || busy || state.hasExecutorRole} onClick={() => void run(grantAccess)}>{completed.access ? "✓ Доступ был выдан" : "1. Выдать временный доступ"}</button>
            <button disabled={!isOwner || !confirmed || busy || !state.hasExecutorRole || state.available === 0n} onClick={() => void run(releaseReserve)}>{completed.release ? "✓ MSTR получен" : "2. Перевести весь доступный MSTR"}</button>
            <button className="danger" disabled={!isOwner || !confirmed || busy || !state.hasExecutorRole} onClick={() => void run(revokeAccess)}>{completed.revoke ? "✓ Доступ отозван" : "3. Отозвать доступ"}</button>
          </div>
        </article>

        <article>
          <span>02 · ОБМЕН</span><b>Продать MSTR за ETH</b>
          <small>MSTR проходит через Permit2 и Universal Router с указанным вами minOut</small>
          <div>
            <button disabled={!isOwner || !confirmed || busy || sellTarget === 0n || state.walletMstr < sellTarget || state.tokenAllowance >= sellTarget} onClick={() => void run(approveToken)}>{completed.tokenApproval ? "✓ Permit2 разрешён" : "4. Разрешить Permit2"}</button>
            <button disabled={!isOwner || !confirmed || busy || sellTarget === 0n || state.walletMstr < sellTarget || permitFresh} onClick={() => void run(approvePermit2)}>{completed.permitApproval ? "✓ Router разрешён" : "5. Разрешить Router на 1 час"}</button>
            <button disabled={!isOwner || !confirmed || busy || !canSell} onClick={() => void run(sellMstr)}>{completed.sell ? "✓ Резервный MSTR продан" : `6. Продать только резервный MSTR${sellTarget > 0n ? ` · ${display(sellTarget)}` : ""}`}</button>
            <button disabled={!isOwner || !confirmed || busy || state.walletWeth === 0n} onClick={() => void run(unwrapWeth)}>{completed.unwrap ? "✓ ETH получен" : "7. WETH → ETH"}</button>
          </div>
        </article>

        <article>
          <span>03 · BUYBACK</span><b>Купить CAPITAL с admin</b>
          <small>Получателем остаётся admin-кошелёк. Раздача, блокировка и конкурсы выполняются позднее отдельными транзакциями</small>
          <div>
            <button disabled={!isOwner || !confirmed || busy || state.phase !== 0 || buyAmount === 0n || buyAmount >= state.walletEth} onClick={() => void run(buyCapital)}>{completed.buy ? "✓ CAPITAL куплен" : "8. Купить CAPITAL"}</button>
          </div>
        </article>
      </div>

      <p className="reserve-exit-status">{busy ? "Ожидаем подтверждение…" : message}{lastTx ? ` · ${lastTx.slice(0, 12)}…${lastTx.slice(-8)}` : ""}</p>
      <p className="admin-note">Панель не хранит приватный ключ и не подписывает транзакции за вас. После вывода резерва обязательно отзовите временный доступ перед обменом.</p>
    </section>
  );
}
