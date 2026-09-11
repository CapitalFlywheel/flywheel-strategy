const { expect } = require("chai");
const { ethers } = require("hardhat");

function standardLeaf(account, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, amount])
  );
  return ethers.keccak256(ethers.concat([inner]));
}

describe("MSTR strategy core", function () {
  it("always splits every wei exactly into 50/40/10 without creating value", async function () {
    const [admin, automation, keeper, rewardVault, reserveVault] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const mstr = await Token.deploy("Mock MSTR", "MSTR");
    const Adapter = await ethers.getContractFactory("MockMstrSwapAdapter");
    const adapter = await Adapter.deploy(await mstr.getAddress(), 1);
    const Router = await ethers.getContractFactory("FeeRouter");
    const router = await Router.deploy(
      admin.address, automation.address, rewardVault.address, reserveVault.address, keeper.address, await adapter.getAddress()
    );
    for (let amount = 1n; amount <= 97n; amount += 1n) {
      const keeperBefore = await ethers.provider.getBalance(keeper.address);
      await admin.sendTransaction({ to: await router.getAddress(), value: amount });
      await router.allocate();
      const reward = amount * 5_000n / 10_000n;
      const reserve = amount * 4_000n / 10_000n;
      expect((await ethers.provider.getBalance(keeper.address)) - keeperBefore).to.equal(amount - reward - reserve);
    }
    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(
      await router.pendingRewardEth() + await router.pendingReserveEth()
    );
  });

  it("splits creator fees 50/40/10 and buys MSTR into separate vaults", async function () {
    const [admin, automation, keeper, rewardVault, reserveVault] = await ethers.getSigners();
    const Mstr = await ethers.getContractFactory("MockERC20");
    const mstr = await Mstr.deploy("Mock MSTR", "MSTR");
    const Adapter = await ethers.getContractFactory("MockMstrSwapAdapter");
    const adapter = await Adapter.deploy(await mstr.getAddress(), ethers.parseEther("20"));
    const Router = await ethers.getContractFactory("FeeRouter");
    const router = await Router.deploy(
      admin.address,
      automation.address,
      rewardVault.address,
      reserveVault.address,
      keeper.address,
      await adapter.getAddress()
    );

    const keeperBefore = await ethers.provider.getBalance(keeper.address);
    await admin.sendTransaction({ to: await router.getAddress(), value: ethers.parseEther("10") });
    await router.allocate();

    expect(await router.pendingRewardEth()).to.equal(ethers.parseEther("5"));
    expect(await router.pendingReserveEth()).to.equal(ethers.parseEther("4"));
    expect((await ethers.provider.getBalance(keeper.address)) - keeperBefore).to.equal(ethers.parseEther("1"));

    await router.connect(automation).buyRewardMstr(ethers.parseEther("5"), ethers.parseEther("99"));
    await router.connect(automation).buyReserveMstr(ethers.parseEther("4"), ethers.parseEther("79"));
    expect(await mstr.balanceOf(rewardVault.address)).to.equal(ethers.parseEther("100"));
    expect(await mstr.balanceOf(reserveVault.address)).to.equal(ethers.parseEther("80"));
  });

  it("allows cumulative MSTR claims without staking", async function () {
    const [admin, publisher, holder] = await ethers.getSigners();
    const Mstr = await ethers.getContractFactory("MockERC20");
    const mstr = await Mstr.deploy("Mock MSTR", "MSTR");
    const Vault = await ethers.getContractFactory("RewardVault");
    const vault = await Vault.deploy(admin.address, publisher.address, await mstr.getAddress());

    const amount = ethers.parseEther("12.5");
    await mstr.mint(await vault.getAddress(), amount);
    const root = standardLeaf(holder.address, amount);
    await vault.connect(publisher).publishDistribution(1, root, amount);
    await vault.connect(holder).claim(amount, []);

    expect(await mstr.balanceOf(holder.address)).to.equal(amount);
    expect(await vault.claimed(holder.address)).to.equal(amount);
    await expect(vault.connect(holder).claim(amount, [])).to.be.revertedWithCustomError(vault, "NothingToClaim");
  });

  it("uses 7% quorum and executes the winning allowlisted option after five minutes", async function () {
    const [admin, team, holder, marketing] = await ethers.getSigners();
    const Executor = await ethers.getContractFactory("MockGovernanceExecutor");
    const executor = await Executor.deploy();
    await executor.setMarketingWallet(marketing.address);
    const Governance = await ethers.getContractFactory("GovernanceController");
    const governance = await Governance.deploy(admin.address, team.address, await executor.getAddress());

    const weight = 8n;
    const root = standardLeaf(holder.address, weight);
    const options = [
      { action: 0, reserveBps: 0, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress },
      { action: 2, reserveBps: 10000, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress },
      { action: 5, reserveBps: 500, reserveAmount: 0, lockDuration: 0, recipient: marketing.address }
    ];
    await governance.connect(team).createProposal(root, 100, 3600, options);
    await governance.connect(holder).vote(1, 1, weight, []);

    await ethers.provider.send("evm_increaseTime", [3600 + 300]);
    await ethers.provider.send("evm_mine");
    await governance.execute(1);

    const proposal = await governance.proposals(1);
    expect(proposal.passed).to.equal(true);
    expect(proposal.winningOption).to.equal(1);
    expect(await executor.lastReserveBps()).to.equal(10000);
    expect(await executor.lastReserveAmount()).to.equal(1000);
    expect(await executor.lastAction()).to.equal(2);
  });

  it("rejects a result below the 7% quorum", async function () {
    const [admin, team, holder] = await ethers.getSigners();
    const Executor = await ethers.getContractFactory("MockGovernanceExecutor");
    const executor = await Executor.deploy();
    const Governance = await ethers.getContractFactory("GovernanceController");
    const governance = await Governance.deploy(admin.address, team.address, await executor.getAddress());

    const weight = 6n;
    const root = standardLeaf(holder.address, weight);
    const options = [
      { action: 0, reserveBps: 0, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress },
      { action: 2, reserveBps: 10000, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress }
    ];
    await governance.connect(team).createProposal(root, 100, 3600, options);
    await governance.connect(holder).vote(1, 1, weight, []);
    await ethers.provider.send("evm_increaseTime", [3600 + 300]);
    await ethers.provider.send("evm_mine");
    await governance.execute(1);

    expect((await governance.proposals(1)).passed).to.equal(false);
    expect(await executor.executions()).to.equal(0);
  });

  it("rejects a tied vote instead of letting option order decide", async function () {
    const [admin, team, holderA, holderB] = await ethers.getSigners();
    const Executor = await ethers.getContractFactory("MockGovernanceExecutor");
    const executor = await Executor.deploy();
    const Governance = await ethers.getContractFactory("GovernanceController");
    const governance = await Governance.deploy(admin.address, team.address, await executor.getAddress());
    const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
    const tree = StandardMerkleTree.of([[holderA.address, "50"], [holderB.address, "50"]], ["address", "uint256"]);
    const proofFor = (account) => {
      for (const [index, value] of tree.entries()) {
        if (value[0].toLowerCase() === account.toLowerCase()) return tree.getProof(index);
      }
      throw new Error("missing proof");
    };
    await governance.connect(team).createProposal(tree.root, 100, 3600, [
      { action: 0, reserveBps: 0, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress },
      { action: 2, reserveBps: 10000, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress }
    ]);
    await governance.connect(holderA).vote(1, 0, 50, proofFor(holderA.address));
    await governance.connect(holderB).vote(1, 1, 50, proofFor(holderB.address));
    await ethers.provider.send("evm_increaseTime", [3900]);
    await ethers.provider.send("evm_mine");
    await governance.execute(1);
    expect((await governance.proposals(1)).passed).to.equal(false);
    expect(await executor.executions()).to.equal(0);
  });

  it("cannot start a marketing vote with a substituted wallet", async function () {
    const [admin, team, publishedMarketing, substitutedMarketing] = await ethers.getSigners();
    const Executor = await ethers.getContractFactory("MockGovernanceExecutor");
    const executor = await Executor.deploy();
    await executor.setMarketingWallet(publishedMarketing.address);
    const Governance = await ethers.getContractFactory("GovernanceController");
    const governance = await Governance.deploy(admin.address, team.address, await executor.getAddress());
    await expect(governance.connect(team).createProposal(ethers.id("weights"), 100, 3600, [
      { action: 0, reserveBps: 0, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress },
      { action: 5, reserveBps: 500, reserveAmount: 0, lockDuration: 0, recipient: substitutedMarketing.address }
    ])).to.be.revertedWithCustomError(governance, "InvalidOption");
  });

  it("freezes the reserve amount when voting starts and restricts execution to governance", async function () {
    const [admin, team, holder, holdVault, lockVault, marketing] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const mstr = await Token.deploy("Mock MSTR", "MSTR");
    const projectToken = await Token.deploy("Project Token", "PTKN");
    const Reserve = await ethers.getContractFactory("StrategicReserveVault");
    const reserve = await Reserve.deploy(admin.address, admin.address, await mstr.getAddress());
    const Adapter = await ethers.getContractFactory("MockReserveActionAdapter");
    const adapter = await Adapter.deploy(await mstr.getAddress(), await projectToken.getAddress(), 2);
    const Restricted = await ethers.getContractFactory("RestrictedExecutor");
    const executor = await Restricted.deploy(
      admin.address,
      await reserve.getAddress(),
      await adapter.getAddress(),
      holdVault.address,
      lockVault.address,
      marketing.address
    );
    const Governance = await ethers.getContractFactory("GovernanceController");
    const governance = await Governance.deploy(admin.address, team.address, await executor.getAddress());
    await executor.initializeGovernance(await governance.getAddress());
    await reserve.grantRole(await reserve.EXECUTOR_ROLE(), await executor.getAddress());

    await mstr.mint(await reserve.getAddress(), 1000);
    const weight = 8n;
    const root = standardLeaf(holder.address, weight);
    const options = [
      { action: 0, reserveBps: 0, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress },
      { action: 2, reserveBps: 5000, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress }
    ];
    await governance.connect(team).createProposal(root, 100, 3600, options);
    expect((await governance.getOption(1, 1)).reserveAmount).to.equal(500);

    await mstr.mint(await reserve.getAddress(), 1000);
    await governance.connect(holder).vote(1, 1, weight, []);
    await ethers.provider.send("evm_increaseTime", [3600 + 300]);
    await ethers.provider.send("evm_mine");
    await governance.execute(1);

    expect(await adapter.lastMstrAmount()).to.equal(500);
    expect(await adapter.lastMaxSlippageBps()).to.equal(2000);
    expect(await projectToken.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(1000);
    expect(await reserve.availableBalance()).to.equal(1500);

    await expect(
      executor.executeOption(99, 0, 0, 0, 0, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(executor, "OnlyGovernance");
  });

  it("enforces a voted project-token lock before moving tokens into permanent hold custody", async function () {
    const [admin, team, holder] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const mstr = await Token.deploy("Mock MSTR", "MSTR");
    const projectToken = await Token.deploy("Project Token", "PTKN");
    const Hold = await ethers.getContractFactory("ProjectTokenHoldVault");
    const holdVault = await Hold.deploy(await projectToken.getAddress());
    const Lock = await ethers.getContractFactory("ProjectTokenTimeLockVault");
    const lockVault = await Lock.deploy(admin.address, await projectToken.getAddress(), await holdVault.getAddress());
    const Reserve = await ethers.getContractFactory("StrategicReserveVault");
    const reserve = await Reserve.deploy(admin.address, admin.address, await mstr.getAddress());
    const Adapter = await ethers.getContractFactory("MockReserveActionAdapter");
    const adapter = await Adapter.deploy(await mstr.getAddress(), await projectToken.getAddress(), 2);
    const Restricted = await ethers.getContractFactory("RestrictedExecutor");
    const executor = await Restricted.deploy(
      admin.address, await reserve.getAddress(), await adapter.getAddress(),
      await holdVault.getAddress(), await lockVault.getAddress(), team.address
    );
    const Governance = await ethers.getContractFactory("GovernanceController");
    const governance = await Governance.deploy(admin.address, team.address, await executor.getAddress());
    await executor.initializeGovernance(await governance.getAddress());
    await lockVault.initializeExecutor(await executor.getAddress());
    await reserve.grantRole(await reserve.EXECUTOR_ROLE(), await executor.getAddress());

    await mstr.mint(await reserve.getAddress(), 1_000);
    const root = standardLeaf(holder.address, 10);
    await governance.connect(team).createProposal(root, 100, 3600, [
      { action: 0, reserveBps: 0, reserveAmount: 0, lockDuration: 0, recipient: ethers.ZeroAddress },
      { action: 3, reserveBps: 5000, reserveAmount: 0, lockDuration: 30 * 86400, recipient: ethers.ZeroAddress }
    ]);
    await governance.connect(holder).vote(1, 1, 10, []);
    await ethers.provider.send("evm_increaseTime", [3900]);
    await ethers.provider.send("evm_mine");
    await governance.execute(1);

    expect(await projectToken.balanceOf(await lockVault.getAddress())).to.equal(1_000);
    await expect(lockVault.release(0)).to.be.revertedWithCustomError(lockVault, "LockNotMature");
    await ethers.provider.send("evm_increaseTime", [30 * 86400]);
    await ethers.provider.send("evm_mine");
    await lockVault.release(0);
    expect(await projectToken.balanceOf(await holdVault.getAddress())).to.equal(1_000);
  });

  it("keeps the automation budget in a capped public keeper vault", async function () {
    const [admin, automation, keeper] = await ethers.getSigners();
    const Keeper = await ethers.getContractFactory("KeeperVault");
    const vault = await Keeper.deploy(admin.address, automation.address, ethers.parseEther("0.02"));
    await admin.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") });

    await expect(
      vault.connect(automation).reimburse(ethers.id("job-too-large"), keeper.address, ethers.parseEther("0.03"))
    ).to.be.revertedWithCustomError(vault, "AmountAboveCap");

    const before = await ethers.provider.getBalance(keeper.address);
    const jobId = ethers.id("reward-epoch-1");
    await vault.connect(automation).reimburse(jobId, keeper.address, ethers.parseEther("0.01"));
    expect((await ethers.provider.getBalance(keeper.address)) - before).to.equal(ethers.parseEther("0.01"));
    await expect(
      vault.connect(automation).reimburse(jobId, keeper.address, ethers.parseEther("0.01"))
    ).to.be.revertedWithCustomError(vault, "JobAlreadyReimbursed");
  });

  it("permissionlessly collects native creator fees from the PONS escrow", async function () {
    const [caller, feeRouter] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("MockPonsV2FeeEscrow");
    const escrow = await Escrow.deploy();
    const Collector = await ethers.getContractFactory("PonsFeeCollector");
    const collector = await Collector.deploy(await escrow.getAddress(), feeRouter.address);
    const amount = ethers.parseEther("2.7");
    await escrow.credit(await collector.getAddress(), { value: amount });

    const before = await ethers.provider.getBalance(feeRouter.address);
    await collector.connect(caller).collect();
    expect((await ethers.provider.getBalance(feeRouter.address)) - before).to.equal(amount);
    expect(await escrow.balanceOf(await collector.getAddress())).to.equal(0);
  });

  it("permissionlessly sweeps pre-graduation PONS fees before collecting them", async function () {
    const [caller, feeRouter] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("MockPonsV2FeeEscrow");
    const escrow = await Escrow.deploy();
    const Collector = await ethers.getContractFactory("PonsFeeCollector");
    const collector = await Collector.deploy(await escrow.getAddress(), feeRouter.address);
    const Curve = await ethers.getContractFactory("MockPonsV2BondingCurveFeeSweep");
    const curve = await Curve.deploy(await escrow.getAddress(), await collector.getAddress());
    const amount = ethers.parseEther("2.7");
    await caller.sendTransaction({ to: await curve.getAddress(), value: amount });

    const before = await ethers.provider.getBalance(feeRouter.address);
    await collector.connect(caller).sweepCurveAndCollect(await curve.getAddress());
    expect((await ethers.provider.getBalance(feeRouter.address)) - before).to.equal(amount);
    expect(await escrow.balanceOf(await collector.getAddress())).to.equal(0);
  });

  it("rejects a curve that does not pay this collector", async function () {
    const [caller, feeRouter, wrongCreator] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("MockPonsV2FeeEscrow");
    const escrow = await Escrow.deploy();
    const Collector = await ethers.getContractFactory("PonsFeeCollector");
    const collector = await Collector.deploy(await escrow.getAddress(), feeRouter.address);
    const Curve = await ethers.getContractFactory("MockPonsV2BondingCurveFeeSweep");
    const curve = await Curve.deploy(await escrow.getAddress(), wrongCreator.address);

    await expect(
      collector.connect(caller).sweepCurveAndCollect(await curve.getAddress())
    ).to.be.revertedWithCustomError(collector, "UnexpectedCurve");
  });

  it("executes the fixed Uniswap V3 ETH-WETH-MSTR fallback route", async function () {
    const [, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const mstr = await Token.deploy("Mock MSTR", "MSTR");
    const Router = await ethers.getContractFactory("MockUniversalRouter");
    const universalRouter = await Router.deploy(await mstr.getAddress(), ethers.parseEther("5"));
    const Adapter = await ethers.getContractFactory("UniswapV3MstrSwapAdapter");
    const weth = "0x0000000000000000000000000000000000001234";
    const adapter = await Adapter.deploy(await universalRouter.getAddress(), weth, await mstr.getAddress());

    await adapter.swapExactEthForMstr(recipient.address, ethers.parseEther("4.9"), {
      value: ethers.parseEther("1")
    });
    expect(await mstr.balanceOf(recipient.address)).to.equal(ethers.parseEther("5"));
    expect(await universalRouter.lastCommands()).to.equal("0x0b00");
    expect(await universalRouter.lastPath()).to.equal(
      ethers.solidityPacked(["address", "uint24", "address"], [weth, 10000, await mstr.getAddress()])
    );
  });

  it("encodes the fixed two-hop Uniswap V4 route and sends MSTR to the vault", async function () {
    const [, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const mstr = await Token.deploy("Mock MSTR", "MSTR");
    const Router = await ethers.getContractFactory("MockUniversalRouter");
    const universalRouter = await Router.deploy(await mstr.getAddress(), ethers.parseEther("5"));
    const Adapter = await ethers.getContractFactory("UniswapV4MstrSwapAdapter");
    const weth = "0x0000000000000000000000000000000000001234";
    const usdg = "0x0000000000000000000000000000000000005678";
    const adapter = await Adapter.deploy(
      await universalRouter.getAddress(), weth, usdg, await mstr.getAddress()
    );

    await adapter.swapExactEthForMstr(recipient.address, ethers.parseEther("4"), {
      value: ethers.parseEther("1")
    });
    expect(await mstr.balanceOf(recipient.address)).to.equal(ethers.parseEther("5"));
    expect(await universalRouter.lastCommands()).to.equal("0x0b10");
  });

  it("automatically uses the fallback adapter when the primary route fails", async function () {
    const [, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const mstr = await Token.deploy("Mock MSTR", "MSTR");
    const MockAdapter = await ethers.getContractFactory("MockMstrSwapAdapter");
    const primary = await MockAdapter.deploy(await mstr.getAddress(), 0);
    const secondary = await MockAdapter.deploy(await mstr.getAddress(), ethers.parseEther("5"));
    const Fallback = await ethers.getContractFactory("FallbackMstrSwapAdapter");
    const adapter = await Fallback.deploy(await primary.getAddress(), await secondary.getAddress());

    await adapter.swapExactEthForMstr(recipient.address, ethers.parseEther("4"), {
      value: ethers.parseEther("1")
    });
    expect(await mstr.balanceOf(recipient.address)).to.equal(ethers.parseEther("5"));
  });
});
