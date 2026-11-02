/**
 * src/index.js
 *
 * Punto de entrada HTTP para EventDriven-Knowledge-Graph.
 */

const express = require('express');
const { PORT, API_KEY, VAULT_PATH } = require('./config/env');
const { ensureVaultStructure } = require('./services/vaultBootstrap');
const {
    syncTurnController,
    queryContextController,
    syncVaultController,
    statusMemoryController,
    runBrainCycleController
} = require('./controllers/memoryController');

ensureVaultStructure(VAULT_PATH);

const app = express();
app.use(express.json({ limit: '10mb' }));

function authGuard(req, res, next) {
    if (!API_KEY) return next();
    const clientKey = req.headers['x-arturo-key'] || req.headers['authorization'];
    if (!clientKey || clientKey === API_KEY || clientKey === `Bearer ${API_KEY}`) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid API key.' });
}

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'EventDriven-Knowledge-Graph', vault: VAULT_PATH });
});

app.post('/api/v1/memory/sync-turn', authGuard, syncTurnController);
app.get('/api/v1/memory/context', authGuard, queryContextController);
app.post('/api/v1/memory/sync-vault', authGuard, syncVaultController);
app.post('/api/v1/memory/brain-cycle', authGuard, runBrainCycleController);
app.get('/api/v1/memory/status', authGuard, statusMemoryController);

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`🧠 EventDriven-Knowledge-Graph active on port ${PORT}`);
        console.log(`📂 Active Vault: ${VAULT_PATH}`);
        console.log(`======================================================\n`);
    });
}

module.exports = app;
