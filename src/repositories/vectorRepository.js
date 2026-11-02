/**
 * src/repositories/vectorRepository.js
 *
 * Repositorio unificado de LanceDB para:
 * 1. Memoria Episódica (arturo_episodic): Turnos deterministas de Antigravity con soporte de Undo por step_id.
 * 2. Grafo de Bóveda (arturo_vault / arturo_boveda): Notas Markdown e inspiración de Media/ (Reels/Videos).
 */

const fs = require('fs');
const path = require('path');
const {
    LANCEDB_PATH,
    OLLAMA_URL,
    OLLAMA_MODEL_EMBED,
    IGNORED_VAULT_DIRS
} = require('../config/env');
const { inferCategoryFromPath } = require('../services/vaultBootstrap');

const TABLE_EPISODIC = 'arturo_episodic';
const TABLE_VAULT = 'arturo_vault';
const LEGACY_BOVEDA_DB_PATH = path.resolve(__dirname, '../../../API/lancedb_data');
const LEGACY_TABLE_BOVEDA = 'arturo_boveda';

let dbInstance = null;
let legacyDbInstance = null;

async function getDb() {
    if (!dbInstance) {
        if (!fs.existsSync(LANCEDB_PATH)) {
            fs.mkdirSync(LANCEDB_PATH, { recursive: true });
        }
        const lancedb = await import('@lancedb/lancedb');
        dbInstance = await lancedb.connect(LANCEDB_PATH);
    }
    return dbInstance;
}

async function getLegacyBovedaTable() {
    try {
        if (process.platform === 'win32') return null; // En Windows sobre SMB, usar la tabla local arturo_vault
        if (!fs.existsSync(LEGACY_BOVEDA_DB_PATH)) return null;
        const lancedb = await import('@lancedb/lancedb');
        if (!legacyDbInstance) {
            legacyDbInstance = await lancedb.connect(LEGACY_BOVEDA_DB_PATH);
        }
        const names = await legacyDbInstance.tableNames();
        if (names.includes(LEGACY_TABLE_BOVEDA)) {
            return await legacyDbInstance.openTable(LEGACY_TABLE_BOVEDA);
        }
    } catch {
        // Ignorar si no existe o no es accesible
    }
    return null;
}

/**
 * Genera el vector de embedding vía Ollama (/api/embeddings) con reintento ante fallos transitorios de red.
 */
async function generarEmbedding(texto, retries = 3) {
    const cleanText = String(texto || '').trim().substring(0, 3000);
    if (!cleanText) throw new Error('Texto vacío para generarEmbedding');

    const urlEmbed = OLLAMA_URL.replace(/\/api\/generate\/?$/, '/api/embeddings');
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(urlEmbed, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: OLLAMA_MODEL_EMBED, prompt: cleanText })
            });

            if (!response.ok) {
                throw new Error(`Error HTTP ${response.status} al generar embedding con ${OLLAMA_MODEL_EMBED}`);
            }

            const data = await response.json();
            if (!data.embedding || !Array.isArray(data.embedding)) {
                throw new Error('Respuesta de Ollama no contiene un vector embedding válido');
            }
            return data.embedding;
        } catch (err) {
            if (attempt === retries) throw err;
            await new Promise(r => setTimeout(r, 1500 * attempt));
        }
    }
}

/**
 * Genera embeddings en lote usando el endpoint /api/embed de Ollama (mucho más rápido en GPU)
 * con fallback individual y reintentos automáticos.
 */
async function generarEmbeddingsBatch(textos, retries = 3) {
    const cleanTexts = textos.map(t => String(t || '').trim().substring(0, 3000));
    const urlBatch = OLLAMA_URL.replace(/\/api\/generate\/?$/, '/api/embed');

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(urlBatch, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: OLLAMA_MODEL_EMBED, input: cleanTexts })
            });

            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data.embeddings) && data.embeddings.length === cleanTexts.length) {
                    return data.embeddings;
                }
            }
        } catch (err) {
            if (attempt === retries) {
                // Fallback uno por uno con reintento
                const out = [];
                for (const txt of cleanTexts) {
                    out.push(await generarEmbedding(txt, retries));
                }
                return out;
            }
            await new Promise(r => setTimeout(r, 1500 * attempt));
        }
    }

    const out = [];
    for (const txt of cleanTexts) {
        out.push(await generarEmbedding(txt, retries));
    }
    return out;
}

