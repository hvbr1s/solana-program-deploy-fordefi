import fs from 'fs';
import * as kit from '@solana/kit';
import { FordefiSolanaConfig } from './config';
import { Client } from './solana-client-utils';
import * as system from '@solana-program/system';
import * as loader from '@solana-program/loader-v3';


export async function createTxPlan(fordefiConfig: FordefiSolanaConfig, client: Client) {
    const deployerVault = kit.address(fordefiConfig.deployerVaultAddress);
    const deployerVaultSigner = kit.createNoopSigner(deployerVault);

    // Load buffer keypair
    const bufferKeypairBytes = new Uint8Array(JSON.parse(fs.readFileSync('buffer-keypair.json', 'utf-8')));
    const bufferSigner = await kit.createKeyPairSignerFromBytes(bufferKeypairBytes);

    const dataSize = new Uint8Array(fs.readFileSync('target/deploy/solana_deploy_contract_fordefi.so'))
    console.log(`Data size: ${dataSize.length}`)

    const bufferSize = dataSize.length+37; // 37 is the Buffer header size
    const lamports = await client.rpc.getMinimumBalanceForRentExemption(BigInt(bufferSize)).send();

    const ixs = [];

    // create buffer account and initialize buffer
    ixs.push(
      system.getCreateAccountInstruction({
        payer: deployerVaultSigner,
        newAccount: bufferSigner,
        lamports,
        space: bufferSize,
        programAddress: kit.address(loader.LOADER_V3_PROGRAM_ADDRESS),
      }),
      loader.getInitializeBufferInstruction({
        bufferAuthority: deployerVault,
        sourceAccount: bufferSigner.address
      })
    );

    // write to buffer in chunks
    // max tx size is 1232 bytes, need room for header, signatures, accounts, etc.
    const chunkSize = 900;
    let offset = 0;
    const writeBufferIxs = [];
    while (offset < dataSize.length) {
      const chunk = dataSize.slice(offset, offset + chunkSize);
      writeBufferIxs.push(
        loader.getWriteInstruction({
          bufferAccount: bufferSigner.address,
          bufferAuthority: deployerVaultSigner,
          offset,
          bytes: chunk,
        })
      );
      offset += chunkSize;
    }

    // fix write instructions - loader-v3 library bug requires 4 bytes padding after first 12 bytes
    const fixedWriteIxs = writeBufferIxs.map(ix => {
      const newData = new Uint8Array([
        ...ix.data!.subarray(0, 12),
        ...[0, 0, 0, 0],
        ...ix.data!.subarray(12, ix.data!.length)
      ]);
      return { ...ix, data: newData };
    });

    ixs.push(...fixedWriteIxs);
    console.log(`Created ${ixs.length} instructions (2 setup + ${ixs.length - 2} writes)`)

    // create instruction plan - this will auto-split if needed
    const instructionPlan = kit.sequentialInstructionPlan(ixs);

    // note we don't add a blockhash yet, we'll add it when signing with Fordefi
    const transactionPlanner = kit.createTransactionPlanner({
        createTransactionMessage: () =>
            kit.pipe(
                kit.createTransactionMessage({ version: 0 }),
                msg => kit.setTransactionMessageFeePayerSigner(deployerVaultSigner, msg),
            ),
    });

    const transactionPlan = await transactionPlanner(instructionPlan);

    return transactionPlan;
}
