/**
 * src/index.js
 * 
 * EventDriven-Knowledge-Graph Server Entry Point.
 */

const express = require('express');
const { PORT, API_KEY } = require('./config/env');
const { syncTurnController, queryContextController } = require('./controllers/memoryController');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Auth middleware
function authGuard(req, res, next) {
    if (!API_KEY) return next();
    const clientKey = req.headers['x-arturo-key'] || req.headers['authorization'];
    if (clientKey === API_KEY || clientKey === `Bearer ${API_KEY}`) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key.' });
}

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'EventDriven-Knowledge-Graph' });
});

// Event-Driven Memory Routes
app.post('/api/v1/memory/sync-turn', authGuard, syncTurnController);
app.get('/api/v1/memory/context', authGuard, queryContextController);

app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🧠 EventDriven-Knowledge-Graph active on port ${PORT}`);
    console.log(`======================================================\n`);
});

module.exports = app;
