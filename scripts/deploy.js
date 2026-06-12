// scripts/deploy.js
const hre = require("hardhat");
require("dotenv").config();

async function main() {
  await hre.run("compile");
  const admin = process.env.ADMIN_ADDRESS || (await hre.ethers.getSigners())[0].address;
  const decimals = Number(process.env.TOKEN_DECIMALS || 18);
  const initialMintRaw = process.env.INITIAL_MINT || "10000000"; // 10 million default
  const initialMint = hre.ethers.parseUnits(initialMintRaw, decimals);

  const Factory = await hre.ethers.getContractFactory("StableCoin");
  const token = await Factory.deploy(process.env.TOKEN_NAME || "BusinessToken", process.env.TOKEN_SYMBOL || "BTK", admin, initialMint);
  await token.deployed();

  console.log("Deployed StableCoin to:", token.address);
  // Optionally export ABI path via script
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
