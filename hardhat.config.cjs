require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    polygon_mumbai: {
      url: process.env.RPC_URL || "https://rpc.ankr.com/polygon_mumbai",
      accounts: process.env.ADMIN_PRIVATE_KEY ? [process.env.ADMIN_PRIVATE_KEY] : []
    },
    // add mainnet when ready
  }
};
