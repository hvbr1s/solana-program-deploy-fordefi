/**
 * Simplified Anchor Program Deployment with Fordefi
 * 
 * This script provides a practical approach to deploying Anchor programs
 * using Fordefi for signing. It handles ephemeral keypairs properly.
 */

import {
  address,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  pipe,
  lamports,
  type Address,
  type Blockhash,
  getBase64Encoder,
  getAddressEncoder,
  getU32Encoder,
  getU64Encoder,
} from '@solana/kit';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Configure ed25519 to use sha512
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

dotenv.config();

// ============================================================================
// Constants
// ============================================================================

const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111111');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const SYSVAR_RENT = address('SysvarRent111111111111111111111111111111111');
const SYSVAR_CLOCK = address('SysvarC1ock11111111111111111111111111111111');

const PROGRAM_DATA_HEADER_SIZE = 45;
const MAX_CHUNK_SIZE = 900;

// ============================================================================
// Types
// ============================================================================

interface Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array; // 64 bytes: 32 seed + 32 public
  address: Address;
}

interface FordefiConfig {
  apiBaseUrl: string;
  apiUserToken: string;
  apiSignerPrivateKeyPem: string;
  vaultId: string;
  vaultAddress: string;
  chain: string;
}

// ============================================================================
// Keypair Utilities
// ============================================================================

/**
 * Generate a new Ed25519 keypair
 */
function generateKeypair(): Keypair {
  const seed = crypto.randomBytes(32);
  const publicKey = ed25519.getPublicKey(seed);
  
  // Solana format: 64 bytes = seed (32) + public key (32)
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKey, 32);
  
  return {
    publicKey,
    secretKey,
    address: address(bs58.encode(publicKey)),
  };
}

/**
 * Load keypair from Solana CLI JSON format
 */
function loadKeypairFromFile(filepath: string): Keypair {
  const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  const secretKey = Uint8Array.from(content);
  const publicKey = secretKey.slice(32);
  
  return {
    publicKey,
    secretKey,
    address: address(bs58.encode(publicKey)),
  };
}

/**
 * Convert secret key to base58 for Fordefi
 */
function secretKeyToBase58(secretKey: Uint8Array): string {
  return bs58.encode(secretKey);
}

// ============================================================================
// Fordefi API Client
// ============================================================================

class FordefiSolanaClient {
  private config: FordefiConfig;
  private privateKey: crypto.KeyObject;
  
  constructor(config: FordefiConfig) {
    this.config = config;
    this.privateKey = crypto.createPrivateKey(config.apiSignerPrivateKeyPem);
  }
  
  /**
   * Sign the API request per Fordefi spec: ${path}|${timestamp}|${requestBody}
   * Uses ECDSA over NIST P-256 curve
   */
  private signRequest(path: string, timestamp: number, requestBody: string): string {
    const message = `${path}|${timestamp}|${requestBody}`;
    const signature = crypto.sign('sha256', Buffer.from(message), this.privateKey);
    return signature.toString('base64');
  }
  
