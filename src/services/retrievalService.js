/**
 * src/services/retrievalService.js
 *
 * Motor de Búsqueda Híbrida (Ambient RAG 4096d Cosine) con Time-Decay + Cruce de Inspiración con Media/:
 * 1. Consulta 1 (Memoria Core: Bóveda v2 + Memoria Episódica entre Chats):
 *    - Excluye el chat_uuid actual en memoria episódica para priorizar lo hablado en OTROS chats.
 *    - Aplica umbral mínimo de afinidad semántica (Cosine >= 0.54) para garantizar 0 ruido y 0 gasto de tokens
 *      cuando el mensaje del usuario es trivial o no guarda relación con la bóveda.
 *    - Balancea hasta 3 notas únicas de la Bóveda + hasta 2 recuerdos episódicos de otros chats.
 * 2. Consulta 2 (Crucero de Ideas sobre Media/):
 *    - Compara en paralelo contra los vectores de Media/ y si CosineSimilarity >= 0.58,
 *      los inyecta como inspiración accionable.
 */

const {
    DECAY_LAMBDA,
    WEIGHT_SIMILARITY,
    WEIGHT_TIME,
    WEIGHT_IMPORTANCE,
    MEDIA_SIMILARITY_THRESHOLD
} = require('../config/env');
const {
    generarEmbedding,
    buscarVectorialUnificado
} = require('../repositories/vectorRepository');

const MIN_VAULT_SIMILARITY = 0.57;
const MIN_EPISODIC_SIMILARITY = 0.56;
const MIN_MEDIA_SIMILARITY = Math.max(0.58, MEDIA_SIMILARITY_THRESHOLD || 0.58);

/**
 * Calcula el puntaje híbrido diferenciando entre:
 * - Memoria Episódica (turnos de otros chats): aplica Time-Decay exponencial.
 * - Conocimiento de Bóveda (Proyectos, Herramientas, Conceptos, Núcleo, Vida): el conocimiento no caduca;
 *   domina la Similitud Semántica de qwen3-embedding:8b (78%) + Relevancia Estructural (22%).
 */
function calcularPuntajeTimeDecay(item, nowMs = Date.now()) {
    const parsedTime = Date.parse(item.created_at);
    const createdMs = Number.isNaN(parsedTime) ? nowMs : parsedTime;
    const hoursElapsed = Math.max(0, (nowMs - createdMs) / (1000 * 60 * 60));

    const similarity = Math.max(0, Math.min(1, Number(item.similarity || 0)));
    const importance = Math.max(0.1, Math.min(1.0, Number(item.importance || 0.5)));
    const isEpisodic = item.source_table === 'episodic';

    const effectiveLambda = isEpisodic ? DECAY_LAMBDA : 0.0002;
    const timeDecay = Math.exp(-effectiveLambda * hoursElapsed);

    const weightedScore = isEpisodic
        ? (WEIGHT_SIMILARITY * similarity) + (WEIGHT_TIME * timeDecay) + (WEIGHT_IMPORTANCE * importance)
        : (0.78 * similarity) + (0.22 * importance);

    const rawAdditiveScore = similarity + timeDecay + importance;

    return {
        ...item,
        hours_elapsed: Number(hoursElapsed.toFixed(2)),
        time_decay_factor: Number(timeDecay.toFixed(4)),
        composite_score: Number(weightedScore.toFixed(4)),
        additive_score: Number(rawAdditiveScore.toFixed(4))
    };
}

/**
 * Ejecuta las dos consultas simultáneas (Core Memory con Time-Decay + Cruce con Media/)
 * usando un único cálculo de embedding (~30ms).
 *
 * @param {string} query
 * @param {object} options
 * @param {number} options.topK
 * @param {number} options.mediaThreshold
 * @param {string|null} options.excludeChatUuid
 */
