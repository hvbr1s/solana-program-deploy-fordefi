import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config()

export interface FordefiSolanaConfig {
  accessToken: string;
  deployerVaultId: string;
  deployerVaultAddress: string;
  privateKeyPem: string;
  apiPathEndpoint: string;
  rpc: string;
  ws: string
}

export const fordefiConfig: FordefiSolanaConfig = {
  accessToken: process.env.FORDEFI_API_TOKEN || "",
  deployerVaultId: process.env.FORDEFI_VAULT_ID || "",
  deployerVaultAddress: process.env.FORDEFI_VAULT_ADDRESS || "",
  privateKeyPem: fs.readFileSync('./fordefi_secret/private.pem', 'utf8'),
  apiPathEndpoint: '/api/v1/transactions',
  rpc: 'https://api.devnet.solana.com',
  ws: 'wss://api.devnet.solana.com'
};