  async createTransaction(request: {
    messageBytes: Uint8Array;
    ephemeralKeys?: string[];
    note?: string;
    waitForState?: string;
  }): Promise<{
    id: string;
    state: string;
    hash?: string;
    signatures?: Array<{ data: string; public_key: string }>;
  }> {
    const base64Encoder = getBase64Encoder();
    const messageBase64 = base64Encoder.encode(request.messageBytes);
    
    const body = {
      vault_id: this.config.vaultId,
      signer_type: 'api_signer',
      type: 'solana_transaction',
      details: {
        type: 'solana_serialized_transaction_message',
        chain: this.config.chain,
        data: messageBase64,
        ...(request.ephemeralKeys && request.ephemeralKeys.length > 0 && {
          ephemeral_signing_keys: request.ephemeralKeys,
        }),
      },
      note: request.note,
      wait_for_state: request.waitForState ?? 'mined',
    };
    
    const path = '/api/v1/transactions';
    const timestamp = Date.now();
    const payload = JSON.stringify(body);
    const signature = this.signRequest(path, timestamp, payload);
    
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiUserToken}`,
        'x-timestamp': timestamp.toString(),
        'x-signature': signature,
      },
      body: payload,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fordefi API error (${response.status}): ${errorText}`);
    }
    
    return response.json();
  }
  
  async getTransaction(txId: string): Promise<any> {
    const path = `/api/v1/transactions/${txId}`;
    
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.apiUserToken}`,
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fordefi API error (${response.status}): ${errorText}`);
    }
    
    return response.json();
  }
  
  /**
   * Wait for transaction to reach a specific state
   */
  async waitForTransaction(
    txId: string,
    targetState: 'signed' | 'pushed_to_blockchain' | 'mined' | 'completed' = 'completed',
    timeoutMs: number = 120000
  ): Promise<any> {
    const startTime = Date.now();
    const terminalStates = ['completed', 'mined', 'error_signing', 'aborted', 'error_submitting_to_provider', 'dropped'];
    
    while (Date.now() - startTime < timeoutMs) {
      const tx = await this.getTransaction(txId);
      
      if (tx.state === targetState || terminalStates.includes(tx.state)) {
        if (tx.state === 'error_signing' || tx.state === 'aborted' || tx.state === 'error_submitting_to_provider' || tx.state === 'dropped') {
          throw new Error(`Transaction ${txId} failed with state: ${tx.state}`);
        }
        return tx;
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Timeout waiting for transaction ${txId}`);
  }
}

// ============================================================================
// BPF Loader Instructions
// ============================================================================

enum LoaderInstruction {
  InitializeBuffer = 0,
  Write = 1,
  DeployWithMaxDataLen = 2,
  Upgrade = 3,
  SetAuthority = 4,
  Close = 5,
}

function createSystemCreateAccountInstruction(
  payer: Address,
  newAccount: Address,
  lamportsAmount: bigint,
  space: number,
  owner: Address
): { programAddress: Address; accounts: any[]; data: Uint8Array } {
  // System Program CreateAccount instruction
  // Layout: [instruction (u32), lamports (u64), space (u64), owner (pubkey)]
  const data = new Uint8Array(4 + 8 + 8 + 32);
  const view = new DataView(data.buffer);
  
  view.setUint32(0, 0, true); // CreateAccount = 0
  view.setBigUint64(4, lamportsAmount, true);
  view.setBigUint64(12, BigInt(space), true);
  
  const addressEncoder = getAddressEncoder();
  data.set(addressEncoder.encode(owner), 20);
  
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: payer, role: 'writable_signer' },
      { address: newAccount, role: 'writable_signer' },
    ],
    data,
  };
}

function createInitializeBufferInstruction(
  buffer: Address,
  authority: Address
): { programAddress: Address; accounts: any[]; data: Uint8Array } {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, LoaderInstruction.InitializeBuffer, true);
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE,
    accounts: [
      { address: buffer, role: 'writable' },
      { address: authority, role: 'readonly' },
    ],
    data,
  };
}

function createWriteInstruction(
  buffer: Address,
  authority: Address,
  offset: number,
  programData: Uint8Array
): { programAddress: Address; accounts: any[]; data: Uint8Array } {
  const data = new Uint8Array(4 + 4 + programData.length);
  const view = new DataView(data.buffer);
  
  view.setUint32(0, LoaderInstruction.Write, true);
  view.setUint32(4, offset, true);
  data.set(programData, 8);
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE,
    accounts: [
      { address: buffer, role: 'writable' },
      { address: authority, role: 'signer' },
    ],
    data,
  };
}

function createDeployInstruction(
  payer: Address,
  programData: Address,
  program: Address,
  buffer: Address,
  authority: Address,
  maxDataLen: bigint
): { programAddress: Address; accounts: any[]; data: Uint8Array } {
  const data = new Uint8Array(4 + 8);
  const view = new DataView(data.buffer);
  
  view.setUint32(0, LoaderInstruction.DeployWithMaxDataLen, true);
  view.setBigUint64(4, maxDataLen, true);
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE,
    accounts: [
      { address: payer, role: 'writable_signer' },
      { address: programData, role: 'writable' },
      { address: program, role: 'writable' },
      { address: buffer, role: 'writable' },
      { address: SYSVAR_RENT, role: 'readonly' },
      { address: SYSVAR_CLOCK, role: 'readonly' },
      { address: SYSTEM_PROGRAM, role: 'readonly' },
      { address: authority, role: 'signer' },
    ],
    data,
  };
}

// ============================================================================
// PDA Derivation
// ============================================================================

async function findProgramDataAddress(programId: Address): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const programIdBytes = addressEncoder.encode(programId);
  const loaderBytes = addressEncoder.encode(BPF_LOADER_UPGRADEABLE);
  
  // Try bump seeds from 255 down to 0
  for (let bump = 255; bump >= 0; bump--) {
    const seeds = Buffer.concat([
      Buffer.from(programIdBytes),
      Buffer.from([bump]),
      Buffer.from(loaderBytes),
      Buffer.from('ProgramDerivedAddress'),
    ]);
    
    const hash = crypto.createHash('sha256').update(seeds).digest();
    const candidateBytes = hash.slice(0, 32);
    
    // Check if point is NOT on the Ed25519 curve (valid PDA requirement)
    // A point is on the curve if it can be used as a valid public key
    try {
      // Try to verify a dummy signature - if it succeeds, point is on curve (invalid PDA)
      // This is a simplified check; production code should use proper curve validation
      const isOnCurve = await isPointOnEd25519Curve(candidateBytes);
      
      if (!isOnCurve) {
        return address(bs58.encode(candidateBytes));
      }
    } catch {
      // If verification fails, the point is not on curve (valid PDA)
      return address(bs58.encode(candidateBytes));
    }
  }
  
  throw new Error('Could not find PDA');
}

/**
 * Check if a point is on the Ed25519 curve
 * A valid PDA must NOT be on the curve
 */
async function isPointOnEd25519Curve(publicKeyBytes: Uint8Array): Promise<boolean> {
  try {
    // Attempt to use the bytes as a public key for verification
    // If ed25519.verify doesn't throw, the point is on the curve
    const dummyMessage = new Uint8Array(32);
    const dummySignature = new Uint8Array(64);
    
    // This will throw if the public key is invalid (not on curve)
    await ed25519.verify(dummySignature, dummyMessage, publicKeyBytes);
    return true; // Point is on curve
  } catch {
    return false; // Point is NOT on curve (valid for PDA)
  }
}

// ============================================================================
// Deployment Functions
// ============================================================================

async function createAndInitializeBuffer(
  rpc: ReturnType<typeof createSolanaRpc>,
  fordefi: FordefiSolanaClient,
  payer: Address,
  programSize: number
): Promise<{ buffer: Keypair }> {
  console.log('\n📦 Step 1: Creating buffer account...');
  
  const buffer = generateKeypair();
  const bufferSize = PROGRAM_DATA_HEADER_SIZE + programSize;
  
  // Calculate rent (approximately 6960 lamports per byte)
  const rentLamports = BigInt(bufferSize) * 6960n;
  
  console.log(`   Buffer: ${buffer.address}`);
  console.log(`   Size: ${bufferSize} bytes`);
  console.log(`   Rent: ${Number(rentLamports) / 1e9} SOL`);
  
  // Get blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  
  // Build transaction
  const createAccountIx = createSystemCreateAccountInstruction(
    payer,
    buffer.address,
    rentLamports,
    bufferSize,
    BPF_LOADER_UPGRADEABLE
  );
  
  const initBufferIx = createInitializeBufferInstruction(buffer.address, payer);
  
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayer(payer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    tx => appendTransactionMessageInstructions([createAccountIx, initBufferIx], tx)
  );
  
  const compiled = compileTransaction(message);
  
  // Sign via Fordefi with buffer keypair as ephemeral
  const bufferKeyBase58 = secretKeyToBase58(buffer.secretKey);
  
  const result = await fordefi.createTransaction({
    messageBytes: compiled.messageBytes,
    ephemeralKeys: [bufferKeyBase58],
    note: 'Create program buffer',
  });
  
  console.log(`   ✅ Buffer created! TX: ${result.hash}`);
  
  return { buffer };
}

async function writeToBuffer(
  rpc: ReturnType<typeof createSolanaRpc>,
  fordefi: FordefiSolanaClient,
  payer: Address,
  buffer: Address,
  programData: Uint8Array
): Promise<void> {
  const chunks = Math.ceil(programData.length / MAX_CHUNK_SIZE);
  console.log(`\n📝 Step 2: Writing program data (${chunks} chunks)...`);
  
  for (let i = 0; i < chunks; i++) {
    const offset = i * MAX_CHUNK_SIZE;
    const end = Math.min(offset + MAX_CHUNK_SIZE, programData.length);
    const chunk = programData.slice(offset, end);
    
    // Get fresh blockhash
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    
    const writeIx = createWriteInstruction(buffer, payer, offset, chunk);
    
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayer(payer, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
      tx => appendTransactionMessageInstruction(writeIx, tx)
    );
    
    const compiled = compileTransaction(message);
    
    await fordefi.createTransaction({
      messageBytes: compiled.messageBytes,
      note: `Write chunk ${i + 1}/${chunks}`,
    });
    
    process.stdout.write(`\r   Progress: ${Math.round(((i + 1) / chunks) * 100)}%`);
  }
  
  console.log('\n   ✅ Buffer write complete!');
}

async function deployProgram(
  rpc: ReturnType<typeof createSolanaRpc>,
  fordefi: FordefiSolanaClient,
  payer: Address,
  buffer: Address,
  programKeypair: Keypair,
  programSize: number
): Promise<Address> {
  console.log('\n🚀 Step 3: Deploying program...');
  
  const programId = programKeypair.address;
  const programDataAddress = await findProgramDataAddress(programId);
  const maxDataLen = BigInt(programSize * 2); // 2x for upgrades
  
  console.log(`   Program ID: ${programId}`);
  console.log(`   Program Data: ${programDataAddress}`);
  
  // Get blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  
  const deployIx = createDeployInstruction(
    payer,
    programDataAddress,
    programId,
    buffer,
    payer,
    maxDataLen
  );
  
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayer(payer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    tx => appendTransactionMessageInstruction(deployIx, tx)
  );
  
  const compiled = compileTransaction(message);
  
  // Sign with program keypair as ephemeral
  const programKeyBase58 = secretKeyToBase58(programKeypair.secretKey);
  
  const result = await fordefi.createTransaction({
    messageBytes: compiled.messageBytes,
    ephemeralKeys: [programKeyBase58],
    note: 'Deploy program',
  });
  
  console.log(`   ✅ Program deployed! TX: ${result.hash}`);
  
  return programId;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Anchor Program Deployment with Fordefi + Solana Kit    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  // Load config
  const config: FordefiConfig = {
    apiBaseUrl: process.env.FORDEFI_API_BASE_URL || 'https://api.fordefi.com',
    apiUserToken: process.env.FORDEFI_API_USER_TOKEN!,
    apiSignerPrivateKeyPem: fs.readFileSync(
      process.env.FORDEFI_API_SIGNER_PRIVATE_KEY_PATH || './fordefi_secret/private.pem',
      'utf-8'
    ),
    vaultId: process.env.FORDEFI_VAULT_ID!,
    vaultAddress: process.env.FORDEFI_VAULT_ADDRESS!,
    chain: process.env.SOLANA_CLUSTER === 'mainnet' ? 'solana_mainnet' : 'solana_devnet',
  };
  
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const programPath = process.env.PROGRAM_SO_PATH || './target/deploy/program.so';
  
  // Validate
  if (!config.apiUserToken) throw new Error('FORDEFI_API_USER_TOKEN required');
  if (!config.vaultId) throw new Error('FORDEFI_VAULT_ID required');
  if (!config.vaultAddress) throw new Error('FORDEFI_VAULT_ADDRESS required');
  
  console.log(`\n📋 Configuration:`);
  console.log(`   Cluster: ${config.chain}`);
  console.log(`   RPC: ${rpcUrl}`);
  console.log(`   Payer: ${config.vaultAddress}`);
  console.log(`   Program: ${programPath}`);
  
  // Load program
  if (!fs.existsSync(programPath)) {
    throw new Error(`Program file not found: ${programPath}`);
  }
  
  const programData = new Uint8Array(fs.readFileSync(programPath));
  console.log(`   Size: ${programData.length} bytes`);
  console.log(`   Est. transactions: ${Math.ceil(programData.length / MAX_CHUNK_SIZE) + 2}`);
  
  // Initialize clients
  const rpc = createSolanaRpc(rpcUrl);
  const fordefi = new FordefiSolanaClient(config);
  const payer = address(config.vaultAddress);
  
  // Check balance
  const { value: balance } = await rpc.getBalance(payer).send();
  console.log(`   Balance: ${Number(balance) / 1e9} SOL`);
  
  // Generate or load program keypair
  let programKeypair: Keypair;
  const keypairPath = process.env.PROGRAM_KEYPAIR_PATH;
  
  if (keypairPath && fs.existsSync(keypairPath)) {
    programKeypair = loadKeypairFromFile(keypairPath);
    console.log(`\n🔑 Loaded program keypair: ${programKeypair.address}`);
  } else {
    programKeypair = generateKeypair();
    console.log(`\n🔑 Generated new program keypair: ${programKeypair.address}`);
    
    // Save keypair for future reference
    const keypairJson = JSON.stringify(Array.from(programKeypair.secretKey));
    fs.writeFileSync('./program-keypair.json', keypairJson);
    console.log(`   Saved to: ./program-keypair.json`);
  }
  
  // Deploy
  const { buffer } = await createAndInitializeBuffer(rpc, fordefi, payer, programData.length);
  await writeToBuffer(rpc, fordefi, payer, buffer.address, programData);
  const programId = await deployProgram(rpc, fordefi, payer, buffer.address, programKeypair, programData.length);
  
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    DEPLOYMENT COMPLETE!                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\n🎉 Program ID: ${programId}`);
  console.log(`🔐 Upgrade Authority: ${payer} (Fordefi Vault)`);
  console.log(`\n📝 Update your Anchor.toml:`);
  console.log(`   [programs.${config.chain === 'solana_mainnet' ? 'mainnet' : 'devnet'}]`);
  console.log(`   your_program = "${programId}"`);
}

main().catch(err => {
  console.error('\n❌ Deployment failed:', err.message);
  process.exit(1);
});
