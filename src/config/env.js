/**
 * src/config/env.js
 * Fuente única de configuración para EventDriven-Knowledge-Graph.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const ROOT_DIR = path.resolve(__dirname, '../..');

function expandHome(filepath) {
    if (!filepath) return '';
    if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
        return path.join(os.homedir(), filepath.slice(2));
    }
    return filepath;
}

function resolvePath(inputPath, defaultRel) {
    const raw = expandHome((inputPath || defaultRel).trim());
    if (raw.startsWith('\\\\')) return raw;
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT_DIR, raw);
}

function resolveSafeLanceDbPath(inputPath) {
    const candidate = resolvePath(inputPath, './lancedb_data');
    if (process.platform !== 'win32') return candidate;

    try {
        const checkDir = fs.existsSync(candidate) ? candidate : path.dirname(candidate);
        if (fs.existsSync(checkDir) && typeof fs.realpathSync.native === 'function') {
            const nativeReal = fs.realpathSync.native(checkDir);
            if (nativeReal.startsWith('\\\\')) {
                return fs.existsSync('C:\\Servidor\\Arturo')
                    ? 'C:\\Servidor\\Arturo\\lancedb_data'
                    : path.join(os.homedir(), '.eventdriven-kg', 'lancedb_data');
            }
        }
    } catch {
        // Fallback normal
    }
    return candidate;
}

const IGNORED_VAULT_DIRS = (process.env.IGNORED_VAULT_DIRS || '.git,.obsidian,node_modules,BotTrading,Boveda')
    .split(',')
    .map(d => d.trim())
    .filter(Boolean);

const PROJECT_SCAN_PATHS = (process.env.PROJECT_SCAN_PATHS || ROOT_DIR)
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => resolvePath(p, ROOT_DIR));

const defaultTranscripts = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const TRANSCRIPTS_PATH = resolvePath(process.env.TRANSCRIPTS_PATH, defaultTranscripts);

module.exports = {
    ROOT_DIR,
    PORT: parseInt(process.env.PORT || '3100', 10),
    LANCEDB_PATH: resolveSafeLanceDbPath(process.env.LANCEDB_PATH),
    VAULT_PATH: resolvePath(process.env.VAULT_PATH, './vault'),
    IGNORED_VAULT_DIRS,
    PROJECT_SCAN_PATHS,
    TRANSCRIPTS_PATH,
    OLLAMA_URL: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate').trim(),
    OLLAMA_MODEL_EMBED: (process.env.OLLAMA_MODEL_EMBED || 'qwen3-embedding:8b').trim(),
    DECAY_LAMBDA: parseFloat(process.env.DECAY_LAMBDA || '0.02'),
    WEIGHT_SIMILARITY: parseFloat(process.env.WEIGHT_SIMILARITY || '0.55'),
    WEIGHT_TIME: parseFloat(process.env.WEIGHT_TIME || '0.30'),
    WEIGHT_IMPORTANCE: parseFloat(process.env.WEIGHT_IMPORTANCE || '0.15'),
    MEDIA_SIMILARITY_THRESHOLD: parseFloat(process.env.MEDIA_SIMILARITY_THRESHOLD || '0.38'),
    API_KEY: (process.env.API_KEY || '').trim()
};
