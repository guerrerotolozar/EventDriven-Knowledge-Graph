/**
 * src/controllers/memoryController.js
 *
 * Thin Controller para:
 * - POST /api/v1/memory/sync-turn (COMMIT | UNDO determinista por step_id)
 * - GET  /api/v1/memory/context   (Time-Decay + Cruce de inspiración Media/)
 * - POST /api/v1/memory/sync-vault (Sincronización incremental de la Bóveda Markdown)
 * - GET  /api/v1/memory/status    (Estado de tablas en LanceDB)
 */

const { procesarCommit, procesarUndo } = require('../services/episodicMemoryService');
const { recuperarContextoHibrido } = require('../services/retrievalService');
const { sincronizarVaultIncremental } = require('../services/vaultIndexerService');
const { ejecutarCicloCerebro } = require('../services/brainDaemonService');
const { obtenerEstadisticas } = require('../repositories/vectorRepository');

async function syncTurnController(req, res) {
    try {
        const body = req.body || {};
        const action = String(body.action || '').toUpperCase();
        const chat_uuid = body.chat_uuid || body.uuid;

        if (!action || !chat_uuid) {
            return res.status(400).json({
                error: 'Se requieren los campos "action" (COMMIT | UNDO) y "chat_uuid" (o "uuid").'
            });
        }

        if (action === 'COMMIT') {
            const payload = {
                chat_uuid,
                step_id: body.step_id,
                files_touched: body.files_touched || [],
                user_prompt: body.user_prompt || '',
                assistant_summary: body.assistant_summary || body.content || '',
                project_name: body.project_name || 'General',
                category: body.category || 'OPERACIONES',
                importance: body.importance ?? 0.65
            };
            const result = await procesarCommit(payload);
            return res.status(200).json({ status: 'committed', data: result });
        }

        if (action === 'UNDO') {
            const rollback_step = body.rollback_step ?? body.step_id;
            const result = await procesarUndo({
                chat_uuid,
                rollback_step,
                project_name: body.project_name
            });
            return res.status(200).json({ status: 'undone', data: result });
        }

        return res.status(400).json({ error: `Acción desconocida "${action}". Usa COMMIT o UNDO.` });
    } catch (err) {
        console.error(`[SYNC_TURN_ERROR] ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
}

async function queryContextController(req, res) {
    try {
        const { query, top_k, media_threshold } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'Se requiere el parámetro "query".' });
        }

        const topK = parseInt(top_k || '5', 10);
        const mediaThreshold = media_threshold ? parseFloat(media_threshold) : undefined;
        const result = await recuperarContextoHibrido(query, { topK, mediaThreshold });

        return res.status(200).json(result);
    } catch (err) {
        console.error(`[QUERY_CONTEXT_ERROR] ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
}

async function syncVaultController(req, res) {
    try {
        const maxFilesPerRun = parseInt(req.body?.max_files || '50', 10);
        const result = await sincronizarVaultIncremental({ maxFilesPerRun });
        return res.status(200).json({ status: 'synced', data: result });
    } catch (err) {
        console.error(`[SYNC_VAULT_ERROR] ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
}

async function statusMemoryController(req, res) {
    try {
        const stats = await obtenerEstadisticas();
        return res.status(200).json({ status: 'ok', data: stats });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

async function runBrainCycleController(req, res) {
    try {
        const maxVaultFiles = parseInt(req.body?.max_files || '40', 10);
        const forceChats = Boolean(req.body?.force_chats);
        const result = await ejecutarCicloCerebro({ maxVaultFiles, forceChats });
        return res.status(200).json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

module.exports = {
    syncTurnController,
    queryContextController,
    syncVaultController,
    statusMemoryController,
    runBrainCycleController
};
