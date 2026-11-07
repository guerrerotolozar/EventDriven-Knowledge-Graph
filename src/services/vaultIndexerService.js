/**
 * src/services/vaultIndexerService.js
 *
 * Sincronizador incremental de la Bóveda Markdown (VAULT_PATH) hacia LanceDB (arturo_vault):
 * - Excluye estrictamente BotTrading/, Boveda/ anidada y carpetas ocultas
 * - Ignora la sección "## 📝 Bitácora Automática" al trocear para no duplicar hechos episódicos
 *   ni provocar bucles de re-indexación cuando sync-turn actualiza una nota
 * - Clasifica automáticamente Media/ como MEDIA_INSPIRATION para el Crucero de Ideas
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LANCEDB_PATH } = require('../config/env');
const { leerVaultRecursivo } = require('./vaultBootstrap');
const {
    upsertChunksVault,
    eliminarChunksPorRutaVault,
    obtenerMapaMtimeVault
} = require('../repositories/vectorRepository');

const MIN_CHUNK_LEN = 50;
const MAX_CHUNK_LEN = 1400;
const SUBSTANCE_CACHE_PATH = path.join(LANCEDB_PATH, 'vault_substance_cache.json');

/**
 * Calcula el Hash de Sustancia Cognitiva (SHA-256) de una nota Markdown,
 * ignorando bloques de máquina (<!-- auto:begin -->...<!-- auto:end -->),
 * propiedades volátiles de frontmatter y telemetría de rendimiento.
 */
