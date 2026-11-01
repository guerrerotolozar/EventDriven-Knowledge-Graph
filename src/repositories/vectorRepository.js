/**
 * src/repositories/vectorRepository.js
 * 
 * Embedded LanceDB interface for the Episodic Memory & Knowledge Graph.
 * Supports:
 * - Deterministic fact insertion with step_id
 * - Rollback deletion for Undo operations
 * - Fast vector search
 */

const { LANCEDB_PATH, OLLAMA_URL, OLLAMA_MODEL_EMBED } = require('../config/env');

const TABLE_EPISODIC = 'arturo_episodic';
let db = null;
let episodicTable = null;

async function getDatabase() {
    if (!db) {
        const lancedb = await import('@lancedb/lancedb');
        db = await lancedb.connect(LANCEDB_PATH);
    }
    return db;
}

/**
 * Generates embeddings via Ollama.
 * Pure numerical calculation (~15ms), zero LLM generation.
 */
async function generarEmbedding(text) {
    const urlEmbed = OLLAMA_URL.replace('/generate', '/embeddings');
    const response = await fetch(urlEmbed, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL_EMBED, prompt: text })
    });

    if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.embedding;
}

async function getEpisodicTable() {
    if (episodicTable) return episodicTable;

    const database = await getDatabase();
    const tables = await database.tableNames();

    if (tables.includes(TABLE_EPISODIC)) {
        episodicTable = await database.openTable(TABLE_EPISODIC);
    }
    return episodicTable;
}

/**
 * Inserts an atomic episodic fact into LanceDB.
 */
async function insertarHechoEpisodico(hecho) {
    const database = await getDatabase();
    const vector = await generarEmbedding(hecho.fact_text);

    const record = {
        id: hecho.id,
        vector: vector,
        fact_text: hecho.fact_text,
        category: hecho.category || 'OPERACIONES',
        project_name: hecho.project_name || '',
        chat_uuid: hecho.chat_uuid,
        step_id: hecho.step_id,
        created_at: hecho.created_at || new Date().toISOString(),
        importance: hecho.importance || 0.5,
        files_touched: hecho.files_touched || ''
    };

    const tables = await database.tableNames();
    if (tables.includes(TABLE_EPISODIC)) {
        episodicTable = await database.openTable(TABLE_EPISODIC);
        await episodicTable.add([record]);
    } else {
        episodicTable = await database.createTable(TABLE_EPISODIC, [record]);
    }

    return record;
}

/**
 * Executes deterministic Undo deletion.
 * Removes all facts from a session where step_id > rollback_step.
 */
async function revertirPorStepId(chat_uuid, rollback_step) {
    const table = await getEpisodicTable();
    if (!table) return 0;

    const escapedUuid = chat_uuid.replace(/'/g, "''");
    const condition = `chat_uuid = '${escapedUuid}' AND step_id > ${rollback_step}`;
    await table.delete(condition);
    console.log(`[LANCEDB] Reverted facts where ${condition}`);
    return true;
}

/**
 * Searches episodic memories by vector similarity.
 */
async function buscarEpisodica(query, topK = 10, category = null) {
    const table = await getEpisodicTable();
    if (!table) return [];

    const queryEmbedding = await generarEmbedding(query);
    let search = table.vectorSearch(queryEmbedding);

    if (category) {
        search = search.where(`category = '${category.replace(/'/g, "''")}'`);
    }

    const results = await search.limit(topK).toArray();
    return results.map(r => ({
        id: r.id,
        fact_text: r.fact_text,
        category: r.category,
        project_name: r.project_name,
        chat_uuid: r.chat_uuid,
        step_id: r.step_id,
        created_at: r.created_at,
        importance: r.importance,
        files_touched: r.files_touched,
        distance: r._distance || 0,
        similarity: 1 - (r._distance || 0)
    }));
}

module.exports = {
    generarEmbedding,
    insertarHechoEpisodico,
    revertirPorStepId,
    buscarEpisodica
};
