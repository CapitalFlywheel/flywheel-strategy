const { ethers } = require("hardhat");
const { mkdir, writeFile } = require("node:fs/promises");

async function deploy(name, ...args) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 46630n) throw new Error("THIS_REHEARSAL_IS_ONLY_FOR_ROBINHOOD_CHAIN_TESTNET");
  const team = ethers.getAddress(process.env.TEAM_ADDRESS || deployer.address);
  const marketingWallet = ethers.getAddress(process.env.MARKETING_WALLET_ADDRESS || deployer.address);
  const automation = ethers.getAddress(process.env.AUTOMATION_ADDRESS || deployer.address);
  const rootPublisher = ethers.getAddress(process.env.ROOT_PUBLISHER_ADDRESS || deployer.address);

  const mstr = await deploy("MockERC20", "Testnet MSTR Mock", "tMSTR");
  const projectToken = await deploy("MockERC20", "ProjectToken Test", "tPTKN");
  const rewardVault = await deploy("RewardVault", deployer.address, rootPublisher, await mstr.getAddress());
  const reserveVault = await deploy("StrategicReserveVault", deployer.address, deployer.address, await mstr.getAddress());
  const keeperVault = await deploy("KeeperVault", deployer.address, automation, ethers.parseEther("0.02"));
  const mstrAdapter = await deploy("MockMstrSwapAdapter", await mstr.getAddress(), ethers.parseEther("20"));
  const feeRouter = await deploy(
    "FeeRouter", deployer.address, automation, await rewardVault.getAddress(), await reserveVault.getAddress(),
    await keeperVault.getAddress(), await mstrAdapter.getAddress()
  );
  const feeEscrow = await deploy("MockPonsV2FeeEscrow");
  const feeCollector = await deploy("PonsFeeCollector", await feeEscrow.getAddress(), await feeRouter.getAddress());
  const holdVault = await deploy("ProjectTokenHoldVault", await projectToken.getAddress());
  const lockVault = await deploy("ProjectTokenTimeLockVault", deployer.address, await projectToken.getAddress(), await holdVault.getAddress());
  const reserveAdapter = await deploy("MockReserveActionAdapter", await mstr.getAddress(), await projectToken.getAddress(), 2);
  const executor = await deploy(
    "RestrictedExecutor", deployer.address, await reserveVault.getAddress(), await reserveAdapter.getAddress(),
    await holdVault.getAddress(), await lockVault.getAddress(), marketingWallet
  );
  const governance = await deploy("GovernanceController", deployer.address, team, await executor.getAddress());
  await (await executor.initializeGovernance(await governance.getAddress())).wait();
  await (await lockVault.initializeExecutor(await executor.getAddress())).wait();
  await (await reserveVault.grantRole(await reserveVault.EXECUTOR_ROLE(), await executor.getAddress())).wait();
  await (await reserveVault.revokeRole(await reserveVault.EXECUTOR_ROLE(), deployer.address)).wait();

  const result = {
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    team,
    marketingWallet,
    automation,
    rootPublisher,
    mstr: await mstr.getAddress(),
    projectToken: await projectToken.getAddress(),
    rewardVault: await rewardVault.getAddress(),
    reserveVault: await reserveVault.getAddress(),
    keeperVault: await keeperVault.getAddress(),
    feeRouter: await feeRouter.getAddress(),
    ponsFeeCollector: await feeCollector.getAddress(),
    mockPonsFeeEscrow: await feeEscrow.getAddress(),
    governance: await governance.getAddress(),
    restrictedExecutor: await executor.getAddress(),
    projectHoldVault: await holdVault.getAddress(),
    projectTokenLockVault: await lockVault.getAddress(),
    warning: "PONS_MSTR_AND_EXCHANGE_LIQUIDITY_ARE_MOCKED_ON_TESTNET_USE_MAINNET_FORK_FOR_ROUTE_FIDELITY"
  };
  await mkdir("deployments", { recursive: true });
  await writeFile("deployments/testnet-46630.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
