const { ethers } = require("hardhat");
const { access, mkdir, writeFile } = require("node:fs/promises");

const ADDRESSES = {
  mstr: "0xec262a75e413fAfD0dF80480274532C79D42da09",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"
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

async function main() {
  try {
    await access("deployments/prelaunch-4663.json");
    throw new Error("PRELAUNCH_ALREADY_DEPLOYED_REMOVE_FILE_ONLY_AFTER_MANUAL_ONCHAIN_CHECK");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 4663n) throw new Error("PRODUCTION_DEPLOYMENT_REQUIRES_ROBINHOOD_MAINNET");
  const expectedDeployer = ethers.getAddress(required("LAUNCHER_ADDRESS"));
  if (deployer.address.toLowerCase() !== expectedDeployer.toLowerCase()) {
    throw new Error(`WRONG_DEPLOYER_EXPECTED_${expectedDeployer}`);
  }
  const automation = ethers.getAddress(required("AUTOMATION_ADDRESS"));
  const rootPublisher = ethers.getAddress(required("ROOT_PUBLISHER_ADDRESS"));

  const rewardVault = await deploy("RewardVault", deployer.address, rootPublisher, ADDRESSES.mstr);
  const reserveVault = await deploy("StrategicReserveVault", deployer.address, deployer.address, ADDRESSES.mstr);
  const keeperVault = await deploy(
    "KeeperVault", deployer.address, automation, process.env.MAX_KEEPER_REIMBURSEMENT_WEI || ethers.parseEther("0.02")
  );
  if (rootPublisher.toLowerCase() !== automation.toLowerCase()) {
    await (await keeperVault.grantRole(await keeperVault.AUTOMATION_ROLE(), rootPublisher)).wait();
  }
  const v4Adapter = await deploy(
    "UniswapV4MstrSwapAdapter", ADDRESSES.universalRouter, ADDRESSES.weth, ADDRESSES.usdg, ADDRESSES.mstr
  );
  const v3Adapter = await deploy(
    "UniswapV3MstrSwapAdapter", ADDRESSES.universalRouter, ADDRESSES.weth, ADDRESSES.mstr
  );
  const feeRouter = await deploy(
    "FeeRouter", deployer.address, automation, await rewardVault.getAddress(), await reserveVault.getAddress(),
    await keeperVault.getAddress(), await v4Adapter.getAddress()
  );
  await (await feeRouter.setSwapAdapterAllowed(await v3Adapter.getAddress(), true)).wait();
  const ponsFeeCollector = await deploy("PonsFeeCollector", ADDRESSES.feeEscrow, await feeRouter.getAddress());

  const result = {
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    automation,
    rootPublisher,
    ...ADDRESSES,
    rewardVault: await rewardVault.getAddress(),
    reserveVault: await reserveVault.getAddress(),
    keeperVault: await keeperVault.getAddress(),
    v4MstrAdapter: await v4Adapter.getAddress(),
    v3MstrAdapter: await v3Adapter.getAddress(),
    feeRouter: await feeRouter.getAddress(),
    ponsFeeCollector: await ponsFeeCollector.getAddress(),
    feeCollectorVersion: "SWEEP_CAPABLE_V2",
    status: "PRELAUNCH_DEPLOYED_READY_FOR_MANUAL_PONS_LAUNCH"
  };
  await mkdir("deployments", { recursive: true });
  await writeFile("deployments/prelaunch-4663.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
