/**
 * src/services/truthReconcilerService.js
 *
 * Motor de Reconciliación Código -> Bóveda (Arquitectura v2):
 * - Resuelve las anclas (`ruta`, `glob`, `carpeta`, `repo`, `contenedor`, `servicio`) declaradas
 *   por cada nota `.md` en su frontmatter YAML ("la nota manda al código").
 * - Consulta en vivo el servidor Ollama (`OLLAMA_URL`) para detectar modelos instalados y dimensiones.
 * - Si la bóveda activa define un reconciliador local privado en `<VAULT_PATH>/.reconciler/truthReconcilerLocal.js`
 *   (ignorado por Git para mantener privados los proyectos y topología personal del autor), delega en él.
 * - En caso contrario, ejecuta la reconciliación genérica basada en las anclas YAML de cada `.md` y
 *   actualiza la zona de máquina `<!-- auto:begin --> ... <!-- auto:end -->` y el índice maestro.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { VAULT_PATH, ROOT_DIR, OLLAMA_URL, OLLAMA_MODEL_EMBED } = require('../config/env');
const { leerVaultRecursivo } = require('./vaultBootstrap');

const ROOTS = {
    '@cerebro': process.env.ROOT_ALIAS_CEREBRO || ROOT_DIR,
    '@api': process.env.ROOT_ALIAS_API || path.resolve(ROOT_DIR, '../API'),
    '@servidor': process.env.ROOT_ALIAS_SERVIDOR || path.resolve(ROOT_DIR, '..'),
    '@webapps': process.env.ROOT_ALIAS_WEBAPPS || path.resolve(ROOT_DIR, '../WebApps')
};

function resolveAliasPath(anchorVal) {
    if (!anchorVal) return null;
    for (const [alias, realBase] of Object.entries(ROOTS)) {
        if (anchorVal === alias) return realBase;
        if (anchorVal.startsWith(alias + '/')) {
            return path.join(realBase, anchorVal.slice(alias.length + 1));
        }
    }
    return path.isAbsolute(anchorVal) ? anchorVal : path.resolve(ROOT_DIR, anchorVal);
}

async function fetchOllamaModels() {
    const baseUrl = OLLAMA_URL.replace(/\/api\/(generate|embeddings|chat)\/?$/, '');
    try {
        const res = await fetch(`${baseUrl}/api/tags`);
        if (!res.ok) return { online: false, models: [] };
        const data = await res.json();
        return { online: true, models: data.models || [] };
    } catch {
        return { online: false, models: [] };
    }
}

async function descubrirVerdadServidor() {
    const localReconcilerPath = path.join(VAULT_PATH, '.reconciler', 'truthReconcilerLocal.js');
    if (fs.existsSync(localReconcilerPath)) {
        const localMod = require(localReconcilerPath);
        if (typeof localMod.descubrirVerdadServidor === 'function') {
            return await localMod.descubrirVerdadServidor();
        }
    }

    const ollamaInfo = await fetchOllamaModels();
    return {
        timestamp: new Date().toISOString().split('T')[0],
        ollamaOnline: ollamaInfo.online,
        ollamaModels: ollamaInfo.models,
        rolesActivos: {
            embedding: OLLAMA_MODEL_EMBED
        }
    };
}

function verificarAnclasNota(contenido) {
    const fmMatch = String(contenido || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return { total: 0, resueltas: 0, ultimoCommit: null };

    const fm = fmMatch[1];
    const anclasMatches = [...fm.matchAll(/^\s*-\s+(ruta|carpeta|repo):\s*["']?([^"'\r\n]+)["']?/gm)];
    let resueltas = 0;
    let ultimoCommit = null;

    for (const m of anclasMatches) {
        const tipo = m[1];
        const target = resolveAliasPath(m[2].trim());
        if (target && fs.existsSync(target)) {
            resueltas++;
            if (tipo === 'repo' && !ultimoCommit) {
                try {
                    ultimoCommit = execSync(`git -C "${target}" log -n 1 --date=short --format="%h (%ad): %s"`, {
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'ignore']
                    }).trim();
                } catch {}
            }
        }
    }

    return {
        total: anclasMatches.length,
        resueltas,
        ultimoCommit
    };
}

async function ejecutarReconciliacionProfunda() {
    const localReconcilerPath = path.join(VAULT_PATH, '.reconciler', 'truthReconcilerLocal.js');
    if (fs.existsSync(localReconcilerPath)) {
        const localMod = require(localReconcilerPath);
        if (typeof localMod.ejecutarReconciliacionProfunda === 'function') {
            return await localMod.ejecutarReconciliacionProfunda();
        }
    }

    const truth = await descubrirVerdadServidor();
    const notas = leerVaultRecursivo(VAULT_PATH);
    const actualizadas = [];

    for (const nota of notas) {
        if (nota.ruta.startsWith('Media/')) continue;
        const { total, resueltas, ultimoCommit } = verificarAnclasNota(nota.contenido);
        if (total === 0) continue;

        const lineaEstado = [
            `verificado: ${truth.timestamp}`,
            `anclas_resueltas: ${resueltas}/${total}`,
            `embedding_activo: ${OLLAMA_MODEL_EMBED}`,
            ultimoCommit ? `ultimo_commit: ${ultimoCommit}` : null
        ].filter(Boolean).join(' | ');

        const autoBlock = `<!-- auto:begin -->\n## Estado verificado\n${lineaEstado}\n<!-- auto:end -->`;
        let nuevoContenido = nota.contenido;

        if (nuevoContenido.includes('<!-- auto:begin -->')) {
            nuevoContenido = nuevoContenido.replace(
                /<!-- auto:begin -->([\s\S]*?)<!-- auto:end -->/,
                (_, inner) => {
                    if (/^verificado:.*$/m.test(inner)) {
                        return `<!-- auto:begin -->${inner.replace(/^verificado:.*$/m, lineaEstado)}<!-- auto:end -->`;
                    }
                    return `<!-- auto:begin -->\n## Estado verificado\n${lineaEstado}\n${inner.trim()}\n<!-- auto:end -->`;
                }
            );
        } else {
            nuevoContenido = `${nuevoContenido.trimEnd()}\n\n${autoBlock}\n`;
        }

        if (nuevoContenido !== nota.contenido) {
            fs.writeFileSync(path.join(VAULT_PATH, nota.ruta), nuevoContenido, 'utf8');
            actualizadas.push(nota.ruta);
        }
    }

    return {
        timestamp: truth.timestamp,
        ollamaOnline: truth.ollamaOnline,
        modelosDetectados: truth.ollamaModels.length,
        rolesActivos: truth.rolesActivos,
        fichasMaestrasReescritas: actualizadas
    };
}

module.exports = {
    descubrirVerdadServidor,
    ejecutarReconciliacionProfunda,
    resolveAliasPath,
    ROOTS
};
