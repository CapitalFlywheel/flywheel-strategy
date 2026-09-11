import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi } from "viem";

const ACTIONS = {
  ACCUMULATE: 0,
  BUYBACK_HOLD: 1,
  BUYBACK_BURN: 2,
  BUYBACK_LOCK: 3,
  LOCK_MSTR: 4,
  MARKETING_SALE: 5,
};
const LOCKS = {
  "1_MONTH": 30 * 86400,
  "3_MONTHS": 90 * 86400,
  "6_MONTHS": 180 * 86400,
  "1_YEAR": 365 * 86400,
  "2_YEARS": 730 * 86400,
  "3_YEARS": 1095 * 86400,
  "5_YEARS": 1825 * 86400,
  FOREVER: 0xffffffff,
};
const abi = parseAbi([
  "function activeProposalId() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function createProposal(bytes32 weightRoot,uint128 totalAvailableWeight,uint32 votingDuration,(uint8 action,uint16 reserveBps,uint128 reserveAmount,uint32 lockDuration,address recipient)[] options) returns (uint256 proposalId)",
]);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const governance = getAddress(required("GOVERNANCE_ADDRESS"));
const team = getAddress(required("TEAM_ADDRESS"));
const snapshotPath = process.env.GOVERNANCE_SNAPSHOT_OUTPUT || "data/public/governance/latest-weights.json";
const optionsPath = process.env.GOVERNANCE_OPTIONS_FILE || "governance-options.json";
const durationHours = Number(process.env.VOTING_DURATION_HOURS || "6");
if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 12) throw new Error("VOTING_DURATION_MUST_BE_1_TO_12_HOURS");

const [snapshot, inputOptions] = await Promise.all([
  readFile(snapshotPath, "utf8").then(JSON.parse),
  readFile(optionsPath, "utf8").then(JSON.parse),
]);
if (!Array.isArray(inputOptions) || inputOptions.length < 2 || inputOptions.length > 6) throw new Error("OPTIONS_MUST_CONTAIN_2_TO_6_ITEMS");
const seen = new Set();
const options = inputOptions.map((option) => {
  const action = ACTIONS[option.action];
  if (action === undefined || seen.has(action)) throw new Error(`INVALID_OR_DUPLICATE_ACTION_${option.action}`);
  seen.add(action);
  const reserveBps = option.action === "ACCUMULATE" ? 0 : Number(option.reservePercent) * 100;
  if (!Number.isInteger(reserveBps) || reserveBps < 0 || reserveBps > 10_000) throw new Error("RESERVE_PERCENT_MUST_BE_0_TO_100");
  const lockDuration = option.lock ? LOCKS[option.lock] : 0;
  if (option.lock && lockDuration === undefined) throw new Error(`INVALID_LOCK_${option.lock}`);
  let recipient = "0x0000000000000000000000000000000000000000";
  if (option.action === "MARKETING_SALE") {
    recipient = getAddress(required("MARKETING_WALLET_ADDRESS"));
    if (option.recipient && getAddress(option.recipient) !== recipient) {
      throw new Error("MARKETING_RECIPIENT_MUST_MATCH_THE_PUBLISHED_WALLET");
    }
  } else if (option.recipient) {
    throw new Error(`RECIPIENT_NOT_ALLOWED_FOR_${option.action}`);
  }
  return {
    action,
    reserveBps,
    reserveAmount: 0n,
    lockDuration,
    recipient,
  };
});
const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com") });
const [active, proposalCount] = await Promise.all([
  client.readContract({ address: governance, abi, functionName: "activeProposalId" }),
  client.readContract({ address: governance, abi, functionName: "proposalCount" }),
]);
if (active !== 0n) throw new Error(`PROPOSAL_${active}_IS_STILL_ACTIVE`);
const expectedProposalId = proposalCount + 1n;
const data = encodeFunctionData({
  abi,
  functionName: "createProposal",
  args: [snapshot.merkleRoot, BigInt(snapshot.totalAvailableWeight), durationHours * 3600, options],
});
const prepared = {
  chainId: 4663,
  expectedProposalId: expectedProposalId.toString(),
  from: team,
  to: governance,
  value: "0",
  data,
  snapshot: snapshotPath,
  options: inputOptions,
  durationHours,
  safety: "UNSIGNED_ONLY_TEAM_MUST_REVIEW_OPTIONS",
};
const publicPath = `${process.env.PUBLIC_GOVERNANCE_DIR || "data/public/governance"}/proposal-${expectedProposalId}.json`;
await mkdir(dirname(publicPath), { recursive: true });
await writeFile(publicPath, JSON.stringify({ ...prepared, weightSnapshot: snapshot }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
console.log(JSON.stringify({ ...prepared, publicPath }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