function calcularHashSustancia(contenido) {
    if (!contenido) return '';
    const normalizado = String(contenido)
        .replace(/<!-- auto:begin -->[\s\S]*?<!-- auto:end -->/g, '')
        .replace(/^---\r?\n([\s\S]*?)\r?\n---/m, (full, fm) => {
            const fmEstable = fm
                .split(/\r?\n/)
                .filter(line => !/^\s*(updated_at|actualizado|verificado|curado_vigilante|fecha_modificacion|mtime)\s*:/i.test(line))
                .join('\n');
            return `---\n${fmEstable}\n---`;
        })
        .replace(/---\r?\n+## ⏱️ Rendimiento del Análisis Profundo[\s\S]*$/g, '')
        .replace(/## ⏱️ Rendimiento del Análisis Profundo[\s\S]*$/g, '')
        .replace(/## 🧠 Conexiones Cerebrales[\s\S]*?(?=\r?\n---|\r?\n## |$)/g, '')
        .split(/^## 📝 Bitácora Automática/m)[0]
        .split(/^## 🔍 Radiografía Viva del Servidor/m)[0]
        .replace(/\r\n/g, '\n')
        .trim();

    return crypto.createHash('sha256').update(normalizado, 'utf8').digest('hex');
}

function cargarCacheSustancia() {
    try {
        if (fs.existsSync(SUBSTANCE_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(SUBSTANCE_CACHE_PATH, 'utf8')) || {};
        }
    } catch {
        // Ignorar caché corrupta
    }
    return {};
}

function guardarCacheSustancia(cache) {
    try {
        const dir = path.dirname(SUBSTANCE_CACHE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SUBSTANCE_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch {
        // Ignorar errores de escritura en caché
    }
}

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

    // Modificador por estado real:
    // Las herramientas (`herramienta`) y conceptos (`concepto`) representan conocimiento técnico reutilizable
    // (recetas, patrones, librerías documentadas por si se usan en un proyecto futuro). Aunque el proyecto
    // donde nacieron esté en pausa (`pausado`), NO se penaliza su relevancia técnica para que el RAG las conecte
    // intuitivamente cuando un problema nuevo coincida con su dominio.
    const esConocimientoReutilizable = tipo === 'herramienta' || tipo === 'concepto';

    if (estado === 'produccion' || estado === 'activo') {
        score += 0.08;
    } else if (esConocimientoReutilizable) {
        // Conocimiento técnico documentado (ej. Canvas API, FastAPI, Moonlight): mantiene su relevancia intacta
        if ( raw.includes('```') || raw.includes('## Aprendizaje') || raw.includes('## La Solución') ) {
            score += 0.06; // Bono por receta práctica / código reutilizable documentado
        }
    } else if (estado === 'planeado' || estado === 'idea' || estado === 'por_verificar') {
        score -= 0.06;
    } else if (estado === 'pausado') {
        score -= 0.25;
    } else if (estado === 'archivado') {
        score -= 0.45;
    }

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
    // Excluir zonas automáticas (auto:begin/end, Bitácora Automática y telemetría de tiempos en Media/)
    const contenidoLimpio = nota.contenido
        .replace(/<!-- auto:begin -->[\s\S]*?<!-- auto:end -->/g, '')
        .replace(/---\r?\n+## ⏱️ Rendimiento del Análisis Profundo[\s\S]*$/g, '')
        .replace(/## ⏱️ Rendimiento del Análisis Profundo[\s\S]*$/g, '')
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
 * Aplica Hash de Sustancia Cognitiva (SHA-256) para evitar re-vectorizar cuando solo cambiaron
 * bloques de máquina (<!-- auto:begin -->...<!-- auto:end -->) o timestamps de frontmatter.
 */
async function sincronizarVaultIncremental({ maxFilesPerRun = 50 } = {}) {
    const t0 = Date.now();
    const notas = leerVaultRecursivo(undefined, undefined, true);
    const mapaPrevio = await obtenerMapaMtimeVault();
    const cacheSustancia = cargarCacheSustancia();
    let cacheModificada = false;

    const rutasActuales = new Set(notas.map(n => n.ruta));
    let rutasEliminadas = 0;
    for (const rutaPrev of mapaPrevio.keys()) {
        if (!rutasActuales.has(rutaPrev)) {
            await eliminarChunksPorRutaVault(rutaPrev);
            delete cacheSustancia[rutaPrev];
            cacheModificada = true;
            rutasEliminadas++;
        }
    }

    const pendientes = [];
    for (const nota of notas) {
        const mtimeAnt = mapaPrevio.get(nota.ruta);
        const cacheEntry = cacheSustancia[nota.ruta];

        if (mtimeAnt && (mtimeAnt === nota.mtimeMs || (cacheEntry && cacheEntry.mtimeMs === nota.mtimeMs))) {
            if (!cacheEntry) {
                cacheSustancia[nota.ruta] = { mtimeMs: nota.mtimeMs, hashSustancia: null };
            }
            continue;
        }

        // Solo leemos el archivo por SMB cuando su mtimeMs es nuevo o cambió
        const contenido = nota.contenido !== null ? nota.contenido : fs.readFileSync(nota.fullPath, 'utf8');
        const nuevoHash = calcularHashSustancia(contenido);

        if (!mtimeAnt) {
            pendientes.push({ ...nota, contenido, hashSustancia: nuevoHash });
            continue;
        }

        if (cacheEntry && cacheEntry.hashSustancia && cacheEntry.hashSustancia === nuevoHash) {
            // Solo cambiaron bloques automáticos (<!-- auto:begin -->) o timestamps: omitir re-embedding
            cacheSustancia[nota.ruta] = { mtimeMs: nota.mtimeMs, hashSustancia: nuevoHash };
            continue;
        }

        pendientes.push({ ...nota, contenido, hashSustancia: nuevoHash });
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
        cacheSustancia[nota.ruta] = {
            mtimeMs: nota.mtimeMs,
            hashSustancia: nota.hashSustancia || calcularHashSustancia(nota.contenido)
        };
    }

    guardarCacheSustancia(cacheSustancia);

    return {
        total_vault_notes: notas.length,
        pending_notes: pendientes.length,
        processed_notes: lote.length,
        deleted_notes: rutasEliminadas,
        chunks_indexed: chunksInsertados,
        elapsed_ms: Date.now() - t0
    };
}

module.exports = {
    sincronizarVaultIncremental,
    dividirNotaEnChunks,
    calcularHashSustancia
};