/**
 * Abre la tabla episódica si existe.
 */
async function openEpisodicTable() {
    const db = await getDb();
    const names = await db.tableNames();
    if (names.includes(TABLE_EPISODIC)) {
        return await db.openTable(TABLE_EPISODIC);
    }
    return null;
}

/**
 * Abre la tabla de bóveda si existe.
 */
async function openVaultTable() {
    const db = await getDb();
    const names = await db.tableNames();
    if (names.includes(TABLE_VAULT)) {
        return await db.openTable(TABLE_VAULT);
    }
    return null;
}

/**
 * Verifica que la dimensión vectorial de la tabla coincida con la del modelo activo.
 * Si el modelo de embeddings cambió (ej. 1024 -> 4096 con qwen3-embedding:8b),
 * recrea la tabla automáticamente para evitar errores de esquema en LanceDB.
 */
async function ensureCompatibleTable(db, tableName, expectedDim) {
    const names = await db.tableNames();
    if (!names.includes(tableName)) return null;

    const table = await db.openTable(tableName);
    try {
        const sample = await table.query().limit(1).toArray();
        if (sample && sample.length > 0 && sample[0].vector) {
            const currentDim = sample[0].vector.length;
            if (currentDim !== expectedDim) {
                console.log(`[LanceDB] Cambio de dimensión detectado en ${tableName} (${currentDim} -> ${expectedDim}). Recreando tabla...`);
                await db.dropTable(tableName);
                return null;
            }
        }
    } catch {
        // Si falla la lectura del sample, recrear limpiamente
        await db.dropTable(tableName);
        return null;
    }
    return table;
}

/**
 * Inserta un hecho atómico en la tabla arturo_episodic.
 */
