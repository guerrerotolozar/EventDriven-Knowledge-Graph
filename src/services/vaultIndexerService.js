/**
 * src/services/vaultIndexerService.js
 *
 * Sincronizador incremental de la Bóveda Markdown (VAULT_PATH) hacia LanceDB (arturo_vault):
 * - Excluye estrictamente BotTrading/, Boveda/ anidada y carpetas ocultas
 * - Ignora la sección "## 📝 Bitácora Automática" al trocear para no duplicar hechos episódicos
 *   ni provocar bucles de re-indexación cuando sync-turn actualiza una nota
 * - Clasifica automáticamente Media/ como MEDIA_INSPIRATION para el Crucero de Ideas
 */

const { leerVaultRecursivo } = require('./vaultBootstrap');
const {
    upsertChunksVault,
    eliminarChunksPorRutaVault,
    obtenerMapaMtimeVault
} = require('../repositories/vectorRepository');

const MIN_CHUNK_LEN = 50;
const MAX_CHUNK_LEN = 1400;

/**
 * Calcula dinámicamente la importancia de una nota a partir de su frontmatter v2
 * (sin números hardcodeados en el YAML):
 * - Política por `tipo` (nucleo, proyecto, sistema, herramienta, concepto, negocio, vida, media)
 * - Modificador por `estado` (produccion/activo vs. pausado/archivado)
 * - Bono por evidencia de `anclas` y centralidad en `relacionados`
 */
function calcularPesoDinamicoNota(nota) {
    const raw = nota.contenido || '';
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) {
        return nota.category === 'NUCLEO' ? 0.88 : nota.category === 'MEDIA_INSPIRATION' ? 0.75 : 0.65;
    }

    const fmText = fmMatch[1];
    const tipoMatch = fmText.match(/^tipo:\s*(\S+)/m);
    const estadoMatch = fmText.match(/^estado:\s*(\S+)/m);
    const tipo = (tipoMatch ? tipoMatch[1] : '').toLowerCase();
    const estado = (estadoMatch ? estadoMatch[1] : 'activo').toLowerCase();

    const basePorTipo = {
        nucleo: 0.90,
        proyecto: 0.78,
        sistema: 0.78,
        herramienta: 0.76,
        negocio: 0.70,
        vida: 0.68,
        concepto: 0.64,
        media: 0.74
    };
    let score = basePorTipo[tipo] || (nota.category === 'NUCLEO' ? 0.88 : 0.68);

    // Modificador por estado real
    if (estado === 'produccion' || estado === 'activo') score += 0.08;
    else if (estado === 'planeado' || estado === 'idea' || estado === 'por_verificar') score -= 0.06;
    else if (estado === 'pausado') score -= 0.35;
    else if (estado === 'archivado') score -= 0.50;

    // Bono por anclas declaradas al servidor
    const anclasCount = (fmText.match(/^\s*-\s+(ruta|glob|carpeta|repo|contenedor|servicio):/gm) || []).length;
    if (anclasCount > 0) {
        score += Math.min(0.06, anclasCount * 0.015);
    }

    // Bono por centralidad (relacionados)
    const relCount = (fmText.match(/^\s*-\s+[a-z_]+\.[a-z0-9_]+/gm) || []).length;
    if (relCount > 0) {
        score += Math.min(0.05, relCount * 0.01);
    }

    return Math.max(0.10, Math.min(0.98, +score.toFixed(3)));
}

/**
 * Divide una nota Markdown en chunks semánticos limpios, excluyendo la zona automática (auto:begin/end)
 * y cualquier bitácora previa.
 */
function dividirNotaEnChunks(nota) {
    // Excluir zonas automáticas (auto:begin/end y Bitácora Automática)
    const contenidoLimpio = nota.contenido
        .replace(/<!-- auto:begin -->[\s\S]*?<!-- auto:end -->/g, '')
        .split(/^## 📝 Bitácora Automática/m)[0]
        .split(/^## 🔍 Radiografía Viva del Servidor/m)[0];

    const secciones = contenidoLimpio.split(/(?=^#{2,4}\s)/m);
    const chunks = [];
    const dynamicImportance = calcularPesoDinamicoNota(nota);

    for (const sec of secciones) {
        const limpio = sec.trim();
        if (limpio.length < MIN_CHUNK_LEN) continue;

        const fragmento = limpio.substring(0, MAX_CHUNK_LEN);
        const idBase = nota.ruta.replace(/[/\\]/g, '_').replace(/\.md$/i, '');

        chunks.push({
            id: `${idBase}::${chunks.length}`,
            fact_text: `[${nota.nombre}] ${fragmento}`,
            category: nota.category,
            project_name: nota.nombre,
            file_path: nota.ruta,
            file_mtime: nota.mtimeMs,
            created_at: nota.createdIso,
            importance: dynamicImportance
        });
    }

    return chunks;
}

/**
 * Sincroniza incrementalmente las notas nuevas o modificadas de VAULT_PATH en arturo_vault.
 */
async function sincronizarVaultIncremental({ maxFilesPerRun = 50 } = {}) {
    const t0 = Date.now();
    const notas = leerVaultRecursivo();
    const mapaPrevio = await obtenerMapaMtimeVault();

    const pendientes = [];
    for (const nota of notas) {
        const mtimeAnt = mapaPrevio.get(nota.ruta);
        if (!mtimeAnt || mtimeAnt !== nota.mtimeMs) {
            pendientes.push(nota);
        }
    }

    const lote = pendientes.slice(0, maxFilesPerRun);
    let chunksInsertados = 0;

    for (const nota of lote) {
        if (mapaPrevio.has(nota.ruta)) {
            await eliminarChunksPorRutaVault(nota.ruta);
        }
        const chunks = dividirNotaEnChunks(nota);
        if (chunks.length > 0) {
            chunksInsertados += await upsertChunksVault(chunks);
        }
    }

    return {
        total_vault_notes: notas.length,
        pending_notes: pendientes.length,
        processed_notes: lote.length,
        chunks_indexed: chunksInsertados,
        elapsed_ms: Date.now() - t0
    };
}

module.exports = {
    sincronizarVaultIncremental,
    dividirNotaEnChunks
};
