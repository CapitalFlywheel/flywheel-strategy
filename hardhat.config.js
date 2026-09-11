require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 500 },
      viaIR: true
    }
  },
  networks: {
    hardhat: process.env.ROBINHOOD_FORK === "true"
      ? {
          chainId: 4663,
          hardfork: "cancun",
          forking: {
            url: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
          }
        }
      : {},
    robinhood: {
      url: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: privateKey ? [privateKey] : []
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: privateKey ? [privateKey] : []
    }
  }
};
