#!/usr/bin/env node
/**
 * MCP Server for Token & Context Meter.
 *
 * Exposes MCP tools over stdio (JSON-RPC 2.0) to allow inspecting
 * exact server-side token usage and live context window consumption in chat.
 */

import readline from 'node:readline';
import { getConversationTokenTelemetry, getModelLimits } from '../sidecars/meter/telemetry.mjs';
import {
  getGlobalLogAudit,
  getGlobalUsage,
  takeAllToLog,
  takeConvoToLog
} from '../sidecars/meter/global-store.mjs';

function formatNumber(num) {
  return (num || 0).toLocaleString();
}

function formatCompactNum(num) {
  const n = num || 0;
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatGap(ms) {
  if (ms == null) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function formatCountdown(ms) {
  if (ms == null || ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function makeProgressBar(usedPct, length = 10) {
  const pct = Math.max(0, Math.min(100, usedPct || 0));
  const filled = Math.round((pct / 100) * length);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, length - filled));
}

function renderQuotaPoolSection(pools, filterModel = 'all') {
  if (!pools || !pools.length) {
    return ['_No quota pool data reported by Antigravity._'];
  }

  const isFiltered = filterModel && filterModel !== 'all';
  let targetPools = pools;
  if (isFiltered) {
    const fLower = filterModel.toLowerCase();
    const matched = pools.filter(p =>
      (p.models || []).some(m => m.toLowerCase().includes(fLower)) ||
      (p.correlation?.byModel || []).some(m => m.model.toLowerCase().includes(fLower))
    );
    if (matched.length) targetPools = matched;
  }

  const lines = [];
  for (const p of targetPools) {
    const winTag = p.windowType === 'weekly' ? 'Weekly' : '5h';
    const bar = makeProgressBar(p.usedPct, 10);
    const resetStr = p.resetTime ? `resets in ${formatCountdown(p.msUntilReset)}` : '';

    lines.push(
      `##### ${p.label} (${winTag} Pool): \`[${bar}]\` **${p.usedPct}% used** · ${p.remainingPct}% left${resetStr ? ` (${resetStr})` : ''}`
    );

    const corr = p.correlation;
    if (corr && corr.hasData) {
      const p1 = corr.per1Pct;
      const rem = corr.estRemaining;
      const full = corr.estFull100;
      lines.push(
        `- **Pool Burn Rate / 1%:** ~${formatNumber(p1.totalProcessedTokens)} tokens (~${p1.turns} turns) · _${formatNumber(p1.inputTokens)} in, ${formatNumber(p1.cacheReadTokens)} cache, ${formatNumber(p1.thinkingTokens)} think, ${formatNumber(p1.responseTokens)} resp_`,
        `- **Remaining Runway (${p.remainingPct}% left):** ~${formatNumber(rem.totalProcessedTokens)} tokens (~${formatNumber(rem.turns)} turns) | **Est. 100% Budget:** ~${formatNumber(full.totalProcessedTokens)} tokens`
      );
    } else {
      const obs = corr?.observedPct || 0;
      lines.push(`- _Collecting 1% correlation (${obs}% / 0.5% min delta observed). Use models in this pool to unlock per-1% burn rate & runway estimates._`);
    }

    const modelsList = corr?.byModel || [];
    if (modelsList.length > 0) {
      if (isFiltered) {
        const fLower = filterModel.toLowerCase();
        const m = modelsList.find(item => item.model.toLowerCase().includes(fLower));
        if (m) {
          lines.push(
            ``,
            `  **Model Separation for \`${m.model}\`:**`,
            `  - **Ingested:** ${formatNumber(m.inputTokens)} new input + ${formatNumber(m.cacheReadTokens)} cache reads (${m.cacheEfficiencyPct}% cached)`,
            `  - **Generated:** ${formatNumber(m.thinkingTokens)} thinking + ${formatNumber(m.responseTokens)} response (${formatNumber(m.totalProcessedTokens)} total across ${m.turns} turns)`,
            `  - **Quota Impact:** Consumed ~**${m.estPctUsed}%** of the ${winTag} quota (**${m.sharePct}%** of all pool tokens)`
          );
          if (m.per1Pct) {
            lines.push(
              `  - **Model Burn / 1%:** ~${formatNumber(m.per1Pct.totalProcessedTokens)} tokens / 1% (~${m.per1Pct.turns}t) · _${formatNumber(m.per1Pct.inputTokens)} in, ${formatNumber(m.per1Pct.cacheReadTokens)} cache, ${formatNumber(m.per1Pct.thinkingTokens)} think, ${formatNumber(m.per1Pct.responseTokens)} resp_`
            );
          }
          if (m.estRemaining) {
            lines.push(
              `  - **Model Runway Estimate:** ~${formatNumber(m.estRemaining.totalProcessedTokens)} tokens (~${formatNumber(m.estRemaining.turns)} turns) remaining at current share`
            );
          }
        }
      } else {
        lines.push(
          ``,
          `  | Model | Input | Cache Read | Thinking | Response | Total | Quota % | Share % | Burn/1% | Runway Est |`,
          `  | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`
        );
        for (const m of modelsList) {
          const burnStr = m.per1Pct ? `~${formatCompactNum(m.per1Pct.totalProcessedTokens)}` : '—';
          const remStr = m.estRemaining ? `~${formatCompactNum(m.estRemaining.totalProcessedTokens)}` : '—';
          lines.push(
            `  | **${m.model}** | ${formatCompactNum(m.inputTokens)} | ${formatCompactNum(m.cacheReadTokens)} (${m.cacheEfficiencyPct}%) | ${formatCompactNum(m.thinkingTokens)} | ${formatCompactNum(m.responseTokens)} | ${formatCompactNum(m.totalProcessedTokens)} (${m.turns}t) | ~${m.estPctUsed}% | ${m.sharePct}% | ${burnStr} | ${remStr} |`
          );
        }
      }
    }
    lines.push(``);
  }
  return lines;
}

function sendResponse(id, result) {
  const response = {
    jsonrpc: '2.0',
    id,
    result
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendError(id, code, message) {
  const response = {
    jsonrpc: '2.0',
    id,
    error: { code, message }
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

const TOOLS = [
  {
    name: 'get_token_context',
    description: 'Get exact server-side token usage, live context window consumption, active account & 5h/weekly quota status with model separation, cross-chat cache lifespan, and session totals. Matches Antigravity CLI /context.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Optional conversation ID or cascadeId. Defaults to the active conversation.'
        },
        model: {
          type: 'string',
          description: 'Optional model filter (e.g. "all", "Claude Opus 5.5", "Gemini 4 Neon"). Defaults to "all". When specified, isolates quota correlation, burn rate, and token metrics to that model.'
        }
      }
    }
  },
  {
    name: 'get_quota_status',
    description: 'Get live Antigravity account status, 5-hour and Weekly quota pools, per-1% token burn rates, runway estimates, and per-model consumption breakdown (all models or separated by model).',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Optional model filter (e.g. "all", "Claude 3.5 Sonnet", "Gemini 4 Neon"). Defaults to "all". When specified, isolates quota correlation and estimates for that specific model.'
        }
      }
    }
  },
  {
    name: 'get_turn_history',
    description: 'Get a detailed breakdown of token consumption and model routing. Supports both "prompt" view (grouped by user prompt boundary) and "step" view (granular per-call breakdown).',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['prompt', 'step'],
          description: 'Aggregation mode: "prompt" (default, grouped by user message) or "step" (granular individual LLM calls).'
        },
        limit: {
          type: 'number',
          description: 'Number of recent prompts or turns to retrieve (default: 10).'
        },
        conversation_id: {
          type: 'string',
          description: 'Optional conversation ID or cascadeId.'
        }
      }
    }
  },
  {
    name: 'get_global_audit',
    description: 'Read-only audit of the append-only global-log.db: 5-hour and 7-day rolling token usage, per-user/userdata splits, 5h budget negative overage, and agy-fast inner tool statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        cap_5h_tokens: {
          type: 'number',
          description: 'Optional 5-hour token budget to compute remaining/negative overage.'
        },
        user_id: {
          type: 'string',
          description: 'Optional filter by canonical user_id (e.g. email).'
        },
        userdata_key: {
          type: 'string',
          description: 'Optional filter by userdata_key (e.g. "desktop:default").'
        }
      }
    }
  },
  {
    name: 'capture_global_log',
    description: 'One-click append into global-log.db: capture all unseen conversations/quotas ("all") or archive a complete single conversation ("session").',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['all', 'session'],
          description: '"all" captures across discovered userdata roots; "session" archives one conversation completely.'
        },
        conversation_id: {
          type: 'string',
          description: 'Optional cascadeId when mode is "session" (defaults to active conversation).'
        }
      }
    }
  }
];

