import type { Address } from "viem";
import { robinhoodChain } from "./network";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  enable?(): Promise<string[]>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isZerion?: boolean;
  isPhantom?: boolean;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon?: string;
  rdns: string;
}

export interface WalletProviderDetail {
  info: WalletInfo;
  provider: Eip1193Provider;
  source: "injected" | "walletconnect";
}

export interface ConnectedWallet {
  account: Address;
  wallet: WalletProviderDetail;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

const wallets = new Map<string, WalletProviderDetail>();
const listeners = new Set<(wallets: WalletProviderDetail[]) => void>();
let discoveryStarted = false;
let activeWallet: WalletProviderDetail | undefined;
let walletConnectProvider: Eip1193Provider | undefined;

const SAVED_WALLET_KEY = "project-token:selected-wallet";

function walletKey(detail: WalletProviderDetail): string {
  return `${detail.info.rdns.toLowerCase()}:${detail.info.uuid}`;
}

function sameProviderExists(provider: Eip1193Provider): boolean {
  return [...wallets.values()].some((wallet) => wallet.provider === provider);
}

function emitWallets(): void {
  const current = getDiscoveredWallets();
  listeners.forEach((listener) => listener(current));
}

function addWallet(detail: WalletProviderDetail): void {
  if (sameProviderExists(detail.provider)) return;
  wallets.set(walletKey(detail), detail);
  emitWallets();
}

function legacyWalletName(provider: Eip1193Provider): { name: string; rdns: string } {
  if (provider.isRabby) return { name: "Rabby Wallet", rdns: "io.rabby" };
  if (provider.isZerion) return { name: "Zerion Wallet", rdns: "io.zerion.wallet" };
  if (provider.isPhantom) return { name: "Phantom", rdns: "app.phantom" };
  if (provider.isMetaMask) return { name: "MetaMask", rdns: "io.metamask" };
  return { name: "Browser wallet", rdns: "legacy.browser.wallet" };
}

function addLegacyProvider(provider: Eip1193Provider | undefined, index: number): void {
  if (!provider || sameProviderExists(provider)) return;
  const identity = legacyWalletName(provider);
  addWallet({
    info: {
      uuid: `legacy-${identity.rdns}-${index}`,
      name: identity.name,
      rdns: identity.rdns,
    },
    provider,
    source: "injected",
  });
}

function addLegacyWallets(): void {
  const ethereum = window.ethereum;
  const legacyProviders = ethereum?.providers?.length ? ethereum.providers : [ethereum];
  legacyProviders.forEach((provider, index) => addLegacyProvider(provider, index));
  addLegacyProvider(window.phantom?.ethereum, legacyProviders.length);
  addLegacyProvider(window.rabby, legacyProviders.length + 1);
  addLegacyProvider(window.zerionWallet, legacyProviders.length + 2);
}

function startDiscovery(): void {
  if (discoveryStarted) return;
  discoveryStarted = true;

  window.addEventListener("eip6963:announceProvider", ((event: CustomEvent<Eip6963Detail>) => {
    const detail = event.detail;
    if (!detail?.provider || !detail.info?.uuid || !detail.info?.name || !detail.info?.rdns) return;
    addWallet({
      info: {
        uuid: detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon,
        rdns: detail.info.rdns,
      },
      provider: detail.provider,
      source: "injected",
    });
  }) as EventListener);

  window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.setTimeout(addLegacyWallets, 250);
}

export function getDiscoveredWallets(): WalletProviderDetail[] {
  return [...wallets.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
}

export function watchInjectedWallets(listener: (wallets: WalletProviderDetail[]) => void): () => void {
  listeners.add(listener);
  startDiscovery();
  listener(getDiscoveredWallets());
  return () => listeners.delete(listener);
}

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: number }).code;
  const nested = (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
  return direct ?? nested;
}

function isPhantom(detail: WalletProviderDetail): boolean {
  const identity = `${detail.info.name} ${detail.info.rdns}`.toLowerCase();
  return identity.includes("phantom") || Boolean(detail.provider.isPhantom);
}

