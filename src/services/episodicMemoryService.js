/**
 * src/services/episodicMemoryService.js
 * 
 * Deterministic service that coordinates:
 * - LanceDB episodic insertions and rollbacks
 * - Obsidian Markdown bitácora and YAML updates (Dataview compatibility)
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { VAULT_PATH } = require('../config/env');
const { insertarHechoEpisodico, revertirPorStepId } = require('../repositories/vectorRepository');

/**
 * Handles a COMMIT event.
 */
async function procesarCommit({
    chat_uuid,
    step_id,
    files_touched = [],
    user_prompt = '',
    assistant_summary = '',
    project_name = 'General',
    category = 'OPERACIONES',
    importance = 0.5
}) {
    if (typeof step_id !== 'number' || step_id < 0) {
        throw new Error('step_id must be a non-negative integer.');
    }

    const filesStr = Array.isArray(files_touched) ? files_touched.join(', ') : String(files_touched || '');
    
    // Construct high-signal factual summary
    const factText = [
        `[Proyecto: ${project_name} | Paso ${step_id}]`,
        user_prompt ? `Petición: ${user_prompt}` : '',
        filesStr ? `Archivos: ${filesStr}` : '',
        assistant_summary ? `Acción: ${assistant_summary}` : ''
    ].filter(Boolean).join(' — ');

    // 1. Insert into LanceDB
    const record = await insertarHechoEpisodico({
        id: uuidv4(),
        fact_text: factText,
        category,
        project_name,
        chat_uuid,
        step_id,
        created_at: new Date().toISOString(),
        importance,
        files_touched: filesStr
    });

    // 2. Update local Markdown bitácora in vault
    actualizarBitacoraMarkdown(project_name, step_id, filesStr, assistant_summary);

    return record;
}

/**
 * Handles an UNDO event.
 */
async function procesarUndo({ chat_uuid, rollback_step, project_name }) {
    if (typeof rollback_step !== 'number') {
        throw new Error('rollback_step must be an integer.');
    }

    // 1. Rollback in LanceDB
    await revertirPorStepId(chat_uuid, rollback_step);

    // 2. Revert bitácora lines in Markdown
    if (project_name) {
        revertirBitacoraMarkdown(project_name, rollback_step);
    }

    return { chat_uuid, rollback_step, reverted: true };
}

/**
 * Updates or appends to the project note in the Vault, respecting Dataview frontmatter.
 */
function actualizarBitacoraMarkdown(project_name, step_id, filesStr, summary) {
    try {
        const projectDir = path.join(VAULT_PATH, 'OPERACIONES');
        if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

        const safeProjectName = project_name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const notePath = path.join(projectDir, `${safeProjectName}.md`);
        const today = new Date().toISOString().split('T')[0];

        let content = '';
        if (fs.existsSync(notePath)) {
            content = fs.readFileSync(notePath, 'utf8');
            // Update fecha_actualizacion in YAML frontmatter for Dataview ordering
            if (content.includes('fecha_actualizacion:')) {
                content = content.replace(/fecha_actualizacion:\s*.*/, `fecha_actualizacion: ${today}`);
            }
        } else {
            // New note scaffolding
            content = [
                '---',
                `tipo: proyecto`,
                `proyecto: ${project_name}`,
                `fecha_actualizacion: ${today}`,
                `descripcion: Bitácora y estado determinista para ${project_name}`,
                '---',
                '',
                `# 🚀 Proyecto: ${project_name}`,
                '',
                '## 📝 Bitácora Automática',
                ''
            ].join('\n');
        }

        // Ensure Bitácora header exists
        if (!content.includes('## 📝 Bitácora Automática')) {
            content += '\n\n## 📝 Bitácora Automática\n';
        }

        const logEntry = `- [Step ${step_id} | ${today}] ${filesStr ? `Modificados: ${filesStr} — ` : ''}${summary}\n`;
        content += logEntry;

        fs.writeFileSync(notePath, content, 'utf8');
    } catch (err) {
        console.warn(`[VAULT_LOG] Error updating markdown log: ${err.message}`);
    }
}

/**
 * Reverts markdown log entries where step_id > rollback_step.
 */
function revertirBitacoraMarkdown(project_name, rollback_step) {
    try {
        const safeProjectName = project_name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const notePath = path.join(VAULT_PATH, 'OPERACIONES', `${safeProjectName}.md`);
        if (!fs.existsSync(notePath)) return;

        let content = fs.readFileSync(notePath, 'utf8');
        const lines = content.split('\n');

        const filtered = lines.filter(line => {
            const match = line.match(/- \[Step\s+(\d+)/);
            if (match) {
                const step = parseInt(match[1], 10);
                return step <= rollback_step;
            }
            return true;
        });

        fs.writeFileSync(notePath, filtered.join('\n'), 'utf8');
    } catch (err) {
        console.warn(`[VAULT_LOG] Error reverting markdown log: ${err.message}`);
    }
}

module.exports = {
    procesarCommit,
    procesarUndo
};
