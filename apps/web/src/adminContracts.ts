import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import rewardVaultJson from "../../../artifacts/contracts/RewardVault.sol/RewardVault.json";
import reserveVaultJson from "../../../artifacts/contracts/StrategicReserveVault.sol/StrategicReserveVault.json";
import keeperVaultJson from "../../../artifacts/contracts/KeeperVault.sol/KeeperVault.json";
import v4AdapterJson from "../../../artifacts/contracts/UniswapV4MstrSwapAdapter.sol/UniswapV4MstrSwapAdapter.json";
import v3AdapterJson from "../../../artifacts/contracts/UniswapV3MstrSwapAdapter.sol/UniswapV3MstrSwapAdapter.json";
import feeRouterJson from "../../../artifacts/contracts/FeeRouter.sol/FeeRouter.json";
import ponsFeeCollectorJson from "../../../artifacts/contracts/PonsFeeCollector.sol/PonsFeeCollector.json";
import holdVaultJson from "../../../artifacts/contracts/ProjectTokenHoldVault.sol/ProjectTokenHoldVault.json";
import tokenLockVaultJson from "../../../artifacts/contracts/ProjectTokenTimeLockVault.sol/ProjectTokenTimeLockVault.json";
import reserveAdapterJson from "../../../artifacts/contracts/RobinhoodReserveActionAdapter.sol/RobinhoodReserveActionAdapter.json";
import restrictedExecutorJson from "../../../artifacts/contracts/RestrictedExecutor.sol/RestrictedExecutor.json";
import governanceJson from "../../../artifacts/contracts/GovernanceController.sol/GovernanceController.json";
import { publicClient } from "./chain";
import { ensureRobinhoodChain, type Eip1193Provider } from "./wallets";

type Artifact = { abi: Abi; bytecode: Hex };

const artifact = (value: unknown) => value as Artifact;
const contracts = {
  rewardVault: artifact(rewardVaultJson),
  reserveVault: artifact(reserveVaultJson),
  keeperVault: artifact(keeperVaultJson),
  v4Adapter: artifact(v4AdapterJson),
  v3Adapter: artifact(v3AdapterJson),
  feeRouter: artifact(feeRouterJson),
  ponsFeeCollector: artifact(ponsFeeCollectorJson),
  holdVault: artifact(holdVaultJson),
  tokenLockVault: artifact(tokenLockVaultJson),
  reserveAdapter: artifact(reserveAdapterJson),
  restrictedExecutor: artifact(restrictedExecutorJson),
  governance: artifact(governanceJson),
};

export const INFRA = {
  chainId: 4663,
  mstr: getAddress("0xec262a75e413fAfD0dF80480274532C79D42da09"),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  universalRouter: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"),
  feeEscrow: getAddress("0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  ponsFactory: getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  ponsHook: getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"),
  v3Quoter: getAddress("0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7"),
  v4Quoter: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
} as const;

export interface PrelaunchManifest {
  version: 1;
  chainId: 4663;
  owner: Address;
  automation: Address;
  rootPublisher: Address;
  mstr: Address;
  weth: Address;
  usdg: Address;
  universalRouter: Address;
  feeEscrow: Address;
  rewardVault: Address;
  reserveVault: Address;
  keeperVault: Address;
  v4MstrAdapter: Address;
  v3MstrAdapter: Address;
  feeRouter: Address;
  ponsFeeCollector: Address;
}

export interface PostlaunchManifest extends PrelaunchManifest {
  projectToken: Address;
  curve: Address;
  marketingWallet: Address;
  team: Address;
  finalAdmin: Address;
  projectHoldVault: Address;
  projectTokenLockVault: Address;
  reserveActionAdapter: Address;
  restrictedExecutor: Address;
  governance: Address;
}

export interface WizardProgress {
  prelaunch?: Partial<PrelaunchManifest>;
  postlaunch?: Partial<PostlaunchManifest>;
  pending?: { label: string; hash: Hex };
}

