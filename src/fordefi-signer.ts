/**
 * Fordefi Signer Adapter for Solana Kit
 * 
 * This module creates a custom TransactionSigner that uses Fordefi API
 * for signing Solana transactions instead of local private keys.
 */

import { 
  type Address,
  type TransactionSigner,
  type SignatureBytes,
  type Transaction,
  getBase64Encoder,
  getBase64Decoder,
} from '@solana/kit';
import crypto from 'crypto';
import fs from 'fs';

// ============================================================================
// Types
// ============================================================================

export interface FordefiConfig {
  apiBaseUrl: string;
  apiUserToken: string;
  apiSignerPrivateKeyPath: string;
  vaultId: string;
  vaultAddress: string;
  chain: 'solana_mainnet' | 'solana_devnet';
}

interface FordefiTransactionRequest {
  vault_id: string;
  signer_type: 'api_signer';
  type: 'solana_transaction';
  details: {
    type: 'solana_serialized_transaction_message';
    chain: string;
    data: string; // base64 encoded transaction message
    signatures?: Array<{
      data: string;
      public_key: string;
    }>;
    ephemeral_signing_keys?: string[];
  };
  note?: string;
  wait_for_state?: 'signed' | 'pushed_to_blockchain' | 'mined';
}

interface FordefiTransactionResponse {
  id: string;
  state: string;
  signed_content?: {
    data: string; // base64 encoded signed transaction
  };
  signatures?: Array<{
    data: string;
    public_key: string;
  }>;
  hash?: string;
}

// ============================================================================
// Fordefi API Client
// ============================================================================

export class FordefiClient {
  private config: FordefiConfig;
  private privateKey: crypto.KeyObject;
  
  constructor(config: FordefiConfig) {
    this.config = config;
    
    // Load the API signer private key
    const pemContent = fs.readFileSync(config.apiSignerPrivateKeyPath, 'utf-8');
    this.privateKey = crypto.createPrivateKey(pemContent);
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
  
  /**
   * Make an authenticated request to the Fordefi API
   */
  private async apiRequest<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: object
  ): Promise<T> {
    const url = `${this.config.apiBaseUrl}${endpoint}`;
    const timestamp = Date.now();
    const payload = body ? JSON.stringify(body) : '';
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.apiUserToken}`,
    };
    
    // Only POST requests with bodies need signing
    if (method === 'POST' && body) {
      const signature = this.signRequest(endpoint, timestamp, payload);
      headers['Content-Type'] = 'application/json';
      headers['x-timestamp'] = timestamp.toString();
      headers['x-signature'] = signature;
    }
    
    const response = await fetch(url, {
      method,
      headers,
      body: payload || undefined,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fordefi API error (${response.status}): ${errorText}`);
    }
    
    return response.json() as Promise<T>;
  }
  
  /**
   * Create and sign a Solana transaction via Fordefi
   */
  async signTransaction(
    transactionMessageBytes: Uint8Array,
    options?: {
      note?: string;
      partialSignatures?: Array<{ data: string; publicKey: string }>;
      ephemeralSigningKeys?: string[];
      waitForState?: 'signed' | 'pushed_to_blockchain' | 'mined';
    }
  ): Promise<FordefiTransactionResponse> {
    const base64Encoder = getBase64Encoder();
    const messageBase64 = base64Encoder.encode(transactionMessageBytes);
    
    const request: FordefiTransactionRequest = {
      vault_id: this.config.vaultId,
      signer_type: 'api_signer',
      type: 'solana_transaction',
      details: {
        type: 'solana_serialized_transaction_message',
        chain: this.config.chain,
        data: messageBase64,
      },
      note: options?.note,
      wait_for_state: options?.waitForState ?? 'signed',
    };
    
    // Add partial signatures if provided (for multi-sig scenarios)
    if (options?.partialSignatures && options.partialSignatures.length > 0) {
      request.details.signatures = options.partialSignatures.map(sig => ({
        data: sig.data,
        public_key: sig.publicKey,
      }));
    }
    
    // Add ephemeral signing keys if provided (for ephemeral accounts like buffer accounts)
    if (options?.ephemeralSigningKeys && options.ephemeralSigningKeys.length > 0) {
      request.details.ephemeral_signing_keys = options.ephemeralSigningKeys;
    }
    
    return this.apiRequest<FordefiTransactionResponse>(
      'POST',
      '/api/v1/transactions',
      request
    );
  }
  
  /**
   * Get transaction status
   */
  async getTransaction(transactionId: string): Promise<FordefiTransactionResponse> {
    return this.apiRequest<FordefiTransactionResponse>(
      'GET',
      `/api/v1/transactions/${transactionId}`
    );
  }
  
  /**
   * Wait for a transaction to reach a specific state
   */
  async waitForTransaction(
    transactionId: string,
    targetState: 'signed' | 'pushed_to_blockchain' | 'mined',
    timeoutMs: number = 60000
  ): Promise<FordefiTransactionResponse> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const tx = await this.getTransaction(transactionId);
      
      if (tx.state === targetState || tx.state === 'completed' || tx.state === 'mined') {
        return tx;
      }
      
      if (tx.state === 'failed' || tx.state === 'cancelled') {
        throw new Error(`Transaction ${transactionId} ${tx.state}`);
      }
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`Timeout waiting for transaction ${transactionId}`);
  }
}

