/**
 * src/services/episodicMemoryService.js
 *
 * Servicio determinista de sincronización de turnos:
 * - Inserta hechos atómicos con step_id en LanceDB (arturo_episodic)
 * - Detecta y ejecuta Rollback automático (UNDO) si step_id retrocede
 * - Actualiza las notas de proyectos en OPERACIONES/ respetando el YAML de Dataview
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { VAULT_PATH, IGNORED_VAULT_DIRS } = require('../config/env');
const { ensureVaultStructure } = require('./vaultBootstrap');
const {
    insertarHechoEpisodico,
    obtenerMaxStepId,
    revertirPorStepId
} = require('../repositories/vectorRepository');

function foldStr(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Busca recursivamente si ya existe una nota para el proyecto dentro de OPERACIONES/:
 * 1. Coincidencia exacta por nombre de archivo (`<safeName>.md`).
 * 2. Coincidencia en `aliases:` o `anclas:` dentro del frontmatter YAML (la nota manda al código).
 */
function findExistingProjectNote(dir, safeName) {
    if (!fs.existsSync(dir)) return null;
    const targetFold = foldStr(safeName);
    const allFiles = [];

    function collect(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') || IGNORED_VAULT_DIRS.includes(entry.name)) continue;
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                collect(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                allFiles.push(fullPath);
            }
        }
    }
    collect(dir);

    // 1. Coincidencia por nombre de archivo
    for (const filePath of allFiles) {
        const baseName = path.basename(filePath, '.md');
        if (foldStr(baseName) === targetFold) {
            return filePath;
        }
    }

    // 2. Coincidencia por aliases o anclas en el frontmatter YAML
    for (const filePath of allFiles) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmMatch) continue;
            const fm = foldStr(fmMatch[1]);
            const lines = fm.split(/\r?\n/).map(l => l.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, '').trim());
            if (lines.some(l => l === targetFold || l.endsWith(`/${targetFold}`) || l.endsWith(`\\${targetFold}`))) {
                return filePath;
            }
        } catch {
            // Ignorar error de lectura
        }
    }

    return null;
}

/**
 * Resuelve la ruta del archivo .md para un proyecto en OPERACIONES/Proyectos/<Entidad>/<Entidad>.md.
 */
function resolveProjectNotePath(project_name) {
    ensureVaultStructure(VAULT_PATH);
    const safeProjectName = String(project_name || 'General')
        .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ0-9\s_-]/g, '')
        .trim()
        .replace(/\s+/g, '_');

    const operacionesDir = path.join(VAULT_PATH, 'OPERACIONES');
    const existing = findExistingProjectNote(operacionesDir, safeProjectName);
    if (existing) return existing;

    const proyectosDir = path.join(operacionesDir, 'Proyectos', safeProjectName);
    if (!fs.existsSync(proyectosDir)) {
        fs.mkdirSync(proyectosDir, { recursive: true });
    }
    return path.join(proyectosDir, `${safeProjectName}.md`);
}

/**
 * Procesa un turno COMMIT determinista.
 * Si detecta que step_id <= maxStepRegistrado para ese chat_uuid (hubo Undo implícito),
 * revierte automáticamente los pasos posteriores antes de insertar el nuevo turno.
 */