export interface DeploymentInputs {
  owner: Address;
  automation: Address;
  rootPublisher: Address;
  marketingWallet: Address;
}

type ProgressCallback = (progress: WizardProgress, label: string) => void;

async function sendTransaction(
  provider: Eip1193Provider,
  account: Address,
  transaction: { to?: Address; data: Hex },
  progress: WizardProgress,
  label: string,
  onProgress: ProgressCallback,
): Promise<{ hash: Hex; contractAddress?: Address }> {
  await ensureRobinhoodChain(provider);
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: account, ...transaction }],
  }) as Hex;
  progress.pending = { label, hash };
  onProgress({ ...progress }, `${label}: транзакция отправлена`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${label}: транзакция завершилась с ошибкой`);
  progress.pending = undefined;
  return { hash, contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : undefined };
}

async function deploy(
  provider: Eip1193Provider,
  account: Address,
  contract: Artifact,
  args: readonly unknown[],
  progress: WizardProgress,
  label: string,
  onProgress: ProgressCallback,
): Promise<Address> {
  const data = encodeDeployData({ abi: contract.abi, bytecode: contract.bytecode, args });
  const receipt = await sendTransaction(provider, account, { data }, progress, label, onProgress);
  if (!receipt.contractAddress) throw new Error(`${label}: адрес контракта не найден`);
  onProgress({ ...progress }, `${label}: готово`);
  return receipt.contractAddress;
}

async function write(
  provider: Eip1193Provider,
  account: Address,
  to: Address,
  contract: Artifact,
  functionName: string,
  args: readonly unknown[],
  progress: WizardProgress,
  label: string,
  onProgress: ProgressCallback,
) {
  const data = encodeFunctionData({ abi: contract.abi, functionName, args });
  await sendTransaction(provider, account, { to, data }, progress, label, onProgress);
  onProgress({ ...progress }, `${label}: готово`);
}

const required = (value: Address | undefined, label: string): Address => {
  if (!value) throw new Error(`${label}: адрес отсутствует`);
  return getAddress(value);
};

export async function deployPrelaunch(
  provider: Eip1193Provider,
  inputs: DeploymentInputs,
  existing: WizardProgress,
  onProgress: ProgressCallback,
): Promise<WizardProgress> {
  const progress: WizardProgress = { ...existing, prelaunch: { ...(existing.prelaunch ?? {}) } };
  const pre = progress.prelaunch!;
  const report: ProgressCallback = (next, label) => {
    progress.pending = next.pending;
    onProgress({ ...progress, prelaunch: { ...pre } }, label);
  };
  const save = (label: string) => report(progress, label);

  Object.assign(pre, {
    version: 1,
    owner: getAddress(inputs.owner),
    automation: getAddress(inputs.automation),
    rootPublisher: getAddress(inputs.rootPublisher),
    ...INFRA,
  });
  save("Подготовка началась");

  pre.rewardVault ??= await deploy(provider, inputs.owner, contracts.rewardVault,
    [inputs.owner, inputs.rootPublisher, INFRA.mstr], progress, "1/9 Хранилище наград", report);
  save("Хранилище наград готово");
  pre.reserveVault ??= await deploy(provider, inputs.owner, contracts.reserveVault,
    [inputs.owner, inputs.owner, INFRA.mstr], progress, "2/9 Резерв MSTR", report);
  save("Резерв MSTR готов");
  pre.keeperVault ??= await deploy(provider, inputs.owner, contracts.keeperVault,
    [inputs.owner, inputs.automation, parseEther("0.02")], progress, "3/9 Бюджет автоматизации", report);
  save("Бюджет автоматизации готов");

  if (inputs.rootPublisher.toLowerCase() !== inputs.automation.toLowerCase() && !(pre as Record<string, unknown>).publisherRoleGranted) {
    await write(provider, inputs.owner, pre.keeperVault, contracts.keeperVault, "grantRole",
      [keccak256(toBytes("AUTOMATION_ROLE")), inputs.rootPublisher], progress, "4/9 Доступ публикации наград", report);
    (pre as Record<string, unknown>).publisherRoleGranted = true;
    save("Доступ публикации наград готов");
  }

  pre.v4MstrAdapter ??= await deploy(provider, inputs.owner, contracts.v4Adapter,
    [INFRA.universalRouter, INFRA.weth, INFRA.usdg, INFRA.mstr], progress, "5/9 Основной маршрут покупки MSTR", report);
  save("Основной маршрут MSTR готов");
  pre.v3MstrAdapter ??= await deploy(provider, inputs.owner, contracts.v3Adapter,
    [INFRA.universalRouter, INFRA.weth, INFRA.mstr], progress, "6/9 Запасной маршрут покупки MSTR", report);
  save("Запасной маршрут MSTR готов");
  pre.feeRouter ??= await deploy(provider, inputs.owner, contracts.feeRouter,
    [inputs.owner, inputs.automation, pre.rewardVault, pre.reserveVault, pre.keeperVault, pre.v4MstrAdapter],
    progress, "7/9 Распределитель комиссий", report);
  save("Распределитель комиссий готов");

  if (!(pre as Record<string, unknown>).fallbackAllowed) {
    await write(provider, inputs.owner, pre.feeRouter, contracts.feeRouter, "setSwapAdapterAllowed",
      [pre.v3MstrAdapter, true], progress, "8/9 Подключение запасного маршрута", report);
    (pre as Record<string, unknown>).fallbackAllowed = true;
    save("Запасной маршрут подключён");
  }

  pre.ponsFeeCollector ??= await deploy(provider, inputs.owner, contracts.ponsFeeCollector,
    [INFRA.feeEscrow, pre.feeRouter], progress, "9/9 Creator wallet", report);
  save("Подготовка контрактов полностью завершена");
  return progress;
}

export async function deployPostlaunch(
  provider: Eip1193Provider,
  inputs: DeploymentInputs,
  projectToken: Address,
  curve: Address,
  existing: WizardProgress,
  onProgress: ProgressCallback,
): Promise<WizardProgress> {
  if (!existing.prelaunch) throw new Error("Сначала завершите подготовку контрактов");
  const pre = existing.prelaunch as PrelaunchManifest;
  const progress: WizardProgress = { ...existing, postlaunch: { ...pre, ...(existing.postlaunch ?? {}) } };
  const post = progress.postlaunch!;
  const report: ProgressCallback = (next, label) => {
    progress.pending = next.pending;
    onProgress({ ...progress, postlaunch: { ...post } }, label);
  };
  const save = (label: string) => report(progress, label);
  Object.assign(post, {
    projectToken: getAddress(projectToken),
    curve: getAddress(curve),
    marketingWallet: getAddress(inputs.marketingWallet),
    team: getAddress(inputs.owner),
    finalAdmin: getAddress(inputs.owner),
  });
  save("Подключение стратегии началось");

  post.projectHoldVault ??= await deploy(provider, inputs.owner, contracts.holdVault,
    [projectToken], progress, "1/10 Хранилище выкупленных токенов", report);
  save("Хранилище выкупленных токенов готово");
  post.projectTokenLockVault ??= await deploy(provider, inputs.owner, contracts.tokenLockVault,
    [inputs.owner, projectToken, post.projectHoldVault], progress, "2/10 Хранилище заблокированных токенов", report);
  save("Хранилище блокировки готово");
  post.reserveActionAdapter ??= await deploy(provider, inputs.owner, contracts.reserveAdapter,
    [inputs.owner, INFRA.mstr, projectToken, INFRA.weth, INFRA.universalRouter, INFRA.permit2,
      INFRA.ponsFactory, INFRA.ponsHook, INFRA.v3Quoter, INFRA.v4Quoter],
    progress, "3/10 Модуль действий с резервом", report);
  save("Модуль резерва готов");
  post.restrictedExecutor ??= await deploy(provider, inputs.owner, contracts.restrictedExecutor,
    [inputs.owner, pre.reserveVault, post.reserveActionAdapter, post.projectHoldVault,
      post.projectTokenLockVault, inputs.marketingWallet], progress, "4/10 Безопасное исполнение решений", report);
  save("Исполнитель решений готов");
  post.governance ??= await deploy(provider, inputs.owner, contracts.governance,
    [inputs.owner, inputs.owner, post.restrictedExecutor], progress, "5/10 Голосование", report);
  save("Контракт голосования готов");

  const flags = post as Record<string, unknown>;
  if (!flags.adapterInitialized) {
    await write(provider, inputs.owner, post.reserveActionAdapter, contracts.reserveAdapter, "initializeExecutor",
      [post.restrictedExecutor], progress, "6/10 Связь резерва с исполнителем", report);
    flags.adapterInitialized = true; save("Связь резерва готова");
  }
  if (!flags.lockInitialized) {
    await write(provider, inputs.owner, post.projectTokenLockVault, contracts.tokenLockVault, "initializeExecutor",
      [post.restrictedExecutor], progress, "7/10 Связь блокировки с исполнителем", report);
    flags.lockInitialized = true; save("Связь блокировки готова");
  }
  if (!flags.governanceInitialized) {
    await write(provider, inputs.owner, post.restrictedExecutor, contracts.restrictedExecutor, "initializeGovernance",
      [post.governance], progress, "8/10 Связь голосования с исполнителем", report);
    flags.governanceInitialized = true; save("Связь голосования готова");
  }
  const executorRole = keccak256(toBytes("EXECUTOR_ROLE"));
  if (!flags.reserveRoleGranted) {
    await write(provider, inputs.owner, pre.reserveVault, contracts.reserveVault, "grantRole",
      [executorRole, post.restrictedExecutor], progress, "9/10 Доступ исполнителя к резерву", report);
    flags.reserveRoleGranted = true; save("Доступ к резерву выдан");
  }
  if (!flags.oldReserveRoleRemoved) {
    await write(provider, inputs.owner, pre.reserveVault, contracts.reserveVault, "revokeRole",
      [executorRole, inputs.owner], progress, "10/10 Удаление прямого доступа к резерву", report);
    flags.oldReserveRoleRemoved = true; save("Прямой доступ владельца к резерву удалён");
  }

  save("Стратегия полностью подключена");
  return progress;
}

export function completePrelaunch(progress: WizardProgress): PrelaunchManifest | undefined {
  const value = progress.prelaunch;
  const keys: (keyof PrelaunchManifest)[] = [
    "version", "chainId", "owner", "automation", "rootPublisher", "mstr", "weth", "usdg",
    "universalRouter", "feeEscrow", "rewardVault", "reserveVault", "keeperVault", "v4MstrAdapter",
    "v3MstrAdapter", "feeRouter", "ponsFeeCollector",
  ];
  return value && keys.every((key) => value[key] !== undefined) ? value as PrelaunchManifest : undefined;
}

export function completePostlaunch(progress: WizardProgress): PostlaunchManifest | undefined {
  const value = progress.postlaunch;
  const keys: (keyof PostlaunchManifest)[] = [
    "projectToken", "curve", "marketingWallet", "team", "finalAdmin", "projectHoldVault",
    "projectTokenLockVault", "reserveActionAdapter", "restrictedExecutor", "governance",
  ];
  return completePrelaunch(progress) && value && keys.every((key) => value[key] !== undefined)
    ? value as PostlaunchManifest : undefined;
}

export const wizardStorageKey = (owner: Address) => `mstr-main-launch:${owner.toLowerCase()}:v1`;

export function loadWizardProgress(owner: Address): WizardProgress {
  try {
    return JSON.parse(localStorage.getItem(wizardStorageKey(owner)) || "{}") as WizardProgress;
  } catch {
    return {};
  }
}

export function saveWizardProgress(owner: Address, progress: WizardProgress) {
  localStorage.setItem(wizardStorageKey(owner), JSON.stringify(progress));
}
