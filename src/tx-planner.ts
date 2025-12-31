import fs from 'fs';
import * as kit from '@solana/kit';
import { FordefiSolanaConfig } from './config';
import { Client } from './solana-client-utils';
import * as system from '@solana-program/system';
import * as loader from '@solana-program/loader-v3';


// our tx plan, a in this case a batch that will execute atomically
export async function createTxPlan(fordefiConfig: FordefiSolanaConfig, client: Client) {
    const deployerVault = kit.address(fordefiConfig.deployerVaultAddress);
    const deployerVaultSigner = kit.createNoopSigner(deployerVault);

    // Load buffer keypair
    const bufferKeypairBytes = new Uint8Array(JSON.parse(fs.readFileSync('buffer-keypair.json', 'utf-8')));
    const bufferKeypair = await kit.createKeyPairFromBytes(bufferKeypairBytes);
    const bufferSigner = await kit.createKeyPairSignerFromBytes(bufferKeypairBytes);

    const dataSize = new Uint8Array(fs.readFileSync('target/deploy/solana_deploy_contract_fordefi.so'))
    console.log(`Data size: ${dataSize.length}`)

    const bufferSize = dataSize.length+37;
    const lamports = await client.rpc.getMinimumBalanceForRentExemption(BigInt(bufferSize)).send();

    const ixs = [
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
    ]


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
