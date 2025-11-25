/**
 * BPF Upgradeable Loader Utilities for Solana Kit
 * 
 * This module provides functions to interact with the BPF Upgradeable Loader
 * program for deploying and managing Solana programs.
 */

import {
  type Address,
  type IInstruction,
  type TransactionSigner,
  address,
  getAddressEncoder,
  getU32Encoder,
  getU64Encoder,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  pipe,
} from '@solana/kit';

// ============================================================================
// Constants
// ============================================================================

/** BPF Upgradeable Loader Program ID */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = address(
  'BPFLoaderUpgradeab1e11111111111111111111111111'
);

/** System Program ID */
export const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111');

/** Size of program account data */
export const PROGRAM_ACCOUNT_SIZE = 36;

/** Size of program data header */
export const PROGRAM_DATA_HEADER_SIZE = 45;

/** Maximum chunk size for writing to buffer (accounting for tx size limits) */
export const MAX_CHUNK_SIZE = 900; // Conservative size to fit in transaction

// ============================================================================
// Instruction Builders
// ============================================================================

/**
 * BPF Loader Upgradeable instruction types
 */
enum UpgradeableLoaderInstruction {
  InitializeBuffer = 0,
  Write = 1,
  DeployWithMaxDataLen = 2,
  Upgrade = 3,
  SetAuthority = 4,
  Close = 5,
  ExtendProgram = 6,
  SetAuthorityChecked = 7,
}

/**
 * Derive the ProgramData address for a program
 */
export async function getProgramDataAddress(
  programId: Address
): Promise<Address> {
  const encoder = getAddressEncoder();
  const programIdBytes = encoder.encode(programId);
  
  // ProgramData PDA: seeds = [program_id], bump
  // The actual derivation uses the program ID as seed with the BPF loader as program
  const seeds = [programIdBytes];
  
  // For simplicity, we'll compute this using the standard PDA derivation
  // In a real implementation, you'd use findProgramDerivedAddress
  // This is a placeholder - the actual address is [programId] seeded under BPF Loader
  const { createHash } = await import('crypto');
  
  let bump = 255;
  while (bump >= 0) {
    const hash = createHash('sha256');
    for (const seed of seeds) {
      hash.update(seed);
    }
    hash.update(Buffer.from([bump]));
    hash.update(encoder.encode(BPF_LOADER_UPGRADEABLE_PROGRAM_ID));
    hash.update(Buffer.from('ProgramDerivedAddress'));
    
    const result = hash.digest();
    
    // Check if it's a valid PDA (not on the ed25519 curve)
    // This is a simplified check - real implementation needs proper curve check
    try {
      return address(result.toString('hex').slice(0, 44)) as Address;
    } catch {
      bump--;
    }
  }
  
  throw new Error('Could not derive program data address');
}

/**
 * Create instruction to initialize a buffer account
 */
export function createInitializeBufferInstruction(
  bufferAddress: Address,
  authority: Address
): IInstruction {
  // InitializeBuffer instruction layout:
  // [0] = instruction type (u32)
  const data = new Uint8Array(4);
  const u32Encoder = getU32Encoder();
  data.set(u32Encoder.encode(UpgradeableLoaderInstruction.InitializeBuffer), 0);
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    accounts: [
      { address: bufferAddress, role: 'writable' },
      { address: authority, role: 'readonly' },
    ],
    data,
  };
}

/**
 * Create instruction to write data to a buffer account
 */
export function createWriteInstruction(
  bufferAddress: Address,
  authority: Address,
  offset: number,
  data: Uint8Array
): IInstruction {
  // Write instruction layout:
  // [0..4] = instruction type (u32)
  // [4..8] = offset (u32)
  // [8..] = data
  const u32Encoder = getU32Encoder();
  const instructionData = new Uint8Array(8 + data.length);
  instructionData.set(u32Encoder.encode(UpgradeableLoaderInstruction.Write), 0);
  instructionData.set(u32Encoder.encode(offset), 4);
  instructionData.set(data, 8);
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    accounts: [
      { address: bufferAddress, role: 'writable' },
      { address: authority, role: 'signer' },
    ],
    data: instructionData,
  };
}

/**
 * Create instruction to deploy a program with max data length
 */
export function createDeployWithMaxDataLenInstruction(
  payerAddress: Address,
  programDataAddress: Address,
  programAddress: Address,
  bufferAddress: Address,
  authority: Address,
  maxDataLen: bigint
): IInstruction {
  // DeployWithMaxDataLen instruction layout:
  // [0..4] = instruction type (u32)
  // [4..12] = max_data_len (u64)
  const u32Encoder = getU32Encoder();
  const u64Encoder = getU64Encoder();
  const data = new Uint8Array(12);
  data.set(u32Encoder.encode(UpgradeableLoaderInstruction.DeployWithMaxDataLen), 0);
  data.set(u64Encoder.encode(maxDataLen), 4);
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    accounts: [
      { address: payerAddress, role: 'writable_signer' },
      { address: programDataAddress, role: 'writable' },
      { address: programAddress, role: 'writable' },
      { address: bufferAddress, role: 'writable' },
      { address: address('SysvarRent111111111111111111111111111111111'), role: 'readonly' },
      { address: address('SysvarC1ock11111111111111111111111111111111'), role: 'readonly' },
      { address: SYSTEM_PROGRAM_ID, role: 'readonly' },
      { address: authority, role: 'signer' },
    ],
    data,
  };
}

