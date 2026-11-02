#!/usr/bin/env node
/**
 * src/scripts/syncVault.js
 * Script CLI para sincronizar incrementalmente la bóveda Markdown hacia LanceDB.
 */

const { VAULT_PATH } = require('../config/env');
const { sincronizarVaultIncremental } = require('../services/vaultIndexerService');

async function run() {
    const maxFiles = parseInt(process.argv[2] || '100', 10);
    console.log(`[SYNC_CLI] Sincronizando bóveda desde: ${VAULT_PATH} (lote máx: ${maxFiles})...`);
    const result = await sincronizarVaultIncremental({ maxFilesPerRun: maxFiles });
    console.log(`[SYNC_CLI] Resultado:`, JSON.stringify(result, null, 2));
}

run().catch(err => {
    console.error(`[SYNC_CLI] Error:`, err.message);
    process.exit(1);
});