async function procesarCommit({
    chat_uuid,
    step_id,
    files_touched = [],
    user_prompt = '',
    assistant_summary = '',
    project_name = 'General',
    category = 'OPERACIONES',
    importance = 0.65
}) {
    const stepNum = Number(step_id);
    if (!Number.isInteger(stepNum) || stepNum < 0) {
        throw new Error('step_id debe ser un número entero >= 0');
    }
    if (!chat_uuid) {
        throw new Error('chat_uuid es obligatorio');
    }

    // 1. Verificar si hubo un Undo implícito en la sesión (stepNum <= maxPrevio)
    const maxPrevio = await obtenerMaxStepId(chat_uuid);
    let autoReverted = null;
    if (maxPrevio > stepNum) {
        autoReverted = await procesarUndo({
            chat_uuid,
            rollback_step: stepNum - 1,
            project_name
        });
    }

    const filesStr = Array.isArray(files_touched)
        ? files_touched.join(', ')
        : String(files_touched || '');

    // Construir fact_text determinista y de alta señal semántica
    const factText = [
        `[Proyecto: ${project_name} | Categoría: ${category} | Step ${stepNum}]`,
        user_prompt ? `Objetivo: ${String(user_prompt).trim().substring(0, 500)}` : '',
        filesStr ? `Archivos tocados: ${filesStr}` : '',
        assistant_summary ? `Resultado: ${String(assistant_summary).trim().substring(0, 1200)}` : ''
    ].filter(Boolean).join(' — ');

    // 2. Insertar en LanceDB (arturo_episodic)
    const record = await insertarHechoEpisodico({
        id: crypto.randomUUID(),
        fact_text: factText,
        category,
        project_name,
        chat_uuid,
        step_id: stepNum,
        created_at: new Date().toISOString(),
        importance: Number(importance ?? 0.65),
        files_touched: filesStr
    });

    // 3. Actualizar bitácora en Markdown respetando el YAML de Dataview
    const notePath = actualizarBitacoraMarkdown({
        project_name,
        chat_uuid,
        step_id: stepNum,
        filesStr,
        summary: assistant_summary || user_prompt
    });

    return {
        record,
        note_updated: notePath,
        auto_reverted: autoReverted
    };
}

/**
 * Procesa una acción UNDO determinista:
 * Elimina en LanceDB todos los registros donde chat_uuid == X y step_id > rollback_step,
 * y limpia las líneas correspondientes en las notas Markdown.
 */
async function procesarUndo({ chat_uuid, rollback_step, project_name }) {
    const stepNum = Number(rollback_step);
    if (!Number.isInteger(stepNum)) {
        throw new Error('rollback_step debe ser un número entero');
    }
    if (!chat_uuid) {
        throw new Error('chat_uuid es obligatorio');
    }

    // 1. Eliminar determinísticamente en LanceDB
    const { deletedCount, projectsAffected } = await revertirPorStepId(chat_uuid, stepNum);

    // 2. Revertir líneas en las notas Markdown de todos los proyectos afectados
    const targets = new Set(projectsAffected);
    if (project_name) targets.add(project_name);

    const notesReverted = [];
    for (const proj of targets) {
        const revertedPath = revertirBitacoraMarkdown(proj, chat_uuid, stepNum);
        if (revertedPath) notesReverted.push(revertedPath);
    }

    return {
        chat_uuid,
        rollback_step: stepNum,
        deleted_vectors: deletedCount,
        notes_reverted: notesReverted
    };
}

/**
 * Actualiza la zona automática (`<!-- auto:begin --> ... <!-- auto:end -->`) de la nota .md
 * del proyecto en OPERACIONES/, manteniendo como máximo los últimos 5 cambios atómicos
 * y sin tocar jamás la zona de autor ni usar emojis.
 */
