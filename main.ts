// import { CdpSmartWalletProvider } from "@coinbase/agentkit";
// import * as fs from "fs";
// import dotenv from "dotenv";

// dotenv.config();

// // Check for required environment variables
// if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
//   throw new Error(
//     "CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set in your .env file"
//   );
// }

// const WALLET_DATA_FILE = "wallet_data.txt";

// type WalletData = {
//   privateKey?: string;
//   smartWalletAddress: string;
//   ownerAddress?: string;
// };

// // Initialize Smart Wallet Provider (same as agent uses)
// const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
//   apiKeyId: process.env.CDP_API_KEY_ID.trim(),
//   apiKeySecret: process.env.CDP_API_KEY_SECRET.trim(),
//   walletSecret: process.env.CDP_WALLET_SECRET,
//   networkId: process.env.NETWORK_ID || "base",
//   paymasterUrl: process.env.PAYMASTER_URL,
//   rpcUrl: process.env.RPC_URL,
// });

// // Export wallet data
// const exportedWallet = await walletProvider.exportWallet();

// // Save wallet data to file
// const walletData: WalletData = {
//   ownerAddress: exportedWallet.ownerAddress,
//   smartWalletAddress: exportedWallet.address,
// };

// fs.writeFileSync(WALLET_DATA_FILE, JSON.stringify(walletData, null, 2));

// console.log("========================================");
// console.log("Smart Wallet Created/Updated");
// console.log("========================================");
// console.log(`Owner Address: ${exportedWallet.ownerAddress}`);
// console.log(`Smart Wallet Address: ${exportedWallet.address}`);
// console.log(`Network: ${walletProvider.getNetwork().networkId}`);
// console.log(`Saved to: ${WALLET_DATA_FILE}`);
// console.log("========================================");

// import { CdpClient } from "@coinbase/cdp-sdk";
// import dotenv from "dotenv";

// dotenv.config();

// const cdp = new CdpClient();
// const account = await cdp.evm.createAccount({
//   name: "ExportEvmAccount",
// });
// console.log("Account to export:", account.address);

// // Export account with its address.
// let privateKey = await cdp.evm.exportAccount({
//   address: account.address
// })

// // Export account with its name.
// privateKey = await cdp.evm.exportAccount({
//   name: account.name
// })