# 🧠 EventDriven-Knowledge-Graph

> **Deterministic Episodic Memory & Event-Driven Knowledge Graph for Autonomous AI Coding Agents.**  
> Powered by **LanceDB** (Embedded Vector Store), **Obsidian/Markdown** (Dataview Knowledge Graph) & **Native Antigravity MCP + Lifecycle Hooks**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![LanceDB](https://img.shields.io/badge/LanceDB-Rust%20Engine-orange.svg)](https://lancedb.github.io/lancedb/)
[![Antigravity Ready](https://img.shields.io/badge/Antigravity-MCP%20%2B%20Hooks-purple.svg)]()

---

## 🎯 Why Traditional RAG Fails Coding Agents

When autonomous AI agents (Antigravity, Claude Code, Cursor) work on multi-turn engineering sessions:
1. **The LLM State Bottleneck:** Asking a local LLM to summarize and structure database records on every turn causes GPU queuing, slow round-trips, and broken JSON schemas.
2. **The "No-Undo" Poisoning:** Traditional RAG is append-only. When a developer rewinds a chat turn or reverts code, stale hallucinations remain trapped in the vector store.
3. **Temporal Blindness:** Standard vector search ranks solely by cosine similarity, treating an obsolete note from 6 months ago with the same weight as an edit made 2 minutes ago.

---

## ⚡ The Solution: Deterministic State + Mathematical Time-Decay

* **100% Deterministic Extraction:** Consumes turn metadata (`chat_uuid`, `step_id`, `files_touched`, `user_prompt`, `assistant_summary`) directly in Node.js without an intermediate LLM.
* **Pure Vector Algebra (~15ms):** Uses lightweight embedding models (`qwen3-embedding:0.6b`) over LanceDB's native Rust engine.
* **Automatic Undo via `step_id`:** Rewinding a session triggers a deterministic rollback in both LanceDB (`DELETE WHERE chat_uuid = X AND step_id > rollback_step`) and the corresponding Markdown project log.
* **Hybrid Time-Decay Ranking:**
  $$\text{Score} = (0.55 \cdot \text{CosineSimilarity}) + \left(0.30 \cdot e^{-0.02 \cdot \Delta t_{\text{hours}}}\right) + (0.15 \cdot \text{Importance})$$
* **Media Cross-Pollination (`Media/`):** Runs a parallel vector query against transcribed video/reel notes and injects inspiration when $\text{CosineSimilarity} \ge 0.78$.
* **Zero-Config Vault Bootstrap:** Automatically generates a clean, Dataview-ready Markdown vault (`./vault` with `NUCLEO/`, `OPERACIONES/`, `VIDA/`, `Media/`, and `000 - Índice Maestro.md`) on first run—keeping your personal vault 100% private and git-ignored.

---

## 🔌 Native Antigravity Integration (MCP + Lifecycle Hooks)

### 1. MCP Server (`mcp_config.json`)
Exposes 4 tools directly to Antigravity, Claude Code, or Cursor over `stdio`:
* `memory_retrieve_context`: Hybrid Time-Decay search + `Media/` inspiration cross-pollination.
* `memory_sync_turn`: Deterministic `COMMIT` or `UNDO` by `step_id`.
* `memory_sync_vault`: Incremental Markdown vault indexer.
* `memory_status`: Live vector store metrics.

```json
{
  "mcpServers": {
    "arturo-knowledge-graph": {
      "command": "node",
      "args": ["/path/to/EventDriven-Knowledge-Graph/src/mcp/server.js"]
    }
  }
}
```

### 2. Zero-Click Lifecycle Hooks (`hooks.json`)
* **`PreInvocation` (`agyLifecycleHook.js pre`):** Automatically detects if you rewound/undid a message in the Antigravity UI by comparing `transcript.jsonl`'s max `step_index` against LanceDB, rolls back stale steps, and injects relevant Time-Decay memories as an `ephemeralMessage`.
* **`Stop` (`agyLifecycleHook.js stop`):** Automatically extracts modified files and turn summaries from `transcript.jsonl` when a turn completes and commits them to LanceDB + Obsidian Dataview logs.

---

## 🚀 Quickstart

```bash
git clone https://github.com/guerrerotolozar/EventDriven-Knowledge-Graph.git
cd EventDriven-Knowledge-Graph
npm install
cp .env.example .env
```

Run the test suite, sync your vault, or start the HTTP server:
```bash
npm test
npm run sync
npm start
```
