const { ethers } = require("hardhat");
const { access, mkdir, readFile, writeFile } = require("node:fs/promises");

const INFRA = {
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  ponsFactory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  ponsHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  v3Quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94"
};

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function deploy(name, ...args) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function moveAdmin(contract, deployer, finalAdmin) {
  if (deployer.toLowerCase() === finalAdmin.toLowerCase()) return;
  const role = await contract.DEFAULT_ADMIN_ROLE();
  await (await contract.grantRole(role, finalAdmin)).wait();
  await (await contract.revokeRole(role, deployer)).wait();
}

async function main() {
  try {
    await access("deployments/mainnet-4663.json");
    throw new Error("POSTLAUNCH_ALREADY_DEPLOYED_REMOVE_FILE_ONLY_AFTER_MANUAL_ONCHAIN_CHECK");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 4663n) throw new Error("PRODUCTION_DEPLOYMENT_REQUIRES_ROBINHOOD_MAINNET");
  const pre = JSON.parse(await readFile("deployments/prelaunch-4663.json", "utf8"));
  const launchRecord = JSON.parse(await readFile("deployments/pons-launch-4663.json", "utf8"));
  if (pre.deployer.toLowerCase() !== deployer.address.toLowerCase()) throw new Error("WRONG_PRELAUNCH_DEPLOYER");
  const projectToken = ethers.getAddress(required("PROJECT_TOKEN_ADDRESS"));
  if (launchRecord.token.toLowerCase() !== projectToken.toLowerCase()) throw new Error("WRONG_RECORDED_PONS_TOKEN");
  if (pre.feeCollectorVersion !== "SWEEP_CAPABLE_V2") throw new Error("OLD_FEE_COLLECTOR_NOT_ALLOWED");
  const team = ethers.getAddress(required("TEAM_ADDRESS"));
  const finalAdmin = ethers.getAddress(required("FINAL_ADMIN_ADDRESS"));
  const marketingWallet = ethers.getAddress(required("MARKETING_WALLET_ADDRESS"));

  const launched = await ethers.getContractAt([
    "function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"
  ], INFRA.ponsFactory);
  const launch = await launched.getLaunchedToken(projectToken);
  if (!launch.exists || launch.creatorFeeRecipient.toLowerCase() !== pre.ponsFeeCollector.toLowerCase()) {
    throw new Error("PROJECT_TOKEN_IS_NOT_THE_EXPECTED_PONS_LAUNCH");
  }

  const holdVault = await deploy("ProjectTokenHoldVault", projectToken);
  const lockVault = await deploy("ProjectTokenTimeLockVault", deployer.address, projectToken, await holdVault.getAddress());
  const reserveAdapter = await deploy(
    "RobinhoodReserveActionAdapter", deployer.address, pre.mstr, projectToken, pre.weth, pre.universalRouter,
    INFRA.permit2, INFRA.ponsFactory, INFRA.ponsHook, INFRA.v3Quoter, INFRA.v4Quoter
  );
  const executor = await deploy(
    "RestrictedExecutor", deployer.address, pre.reserveVault, await reserveAdapter.getAddress(),
    await holdVault.getAddress(), await lockVault.getAddress(), marketingWallet
  );
  const governance = await deploy("GovernanceController", deployer.address, team, await executor.getAddress());
  await (await reserveAdapter.initializeExecutor(await executor.getAddress())).wait();
  await (await lockVault.initializeExecutor(await executor.getAddress())).wait();
  await (await executor.initializeGovernance(await governance.getAddress())).wait();

  const reserveVault = await ethers.getContractAt("StrategicReserveVault", pre.reserveVault);
  const executorRole = await reserveVault.EXECUTOR_ROLE();
  await (await reserveVault.grantRole(executorRole, await executor.getAddress())).wait();
  await (await reserveVault.revokeRole(executorRole, deployer.address)).wait();

  const accessContracts = [
    await ethers.getContractAt("RewardVault", pre.rewardVault),
    reserveVault,
    await ethers.getContractAt("KeeperVault", pre.keeperVault),
    await ethers.getContractAt("FeeRouter", pre.feeRouter),
    governance
  ];
  for (const contract of accessContracts) await moveAdmin(contract, deployer.address, finalAdmin);

  const result = {
    ...pre,
    projectToken,
    team,
    finalAdmin,
    marketingWallet,
    projectHoldVault: await holdVault.getAddress(),
    projectTokenLockVault: await lockVault.getAddress(),
    reserveActionAdapter: await reserveAdapter.getAddress(),
    restrictedExecutor: await executor.getAddress(),
    governance: await governance.getAddress(),
    status: "CORE_DEPLOYED_REQUIRES_PUBLIC_VERIFICATION_AND_AUDIT"
  };
  await writeFile("deployments/mainnet-4663.json", JSON.stringify(result, null, 2));
  await mkdir("data/public", { recursive: true });
  await writeFile("data/public/config.json", JSON.stringify({
    chainId: 4663,
    projectToken,
    mstr: pre.mstr,
    rewardVault: pre.rewardVault,
    reserveVault: pre.reserveVault,
    keeperVault: pre.keeperVault,
    feeRouter: pre.feeRouter,
    ponsFeeCollector: pre.ponsFeeCollector,
    governance: await governance.getAddress(),
    restrictedExecutor: await executor.getAddress(),
    projectHoldVault: await holdVault.getAddress(),
    projectTokenLockVault: await lockVault.getAddress(),
    marketingWallet,
    team,
    finalAdmin
  }, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