// ============================================================================
// Solana Kit Signer Adapter
// ============================================================================

/**
 * Creates a Solana Kit TransactionSigner that uses Fordefi for signing
 */
export function createFordefiSigner(
  fordefiClient: FordefiClient,
  vaultAddress: Address
): TransactionSigner<typeof vaultAddress> {
  return {
    address: vaultAddress,
    
    async signTransactions(
      transactions: readonly Transaction[]
    ): Promise<readonly (Transaction & { readonly signatures: Record<string, SignatureBytes> })[]> {
      const signedTransactions: (Transaction & { readonly signatures: Record<string, SignatureBytes> })[] = [];
      
      for (const transaction of transactions) {
        // The transaction.messageBytes contains the serialized transaction message
        const response = await fordefiClient.signTransaction(
          transaction.messageBytes,
          { waitForState: 'signed' }
        );
        
        // Extract the signature from Fordefi response
        if (!response.signatures || response.signatures.length === 0) {
          throw new Error('No signatures returned from Fordefi');
        }
        
        const base64Decoder = getBase64Decoder();
        const signatures: Record<string, SignatureBytes> = { ...transaction.signatures };
        
        // Add Fordefi's signature
        for (const sig of response.signatures) {
          const signatureBytes = base64Decoder.decode(sig.data) as SignatureBytes;
          signatures[sig.public_key as Address] = signatureBytes;
        }
        
        signedTransactions.push({
          ...transaction,
          signatures,
        });
      }
      
      return signedTransactions;
    },
  };
}

/**
 * Creates a Fordefi signer that also handles ephemeral signers
 * (useful for program deployment where buffer accounts need signing)
 */
export function createFordefiSignerWithEphemeral(
  fordefiClient: FordefiClient,
  vaultAddress: Address,
  ephemeralPrivateKeys: string[] = []
): TransactionSigner<typeof vaultAddress> & { 
  addEphemeralKey: (privateKeyBase58: string) => void;
  clearEphemeralKeys: () => void;
} {
  const ephemeralKeys = [...ephemeralPrivateKeys];
  
  return {
    address: vaultAddress,
    
    addEphemeralKey(privateKeyBase58: string) {
      ephemeralKeys.push(privateKeyBase58);
    },
    
    clearEphemeralKeys() {
      ephemeralKeys.length = 0;
    },
    
    async signTransactions(
      transactions: readonly Transaction[]
    ): Promise<readonly (Transaction & { readonly signatures: Record<string, SignatureBytes> })[]> {
      const signedTransactions: (Transaction & { readonly signatures: Record<string, SignatureBytes> })[] = [];
      
      for (const transaction of transactions) {
        const response = await fordefiClient.signTransaction(
          transaction.messageBytes,
          { 
            waitForState: 'signed',
            ephemeralSigningKeys: ephemeralKeys.length > 0 ? ephemeralKeys : undefined,
          }
        );
        
        if (!response.signatures || response.signatures.length === 0) {
          throw new Error('No signatures returned from Fordefi');
        }
        
        const base64Decoder = getBase64Decoder();
        const signatures: Record<string, SignatureBytes> = { ...transaction.signatures };
        
        for (const sig of response.signatures) {
          const signatureBytes = base64Decoder.decode(sig.data) as SignatureBytes;
          signatures[sig.public_key as Address] = signatureBytes;
        }
        
        signedTransactions.push({
          ...transaction,
          signatures,
        });
      }
      
      return signedTransactions;
    },
  };
}