async function handleToolCall(name, args) {
  const modelFilter = (args?.model || 'all').trim();

  if (name === 'get_global_audit') {
    const audit = await getGlobalLogAudit({
      cap5hTokens: args?.cap_5h_tokens ? Number(args.cap_5h_tokens) : null,
      userId: args?.user_id || null,
      userdataKey: args?.userdata_key || null
    });
    if (!audit.available) {
      return {
        content: [{ type: 'text', text: '⚠️ `global-log.db` has not been created yet. Run `capture_global_log` or `npm run global:take` first.' }]
      };
    }
    const o = audit.overall;
    const lines = [
      `### 📒 Global Append-Log Audit (\`maxSeq=${audit.maxSeq}\`, \`events=${audit.totalEvents}\`)`,
      `- **5-Hour Rolling:** ${formatCompactNum(o.window5h.totals.totalProcessedTokens)} processed (${o.window5h.totals.turns} turns)`,
      `- **7-Day Rolling:** ${formatCompactNum(o.window7d.totals.totalProcessedTokens)} processed (${o.window7d.totals.turns} turns)`,
      `- **agy-fast Tool Calls:** ${o.agyFast.totalCalls} (\`batch_search=${o.agyFast.batch_search.calls}\`, \`apply_edits=${o.agyFast.apply_edits.calls}\`, \`read_slices=${o.agyFast.read_slices.calls}\`)`
    ];
    if (o.window5h.quota.capAnalysis) {
      const c = o.window5h.quota.capAnalysis;
      lines.push(`- **5h Cap (${formatCompactNum(c.cap5hTokens)}):** ${c.isNegative ? `NEGATIVE -${formatCompactNum(c.negativeTokens)}` : `${formatCompactNum(c.remainingBudgetTokens)} remaining`} (${c.utilizationPct}%)`);
    }
    if (audit.byAccount.length) {
      lines.push(``, `#### Per-User / Userdata Splits:`);
      for (const a of audit.byAccount) {
        lines.push(`- **${a.userId}** (\`${a.userdataKey}\`): 5h=${formatCompactNum(a.window5h.totals.totalProcessedTokens)} | 7d=${formatCompactNum(a.window7d.totals.totalProcessedTokens)}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'capture_global_log') {
    const mode = args?.mode === 'session' ? 'session' : 'all';
    const res = mode === 'session'
      ? await takeConvoToLog(args?.conversation_id || null)
      : await takeAllToLog();
    if (!res?.ok) {
      return { content: [{ type: 'text', text: `⚠️ Capture failed: ${res?.error || 'unknown error'}` }] };
    }
    const summary = mode === 'session'
      ? `Archived conversation \`${res.cascadeId}\` for \`${res.userId}\`: **+${res.inserted}** events (${res.turnCount} turns, ${res.stepCount} steps).`
      : `Captured **+${res.inserted}** events (${res.ignored} deduped) across ${res.conversationsScanned} conversations in [${res.roots.join(', ')}] for \`${res.userId}\`.`;
    return { content: [{ type: 'text', text: `✅ ${summary}` }] };
  }

  if (name === 'get_quota_status') {
    const globalUsage = await getGlobalUsage().catch(() => null);
    if (!globalUsage) {
      return {
        content: [{ type: 'text', text: '⚠️ Unable to retrieve Antigravity account quota data.' }]
      };
    }

    const acct = globalUsage.account || {};
    const r5 = globalUsage.quota5h?.rolling;
    const r7 = globalUsage.quota7d?.rolling;
    const output = [
      `### ⏱️ Antigravity Account & Quotas`,
      `- **Active Account:** **${acct.name || 'User'}** (\`${acct.email || 'local'}\` · **${acct.planName || 'Standard'}** Plan)`,
      `- **Active Conversations:** ${globalUsage.conversationCount || 0} tracked (${globalUsage.pendingCount || 0} indexing)`,
      `- **Rolling Consumption:** **5h:** ${formatCompactNum(r5?.totals?.totalProcessedTokens || 0)} (${r5?.conversations || 0} chats) · **7d:** ${formatCompactNum(r7?.totals?.totalProcessedTokens || 0)} (${r7?.conversations || 0} chats)`,
      ``,
      `#### 📊 Live Quota Pools & Burn Rates (${modelFilter === 'all' ? 'All Models' : `Filtered to \`${modelFilter}\``}):`
    ];

    output.push(...renderQuotaPoolSection(globalUsage.quotaPools, modelFilter));

    if (globalUsage.snapshots?.length) {
      const recentSnaps = globalUsage.snapshots.slice(0, 5);
      output.push(
        `#### 📸 Recent Quota Snapshots (100% Cycles & Baselines):`,
        `| Name | Type | Turns | Total Processed | Created At |`,
        `| :--- | :--- | :--- | :--- | :--- |`
      );
      for (const s of recentSnaps) {
        const typeTag = s.auto ? (s.windowType === 'weekly' ? 'Auto Weekly' : 'Auto 5h') : 'Manual';
        output.push(
          `| ${s.name} | ${typeTag} | ${s.totals?.totalTurns || 0}t | ${formatCompactNum(s.totals?.totalProcessedTokens)} | ${s.createdAt ? s.createdAt.slice(0, 16).replace('T', ' ') : '—'} |`
        );
      }
    }

    return {
      content: [{ type: 'text', text: output.join('\n') }]
    };
  }

  const [telemetry, globalUsage] = await Promise.all([
    getConversationTokenTelemetry(args?.conversation_id),
    getGlobalUsage().catch(() => null)
  ]);

  const ctx = telemetry.liveContext;
  const latest = telemetry.latestTurn;
  const cum = telemetry.cumulative;
  const model = telemetry.activeModel;

  if (name === 'get_token_context') {
    const acct = globalUsage?.account || telemetry.account || {};
    let output = [
      `### 📊 Live Context Window & Token Meter`,
      `- **Active Model:** ${latest?.modelDisplayName || model.displayName}${telemetry.isMultiModel ? ` (${telemetry.sessionModelsSummary})` : ''}`,
      `- **Live Context Window:** ${formatNumber(ctx.activeTokens)} / ${formatNumber(ctx.maxLimit)} tokens (**${ctx.consumptionPct}%** used)`,
      `- **Remaining Capacity:** ${formatNumber(ctx.remainingTokens)} tokens (${ctx.remainingPct}% free)`,
      `- **Health Status:** ${telemetry.healthStatus.toUpperCase()}`
    ];

    if (ctx.compactionCount > 0) {
      output.push(`- **Compaction Events:** ${ctx.compactionCount} history checkpoints executed to reclaim context`);
    }

    if (latest) {
      output.push(
        ``,
        `#### Latest AI Turn (#${latest.turnNumber}):`,
        `- **New Input Tokens:** ${formatNumber(latest.inputTokens)}`,
        `- **Cache Read Tokens:** ${formatNumber(latest.cacheReadTokens)} (${latest.cacheEfficiencyPct}% cache reuse)`,
        `- **Total Turn Prompt:** ${formatNumber(latest.promptTokens)}`,
        `- **Turn Output Tokens:** ${formatNumber(latest.outputTokens)}`,
        `  - **Thinking / Reasoning:** ${formatNumber(latest.thinkingTokens)} tokens`,
        `  - **Response & Tools:** ${formatNumber(latest.responseTokens)} tokens`
      );
    }

    // Cache Lifespan & Survival Bounds (Cross-Chat Persisted)
    if (telemetry.cacheLifespan) {
      const cls = telemetry.cacheLifespan;
      const lastAgoMs = cls.lastChatCompletedAtMs ? Math.max(0, Date.now() - cls.lastChatCompletedAtMs) : null;
      output.push(
        ``,
        `#### ⚡ Cache Lifespan & Survival Bounds (Cross-Chat Persisted):`,
        `- **Warm Model:** ${cls.warmModelDisplayName} (${cls.lastTurnHadCache ? 'Warm Cache Hit' : 'Cold Cache Miss'})`,
        `- **Last Chat:** ${lastAgoMs !== null ? `${formatGap(lastAgoMs)} ago` : 'Active conversation'}`
      );

      const byModelEntries = Object.entries(cls.byModel || {});
      if (byModelEntries.length > 0) {
        output.push(`- **Learned Model Bounds:**`);
        for (const [mName, b] of byModelEntries) {
          let desc = 'No lifespan data yet';
          if (b.status === 'bracketed') {
            desc = `${formatGap(b.maxWarmGapMs)} – ${formatGap(b.minColdGapMs)} (est. ~${formatGap(b.estimatedTtlMs)})`;
          } else if (b.status === 'lower_bound') {
            desc = `≥ ${formatGap(b.maxWarmGapMs)} (${b.sampleCount} sample${b.sampleCount === 1 ? '' : 's'}${b.isPersisted ? ' across chats' : ''})`;
          } else if (b.status === 'upper_bound') {
            desc = `≤ ${formatGap(b.minColdGapMs)} (${b.sampleCount} sample${b.sampleCount === 1 ? '' : 's'})`;
          }
          output.push(`  - **${mName}:** ${desc}`);
        }
      }
    }

    // Account & Quota Pools Section (with Model Separation)
    if (globalUsage && globalUsage.quotaPools?.length) {
      output.push(
        ``,
        `#### ⏱️ Account & Quota Pools (${acct.name || 'User'} · ${acct.planName || 'Pro'} · \`${acct.email || 'local'}\`):`
      );
      output.push(...renderQuotaPoolSection(globalUsage.quotaPools, modelFilter));
    }

    output.push(
      ``,
      `#### Session Cumulative (${cum.totalTurns} turns):`,
      `- **Total Ingested:** ${formatNumber(cum.inputTokens)} new inputs + ${formatNumber(cum.cacheReadTokens)} cache reads`,
      `- **Total Generated:** ${formatNumber(cum.outputTokens)} (${formatNumber(cum.thinkingTokens)} thinking + ${formatNumber(cum.responseTokens)} response)`,
      `- **Total Processed:** ${formatNumber(cum.totalProcessedTokens)} tokens`,
      `- **Overall Cache Savings:** ${cum.overallCacheSavingsPct}% cache hit rate`
    );

    if (telemetry.toolCalls?.totalCalls > 0) {
      const tc = telemetry.toolCalls;
      const top3 = (tc.tools || []).slice(0, 3).map(t => `${t.name} (${t.count})`).join(', ');
      output.push(`- **Tool Calls:** ${formatNumber(tc.totalCalls)} calls across ${tc.tools?.length || 0} tools${top3 ? ` (top: ${top3})` : ''}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: output.join('\n')
        }
      ]
    };
  }

  if (name === 'get_turn_history') {
    const limit = Math.max(1, Math.min(50, parseInt(args?.limit || 10, 10)));
    const viewMode = args?.view === 'step' ? 'step' : 'prompt';

    if (viewMode === 'prompt') {
      const recentPrompts = (telemetry.recentPrompts || telemetry.prompts || []).slice(0, limit);
      let rows = [
        `| Prompt | Calls | Model Routing | New Input | Cache Read | Thinking | Output | Ending Context | Cache % |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`
      ];

      recentPrompts.forEach(p => {
        const modelsRouting = p.modelsRoutingPath || p.modelsUsedShort?.join(' → ') || 'Flash';
        rows.push(
          `| #${p.promptNumber} | ${p.llmCallsCount} call${p.llmCallsCount === 1 ? '' : 's'} | ${modelsRouting} | ${formatNumber(p.newInput)} | ${formatNumber(p.cacheRead)} | ${formatNumber(p.thinking)} | ${formatNumber(p.output)} | ${formatNumber(p.endingContext)} (${p.endingContextPct}%) | ${p.cacheEfficiencyPct}% |`
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `### 📜 Prompt-Grouped Telemetry Log (Last ${recentPrompts.length} Prompts)\n\n` + rows.join('\n')
          }
        ]
      };
    } else {
      const recent = (telemetry.recentTurns || []).slice(0, limit);
      let rows = [
        `| Turn | Steps | Model | New Input | Cache Read | Thinking | Output | Total Turn | Cache % |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`
      ];

      recent.forEach(t => {
        const steps = t.stepIndices?.length ? t.stepIndices.join('→') : '-';
        const modelLabel = t.modelShortName || t.modelDisplayName || 'Flash';
        rows.push(
          `| #${t.turnNumber} | ${steps} | ${modelLabel} | ${formatNumber(t.inputTokens)} | ${formatNumber(t.cacheReadTokens)} | ${formatNumber(t.thinkingTokens)} | ${formatNumber(t.outputTokens)} | ${formatNumber(t.totalTurnTokens)} | ${t.cacheEfficiencyPct}% |`
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `### 📜 Per-Step Telemetry Log (Last ${recent.length} Steps)\n\n` + rows.join('\n')
          }
        ]
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let reqId = null;
  try {
    const req = JSON.parse(trimmed);
    reqId = req.id !== undefined ? req.id : null;

    if (req.method === 'initialize') {
      sendResponse(reqId, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'token-context-meter',
          version: '1.1.1'
        }
      });
      return;
    }

    if (req.method === 'notifications/initialized') {
      // Notification, no reply needed
      return;
    }

    if (req.method === 'tools/list') {
      sendResponse(reqId, { tools: TOOLS });
      return;
    }

    if (req.method === 'tools/call') {
      const { name, arguments: toolArgs } = req.params || {};
      try {
        const result = await handleToolCall(name, toolArgs);
        sendResponse(reqId, result);
      } catch (toolErr) {
        sendError(reqId, -32603, `Tool execution error: ${toolErr.message}`);
      }
      return;
    }

    if (req.id !== undefined) {
      sendError(reqId, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    console.error('MCP Server error:', err);
    try {
      sendError(reqId, -32700, `Parse error: ${err.message}`);
    } catch {}
  }
});
