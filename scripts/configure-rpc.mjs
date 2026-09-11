import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function setValue(path, key, value) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const next = lines.filter((line) => !line.startsWith(`${key}=`));
  next.push(`${key}=${value}`);
  await writeFile(path, `${next.join("\n")}\n`);
}

async function rpc(endpoint, method) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error || !payload.result) throw new Error(payload.error?.message || "RPC returned no result");
  return payload.result;
}

const prompt = createInterface({ input, output });
try {
  console.log("\nНастройка подключения к Robinhood Chain Mainnet");
  console.log("Откройте Alchemy → Endpoints → Robinhood Chain Mainnet → HTTPS и скопируйте полный адрес.\n");
  const primary = (await prompt.question("Вставьте HTTPS Endpoint Alchemy: ")).trim();
  const parsed = new URL(primary);
  if (parsed.protocol !== "https:") throw new Error("Нужен HTTPS-адрес");
  const transferSource = parsed.hostname.endsWith(".alchemy.com") ? "alchemy" : "logs";

  console.log("Проверяю подключение...");
  const chainId = await rpc(primary, "eth_chainId");
  if (BigInt(chainId) !== 4663n) throw new Error("Этот адрес подключён не к Robinhood Chain Mainnet");
  await rpc(primary, "eth_blockNumber");

  const fallback = (await prompt.question("Запасной RPC пока можно пропустить — нажмите Enter: ")).trim();
  if (fallback) {
    const fallbackChainId = await rpc(fallback, "eth_chainId");
    if (BigInt(fallbackChainId) !== 4663n) throw new Error("Запасной RPC подключён не к Robinhood Chain Mainnet");
  }

  for (const path of [".env", ".env.rpc"]) {
    await setValue(path, "ROBINHOOD_RPC_URL", primary);
    await setValue(path, "ROBINHOOD_RPC_FALLBACK_URL", fallback);
    await setValue(path, "TRANSFER_SOURCE", transferSource);
    await setValue(path, "INDEXER_CONFIRMATIONS", "1000");
  }
  console.log("\nГотово. Alchemy проверен и сохранён в закрытые файлы .env и .env.rpc.");
} catch (error) {
  console.error(`\nНастройка не завершена: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  prompt.close();
}
