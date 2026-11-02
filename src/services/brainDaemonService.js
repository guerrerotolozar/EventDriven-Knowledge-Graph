/**
 * src/services/brainDaemonService.js
 *
 * Orquestador Central del "Cerebro Vivo":
 * Ejecuta en cadena los 3 Motores Autónomos + Indexación Vectorial en LanceDB:
 *   1. Motor 1 (Project Inspector): Escanea repositorios del servidor -> actualiza fichas .md en OPERACIONES/
 *   2. Motor 2 (Chat Crawler): Revisa chats de Antigravity chat por chat -> consolida hitos en .md y LanceDB
 *   3. Motor 3 (Media Linker): Cruza videos de Media/ contra proyectos al día -> inyecta [[WikiLinks]] bidireccionales
 *   4. Indexador Incremental (LanceDB): Sincroniza todos los .md modificados en la tabla vectorial
 */

const { ejecutarReconciliacionProfunda } = require('./truthReconcilerService');
const { sincronizarVaultIncremental } = require('./vaultIndexerService');

let isRunningCycle = false;

async function ejecutarCicloCerebro({ maxVaultFiles = 60 } = {}) {
    if (isRunningCycle) {
        return { status: 'busy', message: 'Ya hay un ciclo del Cerebro en ejecución.' };
    }

    isRunningCycle = true;
    const t0 = Date.now();

    try {
        // Paso 1: Reconciliar verdad viva del servidor (Ollama + .env + código) -> sobreescribir .md y propagar en cascada
        const reconciliacion = await ejecutarReconciliacionProfunda();

        // Paso 2: Re-indexar incrementalmente las notas .md en LanceDB (qwen3-embedding:8b, 4096d, pesos dinámicos v2)
        const vaultSync = await sincronizarVaultIncremental({ maxFilesPerRun: maxVaultFiles });

        return {
            status: 'completed',
            elapsed_ms: Date.now() - t0,
            truth_reconciliation: reconciliacion,
            vault_vectors: vaultSync
        };
    } finally {
        isRunningCycle = false;
    }
}

module.exports = {
    ejecutarCicloCerebro
};