async function recuperarContextoHibrido(query, { topK = 5, mediaThreshold = MIN_MEDIA_SIMILARITY, excludeChatUuid = null } = {}) {
    const queryEmbedding = await generarEmbedding(query);
    const nowMs = Date.now();

    const [coreRaw, mediaRaw] = await Promise.all([
        buscarVectorialUnificado(queryEmbedding, {
            limit: Math.max(18, topK * 4),
            excludeMedia: true,
            excludeChatUuid
        }),
        buscarVectorialUnificado(queryEmbedding, {
            limit: 6,
            categoryFilter: 'MEDIA_INSPIRATION',
            excludeChatUuid
        })
    ]);

    const seenVaultNotes = new Set();
    const seenEpisodic = new Set();
    const vaultHits = [];
    const episodicHits = [];

    for (const item of coreRaw) {
        if (item.source_table === 'vault') {
            if (item.similarity < MIN_VAULT_SIMILARITY) continue;
            const noteKey = item.files_touched || item.project_name || item.id;
            if (seenVaultNotes.has(noteKey)) continue;
            seenVaultNotes.add(noteKey);
            vaultHits.push(calcularPuntajeTimeDecay(item, nowMs));
        } else if (item.source_table === 'episodic') {
            if (item.similarity < MIN_EPISODIC_SIMILARITY) continue;
            const epKey = `${item.chat_uuid}::${item.fact_text.substring(0, 100)}`;
            if (seenEpisodic.has(epKey)) continue;
            seenEpisodic.add(epKey);
            episodicHits.push(calcularPuntajeTimeDecay(item, nowMs));
        }
    }

    vaultHits.sort((a, b) => b.composite_score - a.composite_score);
    episodicHits.sort((a, b) => b.composite_score - a.composite_score);

    // Balancear slots: hasta 3 notas de Bóveda + hasta 2 recuerdos de otros chats
    const maxVault = Math.min(3, topK);
    const maxEpisodic = Math.max(1, topK - maxVault);
    const memories = [
        ...vaultHits.slice(0, maxVault),
        ...episodicHits.slice(0, maxEpisodic)
    ].sort((a, b) => b.composite_score - a.composite_score);

    // Filtrar Media/ por umbral de similitud coseno
    const effectiveMediaThreshold = Math.max(0.58, mediaThreshold);
    const seenMedia = new Set();
    const mediaSuggestions = [];
    for (const m of mediaRaw) {
        if (m.similarity < effectiveMediaThreshold) continue;
        const key = m.files_touched || m.project_name || m.id;
        if (seenMedia.has(key)) continue;
        seenMedia.add(key);
        mediaSuggestions.push({
            ...m,
            similarity_pct: `${(m.similarity * 100).toFixed(1)}%`
        });
    }
    mediaSuggestions.sort((a, b) => b.similarity - a.similarity);

    return {
        query,
        memories,
        media_suggestions: mediaSuggestions.slice(0, 2),
        formatted_prompt_block: formatearBloqueContexto(memories, mediaSuggestions.slice(0, 2))
    };
}

/**
 * Formatea el resultado listo para pre-inyectar como ephemeralMessage en Antigravity.
 */
function formatearBloqueContexto(memories, mediaSuggestions) {
    const sections = [];

    if (memories && memories.length > 0) {
        const lines = memories.map(m => {
            const fp = String(m.files_touched || '');
            const isToolOrConcept = fp.includes('Herramientas/') || fp.includes('Conceptos/');
            const chatShort = m.chat_uuid ? String(m.chat_uuid).substring(0, 8) : '';
            const tag = m.source_table === 'episodic'
                ? `[OTRO CHAT (${chatShort}) · Proy: ${m.project_name} · hace ${m.hours_elapsed}h]`
                : isToolOrConcept
                    ? `[CONCEPTO/HERRAMIENTA EN BÓVEDA · ${m.project_name} (${fp})]`
                    : `[BÓVEDA ${m.category} · ${m.project_name} (${fp})]`;
            const simPct = Math.round((m.similarity || 0) * 100);
            return `- ${tag} [afinidad: ${simPct}%]: ${m.fact_text.substring(0, 360).replace(/\r?\n+/g, ' ')}`;
        });
        sections.push(`[🧠 MEMORIA ACTIVA DEL CEREBRO (Ambient RAG 4096d — Usa este contexto preexistente si complementa tu respuesta)]:\n${lines.join('\n')}`);
    }

    if (mediaSuggestions && mediaSuggestions.length > 0) {
        const mediaLines = mediaSuggestions.map(v => {
            const ruta = v.files_touched || v.project_name;
            return `- [Video/Media en Bóveda | Afinidad ${v.similarity_pct}] ([[${ruta}]]): ${v.fact_text.substring(0, 300).replace(/\r?\n+/g, ' ')}`;
        });
        sections.push(`[💡 INSPIRACIÓN DE VIDEOS CURADOS EN MEDIA/]:\n${mediaLines.join('\n')}`);
    }

    return sections.join('\n\n');
}

module.exports = {
    recuperarContextoHibrido,
    calcularPuntajeTimeDecay,
    formatearBloqueContexto
};
