/**
 * src/config/env.js
 * Centralized environment loader.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

module.exports = {
    PORT: process.env.PORT || 3100,
    LANCEDB_PATH: process.env.LANCEDB_PATH || path.join(__dirname, '../../lancedb_data'),
    VAULT_PATH: process.env.VAULT_PATH || path.join(__dirname, '../../vault-template'),
    OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434/api/generate',
    OLLAMA_MODEL_EMBED: process.env.OLLAMA_MODEL_EMBED || 'qwen3-embedding:0.6b',
    API_KEY: process.env.API_KEY || 'arturo_local_dev_key'
};
