// node/contract.js
import { ethers } from 'ethers';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const RPC = process.env.RPC_URL;
const ADMIN_PK = process.env.ADMIN_PRIVATE_KEY;
const tokenAddress = process.env.TOKEN_ADDRESS;
export const provider = RPC ? new ethers.JsonRpcProvider(RPC) : null;
export const adminSigner = ADMIN_PK && provider ? new ethers.Wallet(ADMIN_PK, provider) : null;

let tokenAbi = [];
try {
  tokenAbi = JSON.parse(fs.readFileSync('../artifacts/contracts/StableCoin.sol/StableCoin.json', 'utf8')).abi;
} catch (e) {
  // if artifact not present, leave ABI empty and log later
}

export const tokenContract = tokenAbi.length && tokenAddress ? new ethers.Contract(tokenAddress, tokenAbi, adminSigner || provider) : null;

export function parseUnits(amount) {
  const decimals = Number(process.env.TOKEN_DECIMALS || 18);
  return ethers.parseUnits(String(amount), decimals);
}
export function formatUnits(bn) {
  const decimals = Number(process.env.TOKEN_DECIMALS || 18);
  return ethers.formatUnits(bn, decimals);
}
