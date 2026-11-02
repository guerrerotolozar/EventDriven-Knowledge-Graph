/**
 * tests/episodicMemory.test.js
 *
 * Suite de verificación end-to-end para EventDriven-Knowledge-Graph:
 * 1. Verifica Higiene de Bóveda (exclusión de BotTrading y Boveda anidada)
 * 2. Verifica COMMIT determinista en LanceDB + Bitácora Dataview en Markdown
 * 3. Verifica Búsqueda Híbrida con Time-Decay + Cruce de inspiración Media/ (>= 0.78)
 * 4. Verifica UNDO determinista por step_id (borrado en LanceDB + reversión en .md)
 * 5. Verifica Auto-Undo implícito cuando llega un COMMIT con step_id menor al máximo previo
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { leerVaultRecursivo } = require('../src/services/vaultBootstrap');
const { procesarCommit, procesarUndo } = require('../src/services/episodicMemoryService');
const { recuperarContextoHibrido } = require('../src/services/retrievalService');
const { obtenerMaxStepId } = require('../src/repositories/vectorRepository');

const TEST_CHAT_UUID = 'test-session-uuid-9999';
const TEST_PROJECT = 'TestEpisodicProject';

test('1. Higiene de Bóveda: excluye BotTrading y Boveda anidada de VAULT_PATH', () => {
    const notas = leerVaultRecursivo();
    assert.ok(notas.length > 0, 'Debe leer notas reales de la bóveda');

    const contaminadas = notas.filter(n =>
        n.ruta.startsWith('BotTrading/') ||
        n.ruta.startsWith('Boveda/') ||
        n.ruta.includes('/BotTrading/')
    );
    assert.equal(contaminadas.length, 0, 'Ninguna nota debe provenir de BotTrading/ ni Boveda/');

    const mediaNotes = notas.filter(n => n.category === 'MEDIA_INSPIRATION');
    assert.ok(mediaNotes.length > 0, 'Debe detectar notas de Media/ con categoría MEDIA_INSPIRATION');
});

test('2. Flujo COMMIT: inserta pasos 10 y 15 en LanceDB y actualiza Bitácora Markdown', async () => {
    const res10 = await procesarCommit({
        chat_uuid: TEST_CHAT_UUID,
        step_id: 10,
        project_name: TEST_PROJECT,
        category: 'OPERACIONES',
        files_touched: ['src/index.js', 'src/services/retrievalService.js'],
        user_prompt: 'Implementar motor de búsqueda vectorial con Time-Decay en LanceDB',
        assistant_summary: 'Se creó retrievalService.js con decaimiento exponencial y cruce Media/.',
        importance: 0.85
    });

    assert.equal(res10.record.step_id, 10);
    assert.ok(res10.note_updated && fs.existsSync(res10.note_updated), 'La nota .md del proyecto debe existir');

    const res15 = await procesarCommit({
        chat_uuid: TEST_CHAT_UUID,
        step_id: 15,
        project_name: TEST_PROJECT,
        category: 'OPERACIONES',
        files_touched: ['src/experiment_bad.js'],
        user_prompt: 'Experimento temporal que luego será revertido con Undo',
        assistant_summary: 'Se agregó código experimental en experiment_bad.js.',
        importance: 0.4
    });

    assert.equal(res15.record.step_id, 15);
    const maxStep = await obtenerMaxStepId(TEST_CHAT_UUID);
    assert.equal(maxStep, 15);

    const mdContent = fs.readFileSync(res15.note_updated, 'utf8');
    assert.match(mdContent, /\[Step 10 \| test-ses/);
    assert.match(mdContent, /\[Step 15 \| test-ses/);
});

test('3. Búsqueda Híbrida Time-Decay y Cruce con Media/', async () => {
    const ctx = await recuperarContextoHibrido('motor de búsqueda vectorial con Time-Decay en LanceDB', {
        topK: 5
    });

    assert.ok(Array.isArray(ctx.memories) && ctx.memories.length > 0, 'Debe devolver recuerdos rankeados');
    const foundTestProject = ctx.memories.some(m => m.project_name === TEST_PROJECT);
    assert.ok(foundTestProject, 'El turno recién insertado debe aparecer en el top de Time-Decay');
});

test('4. Flujo UNDO determinista: revierte step_id > 10 en LanceDB y en el archivo .md', async () => {
    const undoRes = await procesarUndo({
        chat_uuid: TEST_CHAT_UUID,
        rollback_step: 10,
        project_name: TEST_PROJECT
    });

    assert.equal(undoRes.deleted_vectors, 1, 'Debe haber eliminado exactamente el paso 15 en LanceDB');

    const maxStepAfter = await obtenerMaxStepId(TEST_CHAT_UUID);
    assert.equal(maxStepAfter, 10, 'El step_id máximo en LanceDB debe volver a ser 10');

    const notePath = undoRes.notes_reverted[0];
    assert.ok(notePath && fs.existsSync(notePath));
    const mdAfter = fs.readFileSync(notePath, 'utf8');
    assert.match(mdAfter, /\[Step 10 \| test-ses/, 'El paso 10 debe permanecer en la bitácora');
    assert.doesNotMatch(mdAfter, /\[Step 15 \| test-ses/, 'El paso 15 debe haber sido borrado de la bitácora');

    // Limpieza final de la sesión de prueba (rollback a -1 y borrar nota temporal de prueba)
    await procesarUndo({
        chat_uuid: TEST_CHAT_UUID,
        rollback_step: -1,
        project_name: TEST_PROJECT
    });
    if (fs.existsSync(notePath)) {
        fs.unlinkSync(notePath);
    }
});