export async function ensureRobinhoodChain(provider: Eip1193Provider, wallet?: WalletProviderDetail): Promise<void> {
  const currentChain = await provider.request({ method: "eth_chainId" }).catch(() => undefined);
  if (typeof currentChain === "string" && currentChain.toLowerCase() === robinhoodChain.hexId) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: robinhoodChain.hexId }],
    });
    return;
  } catch (switchError) {
    if (errorCode(switchError) === 4001) throw new Error("You cancelled the network switch");
  }

  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: robinhoodChain.hexId,
        chainName: robinhoodChain.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [robinhoodChain.rpcUrl],
        blockExplorerUrls: [robinhoodChain.explorer],
      }],
    });
    const addedChain = await provider.request({ method: "eth_chainId" }).catch(() => undefined);
    if (typeof addedChain === "string" && addedChain.toLowerCase() !== robinhoodChain.hexId) {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: robinhoodChain.hexId }],
      });
    }
  } catch (addError) {
    if (errorCode(addError) === 4001) throw new Error("You cancelled adding Robinhood Chain");
    if (wallet && isPhantom(wallet)) {
      throw new Error("Phantom currently does not support Robinhood Chain. Use Zerion, Rabby or MetaMask for this network.");
    }
    throw new Error("This wallet could not add Robinhood Chain. Add network 4663 in the wallet and try again.");
  }
}

export async function connectInjectedWallet(wallet: WalletProviderDetail): Promise<ConnectedWallet> {
  const accounts = await wallet.provider.request({ method: "eth_requestAccounts" }) as Address[];
  if (!accounts[0]) throw new Error("The wallet did not return an account");
  await ensureRobinhoodChain(wallet.provider, wallet);
  activeWallet = wallet;
  localStorage.setItem(SAVED_WALLET_KEY, wallet.info.rdns);
  return { account: accounts[0], wallet };
}

export async function connectMobileWallet(projectId: string): Promise<ConnectedWallet> {
  if (!projectId.trim()) {
    throw new Error("Mobile wallet connection is not activated yet. Add a Reown Project ID before launch.");
  }

  if (!walletConnectProvider) {
    const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
    walletConnectProvider = await EthereumProvider.init({
      projectId,
      chains: [robinhoodChain.id],
      showQrModal: true,
      rpcMap: { [robinhoodChain.id]: robinhoodChain.rpcUrl },
      metadata: {
        name: "ProjectToken",
        description: "Passive MSTR rewards on Robinhood Chain",
        url: window.location.origin,
        icons: [],
      },
      qrModalOptions: {
        themeMode: "dark",
        themeVariables: { "--wcm-accent-color": "#7effad" },
      },
    }) as Eip1193Provider;
  }

  const accounts = walletConnectProvider.enable
    ? await walletConnectProvider.enable() as Address[]
    : await walletConnectProvider.request({ method: "eth_requestAccounts" }) as Address[];
  if (!accounts[0]) throw new Error("The mobile wallet did not return an account");
  const wallet: WalletProviderDetail = {
    info: { uuid: "walletconnect", name: "Mobile wallet", rdns: "org.walletconnect" },
    provider: walletConnectProvider,
    source: "walletconnect",
  };
  await ensureRobinhoodChain(walletConnectProvider, wallet);
  activeWallet = wallet;
  localStorage.setItem(SAVED_WALLET_KEY, wallet.info.rdns);
  return { account: accounts[0], wallet };
}

export async function restoreWallet(): Promise<ConnectedWallet | undefined> {
  const savedRdns = localStorage.getItem(SAVED_WALLET_KEY);
  if (!savedRdns || savedRdns === "org.walletconnect") return undefined;
  startDiscovery();
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  const wallet = getDiscoveredWallets().find((candidate) => candidate.info.rdns === savedRdns);
  if (!wallet) return undefined;
  const accounts = await wallet.provider.request({ method: "eth_accounts" }) as Address[];
  if (!accounts[0]) return undefined;
  activeWallet = wallet;
  return { account: accounts[0], wallet };
}

export function getActiveWalletProvider(): Eip1193Provider {
  if (!activeWallet) throw new Error("Wallet is not connected");
  return activeWallet.provider;
}

export function watchConnectedWallet(
  wallet: WalletProviderDetail,
  onAccountsChanged: (accounts: Address[]) => void,
  onDisconnect: () => void,
): () => void {
  const accountsHandler = (...args: unknown[]) => onAccountsChanged((args[0] ?? []) as Address[]);
  const disconnectHandler = () => onDisconnect();
  wallet.provider.on?.("accountsChanged", accountsHandler);
  wallet.provider.on?.("disconnect", disconnectHandler);
  return () => {
    wallet.provider.removeListener?.("accountsChanged", accountsHandler);
    wallet.provider.removeListener?.("disconnect", disconnectHandler);
  };
}

export async function disconnectWallet(): Promise<void> {
  const wallet = activeWallet;
  activeWallet = undefined;
  localStorage.removeItem(SAVED_WALLET_KEY);
  if (wallet?.source === "walletconnect") {
    await wallet.provider.disconnect?.();
    walletConnectProvider = undefined;
  }
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] };
    phantom?: { ethereum?: Eip1193Provider };
    rabby?: Eip1193Provider;
    zerionWallet?: Eip1193Provider;
  }
}
