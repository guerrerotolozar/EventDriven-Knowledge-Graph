/**
 * src/services/retrievalService.js
 *
 * Motor de Búsqueda Híbrida con Time-Decay + Cruce de Inspiración con Media/:
 * 1. Consulta 1 (Estado y Memoria Core):
 *    FinalScore = (0.55 * CosineSimilarity) + (0.30 * Math.exp(-0.02 * horas_transcurridas)) + (0.15 * importancia)
 * 2. Consulta 2 (Crucero de Ideas sobre Media/):
 *    Compara en paralelo contra los vectores de Media/ (videos de Instagram) y si
 *    CosineSimilarity >= 0.78 (umbral configurable), los inyecta como inspiración accionable.
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

/**
 * Calcula el puntaje híbrido con decaimiento exponencial temporal.
 */
function calcularPuntajeTimeDecay(item, nowMs = Date.now()) {
    const parsedTime = Date.parse(item.created_at);
    const createdMs = Number.isNaN(parsedTime) ? nowMs : parsedTime;
    const hoursElapsed = Math.max(0, (nowMs - createdMs) / (1000 * 60 * 60));

    const similarity = Math.max(0, Math.min(1, Number(item.similarity || 0)));
    const importance = Math.max(0.1, Math.min(1.0, Number(item.importance || 0.5)));
    const timeDecay = Math.exp(-DECAY_LAMBDA * hoursElapsed);

    // Fórmula ponderada + fórmula aditiva pura para transparencia
    const weightedScore =
        (WEIGHT_SIMILARITY * similarity) +
        (WEIGHT_TIME * timeDecay) +
        (WEIGHT_IMPORTANCE * importance);

    const rawAdditiveScore = similarity + Math.exp(-0.01 * hoursElapsed) + importance;

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
 * usando un único cálculo de embedding para máxima velocidad (~15ms).
 *
 * @param {string} query
 * @param {object} options
 * @param {number} options.topK
 * @param {number} options.mediaThreshold
 */
async function recuperarContextoHibrido(query, { topK = 5, mediaThreshold = MEDIA_SIMILARITY_THRESHOLD } = {}) {
    const queryEmbedding = await generarEmbedding(query);
    const nowMs = Date.now();

    // Ejecutar Consulta 1 (Memoria Core: NUCLEO, OPERACIONES, VIDA) y Consulta 2 (Media/) en paralelo
    const [coreRaw, mediaRaw] = await Promise.all([
        buscarVectorialUnificado(queryEmbedding, { limit: topK * 3, excludeMedia: true }),
        buscarVectorialUnificado(queryEmbedding, { limit: 6, categoryFilter: 'MEDIA_INSPIRATION' })
    ]);

    // Deduplicar Core por contenido / id y aplicar Time-Decay
    const seenCore = new Set();
    const coreScored = [];
    for (const item of coreRaw) {
        const key = `${item.project_name}::${item.fact_text.substring(0, 120)}`;
        if (seenCore.has(key)) continue;
        seenCore.add(key);
        coreScored.push(calcularPuntajeTimeDecay(item, nowMs));
    }

    coreScored.sort((a, b) => b.composite_score - a.composite_score);
    const memories = coreScored.slice(0, topK);

    // Filtrar Media/ por umbral numérico duro (CosineSimilarity >= 0.78 por defecto)
    const seenMedia = new Set();
    const mediaSuggestions = [];
    for (const m of mediaRaw) {
        if (m.similarity < mediaThreshold) continue;
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
        media_suggestions: mediaSuggestions.slice(0, 3),
        formatted_prompt_block: formatearBloqueContexto(memories, mediaSuggestions.slice(0, 3))
    };
}

/**
 * Formatea el resultado listo para inyectar en el contexto de Antigravity.
 */
function formatearBloqueContexto(memories, mediaSuggestions) {
    const sections = [];

    if (memories && memories.length > 0) {
        const lines = memories.map(m => {
            const tag = m.source_table === 'episodic'
                ? `[EPISÓDICO Step ${m.step_id} | ${m.project_name} | hace ${m.hours_elapsed}h]`
                : `[BÓVEDA ${m.category} | ${m.project_name}]`;
            return `- ${tag} (score: ${m.composite_score}, sim: ${m.similarity.toFixed(2)}): ${m.fact_text.substring(0, 350).replace(/\r?\n+/g, ' ')}`;
        });
        sections.push(`[MEMORIA EPISÓDICA Y BÓVEDA (Time-Decay Ranking)]:\n${lines.join('\n')}`);
    }

    if (mediaSuggestions && mediaSuggestions.length > 0) {
        const mediaLines = mediaSuggestions.map(v => {
            const ruta = v.files_touched || v.project_name;
            return `- [Sugerencia de tu carpeta Media/ | Calza al ${v.similarity_pct}] ([[${ruta}]]): ${v.fact_text.substring(0, 320).replace(/\r?\n+/g, ' ')}`;
        });
        sections.push(`[💡 INSPIRACIÓN DE TUS VIDEOS GUARDADOS EN MEDIA/]:\n${mediaLines.join('\n')}`);
    }

    return sections.join('\n\n');
}

module.exports = {
    recuperarContextoHibrido,
    calcularPuntajeTimeDecay,
    formatearBloqueContexto
};
