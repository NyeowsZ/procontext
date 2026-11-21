---
name: context
description: Tracks exact server-side token usage per AI turn and live context window consumption for the active chat, matching the accuracy of Antigravity CLI's /context command. Use when the user asks about context usage, token count, context window limits, prompt caching, or triggers /context.
---

# /context: Procontext — Token & Context Window Meter

This skill inspects exact, server-side telemetry from the active conversation without client-side approximation or token estimation. It matches the accuracy of the Antigravity CLI `/context` command and adds live 5-hour & Weekly quota tracking with model separation and cross-chat cache lifespan bounds.

## Available MCP Tools

1. **`get_token_context`**:
   - `model` (optional, string): Filter to a specific model (e.g. `'Claude Opus 5.5'`, `'Gemini 4 Neon'`) or `'all'` (default).
   - `conversation_id` (optional, string): Cascade ID (defaults to active chat).
   - Returns: Live context window utilization, active model limits, latest turn breakdown, cross-chat cache lifespan bounds, account & 5h/Weekly quota pools with model separation, and session cumulative totals.

2. **`get_quota_status`**:
   - `model` (optional, string): Filter to a specific model or `'all'` (default).
   - Returns: Active account status, 5-hour and Weekly quota pools with visual progress bars, per-1% token burn rates, remaining runway estimates, per-model consumption breakdown (Input, Cache Read, Thinking, Response, Share %, Quota %), and recent quota snapshots.

3. **`get_turn_history`**:
   - `view`: `'prompt'` (default, grouped by user message boundary) or `'step'` (granular LLM invocations).
   - `limit`: Number of recent entries (default: 10).

## How to Check Token Usage & Context

When the user asks for `/context`, asks about account quota, or inquires about current token usage, follow these steps:

1. **Query Telemetry**:
   Call the `token-context-meter` MCP tool `get_token_context` (or `get_quota_status` for dedicated quota inquiries):
   - Pass `model` if the user is interested in a particular model or quota pool.
   - If MCP is lazy-loaded or not yet initialized in the current turn, you can run the quick Node one-liner:
     ```bash
     node -e "const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),url=require('node:url');const p=[path.resolve('sidecars/meter/telemetry.mjs'),path.join(os.homedir(),'.gemini','config','plugins','token-context-meter','sidecars','meter','telemetry.mjs')].find(fs.existsSync);import(url.pathToFileURL(p).href).then(m=>m.getConversationTokenTelemetry()).then(t=>console.log(JSON.stringify(t,null,2)))"
     ```

2. **Present Metrics to the User**:
   Structure your response with:
   - **Active Model & Limits**: Active model name (e.g. Gemini 3.8 Flash High) and max context window (e.g. 1,048,576 tokens).
   - **Live Context Window**: Exact tokens currently occupying the context window (`activeTokens / maxLimit`) and consumption percentage (`consumptionPct%`), plus remaining headroom.
   - **Latest AI Turn**:
     - **New Input Tokens**: Fresh un-cached prompt tokens ingested.
     - **Cache Read Tokens**: Prompt tokens served from cache, along with the Cache Reuse Percentage (`cacheEfficiencyPct%`).
     - **Output Tokens Breakdown**: Total generated tokens, broken down into internal reasoning/thinking tokens (`thinkingTokens`) and visible response/tool tokens (`responseTokens`).
   - **Cache Lifespan & Learned Survival Bounds**:
     - Warm model and cache hit/miss status.
     - Burst-resistant survival bounds learned across chats (e.g. `Gemini 4 Neon ≥ 8m 37s`, `Claude Opus ≥ 7m 06s`).
   - **Account & Quotas (5h & Weekly Pools)**:
     - 5-hour and Weekly pools: % used, % remaining, and reset countdown.
     - Tokens per 1% quota consumed and estimated remaining runway.
     - Model separation: exact input, cache read, thinking, response tokens consumed by each model in the pool.
   - **Cumulative Session Totals**: Total processed tokens, total turns, tool calls count, and overall cache savings across the entire conversation.
   - **Compaction Status**: Note whether conversation history has undergone compaction/checkpointing.

3. **Sidecar Visual Dashboard**:
   Inform the user that they can also view real-time live graphs, gauges, and historical telemetry logs in the **Context Meter** sidecar panel docked in the desktop application's auxiliary sidebar.
   The dashboard includes:
   - **Session Tab**: Live window utilization, account & 5h/weekly quotas with per-1% burn correlation, active turn breakdown with cross-chat cache lifespan strip, generation output with 3-level tool calls drill-down, cumulative session statistics, and telemetry ledger.
   - **Agents Tab**: Discovered running subagents with live token consumption and turn count.
   - **Global Tab**: Total all-time tokens, separated account storage, quota pools, and manual/auto 100% snapshots.
   - **Per-Model Dropdown**: Filters all telemetry, ledgers, and quota cards to an individual model or "All Models".
