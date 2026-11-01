/**
 * src/controllers/memoryController.js
 * 
 * Thin Controller for episodic memory and sync-turn events.
 */

const { procesarCommit, procesarUndo } = require('../services/episodicMemoryService');
const { recuperarContexto, buscarInspiracionMedia } = require('../services/retrievalService');

async function syncTurnController(req, res) {
    try {
        const { action, chat_uuid, step_id, rollback_step } = req.body;

        if (!action || !chat_uuid) {
            return res.status(400).json({ error: 'Missing action or chat_uuid in request body.' });
        }

        if (action.toUpperCase() === 'COMMIT') {
            const result = await procesarCommit(req.body);
            return res.status(200).json({ status: 'committed', data: result });
        } else if (action.toUpperCase() === 'UNDO') {
            const result = await procesarUndo(req.body);
            return res.status(200).json({ status: 'undone', data: result });
        } else {
            return res.status(400).json({ error: `Unknown action: ${action}. Use COMMIT or UNDO.` });
        }
    } catch (err) {
        console.error(`[SYNC_TURN_ERROR] ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
}

async function queryContextController(req, res) {
    try {
        const { query, top_k } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'Missing query parameter.' });
        }

        const topK = parseInt(top_k || '5', 10);
        const [memories, media] = await Promise.all([
            recuperarContexto(query, topK),
            buscarInspiracionMedia(query)
        ]);

        return res.status(200).json({
            query,
            memories,
            media_suggestions: media
        });
    } catch (err) {
        console.error(`[QUERY_CONTEXT_ERROR] ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
}

module.exports = {
    syncTurnController,
    queryContextController
};
