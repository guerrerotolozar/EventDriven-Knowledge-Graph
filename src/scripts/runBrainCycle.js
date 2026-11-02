#!/usr/bin/env node
/**
 * src/scripts/runBrainCycle.js
 *
 * Ejecuta un ciclo completo de los 3 Motores Autónomos del Cerebro Vivo:
 * 1. Inspector de Proyectos del Servidor
 * 2. Crawler de Chats de Antigravity (Chat por Chat)
 * 3. Enlazador Bidireccional de Videos Media/
 * 4. Indexador Vectorial LanceDB
 */

const { ejecutarCicloCerebro } = require('../services/brainDaemonService');

async function main() {
    const maxFiles = parseInt(process.argv[2] || '50', 10);
    const forceChats = process.argv.includes('--force-chats');

    console.log('🧠 [BRAIN_CYCLE] Iniciando ciclo autónomo del Cerebro Vivo...');
    const result = await ejecutarCicloCerebro({ maxVaultFiles: maxFiles, forceChats });
    console.log('✅ [BRAIN_CYCLE] Ciclo completado:\n', JSON.stringify(result, null, 2));
}

main().catch(err => {
    console.error('❌ [BRAIN_CYCLE] Error:', err.message);
    process.exit(1);
});
