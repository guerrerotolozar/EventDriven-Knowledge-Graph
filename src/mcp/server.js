#!/usr/bin/env node
/**
 * src/mcp/server.js
 *
 * Servidor MCP (Model Context Protocol) nativo sobre Stdio (JSON-RPC 2.0).
 * Conecta EventDriven-Knowledge-Graph directamente con Antigravity, Claude Code y Cursor
 * sin requerir dependencias externas pesadas.
 */

const readline = require('readline');
const { VAULT_PATH } = require('../config/env');
const { ensureVaultStructure } = require('../services/vaultBootstrap');
const { procesarCommit, procesarUndo } = require('../services/episodicMemoryService');
const { recuperarContextoHibrido } = require('../services/retrievalService');
const { sincronizarVaultIncremental } = require('../services/vaultIndexerService');
const { ejecutarCicloCerebro } = require('../services/brainDaemonService');
const { obtenerEstadisticas } = require('../repositories/vectorRepository');

// Redirigir console.log a stderr para no contaminar el canal JSON-RPC en stdout
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');

ensureVaultStructure(VAULT_PATH);

const TOOLS = [
    {
        name: 'memory_retrieve_context',
        description: 'Busca en la Memoria Episódica (con Time-Decay exponencial) y en la Bóveda Markdown, incluyendo el cruce automático con videos de Media/ (umbral >= 0.78). Úsalo antes de iniciar o diseñar cambios en un proyecto.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Consulta técnica, nombre del proyecto o tarea actual.'
                },
                top_k: {
                    type: 'integer',
                    description: 'Cantidad máxima de recuerdos a recuperar (por defecto: 5).'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'memory_sync_turn',
        description: 'Sincroniza determinísticamente un turno de Antigravity (COMMIT) o revierte el estado hasta un paso anterior (UNDO) usando chat_uuid y step_id, actualizando LanceDB y la bitácora Dataview en Obsidian.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['COMMIT', 'UNDO'],
                    description: 'COMMIT para guardar un hito/turno; UNDO para eliminar todos los pasos > step_id.'
                },
                chat_uuid: {
                    type: 'string',
                    description: 'UUID de la conversación actual de Antigravity.'
                },
                step_id: {
                    type: 'integer',
                    description: 'Paso técnico actual (para COMMIT) o paso al cual retroceder (para UNDO).'
                },
                project_name: {
                    type: 'string',
                    description: 'Nombre del proyecto activo en la bóveda (ej. EventDriven-Knowledge-Graph, CoreAPI).'
                },
                category: {
                    type: 'string',
                    enum: ['OPERACIONES', 'NUCLEO', 'VIDA'],
                    description: 'Categoría en la bóveda (por defecto: OPERACIONES).'
                },
                files_touched: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Lista de archivos creados o modificados en este turno.'
                },
                user_prompt: {
                    type: 'string',
                    description: 'Resumen de la solicitud del usuario.'
                },
                assistant_summary: {
                    type: 'string',
                    description: 'Resumen técnico de los cambios aplicados.'
                },
                importance: {
                    type: 'number',
                    description: 'Peso de importancia entre 0.1 y 1.0 (por defecto: 0.7).'
                }
            },
            required: ['action', 'chat_uuid', 'step_id']
        }
    },
    {
        name: 'memory_sync_vault',
        description: 'Sincroniza incrementalmente las notas .md nuevas o editadas de la Bóveda hacia LanceDB (excluyendo carpetas ignoradas como BotTrading).',
        inputSchema: {
            type: 'object',
            properties: {
                max_files: {
                    type: 'integer',
                    description: 'Máximo de archivos a vectorizar en esta corrida (por defecto: 30).'
                }
            }
        }
    },
    {
        name: 'memory_status',
        description: 'Devuelve las estadísticas actuales de LanceDB (hechos episódicos, chunks de bóveda y ruta activa).',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    }
];

function sendJsonRpc(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

async function handleToolCall(name, args = {}) {
    switch (name) {
        case 'memory_retrieve_context': {
            const res = await recuperarContextoHibrido(args.query, {
                topK: args.top_k || 5
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: res.formatted_prompt_block || 'Sin recuerdos relevantes para esta consulta.'
                    }
                ],
                structuredContent: res
            };
        }
        case 'memory_sync_turn': {
            const act = String(args.action || 'COMMIT').toUpperCase();
            if (act === 'UNDO') {
                const res = await procesarUndo({
                    chat_uuid: args.chat_uuid,
                    rollback_step: args.step_id,
                    project_name: args.project_name
                });
                return {
                    content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
                };
            }
            const res = await procesarCommit({
                chat_uuid: args.chat_uuid,
                step_id: args.step_id,
                files_touched: args.files_touched || [],
                user_prompt: args.user_prompt || '',
                assistant_summary: args.assistant_summary || '',
                project_name: args.project_name || 'General',
                category: args.category || 'OPERACIONES',
                importance: args.importance ?? 0.7
            });
            return {
                content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
            };
        }
        case 'memory_sync_vault': {
            const res = await sincronizarVaultIncremental({
                maxFilesPerRun: args.max_files || 30
            });
            return {
                content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
            };
        }
        case 'memory_status': {
            const stats = await obtenerEstadisticas();
            return {
                content: [{ type: 'text', text: JSON.stringify({ vault_path: VAULT_PATH, ...stats }, null, 2) }]
            };
        }
        case 'memory_run_brain_cycle': {
            const res = await ejecutarCicloCerebro({
                maxVaultFiles: args.max_files || 40,
                forceChats: Boolean(args.force_chats)
            });
            return {
                content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
            };
        }
        default:
            throw new Error(`Herramienta MCP desconocida: ${name}`);
    }
}

async function processRequest(req) {
    if (!req || typeof req !== 'object') return;
    const { id, method, params } = req;

    // Notificaciones sin id no requieren respuesta
    if (id === undefined || id === null) return;

    try {
        if (method === 'initialize') {
            return sendJsonRpc({
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: params?.protocolVersion || '2024-11-05',
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: {
                        name: 'event-driven-knowledge-graph',
                        version: '1.0.0'
                    }
                }
            });
        }

        if (method === 'ping') {
            return sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
        }

        if (method === 'tools/list') {
            return sendJsonRpc({
                jsonrpc: '2.0',
                id,
                result: { tools: TOOLS }
            });
        }

        if (method === 'tools/call') {
            const toolResult = await handleToolCall(params?.name, params?.arguments);
            return sendJsonRpc({
                jsonrpc: '2.0',
                id,
                result: toolResult
            });
        }

        sendJsonRpc({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
        });
    } catch (err) {
        sendJsonRpc({
            jsonrpc: '2.0',
            id,
            result: {
                isError: true,
                content: [{ type: 'text', text: `Error: ${err.message}` }]
            }
        });
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
});

rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
        const parsed = JSON.parse(trimmed);
        processRequest(parsed);
    } catch {
        // Ignorar entradas no JSON
    }
});
