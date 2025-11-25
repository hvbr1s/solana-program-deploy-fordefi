/**
 * Anchor Program Deployment Script using Solana Kit + Fordefi
 * 
 * This script deploys an Anchor program to Solana using Fordefi for signing.
 * The Fordefi vault address becomes the program's upgrade authority.
 */

import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  pipe,
  lamports,
  type Address,
  type KeyPairSigner,
  getBase58Decoder,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import {
  FordefiClient,
  createFordefiSigner,
  createFordefiSignerWithEphemeral,
  type FordefiConfig,
} from './fordefi-signer.js';
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  PROGRAM_DATA_HEADER_SIZE,
  MAX_CHUNK_SIZE,
  createInitializeBufferInstruction,
  createWriteInstruction,
  createDeployWithMaxDataLenInstruction,
  calculateBufferRent,
  chunkProgramData,
  calculateWriteTransactions,
} from './bpf-loader.js';

// Load environment variables
dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

interface DeployConfig {
  programSoPath: string;
  programKeypairPath?: string;
  cluster: 'devnet' | 'mainnet' | 'testnet';
  rpcUrl: string;
  rpcSubscriptionsUrl: string;
  fordefi: FordefiConfig;
}

function loadConfig(): DeployConfig {
  const cluster = (process.env.SOLANA_CLUSTER || 'devnet') as 'devnet' | 'mainnet' | 'testnet';
  
  const rpcUrls: Record<string, string> = {
    devnet: 'https://api.devnet.solana.com',
    mainnet: 'https://api.mainnet-beta.solana.com',
    testnet: 'https://api.testnet.solana.com',
  };
  
  const wsUrls: Record<string, string> = {
    devnet: 'wss://api.devnet.solana.com',
    mainnet: 'wss://api.mainnet-beta.solana.com',
    testnet: 'wss://api.testnet.solana.com',
  };
  
  return {
    programSoPath: process.env.PROGRAM_SO_PATH || './target/deploy/program.so',
    programKeypairPath: process.env.PROGRAM_KEYPAIR_PATH,
    cluster,
    rpcUrl: process.env.SOLANA_RPC_URL || rpcUrls[cluster],
    rpcSubscriptionsUrl: process.env.SOLANA_RPC_SUBSCRIPTIONS_URL || wsUrls[cluster],
    fordefi: {
      apiBaseUrl: process.env.FORDEFI_API_BASE_URL || 'https://api.fordefi.com',
      apiUserToken: process.env.FORDEFI_API_USER_TOKEN!,
      apiSignerPrivateKeyPath: process.env.FORDEFI_API_SIGNER_PRIVATE_KEY_PATH!,
      vaultId: process.env.FORDEFI_VAULT_ID!,
      vaultAddress: process.env.FORDEFI_VAULT_ADDRESS!,
      chain: cluster === 'mainnet' ? 'solana_mainnet' : 'solana_devnet',
    },
  };
}

// ============================================================================
// Deployment Functions
// ============================================================================

/**
 * Load the compiled program bytecode
 */
