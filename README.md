# Solana Program Deployment with Fordefi MPC

This project demonstrates how to deploy Solana (Anchor) programs using Fordefi's MPC wallet for signing. The deployment process involves creating a buffer, uploading program bytes in chunks, and deploying the buffer as an upgradeable program.

## Prerequisites

- Node.js 18+
- Rust and Solana CLI tools
- Anchor CLI (`anchor-cli`)
- Fordefi API access with a configured Solana vault

## Environment Setup

Create a `.env` file with your Fordefi credentials:

```env
FORDEFI_API_TOKEN=your_api_token
FORDEFI_VAULT_ID=your_vault_id
FORDEFI_VAULT_ADDRESS=your_solana_vault_address
```

Place your Fordefi API user private key at `./fordefi_secret/private.pem`.

## Project Structure

```
├── programs/                    # Anchor program source
├── src/
│   ├── config.ts               # Fordefi configuration
│   ├── tx-planner.ts           # Transaction planning (buffer + deploy)
│   ├── signers.ts              # Fordefi signing logic
│   ├── run.ts                  # Main deployment script
│   ├── close-buffer.ts         # Utility to close failed buffers
│   ├── process-tx.ts           # Fordefi API helpers
│   └── solana-client-utils.ts  # Solana RPC client
├── buffer-keypair.json         # Keypair for the buffer account
├── program-keypair.json        # Keypair for the program ID
└── target/deploy/*.so          # Compiled program binary
```

## Deployment Flow

### 1. Generate Keypairs

Generate fresh keypairs for the buffer and program:

```bash
solana-keygen new --no-bip39-passphrase -o buffer-keypair.json --force
solana-keygen new --no-bip39-passphrase -o program-keypair.json --force
```

### 2. Update Program ID

Update the `declare_id!` in `programs/solana-deploy-contract-fordefi/src/lib.rs` with the program keypair's public key:

```rust
declare_id!("YOUR_PROGRAM_KEYPAIR_PUBKEY");
```

### 3. Build the Program

```bash
anchor build
```

### 4. Deploy

```bash
npx tsx src/run.ts
```

## Key Learnings & Gotchas

### 1. Custom Fees are CRITICAL

**Problem:** Fordefi's default fee estimation was charging ~0.07 SOL per transaction. With 212+ write transactions, this resulted in ~15 SOL in fees alone!

**Solution:** Always pass custom fees to Fordefi. In `src/signers.ts`:

```typescript
const jsonBody = {
  // ... other fields
  details: {
    // ... other fields
    fee: {
      type: "custom",
      unit_price: "5000"  // 5000 lamports = 0.000005 SOL (base fee)
    }
  }
};
```

**Expected costs with custom fees:**
- Transaction fees: ~0.001 SOL (212 txs × 5000 lamports)
- Buffer rent: ~1.33 SOL (recovered after deployment)
- Program data rent: ~1.4 SOL
- **Total: ~2.7 SOL** (vs 15+ SOL without custom fees)

### 2. Blockhash Expiry with Long Deployments

**Problem:** Blockhashes expire after ~60-90 seconds. With 212 transactions and Fordefi's MPC signing taking 2-5 seconds each, later transactions fail with "Blockhash not found".

**Solution:** Implement retry logic that gets a fresh blockhash on each retry:

```typescript
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    const rawSignedTxBase64 = await signWithFordefi(message, rpc);
    // ... send transaction
  } catch (error) {
    if (errorMsg.includes('Blockhash not found')) {
      continue;  // Retry with fresh blockhash
    }
    throw error;
  }
}
```

### 3. Buffer Cleanup After Failed Deployments

**Problem:** If deployment fails mid-way, the buffer account holds ~1.33 SOL that won't be automatically recovered.

**Solution:** Use the `close-buffer.ts` utility:

```bash
# Close a specific buffer
npx tsx src/close-buffer.ts BUFFER_ADDRESS

# Example
npx tsx src/close-buffer.ts BY7zjwvhKgwTUwyGh8dBCPki7dRSjhTjcC46wMdfL9YM
```

This will:
1. Check if the buffer exists
2. Display its balance
3. Close the buffer via Fordefi signing
4. Return the rent (~1.33 SOL) to your vault

### 4. Do NOT Apply Padding Fix to Write Instructions

**Problem:** There was a commented-out "fix" that added 4 bytes of padding to write instructions. This corrupted the program data and caused "Failed to parse ELF file: invalid file header" errors.

**Solution:** Use write instructions directly without modification:

```typescript
// WRONG - corrupts program data
const fixedWriteIxs = writeBufferIxs.map(ix => {
  const newData = new Uint8Array([
    ...ix.data!.subarray(0, 12),
    ...[0, 0, 0, 0],  // BAD: corrupts ELF header
    ...ix.data!.subarray(12, ix.data!.length)
  ]);
  return { ...ix, data: newData };
});

// CORRECT - use instructions as-is
ixs.push(...writeBufferIxs);
```

### 5. Fresh Keypairs for Each Deployment Attempt

**Problem:** Reusing keypairs from failed deployments causes "account already in use" errors.

**Solution:** Generate fresh keypairs before each deployment attempt:

```bash
solana-keygen new --no-bip39-passphrase -o buffer-keypair.json --force
solana-keygen new --no-bip39-passphrase -o program-keypair.json --force
```

Then update `declare_id!` in `lib.rs` and rebuild with `anchor build`.

## Transaction Breakdown

For a ~190KB program:

| Step | Instructions | Transactions |
|------|--------------|--------------|
| Create buffer + Initialize | 2 | 1 |
| Write chunks (900 bytes each) | 212 | 212 |
| Create program + Deploy | 2 | 1 |
| **Total** | **216** | **~214** |

## Cost Breakdown

| Item | Cost | Notes |
|------|------|-------|
| Buffer rent | ~1.33 SOL | Absorbed into program on deploy |
| Program account | ~0.001 SOL | 36 bytes |
| Program data | ~1.4 SOL | Based on `maxDataLen` |
| Transaction fees | ~0.001 SOL | With custom 5000 lamport fee |
| **Total** | **~2.7 SOL** | Actual rent ~1.4 SOL |

## Troubleshooting

### "account already in use"
Generate fresh keypairs and rebuild.

### "Blockhash not found"
The retry logic should handle this automatically. If persistent, check your network connection.

### "Failed to parse ELF file"
Ensure the padding fix is NOT applied to write instructions. Check `tx-planner.ts`.

### "insufficient funds"
1. Check your Fordefi vault balance
2. Ensure custom fees are configured (not Fordefi's default estimation)
3. Close any orphaned buffers to recover rent

### Failed deployment mid-way
1. Note the buffer address from logs
2. Run `npx tsx src/close-buffer.ts BUFFER_ADDRESS`
3. Generate fresh keypairs
4. Update `declare_id!` and rebuild
5. Try again

## Fordefi API Notes

The Fordefi transaction payload structure for Solana:

```typescript
{
  vault_id: "...",
  signer_type: "api_signer",
  sign_mode: "auto",
  type: "solana_transaction",
  details: {
    type: "solana_serialized_transaction_message",
    push_mode: "manual",      // We broadcast ourselves
    chain: "solana_devnet",   // or "solana_mainnet"
    data: base64EncodedMessage,
    signatures: [...],
    skip_prediction: true,    // Speeds up signing
    fee: {
      type: "custom",
      unit_price: "5000"      // IMPORTANT: prevents fee explosion
    }
  }
}
```

## License

MIT
