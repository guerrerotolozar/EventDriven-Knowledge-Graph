#!/usr/bin/env node
/**
 * src/hooks/agyLifecycleHook.js
 *
 * Hook nativo para el ciclo de vida de Antigravity (hooks.json):
 * - Modo `pre` (PreInvocation):
 *   1. Auto-detecta Undo comparando el step_index de transcript.jsonl contra LanceDB.
 *   2. En el primer paso del turno, inyecta como `ephemeralMessage` el contexto ya preparado
 *      por el servidor (Time-Decay + estado de proyectos + videos de Media/ vinculados).
 *
 * - Modo `stop` (Stop):
 *   1. Registra el paso en LanceDB y lanza en segundo plano (`detached`, 0ms de bloqueo)
 *      el ciclo autónomo del servidor (`runBrainCycle.js`) para que el servidor actualice
 *      las fichas de proyectos, el historial chat por chat y los enlaces de Media/.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { procesarCommit, procesarUndo } = require('../services/episodicMemoryService');
const { recuperarContextoHibrido } = require('../services/retrievalService');
const { sincronizarVaultIncremental } = require('../services/vaultIndexerService');
const { obtenerMaxStepId } = require('../repositories/vectorRepository');

console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');

function parseRecentTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return { maxStep: 0, filesTouched: [], lastAssistantText: '' };
    }

    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split(/\r?\n/);
    let maxStep = 0;
    const filesSet = new Set();
    let lastAssistantText = '';

    const tail = lines.slice(-40);
    for (const line of tail) {
        try {
            const step = JSON.parse(line);
            if (typeof step.step_index === 'number' && step.step_index > maxStep) {
                maxStep = step.step_index;
            }
            if (Array.isArray(step.tool_calls)) {
                for (const tc of step.tool_calls) {
                    const name = tc.name || '';
                    let args = tc.args || tc.arguments || {};
                    if (typeof args === 'string') {
                        try { args = JSON.parse(args); } catch { args = {}; }
                    }
                    if (/write_file|edit_file|replace_file|create_file/i.test(name)) {
                        const target = args.Path || args.TargetFile || args.path || '';
                        if (target && !target.includes('.gemini\\antigravity\\brain')) {
                            filesSet.add(path.basename(target));
                        }
                    }
                }
            }
            if (step.type === 'PLANNER_RESPONSE' && step.content && typeof step.content === 'string') {
                lastAssistantText = step.content;
            }
        } catch {
            // Ignorar líneas truncadas
        }
    }

    return {
        maxStep,
        filesTouched: Array.from(filesSet),
        lastAssistantText
    };
}

function inferProjectName(workspacePaths) {
    if (Array.isArray(workspacePaths) && workspacePaths.length > 0 && workspacePaths[0]) {
        return path.basename(workspacePaths[0]);
    }
    return 'Arturo';
}

async function handlePreInvocation(input) {
    const chatUuid = input.conversationId;
    const projectName = inferProjectName(input.workspacePaths);
    const { maxStep } = parseRecentTranscript(input.transcriptPath);

    if (chatUuid && maxStep > 0) {
        const dbMaxStep = await obtenerMaxStepId(chatUuid);
        if (dbMaxStep > maxStep) {
            await procesarUndo({
                chat_uuid: chatUuid,
                rollback_step: maxStep,
                project_name: projectName
            });
        }
    }

    const rawPrompt = String(input.lastUserInput || '')
        .replace(/<\/?USER_REQUEST>/gi, '')
        .trim();

    // Ignorar invocaciones secundarias dentro del mismo turno o respuestas/saludos conversacionales cortos
    const trivialRe = /^(continue|continuar|ok|okay|si|sí|dale|listo|gracias|hola(\s+como\s+(vas|estas|estás))?|buenas(\s+(tardes|noches|dias|días))?|todo\s+bien|perfecto)[?!.]*$/i;
    if ((input.invocationNum && input.invocationNum > 1) || rawPrompt.length < 10 || trivialRe.test(rawPrompt)) {
        return { injectSteps: [] };
    }

    // Disparar en segundo plano (detached, 0ms de bloqueo al turno) la sincronización incremental
    // de la Bóveda si han pasado más de 3 minutos desde el último chequeo.
    try {
        const { LANCEDB_PATH } = require('../config/env');
        const cacheFile = path.join(LANCEDB_PATH, 'vault_substance_cache.json');
        let shouldSpawnSync = true;
        if (fs.existsSync(cacheFile)) {
            const ageMs = Date.now() - fs.statSync(cacheFile).mtimeMs;
            if (ageMs < 180000) shouldSpawnSync = false;
        }
        if (shouldSpawnSync) {
            const syncScript = path.resolve(__dirname, '../scripts/syncVault.js');
            const child = spawn(process.execPath, [syncScript, '15'], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
        }
    } catch {
        // Nunca bloquear PreInvocation
    }

    const ctx = await recuperarContextoHibrido(rawPrompt, {
        topK: 5,
        excludeChatUuid: chatUuid
    });
    if (!ctx.formatted_prompt_block) {
        return { injectSteps: [] };
    }

    return {
        injectSteps: [
            {
                ephemeralMessage: ctx.formatted_prompt_block
            }
        ]
    };
}

async function handleStop(input) {
    if (input.terminationReason && input.terminationReason !== 'NO_TOOL_CALL') {
        return { decision: 'allow' };
    }

    const chatUuid = input.conversationId;
    const userPrompt = String(input.lastUserInput || '').trim();
    if (!chatUuid || !userPrompt) {
        return { decision: 'allow' };
    }

    const projectName = inferProjectName(input.workspacePaths);
    const { maxStep, filesTouched, lastAssistantText } = parseRecentTranscript(input.transcriptPath);

    if (maxStep > 0 && (filesTouched.length > 0 || lastAssistantText.length > 40)) {
        await procesarCommit({
            chat_uuid: chatUuid,
            step_id: maxStep,
            files_touched: filesTouched,
            user_prompt: userPrompt.substring(0, 300),
            assistant_summary: lastAssistantText.substring(0, 350),
            project_name: projectName,
            category: 'OPERACIONES',
            importance: filesTouched.length > 0 ? 0.85 : 0.65
        });

        // Lanzar en segundo plano (desacoplado, 0ms de espera) el ciclo de actualización del Cerebro
        try {
            const cycleScript = path.resolve(__dirname, '../scripts/runBrainCycle.js');
            const child = spawn(process.execPath, [cycleScript, '10'], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
        } catch {
            // No bloquear nunca
        }
    }

    return { decision: 'allow' };
}

async function main() {
    const mode = (process.argv[2] || 'pre').toLowerCase();
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk;
    }

    let input = {};
    try {
        input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
        input = {};
    }

    try {
        const output = mode === 'stop'
            ? await handleStop(input)
            : await handlePreInvocation(input);
        process.stdout.write(JSON.stringify(output));
    } catch {
        process.stdout.write(JSON.stringify(mode === 'stop' ? { decision: 'allow' } : { injectSteps: [] }));
    }
}

main();
