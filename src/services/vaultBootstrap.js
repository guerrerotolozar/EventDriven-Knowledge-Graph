/**
 * src/services/vaultBootstrap.js
 *
 * 1. Auto-genera una estructura de Bóveda limpia (Obsidian + Dataview) para cualquier
 *    usuario de GitHub si VAULT_PATH aún no existe en disco.
 * 2. Si VAULT_PATH ya existe (ej. Z:\Cerebro\Boveda en producción), la respeta al 100%.
 * 3. Provee lectura recursiva con higiene estricta (excluyendo BotTrading, Boveda anidada, etc.).
 */

const fs = require('fs');
const path = require('path');
const { VAULT_PATH, IGNORED_VAULT_DIRS } = require('../config/env');

const DEFAULT_INDEX_MD = `---
tipo: indice
fecha_actualizacion: ${new Date().toISOString().split('T')[0]}
descripcion: Índice Maestro del Segundo Cerebro (Dataview)
---

# 🧠 Segundo Cerebro — Event-Driven Knowledge Graph

---

## 🔴 NUCLEO — Directrices y Arquitectura del Agente

\`\`\`dataview
TABLE descripcion AS "Descripción", fecha_actualizacion AS "Actualizado"
FROM "NUCLEO"
SORT file.name ASC
\`\`\`

---

## 🟢 OPERACIONES — Proyectos y Bitácoras Deterministas

\`\`\`dataview
TABLE descripcion AS "Descripción", fecha_actualizacion AS "Último Turno"
FROM "OPERACIONES"
SORT file.mtime DESC
\`\`\`

---

## 🔵 VIDA — Metas y Contexto Personal

\`\`\`dataview
TABLE descripcion AS "Descripción"
FROM "VIDA"
SORT file.mtime DESC
\`\`\`

---

## 🎬 MEDIA — Inspiración e Ideas (Reels / Videos)

\`\`\`dataview
TABLE fuente_original AS "Autor", tags AS "Categorías"
FROM "Media"
SORT file.mtime DESC
\`\`\`
`;

const DEFAULT_NUCLEO_MD = `---
tipo: nucleo
fecha_actualizacion: ${new Date().toISOString().split('T')[0]}
descripcion: Reglas operativas base y protocolo de memoria determinista
---

# Directrices Operativas del Agente

1. **Estado Determinista:** Cada turno relevante se registra con su \`step_id\` y \`chat_uuid\`.
2. **Soporte de Undo:** Cualquier reversión de pasos elimina determinísticamente los hechos posteriores al \`rollback_step\`.
3. **Cero Alucinación en Base de Datos:** Los vectores se calculan algebraicamente mediante embeddings locales sin usar un LLM intermedio para mutar el estado.
`;

/**
 * Inicializa la bóveda del usuario si no existe.
 */
function ensureVaultStructure(vaultDir = VAULT_PATH) {
    let created = false;
    const subdirs = ['NUCLEO', 'OPERACIONES', 'VIDA', 'Media'];

    if (!fs.existsSync(vaultDir)) {
        fs.mkdirSync(vaultDir, { recursive: true });
        created = true;
    }

    for (const dir of subdirs) {
        const fullDir = path.join(vaultDir, dir);
        if (!fs.existsSync(fullDir)) {
            fs.mkdirSync(fullDir, { recursive: true });
        }
    }

    // Solo crear archivos semilla si la bóveda fue recién creada y no tiene índice
    const indexPath = path.join(vaultDir, '000 - Índice Maestro.md');
    if (created && !fs.existsSync(indexPath)) {
        fs.writeFileSync(indexPath, DEFAULT_INDEX_MD, 'utf8');
        const nucleoSeed = path.join(vaultDir, 'NUCLEO', '01_Directrices_Agente.md');
        if (!fs.existsSync(nucleoSeed)) {
            fs.writeFileSync(nucleoSeed, DEFAULT_NUCLEO_MD, 'utf8');
        }
        console.log(`[VAULT_BOOTSTRAP] ✨ Nueva bóveda generada automáticamente en: ${vaultDir}`);
    }

    return { vaultDir, created };
}

/**
 * Determina la categoría del esquema según la ruta relativa en la bóveda.
 */
function inferCategoryFromPath(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/');
    const topFolder = normalized.split('/')[0].toUpperCase();

    if (topFolder === 'MEDIA') return 'MEDIA_INSPIRATION';
    if (topFolder === 'NUCLEO' || topFolder === 'NÚCLEO') return 'NUCLEO';
    if (topFolder === 'VIDA') return 'VIDA';
    return 'OPERACIONES';
}

/**
 * Lee recursivamente todas las notas .md del vault aplicando la lista negra de directorios.
 * Si `lazyContent = true`, no ejecuta `readFileSync` por red SMB hasta que el indexador
 * confirme que el `mtimeMs` del archivo realmente cambió.
 *
 * @param {string} dir
 * @param {string} rootDir
 * @param {boolean} lazyContent
 * @returns {Array<{ruta: string, fullPath: string, nombre: string, contenido: string|null, mtimeMs: number, createdIso: string, category: string}>}
 */
function leerVaultRecursivo(dir = VAULT_PATH, rootDir = VAULT_PATH, lazyContent = false) {
    if (dir === rootDir) {
        ensureVaultStructure(rootDir);
    }
    const resultados = [];

    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.warn(`[VAULT_READER] No se pudo leer directorio ${dir}: ${err.message}`);
        return resultados;
    }

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (IGNORED_VAULT_DIRS.includes(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            resultados.push(...leerVaultRecursivo(fullPath, rootDir, lazyContent));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            if (entry.name.includes('Bitacora_Ordenes_OasisStore') || entry.name.includes('Mapa_Directorios_y_Espacio_Servidor')) continue;
            try {
                const stats = fs.statSync(fullPath);
                const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
                const contenido = lazyContent ? null : fs.readFileSync(fullPath, 'utf8');

                resultados.push({
                    ruta: relPath,
                    fullPath,
                    nombre: path.basename(fullPath, '.md'),
                    contenido,
                    mtimeMs: Math.floor(stats.mtimeMs),
                    createdIso: new Date(stats.mtimeMs).toISOString(),
                    category: inferCategoryFromPath(relPath)
                });
            } catch {
                // Ignorar archivos bloqueados temporalmente
            }
        }
    }

    return resultados;
}

module.exports = {
    ensureVaultStructure,
    inferCategoryFromPath,
    leerVaultRecursivo
};