async function insertarHechoEpisodico(hecho) {
    const db = await getDb();
    const vector = hecho.vector || await generarEmbedding(hecho.fact_text);

    const record = {
        id: String(hecho.id),
        vector,
        fact_text: String(hecho.fact_text).substring(0, 3000),
        category: String(hecho.category || 'OPERACIONES'),
        project_name: String(hecho.project_name || 'General'),
        chat_uuid: String(hecho.chat_uuid),
        step_id: Number(hecho.step_id),
        created_at: String(hecho.created_at || new Date().toISOString()),
        importance: Number(hecho.importance ?? 0.6),
        files_touched: String(hecho.files_touched || '')
    };

    const table = await ensureCompatibleTable(db, TABLE_EPISODIC, vector.length);
    if (table) {
        const escapedUuid = record.chat_uuid.replace(/'/g, "''");
        await table.delete(`chat_uuid = '${escapedUuid}' AND step_id = ${record.step_id}`);
        await table.add([record]);
    } else {
        await db.createTable(TABLE_EPISODIC, [record]);
    }

    return record;
}

/**
 * Obtiene el step_id máximo registrado para un chat_uuid.
 * Permite detectar automáticamente si el usuario hizo Undo en la UI de Antigravity.
 */
async function obtenerMaxStepId(chat_uuid) {
    const table = await openEpisodicTable();
    if (!table) return -1;

    try {
        const escapedUuid = String(chat_uuid).replace(/'/g, "''");
        const rows = await table
            .query()
            .where(`chat_uuid = '${escapedUuid}'`)
            .select(['step_id'])
            .toArray();

        if (!rows || rows.length === 0) return -1;
        return Math.max(...rows.map(r => Number(r.step_id)));
    } catch {
        return -1;
    }
}

/**
 * Ejecuta el Undo determinista en LanceDB:
 * DELETE WHERE chat_uuid = X AND step_id > rollback_step
 */
async function revertirPorStepId(chat_uuid, rollback_step) {
    const table = await openEpisodicTable();
    if (!table) return { deletedCount: 0 };

    const escapedUuid = String(chat_uuid).replace(/'/g, "''");
    const stepNum = Number(rollback_step);
    const condition = `chat_uuid = '${escapedUuid}' AND step_id > ${stepNum}`;

    const beforeRows = await table.query().where(condition).select(['id', 'project_name', 'step_id']).toArray();
    if (beforeRows.length > 0) {
        await table.delete(condition);
    }

    const projectsAffected = Array.from(new Set(beforeRows.map(r => r.project_name).filter(Boolean)));
    return {
        deletedCount: beforeRows.length,
        projectsAffected
    };
}

/**
 * Inserta o actualiza chunks de archivos Markdown de la bóveda en arturo_vault.
 */
async function upsertChunksVault(chunks) {
    if (!chunks || chunks.length === 0) return 0;
    const db = await getDb();
    const vectors = await generarEmbeddingsBatch(chunks.map(c => c.fact_text));
    const registros = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = vectors[i];
        registros.push({
            id: String(chunk.id),
            vector,
            fact_text: String(chunk.fact_text).substring(0, 2500),
            category: String(chunk.category || 'OPERACIONES'),
            project_name: String(chunk.project_name || ''),
            chat_uuid: 'VAULT_STATIC',
            step_id: 0,
            created_at: String(chunk.created_at || new Date().toISOString()),
            importance: Number(chunk.importance ?? 0.7),
            files_touched: String(chunk.file_path || ''),
            file_mtime: Number(chunk.file_mtime || 0)
        });
    }

    const table = await ensureCompatibleTable(db, TABLE_VAULT, registros[0].vector.length);
    if (table) {
        await table.add(registros);
    } else {
        await db.createTable(TABLE_VAULT, registros);
    }

    return registros.length;
}

/**
 * Elimina chunks de una nota específica en arturo_vault antes de re-indexarla.
 */
async function eliminarChunksPorRutaVault(relPath) {
    const table = await openVaultTable();
    if (!table) return;
    const escaped = String(relPath).replace(/'/g, "''");
    await table.delete(`files_touched = '${escaped}'`);
}

/**
 * Obtiene el mapa de { file_path -> file_mtime } actualmente indexado en arturo_vault.
 * Si el modelo de embeddings cambió de dimensión, invalida la tabla para forzar re-indexado completo.
 */
async function obtenerMapaMtimeVault() {
    const mapa = new Map();
    const db = await getDb();
    try {
        const probeVec = await generarEmbedding('probe_dimension');
        const table = await ensureCompatibleTable(db, TABLE_VAULT, probeVec.length);
        if (!table) return mapa;

        const rows = await table.query().select(['files_touched', 'file_mtime']).toArray();
        for (const r of rows) {
            if (r.files_touched) {
                mapa.set(r.files_touched, Number(r.file_mtime || 0));
            }
        }
    } catch {
        // Tabla vacía o sin inicializar
    }
    return mapa;
}

/**
 * Verifica si una ruta pertenece a los directorios huérfanos ignorados (ej. BotTrading, Boveda).
 */
function isIgnoredPath(rutaStr) {
    if (!rutaStr) return false;
    const parts = String(rutaStr).replace(/\\/g, '/').split('/');
    return parts.some(p => IGNORED_VAULT_DIRS.includes(p));
}

/**
 * Búsqueda vectorial unificada sobre:
 * - arturo_episodic (Memoria de turnos con step_id)
 * - arturo_vault (Grafo Markdown sincronizado)
 * - arturo_boveda (Puente automático con la base existente en Z:\API\lancedb_data si está disponible)
 *
 * @param {number[]} queryEmbedding
 * @param {object} options
 * @param {number} options.limit
 * @param {string|null} options.categoryFilter - Si se especifica (ej. 'MEDIA_INSPIRATION'), filtra por categoría
 * @param {boolean} options.excludeMedia - Si true, excluye MEDIA_INSPIRATION
 */
async function buscarVectorialUnificado(queryEmbedding, { limit = 15, categoryFilter = null, excludeMedia = false } = {}) {
    const candidatos = [];

    // 1. Buscar en arturo_episodic
    const episodicTable = await openEpisodicTable();
    if (episodicTable) {
        try {
            let search = episodicTable.vectorSearch(queryEmbedding);
            if (categoryFilter) {
                search = search.where(`category = '${categoryFilter.replace(/'/g, "''")}'`);
            } else if (excludeMedia) {
                search = search.where(`category != 'MEDIA_INSPIRATION'`);
            }
            const rows = await search.limit(limit).toArray();
            for (const r of rows) {
                if (isIgnoredPath(r.files_touched)) continue;
                candidatos.push({
                    id: r.id,
                    source_table: 'episodic',
                    fact_text: r.fact_text,
                    category: r.category,
                    project_name: r.project_name,
                    chat_uuid: r.chat_uuid,
                    step_id: r.step_id,
                    created_at: r.created_at,
                    importance: Number(r.importance ?? 0.6),
                    files_touched: r.files_touched,
                    distance: Number(r._distance ?? 1),
                    similarity: Math.max(0, 1 - Number(r._distance ?? 1))
                });
            }
        } catch (err) {
            console.warn(`[VECTOR_SEARCH] Aviso en tabla episodic: ${err.message}`);
        }
    }

    // 2. Buscar en arturo_vault
    const vaultTable = await openVaultTable();
    if (vaultTable) {
        try {
            let search = vaultTable.vectorSearch(queryEmbedding);
            if (categoryFilter) {
                search = search.where(`category = '${categoryFilter.replace(/'/g, "''")}'`);
            } else if (excludeMedia) {
                search = search.where(`category != 'MEDIA_INSPIRATION'`);
            }
            const rows = await search.limit(limit).toArray();
            for (const r of rows) {
                if (isIgnoredPath(r.files_touched)) continue;
                candidatos.push({
                    id: r.id,
                    source_table: 'vault',
                    fact_text: r.fact_text,
                    category: r.category,
                    project_name: r.project_name,
                    chat_uuid: r.chat_uuid,
                    step_id: r.step_id,
                    created_at: r.created_at,
                    importance: Number(r.importance ?? 0.7),
                    files_touched: r.files_touched,
                    distance: Number(r._distance ?? 1),
                    similarity: Math.max(0, 1 - Number(r._distance ?? 1))
                });
            }
        } catch (err) {
            console.warn(`[VECTOR_SEARCH] Aviso en tabla vault: ${err.message}`);
        }
    }

    // 3. Puente con arturo_boveda existente (22,534 docs en Z:\API\lancedb_data) si está disponible
    const legacyTable = await getLegacyBovedaTable();
    if (legacyTable) {
        try {
            const rows = await legacyTable.vectorSearch(queryEmbedding).limit(limit * 2).toArray();
            for (const r of rows) {
                const ruta = r.ruta || '';
                if (isIgnoredPath(ruta) || isIgnoredPath(r.carpeta)) continue;

                const cat = inferCategoryFromPath(ruta || r.carpeta || '');
                if (categoryFilter && cat !== categoryFilter) continue;
                if (excludeMedia && cat === 'MEDIA_INSPIRATION') continue;

                candidatos.push({
                    id: r.id,
                    source_table: 'boveda_legacy',
                    fact_text: r.text,
                    category: cat,
                    project_name: r.fuente || path.basename(ruta, '.md'),
                    chat_uuid: 'BOVEDA',
                    step_id: 0,
                    created_at: r.sincronizado || new Date().toISOString(),
                    importance: cat === 'NUCLEO' ? 0.85 : (cat === 'MEDIA_INSPIRATION' ? 0.80 : 0.70),
                    files_touched: ruta,
                    distance: Number(r._distance ?? 1),
                    similarity: Math.max(0, 1 - Number(r._distance ?? 1))
                });
            }
        } catch {
            // Ignorar si la tabla legacy está ocupada
        }
    }

    return candidatos;
}

/**
 * Estadísticas generales del motor vectorial.
 */
async function obtenerEstadisticas() {
    const episodicTable = await openEpisodicTable();
    const vaultTable = await openVaultTable();
    const legacyTable = await getLegacyBovedaTable();

    const episodicCount = episodicTable ? await episodicTable.countRows() : 0;
    const vaultCount = vaultTable ? await vaultTable.countRows() : 0;
    const legacyCount = legacyTable ? await legacyTable.countRows() : 0;

    return {
        lancedb_path: LANCEDB_PATH,
        episodic_facts: episodicCount,
        vault_chunks: vaultCount,
        legacy_boveda_chunks: legacyCount
    };
}

module.exports = {
    generarEmbedding,
    insertarHechoEpisodico,
    obtenerMaxStepId,
    revertirPorStepId,
    upsertChunksVault,
    eliminarChunksPorRutaVault,
    obtenerMapaMtimeVault,
    buscarVectorialUnificado,
    obtenerEstadisticas,
    isIgnoredPath
};