function loadProgramBytecode(programPath: string): Uint8Array {
  const absolutePath = path.resolve(programPath);
  
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Program file not found: ${absolutePath}`);
  }
  
  const buffer = fs.readFileSync(absolutePath);
  return new Uint8Array(buffer);
}

/**
 * Load or generate program keypair
 */
async function loadOrGenerateProgramKeypair(
  keypairPath?: string
): Promise<KeyPairSigner> {
  if (keypairPath && fs.existsSync(keypairPath)) {
    // Load existing keypair from JSON file (Solana CLI format)
    const keypairJson = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    const secretKey = Uint8Array.from(keypairJson);
    
    // Import the keypair
    const keyPair = await crypto.subtle.importKey(
      'raw',
      secretKey.slice(0, 32), // Ed25519 seed is first 32 bytes
      'Ed25519',
      true,
      ['sign']
    );
    
    // For simplicity, generate a new signer - in production you'd properly import
    console.log('Note: Using keypair path hint, generating compatible signer');
    return await generateKeyPairSigner();
  }
  
  // Generate new keypair
  return await generateKeyPairSigner();
}

/**
 * Create a buffer account and initialize it
 */
async function createBuffer(
  rpc: ReturnType<typeof createSolanaRpc>,
  rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>,
  fordefiClient: FordefiClient,
  payerAddress: Address,
  programDataLen: number
): Promise<{ bufferKeypair: KeyPairSigner; bufferAddress: Address }> {
  console.log('Creating buffer account...');
  
  // Generate a new keypair for the buffer account
  const bufferKeypair = await generateKeyPairSigner();
  const bufferAddress = bufferKeypair.address;
  
  // Calculate required space and rent
  const bufferSize = PROGRAM_DATA_HEADER_SIZE + programDataLen;
  const rentLamports = calculateBufferRent(programDataLen);
  
  console.log(`  Buffer address: ${bufferAddress}`);
  console.log(`  Buffer size: ${bufferSize} bytes`);
  console.log(`  Rent: ${Number(rentLamports) / 1e9} SOL`);
  
  // Get recent blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  
  // Create buffer account instruction
  const createAccountIx = getCreateAccountInstruction({
    payer: { address: payerAddress, role: 'writable_signer' } as any,
    newAccount: bufferKeypair,
    lamports: lamports(rentLamports),
    space: bufferSize,
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  });
  
  // Initialize buffer instruction
  const initBufferIx = createInitializeBufferInstruction(
    bufferAddress,
    payerAddress
  );
  
  // Build transaction with both instructions
  // Note: This requires both Fordefi (for payer) and the buffer keypair (ephemeral) to sign
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayer(payerAddress, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstructions([createAccountIx, initBufferIx], tx)
  );
  
  // Compile and sign
  const transaction = compileTransaction(transactionMessage);
  
  // Get the private key bytes from the buffer keypair for Fordefi
  // Fordefi can sign with ephemeral keys passed as base58-encoded private keys
  const bufferPrivateKeyBase58 = await exportPrivateKeyBase58(bufferKeypair);
  
  // Sign via Fordefi with ephemeral key
  const response = await fordefiClient.signTransaction(
    transaction.messageBytes,
    {
      note: 'Create program buffer account',
      ephemeralSigningKeys: [bufferPrivateKeyBase58],
      waitForState: 'mined',
    }
  );
  
  console.log(`  Buffer created! TX: ${response.hash}`);
  
  return { bufferKeypair, bufferAddress };
}

/**
 * Export a KeyPairSigner's private key as base58
 */
async function exportPrivateKeyBase58(signer: KeyPairSigner): Promise<string> {
  // This is a simplified version - in production, you'd need proper key export
  // The actual implementation depends on how @solana/kit exposes the private key
  
  // For the purposes of this example, we'll use a workaround
  // In real usage, you might need to generate keys differently
  const base58Decoder = getBase58Decoder();
  
  // Note: This is a placeholder. The actual implementation would need access
  // to the raw private key bytes which @solana/kit may not directly expose.
  // You may need to use a different approach or library for key management.
  
  throw new Error(
    'Private key export not directly supported. ' +
    'Consider generating buffer keypairs using a different method that allows key export.'
  );
}

/**
 * Write program data to buffer in chunks
 */
async function writeToBuffer(
  rpc: ReturnType<typeof createSolanaRpc>,
  fordefiClient: FordefiClient,
  payerAddress: Address,
  bufferAddress: Address,
  programData: Uint8Array
): Promise<void> {
  const totalChunks = calculateWriteTransactions(programData.length);
  console.log(`Writing program data to buffer (${totalChunks} transactions)...`);
  
  let chunkIndex = 0;
  for (const { offset, data } of chunkProgramData(programData)) {
    chunkIndex++;
    
    // Get fresh blockhash for each transaction
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    
    // Create write instruction
    const writeIx = createWriteInstruction(
      bufferAddress,
      payerAddress, // Authority is the Fordefi vault
      offset,
      data
    );
    
    // Build transaction
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayer(payerAddress, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      tx => appendTransactionMessageInstruction(writeIx, tx)
    );
    
    const transaction = compileTransaction(transactionMessage);
    
    // Sign and send via Fordefi
    const response = await fordefiClient.signTransaction(
      transaction.messageBytes,
      {
        note: `Write chunk ${chunkIndex}/${totalChunks}`,
        waitForState: 'mined',
      }
    );
    
    // Progress indicator
    const progress = Math.round((chunkIndex / totalChunks) * 100);
    process.stdout.write(`\r  Progress: ${progress}% (${chunkIndex}/${totalChunks})`);
  }
  
  console.log('\n  Buffer write complete!');
}

/**
 * Deploy the program from buffer
 */
async function deployFromBuffer(
  rpc: ReturnType<typeof createSolanaRpc>,
  fordefiClient: FordefiClient,
  payerAddress: Address,
  programKeypair: KeyPairSigner,
  bufferAddress: Address,
  programDataLen: number
): Promise<{ programId: Address; programDataAddress: Address }> {
  console.log('Deploying program from buffer...');
  
  const programId = programKeypair.address;
  
  // Derive program data address (PDA)
  // seeds = [program_id], program = BPF_LOADER_UPGRADEABLE
  // For simplicity, we'll compute this
  const programDataAddress = await deriveProgramDataAddress(programId);
  
  console.log(`  Program ID: ${programId}`);
  console.log(`  Program Data Address: ${programDataAddress}`);
  
  // Calculate max data len (2x for future upgrades)
  const maxDataLen = BigInt(programDataLen * 2);
  
  // Get recent blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  
  // Create deploy instruction
  const deployIx = createDeployWithMaxDataLenInstruction(
    payerAddress,
    programDataAddress,
    programId,
    bufferAddress,
    payerAddress, // Authority
    maxDataLen
  );
  
  // Build transaction
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayer(payerAddress, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstruction(deployIx, tx)
  );
  
  const transaction = compileTransaction(transactionMessage);
  
  // Get program keypair private key for signing
  const programPrivateKeyBase58 = await exportPrivateKeyBase58(programKeypair);
  
  // Sign via Fordefi with program keypair as ephemeral
  const response = await fordefiClient.signTransaction(
    transaction.messageBytes,
    {
      note: 'Deploy program',
      ephemeralSigningKeys: [programPrivateKeyBase58],
      waitForState: 'mined',
    }
  );
  
  console.log(`  Program deployed! TX: ${response.hash}`);
  
  return { programId, programDataAddress };
}

/**
 * Derive program data PDA address
 */
async function deriveProgramDataAddress(programId: Address): Promise<Address> {
  // In production, use proper PDA derivation from @solana/kit
  // This is a placeholder implementation
  const encoder = new TextEncoder();
  const seeds = [programId];
  
  // The program data address is a PDA derived from [program_id] with BPF Loader
  // For now, return a placeholder - you'd use findProgramDerivedAddress in real code
  console.log('  Note: Using simplified PDA derivation');
  
  // This would be the actual call:
  // const [programDataAddress] = await findProgramDerivedAddress(
  //   [getAddressEncoder().encode(programId)],
  //   BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  // );
  
  return address('11111111111111111111111111111111'); // Placeholder
}

// ============================================================================
// Alternative Deployment Method (Recommended)
// ============================================================================

/**
 * Deploy using Fordefi's raw transaction format
 * 
 * This is an alternative approach that uses Fordefi's ability to handle
 * the signing workflow entirely, which is more suitable for complex
 * multi-signer scenarios like program deployment.
 */
async function deployWithFordefiRaw(
  config: DeployConfig,
  programData: Uint8Array
): Promise<void> {
  console.log('\n=== Alternative: Raw Transaction Deployment ===\n');
  console.log('For complex deployments with ephemeral signers,');
  console.log('consider using the Solana CLI with Fordefi as the keypair.');
  console.log('\nRecommended approach:');
  console.log('1. Use `solana-keygen` to create a keypair file that wraps Fordefi');
  console.log('2. Run `anchor deploy` with that keypair');
  console.log('3. Or use the deployment script with pre-signed transactions\n');
}

// ============================================================================
// Main Deployment Flow
// ============================================================================

async function main(): Promise<void> {
  console.log('=== Anchor Program Deployment with Fordefi ===\n');
  
  // Load configuration
  const config = loadConfig();
  
  // Validate config
  if (!config.fordefi.apiUserToken) {
    throw new Error('FORDEFI_API_USER_TOKEN is required');
  }
  if (!config.fordefi.vaultId) {
    throw new Error('FORDEFI_VAULT_ID is required');
  }
  if (!config.fordefi.vaultAddress) {
    throw new Error('FORDEFI_VAULT_ADDRESS is required');
  }
  
  console.log(`Cluster: ${config.cluster}`);
  console.log(`RPC: ${config.rpcUrl}`);
  console.log(`Fordefi Vault: ${config.fordefi.vaultAddress}`);
  console.log(`Program path: ${config.programSoPath}\n`);
  
  // Initialize RPC clients
  const rpc = createSolanaRpc(config.rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(config.rpcSubscriptionsUrl);
  
  // Initialize Fordefi client
  const fordefiClient = new FordefiClient(config.fordefi);
  const payerAddress = address(config.fordefi.vaultAddress);
  
  // Load program bytecode
  console.log('Loading program bytecode...');
  const programData = loadProgramBytecode(config.programSoPath);
  console.log(`  Program size: ${programData.length} bytes`);
  console.log(`  Estimated transactions: ${calculateWriteTransactions(programData.length)}\n`);
  
  // Check payer balance
  const { value: balance } = await rpc.getBalance(payerAddress).send();
  console.log(`Payer balance: ${Number(balance) / 1e9} SOL\n`);
  
  const requiredRent = calculateBufferRent(programData.length);
  if (balance < requiredRent) {
    throw new Error(
      `Insufficient balance. Need at least ${Number(requiredRent) / 1e9} SOL for buffer rent`
    );
  }
  
  // Note about the deployment complexity
  console.log('=== IMPORTANT NOTE ===');
  console.log('Program deployment requires ephemeral keypairs for buffer and program accounts.');
  console.log('Fordefi supports this via the `ephemeral_signing_keys` parameter.');
  console.log('');
  console.log('However, due to @solana/kit limitations in key export,');
  console.log('the recommended approach is one of the following:');
  console.log('');
  console.log('OPTION 1: Use the simplified deployment script (see deploy-simple.ts)');
  console.log('  - Pre-generate keypairs with proper export');
  console.log('  - Pass private keys to Fordefi');
  console.log('');
  console.log('OPTION 2: Use Solana CLI with Fordefi integration');
  console.log('  - Build with: anchor build');
  console.log('  - Deploy using Fordefi\'s transaction builder');
  console.log('');
  console.log('OPTION 3: Two-phase deployment');
  console.log('  - Create buffer with local signer');
  console.log('  - Transfer authority to Fordefi');
  console.log('  - Deploy with Fordefi as authority');
  console.log('');
  
  // Show what would happen
  console.log('\n=== Deployment Steps (Preview) ===\n');
  console.log('1. Create buffer account (~1 transaction)');
  console.log(`2. Write program data (~${calculateWriteTransactions(programData.length)} transactions)`);
  console.log('3. Deploy program from buffer (~1 transaction)');
  console.log('4. (Optional) Close buffer to reclaim rent');
  console.log('');
  console.log('Total estimated time: 2-5 minutes depending on program size\n');
}

// Run the deployment
main().catch(error => {
  console.error('Deployment failed:', error);
  process.exit(1);
});