/**
 * Create instruction to upgrade a program
 */
export function createUpgradeInstruction(
  programDataAddress: Address,
  programAddress: Address,
  bufferAddress: Address,
  spillAddress: Address,
  authority: Address
): IInstruction {
  const u32Encoder = getU32Encoder();
  const data = new Uint8Array(4);
  data.set(u32Encoder.encode(UpgradeableLoaderInstruction.Upgrade), 0);
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    accounts: [
      { address: programDataAddress, role: 'writable' },
      { address: programAddress, role: 'writable' },
      { address: bufferAddress, role: 'writable' },
      { address: spillAddress, role: 'writable' },
      { address: address('SysvarRent111111111111111111111111111111111'), role: 'readonly' },
      { address: address('SysvarC1ock11111111111111111111111111111111'), role: 'readonly' },
      { address: authority, role: 'signer' },
    ],
    data,
  };
}

/**
 * Create instruction to set program authority
 */
export function createSetAuthorityInstruction(
  accountAddress: Address,
  currentAuthority: Address,
  newAuthority: Address | null
): IInstruction {
  const u32Encoder = getU32Encoder();
  
  // SetAuthority instruction layout:
  // [0..4] = instruction type (u32)
  // [4..5] = option flag (1 if new authority present)
  // [5..37] = new authority pubkey (if present)
  const hasNewAuthority = newAuthority !== null;
  const data = new Uint8Array(hasNewAuthority ? 37 : 5);
  data.set(u32Encoder.encode(UpgradeableLoaderInstruction.SetAuthority), 0);
  data[4] = hasNewAuthority ? 1 : 0;
  
  if (hasNewAuthority && newAuthority) {
    const addressEncoder = getAddressEncoder();
    data.set(addressEncoder.encode(newAuthority), 5);
  }
  
  const accounts = [
    { address: accountAddress, role: 'writable' as const },
    { address: currentAuthority, role: 'signer' as const },
  ];
  
  if (hasNewAuthority && newAuthority) {
    accounts.push({ address: newAuthority, role: 'readonly' as const });
  }
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    accounts,
    data,
  };
}

/**
 * Create instruction to close a buffer or program
 */
export function createCloseInstruction(
  accountAddress: Address,
  recipientAddress: Address,
  authority: Address | null,
  programAddress?: Address
): IInstruction {
  const u32Encoder = getU32Encoder();
  const data = new Uint8Array(4);
  data.set(u32Encoder.encode(UpgradeableLoaderInstruction.Close), 0);
  
  const accounts: Array<{ address: Address; role: 'writable' | 'signer' | 'readonly' | 'writable_signer' }> = [
    { address: accountAddress, role: 'writable' },
    { address: recipientAddress, role: 'writable' },
  ];
  
  if (authority) {
    accounts.push({ address: authority, role: 'signer' });
  }
  
  if (programAddress) {
    accounts.push({ address: programAddress, role: 'writable' });
  }
  
  return {
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    accounts,
    data,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate the rent-exempt balance for a buffer account
 */
export function calculateBufferRent(programDataLen: number): bigint {
  // Rent is approximately 6.96 SOL per MB per year, with 2 years of rent-exemption
  // Simplified calculation: ~0.00001 SOL per byte
  const bufferSize = PROGRAM_DATA_HEADER_SIZE + programDataLen;
  const lamportsPerByte = 6960n; // Approximate lamports per byte for rent exemption
  return BigInt(bufferSize) * lamportsPerByte;
}

/**
 * Calculate the rent-exempt balance for a program account
 */
export function calculateProgramRent(): bigint {
  return BigInt(PROGRAM_ACCOUNT_SIZE) * 6960n;
}

/**
 * Split program data into chunks for writing
 */
export function* chunkProgramData(
  programData: Uint8Array,
  chunkSize: number = MAX_CHUNK_SIZE
): Generator<{ offset: number; data: Uint8Array }> {
  let offset = 0;
  while (offset < programData.length) {
    const end = Math.min(offset + chunkSize, programData.length);
    yield {
      offset,
      data: programData.slice(offset, end),
    };
    offset = end;
  }
}

/**
 * Calculate the number of transactions needed to write program data
 */
export function calculateWriteTransactions(
  programDataLen: number,
  chunkSize: number = MAX_CHUNK_SIZE
): number {
  return Math.ceil(programDataLen / chunkSize);
}