function actualizarBitacoraMarkdown({ project_name, chat_uuid, step_id, filesStr, summary }) {
    try {
        const notePath = resolveProjectNotePath(project_name);
        const today = new Date().toISOString().split('T')[0];
        const chatShort = String(chat_uuid).substring(0, 8);
        const cleanSummary = String(summary || 'Actualización de turno')
            .replace(/#{1,6}\s*/g, '')
            .replace(/---+/g, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\r?\n+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .substring(0, 140);

        const slugId = String(project_name || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        let content = '';
        if (fs.existsSync(notePath)) {
            content = fs.readFileSync(notePath, 'utf8');
        } else {
            fs.mkdirSync(path.dirname(notePath), { recursive: true });
            content = [
                '---',
                `id: proyecto.${slugId}`,
                'tipo: proyecto',
                `resumen: "Proyecto ${project_name}"`,
                'estado: activo',
                'anclas: []',
                'relacionados: []',
                '---',
                '',
                `# ${project_name}`,
                '',
                '<!-- auto:begin -->',
                '## Estado verificado',
                `verificado: ${today}`,
                '<!-- auto:end -->',
                ''
            ].join('\n');
        }

        const logLine = `- [Step ${step_id} | ${chatShort} | ${today}] ${filesStr ? `Modificados: \`${filesStr}\` — ` : ''}${cleanSummary}`;

        const autoMatch = content.match(/<!-- auto:begin -->([\s\S]*?)<!-- auto:end -->/);
        let prevStepLines = [];
        let vigilanteLines = [];
        let statusLine = `verificado: ${today}`;

        if (autoMatch) {
            const innerLines = autoMatch[1].split(/\r?\n/);
            let inVigilanteSection = false;
            for (const ln of innerLines) {
                if (ln.startsWith('verificado:')) {
                    statusLine = ln;
                    inVigilanteSection = false;
                } else if (ln.startsWith('### 💡 Oportunidades')) {
                    inVigilanteSection = true;
                } else if (ln.startsWith('## ')) {
                    inVigilanteSection = false;
                } else if (inVigilanteSection && ln.trim().startsWith('- ')) {
                    vigilanteLines.push(ln);
                } else if (/^-\s*\[Step\s+\d+/i.test(ln)) {
                    const sameStep = new RegExp(`^-\\s*\\[Step\\s+${step_id}\\s*\\|\\s*${chatShort}\\s*\\|`, 'i');
                    if (!sameStep.test(ln)) prevStepLines.push(ln);
                }
            }
        }

        prevStepLines.push(logLine);
        const recentSteps = prevStepLines.slice(-5);

        const autoParts = [
            '<!-- auto:begin -->',
            '## Estado verificado',
            statusLine,
            '## Cambios recientes (max 5)',
            ...recentSteps
        ];
        if (vigilanteLines.length > 0) {
            autoParts.push('', '### 💡 Oportunidades y Conceptos Aplicables (Vigilante)', ...vigilanteLines);
        }
        autoParts.push('<!-- auto:end -->');
        const newAutoBlock = autoParts.join('\n');

        if (autoMatch) {
            content = content.replace(/<!-- auto:begin -->[\s\S]*?<!-- auto:end -->/, newAutoBlock);
        } else {
            content = content.trimEnd() + '\n\n' + newAutoBlock + '\n';
        }

        fs.writeFileSync(notePath, content, 'utf8');
        return notePath;
    } catch (err) {
        console.warn(`[VAULT_BITACORA] Aviso actualizando nota Markdown: ${err.message}`);
        return null;
    }
}

/**
 * Elimina de la bitácora del archivo .md cualquier línea del chat_uuid con Step > rollback_step.
 */
function revertirBitacoraMarkdown(project_name, chat_uuid, rollback_step) {
    try {
        const notePath = resolveProjectNotePath(project_name);
        if (!fs.existsSync(notePath)) return null;

        const chatShort = String(chat_uuid).substring(0, 8);
        const content = fs.readFileSync(notePath, 'utf8');
        const lines = content.split(/\r?\n/);

        let modified = false;
        const filtered = lines.filter(line => {
            const match = line.match(/^-\s*\[Step\s+(\d+)\s*\|\s*([^\s|\]]+)\s*\|/i);
            if (match) {
                const lineStep = parseInt(match[1], 10);
                const lineChat = match[2];
                if (lineChat === chatShort && lineStep > rollback_step) {
                    modified = true;
                    return false;
                }
            }
            return true;
        });

        if (modified) {
            fs.writeFileSync(notePath, filtered.join('\n'), 'utf8');
            return notePath;
        }
        return null;
    } catch (err) {
        console.warn(`[VAULT_BITACORA] Aviso revirtiendo nota Markdown: ${err.message}`);
        return null;
    }
}

module.exports = {
    procesarCommit,
    procesarUndo
};
