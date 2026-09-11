const { expect } = require("chai");
const { existsSync, readFileSync } = require("node:fs");
const { ethers, network } = require("hardhat");

const enabled = process.env.RUN_FORK_TESTS === "true";
const describeFork = enabled ? describe : describe.skip;

function standardLeaf(account, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, amount])
  );
  return ethers.keccak256(ethers.concat([inner]));
}

describeFork("Robinhood Chain MSTR routes — fork smoke test", function () {
  this.timeout(600_000);

  const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
  const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const MSTR = "0xec262a75e413fAfD0dF80480274532C79D42da09";
  const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
  const PONS_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const V3_QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
  const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";

  it("lets a holder claim a published live reward epoch when one is available", async function () {
    const snapshotPath = "data/public/snapshots/latest.json";
    if (!existsSync(snapshotPath)) this.skip();
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(snapshot.status).to.equal("published");
    expect(snapshot.epoch).to.be.greaterThan(0);
    expect(snapshot.entries.length).to.be.greaterThan(0);

    const entry = snapshot.entries[0];
    await network.provider.send("hardhat_setBalance", [entry.account, "0xDE0B6B3A7640000"]);
    await network.provider.send("hardhat_impersonateAccount", [entry.account]);
    await network.provider.send("evm_mine");
    const holder = await ethers.getSigner(entry.account);
    const vault = await ethers.getContractAt("RewardVault", snapshot.rewardVault);
    if ((await vault.merkleRoot()).toLowerCase() !== snapshot.merkleRoot.toLowerCase()) this.skip();
    const mstr = await ethers.getContractAt("IERC20", MSTR);
    const before = await mstr.balanceOf(entry.account);

    await vault.connect(holder).claim(entry.cumulativeRewardRaw, entry.proof);

    expect(await mstr.balanceOf(entry.account)).to.equal(before + BigInt(entry.cumulativeRewardRaw));
    await network.provider.send("hardhat_stopImpersonatingAccount", [entry.account]);
  });

  it("buys, stores and claims official MSTR through the fixed V4 route", async function () {
    const [admin, publisher, holder] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("RewardVault");
    const vault = await Vault.deploy(admin.address, publisher.address, MSTR);
    const Adapter = await ethers.getContractFactory("UniswapV4MstrSwapAdapter");
    const adapter = await Adapter.deploy(ROUTER, WETH, USDG, MSTR);
    const mstr = await ethers.getContractAt("IERC20", MSTR);
    await adapter.swapExactEthForMstr(await vault.getAddress(), 1, { value: ethers.parseEther("0.001") });
    const amount = await mstr.balanceOf(await vault.getAddress());
    expect(amount).to.be.greaterThan(0);
    await vault.connect(publisher).publishDistribution(1, standardLeaf(holder.address, amount), amount);
    await vault.connect(holder).claim(amount, []);
    expect(await mstr.balanceOf(holder.address)).to.equal(amount);
  });

  it("buys official MSTR through the direct V3 fallback route", async function () {
    const [recipient] = await ethers.getSigners();
    const Adapter = await ethers.getContractFactory("UniswapV3MstrSwapAdapter");
    const adapter = await Adapter.deploy(ROUTER, WETH, MSTR);
    const mstr = await ethers.getContractAt("IERC20", MSTR);
    const before = await mstr.balanceOf(recipient.address);

    await adapter.swapExactEthForMstr(recipient.address, 1, { value: ethers.parseEther("0.001") });
    expect(await mstr.balanceOf(recipient.address)).to.be.greaterThan(before);
  });

  it("executes governed MSTR marketing sale and post-graduation buyback", async function () {
    const [executor, holdVault, marketing] = await ethers.getSigners();
    const Collector = await ethers.getContractFactory("PonsFeeCollector");
    const collector = await Collector.deploy("0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e", executor.address);
    const factory = await ethers.getContractAt([
      "function launchFee() view returns (uint256)",
      "function previewLaunchEconomics(uint256,address) view returns (bytes32)",
      "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt),uint256,address) payable returns(address,address)",
      "function createGraduatedPool(address) returns (uint256)"
    ], PONS_FACTORY);
    const expectedEconomics = await factory.previewLaunchEconomics(0, ethers.ZeroAddress);
    const params = {
      name: "Reserve Fork Test",
      symbol: "RFT",
      logo: "",
      description: "",
      socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
      creatorFeeRecipient: await collector.getAddress(),
      creatorTaxBps: 200,
      buybackEnabled: false,
      expectedEconomics,
      salt: ethers.randomBytes(32)
    };
    const [tokenAddress, curveAddress] = await factory.launchToken.staticCall(
      params, 0, ethers.ZeroAddress, { value: await factory.launchFee() }
    );
    await factory.launchToken(params, 0, ethers.ZeroAddress, { value: await factory.launchFee() });
    const curve = await ethers.getContractAt([
      "function buy(uint256,uint256,address) payable returns(uint256)"
    ], curveAddress);
    const escrow = await ethers.getContractAt(["function balanceOf(address) view returns(uint256)"], "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e");

    const BuyMstr = await ethers.getContractFactory("UniswapV4MstrSwapAdapter");
    const buyMstr = await BuyMstr.deploy(ROUTER, WETH, USDG, MSTR);
    const mstr = await ethers.getContractAt("IERC20", MSTR);
    await buyMstr.swapExactEthForMstr(executor.address, 1, { value: ethers.parseEther("5") });

    const ReserveAdapter = await ethers.getContractFactory("RobinhoodReserveActionAdapter");
    const reserveAdapter = await ReserveAdapter.deploy(
      executor.address,
      MSTR,
      tokenAddress,
      WETH,
      ROUTER,
      PERMIT2,
      PONS_FACTORY,
      PONS_HOOK,
      V3_QUOTER,
      V4_QUOTER
    );
    await reserveAdapter.initializeExecutor(executor.address);
    const mstrBalance = await mstr.balanceOf(executor.address);
    const project = await ethers.getContractAt("IERC20", tokenAddress);

    // The governance route is live while PONS still trades on its bonding
    // curve. Move past the short launch-second anti-snipe window first.
    await network.provider.send("evm_increaseTime", [5]);
    await network.provider.send("evm_mine");
    const curveBuyback = mstrBalance / 1000n;
    await mstr.transfer(await reserveAdapter.getAddress(), curveBuyback);
    const beforeHold = await project.balanceOf(holdVault.address);
    await reserveAdapter.buyProjectToken(1, curveBuyback, 0, holdVault.address, 2000);
    expect(await project.balanceOf(holdVault.address)).to.be.greaterThan(beforeHold);

    // Let the same reserve action cross the threshold. It must accept PONS'
    // partial-fill refund, finish the retryable migration and spend the
    // refund in the new V4 pool without a manual transaction in between.
    const migrationBuyback = (await mstr.balanceOf(executor.address)) * 99n / 100n;
    await mstr.transfer(await reserveAdapter.getAddress(), migrationBuyback);
    const beforeMigrationHold = await project.balanceOf(holdVault.address);
    await reserveAdapter.buyProjectToken(2, migrationBuyback, 0, holdVault.address, 2000);
    expect(await project.balanceOf(holdVault.address)).to.be.greaterThan(beforeMigrationHold);
    expect(await escrow.balanceOf(await collector.getAddress())).to.be.greaterThan(0);
    const feeRecipientBefore = await ethers.provider.getBalance(executor.address);
    await collector.connect(holdVault).collect();
    expect(await ethers.provider.getBalance(executor.address)).to.be.greaterThan(feeRecipientBefore);
    const launchAfterBuy = await ethers.getContractAt([
      "function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"
    ], PONS_FACTORY).then((contract) => contract.getLaunchedToken(tokenAddress));
    expect(launchAfterBuy.phase).to.equal(2n);

    const v4Buyback = (await mstr.balanceOf(executor.address)) / 2n;
    await mstr.transfer(await reserveAdapter.getAddress(), v4Buyback);
    const beforeV4Hold = await project.balanceOf(holdVault.address);
    await reserveAdapter.buyProjectToken(3, v4Buyback, 0, holdVault.address, 2000);
    expect(await project.balanceOf(holdVault.address)).to.be.greaterThan(beforeV4Hold);

    const marketingAmount = (await mstr.balanceOf(executor.address)) / 2n;
    await mstr.transfer(await reserveAdapter.getAddress(), marketingAmount);
    const beforeMarketing = await ethers.provider.getBalance(marketing.address);
    await reserveAdapter.sellMstrForEth(4, marketingAmount, marketing.address, 2000);
    expect(await ethers.provider.getBalance(marketing.address)).to.be.greaterThan(beforeMarketing);
  });
});
