const { ethers } = require("hardhat");

async function deploy(name, ...args) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const [deployer, team, automation, rootPublisher, holdVault, tokenLockVault] =
    await ethers.getSigners();

  const mstr = await deploy("MockERC20", "Mock MSTR", "MSTR");
  const projectToken = await deploy("MockERC20", "ProjectToken", "PTKN");
  const keeperVault = await deploy(
    "KeeperVault",
    deployer.address,
    automation.address,
    ethers.parseEther("0.02")
  );
  const rewardVault = await deploy(
    "RewardVault",
    deployer.address,
    rootPublisher.address,
    await mstr.getAddress()
  );
  const reserveVault = await deploy(
    "StrategicReserveVault",
    deployer.address,
    deployer.address,
    await mstr.getAddress()
  );
  const mstrSwapAdapter = await deploy(
    "MockMstrSwapAdapter",
    await mstr.getAddress(),
    ethers.parseEther("20")
  );
  const feeRouter = await deploy(
    "FeeRouter",
    deployer.address,
    automation.address,
    await rewardVault.getAddress(),
    await reserveVault.getAddress(),
    await keeperVault.getAddress(),
    await mstrSwapAdapter.getAddress()
  );
  const ponsFeeEscrow = await deploy("MockPonsV2FeeEscrow");
  const ponsFeeCollector = await deploy(
    "PonsFeeCollector",
    await ponsFeeEscrow.getAddress(),
    await feeRouter.getAddress()
  );
  const reserveActionAdapter = await deploy(
    "MockReserveActionAdapter",
    await mstr.getAddress(),
    await projectToken.getAddress(),
    2
  );
  const executor = await deploy(
    "RestrictedExecutor",
    deployer.address,
    await reserveVault.getAddress(),
    await reserveActionAdapter.getAddress(),
    holdVault.address,
    tokenLockVault.address,
    team.address
  );
  const governance = await deploy(
    "GovernanceController",
    deployer.address,
    team.address,
    await executor.getAddress()
  );

  await (await executor.initializeGovernance(await governance.getAddress())).wait();
  const executorRole = await reserveVault.EXECUTOR_ROLE();
  await (await reserveVault.grantRole(executorRole, await executor.getAddress())).wait();
  await (await reserveVault.revokeRole(executorRole, deployer.address)).wait();

  const addresses = {
    mstr: await mstr.getAddress(),
    projectToken: await projectToken.getAddress(),
    feeRouter: await feeRouter.getAddress(),
    rewardVault: await rewardVault.getAddress(),
    reserveVault: await reserveVault.getAddress(),
    keeperVault: await keeperVault.getAddress(),
    governance: await governance.getAddress(),
    executor: await executor.getAddress(),
    mstrSwapAdapter: await mstrSwapAdapter.getAddress(),
    reserveActionAdapter: await reserveActionAdapter.getAddress(),
    ponsFeeEscrow: await ponsFeeEscrow.getAddress(),
    ponsFeeCollector: await ponsFeeCollector.getAddress()
  };

  console.log(JSON.stringify(addresses, null, 2));
  console.log("Local-only deployment complete. Both adapters are mocks.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
